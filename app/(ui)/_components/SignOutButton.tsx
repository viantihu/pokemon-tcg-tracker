"use client";

/**
 * Owner identity + sign-out affordance for the app shell. Pinned bottom-left so it stays out of the
 * way of the retro top nav (which is a separate, frozen component). Submits the `signOut` server
 * action, which clears the Supabase session and returns to /login.
 */

import { signOut } from "@/app/login/actions";

export function SignOutButton({ email }: { email: string | null }) {
  return (
    <form
      action={signOut}
      style={{
        position: "fixed",
        left: 14,
        bottom: 14,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {email ? (
        <span className="tag" title={email}>
          {email}
        </span>
      ) : null}
      <button type="submit" className="btn u" style={{ fontSize: 10 }}>
        Sign out
      </button>
    </form>
  );
}
