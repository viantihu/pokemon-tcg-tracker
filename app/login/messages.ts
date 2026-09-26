/**
 * Sign-in text shared by the server action and its tests. It lives here, not in `./actions`, because a
 * "use server" file may export only async functions: Next throws at runtime when it loads one that exports
 * anything else (E352), which is how a string exported from `./actions` took /login down (2026-09-26).
 * tests/app/use-server-exports.test.ts keeps every "use server" file to that rule.
 */

/** What she reads when Supabase's hourly email limit is hit — the message she used to get was Supabase's. */
export const RATE_LIMITED =
  "Too many sign-in emails were sent in the last hour. The limit resets on the hour. If an earlier " +
  "link is still in your inbox, open that one.";

/**
 * When Sign in or Sign out cannot reach the server at all (UIL-106's family: a redeploy under an open page,
 * or a dropped connection). Neither says what did or did not happen, because a call that never answered may
 * still have landed.
 */
export const SIGN_IN_UNREACHED =
  "The app was updated while this page was open, or the connection dropped. Reload the page and send the " +
  "link again. If a link does arrive from before, it still works.";
export const SIGN_OUT_UNREACHED =
  "The app was updated while this page was open, or the connection dropped. Reload the page; if you are " +
  "still signed in, sign out again.";
