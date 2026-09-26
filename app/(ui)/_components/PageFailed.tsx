"use client";

/**
 * What she sees when a page throws instead of rendering (UIL-106 part 4): the backstop behind the named
 * fixes, for whatever they did not name. Next's own error page said nothing she could act on.
 *
 * It says only what is true of EVERY way a page lands here. A boundary catches a bug as readily as a
 * redeploy or a dropped connection, so the cause is offered as an "if", never asserted, and nothing here
 * claims what was or was not saved. The error's own message is not shown and not logged: a server error
 * arrives redacted anyway, and this boundary also wraps sign-in, where nothing may echo what it was handed.
 * The digest is shown because it is made to be: it matches the server's log line and carries nothing else.
 */

export const PAGE_FAILED = {
  title: "This page stopped working",
  body:
    "Something went wrong while showing it. If the app was updated while this page was open, or the " +
    "connection dropped, reloading the page fixes it.",
} as const;

export function PageFailed({
  retry,
  digest,
  reload = () => window.location.reload(),
}: {
  /** Next's `retry`: re-fetch and re-render the segment in place. */
  retry: () => void;
  digest?: string;
  /** A full reload, which is what a redeploy needs. A prop only so a test can see it pressed. */
  reload?: () => void;
}) {
  return (
    <div className="stub panel" role="alert">
      <h1 className="u">{PAGE_FAILED.title}</h1>
      <p>{PAGE_FAILED.body}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" className="btn btn-primary u" onClick={reload}>
          Reload the page
        </button>
        <button type="button" className="btn u" onClick={retry}>
          Try again
        </button>
      </div>
      {digest ? (
        <p style={{ marginTop: 12, fontSize: 10, color: "var(--ink-2)" }}>Reference: {digest}</p>
      ) : null}
    </div>
  );
}
