"use client";

/**
 * Owner-session context for the `(ui)` shell. The layout resolves the authenticated user server-side
 * and hands the minimal owner identity (id + email) to client screens through this provider, so
 * components can greet the owner or gate UI without re-fetching the session. This is a UI
 * convenience only: real authorization is RLS (`auth.uid()`) on every domain table, enforced on the
 * server through the `lib/plan/session.ts` seam — never trust this context for access control.
 */

import { createContext, useContext, type ReactNode } from "react";

export interface OwnerSession {
  userId: string;
  email: string | null;
}

const SessionContext = createContext<OwnerSession | null>(null);

export function SessionProvider({ value, children }: { value: OwnerSession; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Read the owner session. Throws if used outside the `(ui)` shell (i.e. no session). */
export function useSession(): OwnerSession {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within the (ui) SessionProvider.");
  }
  return ctx;
}
