/**
 * Call a server action from the browser, and turn "it never reached the server" into a message (UIL-105, UIL-106).
 *
 * A server action that THROWS never reached her data, or never answered: the app was redeployed while the page
 * was open (a new deployment retires the old action ids), or the connection dropped. The actions report their own
 * failures as `{ ok: false }`, so a throw is only ever this. Uncaught, it left progress bars running forever and
 * busy flags set, so a screen stopped answering with nothing said. #349 fixed the Sync page with this shape; it
 * lives here so every screen uses the one helper and the one family of words, not a copy.
 *
 * Say only what is TRUE for the call (#349's copy correction): a read writes nothing; a write is all-or-nothing on
 * the server, so a reload shows which way it went — which is why no message here says "nothing was saved".
 *
 * NOT EVERY THROW IS A FAILURE. An action that ends in `redirect()` (Sign out does) reaches the browser as a
 * REJECTED promise carrying Next's redirect, for Next's own boundary to act on (next's server-action reducer:
 * "the action promise will be rejected with a redirect"). Caught here, Sign out would stop navigating and
 * say the connection dropped. `unstable_rethrow` hands every such Next signal back unchanged, and only a
 * genuine failure becomes a message.
 */

import { unstable_rethrow } from "next/navigation";

/** What `reach` returns when the call threw. `ok: false` so an action's own failure path handles it too. */
export interface Unreached {
  ok: false;
  error: string;
  unreached: true;
}

const PREFIX = "The app was updated while this page was open, or the connection dropped.";

export const LOST = {
  /** A write: it may or may not have landed; a reload shows which. */
  action: `${PREFIX} Reload the page to see whether that went through.`,
  /** A read: nothing was changed; a reload shows the latest. */
  read: `${PREFIX} Reload the page to see the latest.`,
  /**
   * A read whose action ALSO throws when the server itself fails (it returns data, not `{ ok }`), so a throw
   * is not only a call that never arrived. It names all three causes, which is true of every throw (UIL-109).
   */
  load:
    "The app was updated while this page was open, the connection dropped, or the server could not " +
    "answer. Reload the page to try again.",
} as const;

/** True when `reach`'s call threw — for a read that returns data rather than `{ ok }`. */
export function isUnreached(value: unknown): value is Unreached {
  return typeof value === "object" && value !== null && "unreached" in value;
}

export async function reach<T>(call: () => Promise<T>, lost: string): Promise<T | Unreached> {
  try {
    return await call();
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: lost, unreached: true };
  }
}
