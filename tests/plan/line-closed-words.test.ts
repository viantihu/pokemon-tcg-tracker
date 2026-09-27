/**
 * UIL-120 after UIL-121 — the Haul Plan's toast says what the Lines screen's badge says (the Senior BA's ruling): a
 * finished line reads ◆ CLOSED there, and a line she declined is closed without being complete, so the toast says
 * "Line closed", never "Line complete". Pinned on the source of both, so one cannot change its word alone.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const plan = readFileSync("app/(ui)/plan/PlanScreen.tsx", "utf8");
const lines = readFileSync("app/(ui)/line/LineScreen.tsx", "utf8");

describe("the toast's word is the badge's word", () => {
  it("the Lines badge for a closed line, and the toast, both say CLOSED", () => {
    const badge = /closed:\s*"◆ (\w+)"/.exec(lines)?.[1];
    expect(badge).toBe("CLOSED");
    const toasts = [...plan.matchAll(/`Line (\w+) · \$\{[^}]+\} line`|"Line (\w+)"/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(toasts.length).toBeGreaterThan(0);
    for (const word of toasts) expect(word.toUpperCase()).toBe(badge);
    expect(plan).not.toMatch(/Line complete/);
  });
});
