/**
 * The URL fragment a magic link lands with (UIL-097). Pure, so the one rule for what the app acts on is
 * testable without a browser.
 *
 * The link is requested in the IMPLICIT flow (app/login/actions.ts), so Supabase's verify endpoint
 * redirects with the session in the fragment — `#access_token=…&refresh_token=…` — or, for a link that was
 * already used or has expired, with `#error=…&error_code=…`. A fragment never reaches any server (it is
 * not in the request, the Referer or a log), which is what lets the link work in a browser that did not
 * request it: nothing has to be matched against a cookie.
 *
 * The rule (the Senior BA's ruling): act ONLY on a fragment that carries BOTH tokens, or a Supabase error.
 * Anything else is left exactly as it is. The error's description is not kept: only its code, which the
 * login page maps to its own words, so no text from the URL is ever shown back.
 */

export type AuthFragment =
  | { kind: "session"; accessToken: string; refreshToken: string }
  | { kind: "error"; code: string | null }
  | { kind: "none" };

export function parseAuthFragment(hash: string): AuthFragment {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return { kind: "none" };
  const params = new URLSearchParams(raw);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken };
  if (params.has("error") || params.has("error_code")) {
    return { kind: "error", code: params.get("error_code") ?? params.get("error") };
  }
  return { kind: "none" };
}
