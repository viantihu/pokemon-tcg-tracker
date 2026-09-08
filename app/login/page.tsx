/**
 * Sign-in screen (dev-spec §3 decision 4; §7 gate 1). Lives OUTSIDE the `(ui)` route group, so it
 * has no app shell / nav and no auth guard — this is the one place an unauthenticated visitor lands.
 * If a valid session already exists, bounce straight to the app.
 */

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · Binder Ops" };

const ERROR_MESSAGES: Record<string, string> = {
  auth: "That sign-in link was invalid or has expired. Request a new one below.",
  forbidden: "That account is not authorised for this binder.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/plan");

  const params = await searchParams;
  const errorKey = typeof params.error === "string" ? params.error : null;
  const errorMessage = errorKey ? ERROR_MESSAGES[errorKey] : null;

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="panel" style={{ width: "100%", maxWidth: 420, padding: 22 }}>
        <div
          className="brand"
          style={{ marginBottom: 18, boxShadow: "none", justifyContent: "center" }}
        >
          <span className="mark" />
          <div>
            <b>BINDER OPS</b>
            <br />
            <span>SORT · ROUTE · HUNT</span>
          </div>
        </div>
        {errorMessage ? (
          <div className="alertbar" style={{ marginBottom: 16, boxShadow: "none" }}>
            <span style={{ fontSize: 11, letterSpacing: "0.04em" }}>{errorMessage}</span>
          </div>
        ) : null}
        <p style={{ fontSize: 11, color: "var(--ink-2)", lineHeight: 1.7, marginBottom: 16 }}>
          This binder is private. Enter the owner email to receive a one-time sign-in link.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
