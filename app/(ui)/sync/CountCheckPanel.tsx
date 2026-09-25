"use client";

/**
 * UIL-100 — does the collection add up to the Dex file? Always on the Sync page, refreshed after every
 * import, match, retry and undo (the screen reloads its whole state after each). Never silent: when it does
 * not add up, it says by how much, names every card, and says what to do.
 */
import type { CountCheckView, NamedCountMismatch } from "@/lib/sync/count-check";

function where(m: NamedCountMismatch): string {
  const set = [m.setName, m.localId].filter(Boolean).join(" ");
  return [m.name, set, m.dexVariantRaw].filter(Boolean).join(" · ");
}

function detail(m: NamedCountMismatch): string {
  const removed = m.removed > 0 ? `, you removed ${m.removed}` : "";
  const gap = Math.abs(m.have - m.expected);
  const label = m.direction === "extra" ? `${gap} extra` : `${gap} missing`;
  return `Dex says ${m.dex}${removed}, you have ${m.have} (${label})`;
}

export function CountCheckPanel({ check }: { check: CountCheckView }) {
  if (check.status === "none") {
    return (
      <div className="panel" style={{ padding: 12, fontSize: 12 }} data-testid="count-check">
        <b>Count check:</b> no import checked yet. Import your Dex file and the app checks your
        collection against it from then on.
      </div>
    );
  }

  const sum = (
    <span>
      Dex file <b>{check.fileTotal}</b> = <b>{check.inCollection}</b> in your collection +{" "}
      <b>{check.waiting}</b> waiting to be matched + <b>{check.dismissed}</b> dismissed +{" "}
      <b>{check.removed}</b> you removed
    </span>
  );

  if (check.status === "ok") {
    return (
      <div className="panel" style={{ padding: 12, fontSize: 12 }} data-testid="count-check">
        <b>Your collection adds up to your Dex file.</b> {sum}.
      </div>
    );
  }

  const extra = check.mismatches.filter((m) => m.direction === "extra");
  const missing = check.mismatches.filter((m) => m.direction === "missing");
  return (
    <div
      className="panel"
      role="alert"
      style={{ padding: 12, fontSize: 12, background: "#FFD9DF", display: "grid", gap: 8 }}
      data-testid="count-check"
    >
      <b>Your collection does not add up to your Dex file.</b>
      <div>{sum}.</div>
      {check.mismatches.length > 0 ? (
        <div>
          <div style={{ marginBottom: 4 }}>
            {check.mismatches.length} card{check.mismatches.length === 1 ? "" : "s"} disagree
            {extra.length > 0 ? " — an extra copy usually means the same card was added twice" : ""}
            :
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
            {check.mismatches.map((m) => (
              <li key={`${m.catalogCardId}|${m.dexVariantRaw}`}>
                <b>{where(m)}</b>: {detail(m)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {check.ungroupedCopies > 0 ? (
        <div>
          {check.ungroupedCopies} card{check.ungroupedCopies === 1 ? " is" : "s are"} in your
          collection without a link to your Dex import, so the next import would count{" "}
          {check.ungroupedCopies === 1 ? "it" : "them"} a second time.
        </div>
      ) : null}
      {!check.fileAddsUp ? (
        <div>
          The saved record of your last Dex file no longer matches that file&apos;s total. Import
          the file again to refresh it.
        </div>
      ) : null}
      <div style={{ color: "var(--ink-2)" }}>
        What to do: {missing.length > 0 || !check.fileAddsUp ? "import your Dex file again; " : ""}
        {check.ungroupedCopies > 0
          ? "for a card not linked to your import, use Merge on its card page; "
          : ""}
        {extra.length > 0
          ? "an extra copy of a card from your import is a bug to report (UIL-100) — do not remove it, because removing records the card as traded away; "
          : ""}
        anything still listed after that, report it (UIL-100).
      </div>
    </div>
  );
}
