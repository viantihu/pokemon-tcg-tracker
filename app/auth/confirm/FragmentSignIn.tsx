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

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseAuthFragment } from "@/lib/auth/fragment";
import { completeSignIn } from "./actions";

/**
 * `pending`: what the page shows while the sign-in finishes (the confirm page's "Signing you in…").
 *
 * ALREADY SIGNED IN AS SOMEONE ELSE (UIL-127c; the Tech Lead's condition on R2): her session is kept, and instead of
 * moving on as though the link had worked, this names the account she is in and how to use the link.
 */
export function FragmentSignIn({
  onEmpty,
  pending = null,
}: {
  onEmpty: "ignore" | "fail";
  pending?: ReactNode;
}) {
  const router = useRouter();
  const started = useRef(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

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
      (res) => {
        if (res.ok && res.signedInAs) setSignedInAs(res.signedInAs);
        else router.replace(res.ok ? "/plan" : `/login?error=${res.error}`);
      },
      () => router.replace("/login?error=auth"),
    );
  }, [onEmpty, router]);

  if (!signedInAs) return pending;
  return (
    <div role="status" style={{ fontSize: 12, lineHeight: 1.7 }}>
      <p style={{ marginBottom: 12 }}>
        You&apos;re already signed in as <strong>{signedInAs}</strong>. That link was for a
        different account. To use it, sign out first, then open the link again.
      </p>
      <Link href="/plan" className="btn btn-primary u">
        Continue as {signedInAs}
      </Link>
    </div>
  );
}
