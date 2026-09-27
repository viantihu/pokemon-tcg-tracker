/**
 * The `session_id` claim of a Supabase access token (UIL-097 R2b), or null when there is none to read.
 *
 * Decoded, NOT verified: it is only ever COMPARED, to tell "the link she already signed in with, opened
 * again" from "a second link". Neither answer trusts the claim with anything. A replay is left alone; a
 * different session is revoked only after Supabase itself validates its tokens (`setSession`), so a forged
 * claim can at worst make the app do nothing. Pure.
 */
export function sessionIdOf(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null;
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    const id = (claims as { session_id?: unknown } | null)?.session_id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/**
 * The `sub` claim (the account id) of a Supabase access token, or null (UIL-127c). Decoded, NOT verified, and used
 * for one thing only: telling her a link she opened while signed in was for ANOTHER account, so it does not look as
 * though the link did nothing. It grants nothing and revokes nothing. Pure.
 */
export function userIdOf(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null;
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    const sub = (claims as { sub?: unknown } | null)?.sub;
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch {
    return null;
  }
}
