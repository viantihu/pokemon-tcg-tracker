/**
 * UIL-128 — the tour's dock must never take a tap meant for the page (the UX Dev's must-fix on #414).
 *
 * Hidden, the dock keeps its full width while the pill beside it is 180px, and that transparent strip swallowed
 * "Leave for later" at 375. jsdom cannot hit-test, so the real-page measurement stays the proof; this pins the rule
 * that makes it true, so a later CSS refactor cannot quietly bring the dead zone back. The dom test pins that the
 * card and the pill render inside `.tour-dock`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

/** The body of the FIRST top-level rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const m = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[2];
}

describe("UIL-128 · the dock is click-through; only its card or pill takes taps", () => {
  it(".tour-dock sets pointer-events: none", () => {
    expect(ruleBody(".tour-dock")).toMatch(/pointer-events:\s*none/);
  });

  it(".tour-dock > * sets pointer-events back to auto", () => {
    expect(ruleBody(".tour-dock > *")).toMatch(/pointer-events:\s*auto/);
  });
});
