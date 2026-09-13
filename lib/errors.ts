/**
 * One place to turn an unknown thrown value into a message a human can act on.
 *
 * WHY THIS EXISTS. The obvious idiom — `err instanceof Error ? err.message : String(err)` — is wrong
 * for the errors this app actually throws. supabase-js rejects with a `PostgrestError`, which is a
 * PLAIN OBJECT (`{ message, details, hint, code }`), not an `Error` instance. So `String(err)` renders
 * the literal text `"[object Object]"`, and every DB failure surfaces to the user, and to CI logs, with
 * no information at all. That is exactly how a mirror run reported
 * `{"ok":false,"error":"[object Object]"}` for one set and left the cause unknowable.
 *
 * Errors are the one output that has to stay legible when everything else has gone wrong, so this
 * favours saying too much over saying nothing: Postgres's `code`/`details`/`hint` carry the part that
 * usually identifies the fault (a constraint name, a missing function), and dropping them to keep the
 * string tidy is what created the blind spot.
 */

/** The shape supabase-js rejects with. Structural, not `instanceof` — it is a plain object. */
function asMessageBearing(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.message === "string" ? o : null;
}

/** A readable one-liner for any thrown value. Never throws, never returns an empty string. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string" && err.trim() !== "") return err;

  if (err instanceof Error) {
    const parts = [err.message || err.name];
    // A wrapped cause is often the only place the real reason lives (e.g. a fetch failure).
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      const inner = errorMessage(cause);
      if (inner && !err.message.includes(inner)) parts.push(`(cause: ${inner})`);
    }
    return parts.join(" ");
  }

  const bearer = asMessageBearing(err);
  if (bearer) {
    const detail = ["code", "details", "hint"]
      .map((k) => {
        const v = bearer[k];
        return typeof v === "string" && v.trim() !== "" ? `${k}: ${v}` : null;
      })
      .filter(Boolean);
    const head = String(bearer.message);
    return detail.length > 0 ? `${head} [${detail.join("; ")}]` : head;
  }

  // Last resort: show the structure rather than "[object Object]".
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}" && json !== "null") return json;
  } catch {
    // Circular or non-serializable — fall through.
  }
  return err === undefined ? "unknown error (undefined)" : `unknown error (${typeof err})`;
}
