"use server";

/**
 * Finish a magic-link sign-in from the tokens in the link's fragment (UIL-097).
 *
 * A Server Function is reachable by a direct POST, not only from /auth/confirm, so this checks everything
 * itself: the tokens are handed to Supabase, which VALIDATES them with the auth server before it keeps the
 * session (`setSession` → `_getUser`), the session cookies are written by the SSR client, and the user it
 * belongs to must be the one allow-listed owner — any other session is signed out at once. RLS remains the
 * backstop behind all of it.
 *
 * NOTHING HERE LOGS, ECHOES OR RETURNS A TOKEN, OR ANY TEXT THAT COULD CARRY ONE (the Senior BA's
 * condition): no console output, and the result is one of three fixed codes, never Supabase's message.
 *
 * Two rules from the Tech Lead's security review (#333), ruled in by the Senior BA:
 *   R2 — ALREADY SIGNED IN AS THE OWNER: her session is not touched. A link cannot replace it, so a crafted
 *        `/login#access_token=…` for another account cannot sign her out.
 *   R2b — …but the LINK'S session, when it is a different one, is revoked, so a second link opened while she
 *        is signed in does not stay a live credential in the in-app browser's history. Compared by
 *        `session_id`; revoked on a throwaway client with `signOut({ scope: "local" })`, and HER session is
 *        never refreshed for it — refreshing could trip Supabase's reuse detection, which revokes a whole
 *        session family, hers included if the link was her own. A replay of her own link is left alone: R1
 *        already burned it. The revoke runs in `after()`, once her response has gone, so her sign-in never
 *        waits on it.
 *
 *        THE ASSUMPTION, stated (the Tech Lead's review): on a NON-expired link token, `setSession` verifies
 *        it with the auth server, so the compared `session_id` is authentic. On an EXPIRED one, auth-js
 *        2.115.0 never verifies the access token — it refreshes with the refresh token — so the REFRESH
 *        token decides which session is refreshed and revoked. That is still "the other session" only
 *        because a link's two tokens belong together, which Supabase's redirect guarantees; a mismatched
 *        pair would need her refresh token, which is already a takeover. The re-check below narrows even
 *        that: the session `setSession` hands back has been issued or verified, and is compared again.
 *   R1 — ROTATE AT ONCE: once the allow-list passes, the session is refreshed, so the cookies hold a NEW
 *        pair and the refresh token that travelled in the URL — and may sit in the in-app browser's history
 *        — stops working after Supabase's reuse interval, instead of staying a live credential for days.
 */

import { after } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/auth/allowlist";
import { sessionIdOf } from "@/lib/auth/session-id";
import { publicEnv } from "@/lib/env";

export type CompleteSignInResult = { ok: true } | { ok: false; error: "auth" | "forbidden" };

export async function completeSignIn(
  accessToken: unknown,
  refreshToken: unknown,
): Promise<CompleteSignInResult> {
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    return { ok: false, error: "auth" };
  }
  if (accessToken === "" || refreshToken === "") return { ok: false, error: "auth" };

  const supabase = await createClient();

  // R2: already the owner — leave her session exactly as it is; R2b: retire the link's own, if different.
  const {
    data: { user: current },
  } = await supabase.auth.getUser();
  if (current && isAllowedEmail(current.email)) {
    const {
      data: { session: mine },
    } = await supabase.auth.getSession();
    const mineId = sessionIdOf(mine?.access_token);
    after(() => revokeIfAnotherSession(mineId, accessToken, refreshToken));
    return { ok: true };
  }

  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) return { ok: false, error: "auth" };

  // Re-read the user the auth server says this session belongs to; never trust the token's own claims.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAllowedEmail(user?.email)) {
    await supabase.auth.signOut();
    return { ok: false, error: "forbidden" };
  }

  // R1: burn the pair that came through the URL. A session that cannot rotate is not kept.
  const { error: rotateError } = await supabase.auth.refreshSession();
  if (rotateError) {
    await supabase.auth.signOut();
    return { ok: false, error: "auth" };
  }
  return { ok: true };
}

/**
 * R2b: revoke the session a link carries when it is NOT the one she is signed in with. Best effort and
 * silent: nothing here may fail her sign-in or log anything. When either id cannot be read, nothing is done —
 * the safe answer, since revoking what might be her own session is the one outcome that must not happen.
 */
async function revokeIfAnotherSession(
  mine: string | null,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  const theirs = sessionIdOf(accessToken);
  if (!mine || !theirs || mine === theirs) return;
  // A client with no cookies and no storage: it can only ever hold the link's session.
  const throwaway = createSupabaseClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try {
    const { data, error } = await throwaway.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) return;
    // Re-check on the session Supabase handed back — issued or verified by now, unlike the URL's claim.
    const held = sessionIdOf(data.session?.access_token);
    if (!held || held === mine) return;
    await throwaway.auth.signOut({ scope: "local" });
  } catch {
    // Silent by design (the Senior BA's condition: nothing logs a token or text that could carry one).
  }
}
