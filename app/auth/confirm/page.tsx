/**
 * Where a magic link lands (UIL-097). The session arrives in the URL fragment, which only the browser can
 * read, so the work is done by the client island `FragmentSignIn`; this page is the frame she sees for the
 * moment it takes. Public: /auth/* is outside the proxy's sign-in gate (lib/supabase/proxy.ts).
 */

import { FragmentSignIn } from "./FragmentSignIn";

export const metadata = { title: "Signing in · Binder Ops" };

export default function ConfirmPage() {
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="panel" style={{ width: "100%", maxWidth: 420, padding: 22 }}>
        <p role="status" style={{ fontSize: 12, lineHeight: 1.7 }}>
          Signing you in…
        </p>
        <FragmentSignIn onEmpty="fail" />
      </div>
    </main>
  );
}
