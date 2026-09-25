"use client";

/**
 * Finish a magic-link sign-in from the URL fragment, in any browser (UIL-097).
 *
 * Karvi: "When I opened the 'magic link' from the gmail app, it opened a chrome tab asking me to enter my
 * email again." The old link was PKCE: it could only be finished by the browser that requested it, because
 * the proof lived in that browser's cookies. The link is now requested in the implicit flow, so it lands
 * with the session in the fragment and any browser can finish it.
 *
 * ORDER IS THE SECURITY (the Senior BA's condition, pinned by tests/auth/fragment-sign-in.dom.test.ts):
 *   1. read the fragment, and act only on BOTH tokens or a Supabase error (`parseAuthFragment`);
 *   2. WIPE it from the address bar and this history entry — before any network call, analytics
 *      included — so the tokens are not left in the URL for a screenshot, a share or the back button;
 *   3. only then hand the tokens to the server (`completeSignIn`), which validates them and enforces the
 *      allow-list.
 * Nothing here logs or displays a token: on failure she is sent to /login with a fixed error code.
 *
 * Mounted on /auth/confirm (where the link points) and on /login, the safety net for a redirect that fell
 * back to the Site URL: the root sends a signed-out visitor to /login, the browser keeps the fragment
 * across that redirect, and this finishes the sign-in there instead of her being asked for her email again.
 * On /login a page with no qualifying fragment is left alone; on /auth/confirm it is a failed link.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { parseAuthFragment } from "@/lib/auth/fragment";
import { completeSignIn } from "./actions";

export function FragmentSignIn({ onEmpty }: { onEmpty: "ignore" | "fail" }) {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    // Once per page: React may run an effect twice in development, and the fragment is gone after the
    // first run anyway.
    if (started.current) return;
    started.current = true;

    const fragment = parseAuthFragment(window.location.hash);
    if (fragment.kind === "none") {
      if (onEmpty === "fail") router.replace("/login?error=auth");
      return;
    }

    // 2. Wipe first. Nothing below may run before this line.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);

    if (fragment.kind === "error") {
      router.replace("/login?error=expired");
      return;
    }

    completeSignIn(fragment.accessToken, fragment.refreshToken).then(
      (res) => router.replace(res.ok ? "/plan" : `/login?error=${res.error}`),
      () => router.replace("/login?error=auth"),
    );
  }, [onEmpty, router]);

  return null;
}
