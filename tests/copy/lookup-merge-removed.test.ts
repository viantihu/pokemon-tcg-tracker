/**
 * UIL-103 — Lookup's "Same card" merge is gone, and nothing still reaches for it. Static scan over app/,
 * lib/ and scripts/.
 *
 * Karvi's ruling: remove it; re-importing is the repair path for a double. The merge joined a copy typed by
 * hand (in no presence group) to its Dex twin. Since 0023 every copy carries its group, so the button could
 * never appear again and the server side could only refuse. This pins the removal at the source: a later
 * change that brings back any piece of it (the action, the server core, its ops builder, its refusals, the
 * client flag that only it read, or the words on screen) fails here and has to be argued for again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCANNED = ["app", "lib", "scripts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = SCANNED.flatMap((d) => sourceFiles(path.join(ROOT, d))).map((f) => ({
  rel: path.relative(ROOT, f).split(path.sep).join("/"),
  src: readFileSync(f, "utf8"),
}));

/** Every name the merge had, and the words it put on screen. */
const REMOVED: [string, RegExp][] = [
  ["the server action", /\bmergeCopies\b/],
  ["the server core", /\bapplyCopyMerge\b/],
  ["its ops builder", /\bbuildMergeCopiesOps\b/],
  ["its plan type", /\bMergeCopiesPlan\b/],
  ["its outcome type", /\bMergeCopiesOutcome\b/],
  ["its refusals", /\bMERGE_REFUSALS\b/],
  ["the screen's offer rule", /\bmergeableTwinOf\b/],
  ["the screen's handler", /\bonMerge\b/],
  ["the client flag only the merge read", /\bdexTracked\b/],
  ["the button", /["'>]\s*Same card\s*[<"']/],
  ["the count check's pointer to it", /use Merge/],
];

describe("UIL-103 · Lookup's merge is removed, and nothing calls it", () => {
  it("the scan actually sees the code (guards a vacuous pass)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel === "app/(ui)/look/LookupScreen.tsx")).toBe(true);
    expect(FILES.some((f) => f.rel === "lib/copy/remove.ts")).toBe(true);
  });

  for (const [what, pattern] of REMOVED) {
    it(`no source names ${what} (${pattern})`, () => {
      expect(FILES.filter((f) => pattern.test(f.src)).map((f) => f.rel)).toEqual([]);
    });
  }

  it("removing one copy still works the way it did: its own action and core are untouched", () => {
    const actions = FILES.find((f) => f.rel === "app/(ui)/look/actions.ts")!.src;
    const core = FILES.find((f) => f.rel === "lib/copy/remove.ts")!.src;
    expect(actions).toMatch(/export async function removeCopy\(/);
    expect(core).toMatch(/export async function applyCopyRemoval\(/);
  });
});
