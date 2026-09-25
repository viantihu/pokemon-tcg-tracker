/**
 * UIL-098 — only the Dex import creates a copy. Static allow-list over app/ and lib/.
 *
 * Karvi: "The only way inventory can be added is through the dex sync or a manual add" — and the manual
 * add is the Sync page's manual match of a Dex row. Every copy comes from a Dex row, because presence is
 * reconciled through presence groups: a copy made anywhere else is in no group, so the next import cannot
 * see it and creates a second one when Dex lists the card. The Haul Plan (#327), Collections (#319) and
 * Backfill (this PR) each created copies by hand; all three now place or wishlist instead.
 *
 * This pins it at the source, so a new screen cannot quietly become a fourth creator:
 *   - `insert_copy` may be EMITTED only in lib/sync/exec.ts (the import, Retry, Undo, the manual match);
 *   - every other file that so much as names it is on the list below, with the reason it is allowed;
 *   - the direct-insert shapes that would skip `insert_copy` entirely are allowed nowhere (the Tech
 *     Lead's addition: `createRepo` hands `copyRepo` an `insert`/`insertMany` for free).
 *
 * The database guard is the Tech Lead's migration 0023 (`copy.presence_group_id` NOT NULL); it extends
 * this list rather than adding a second one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCANNED = ["app", "lib"];

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

/** The one file allowed to emit the op. */
const EMITTER = "lib/sync/exec.ts";

/** Every file allowed to NAME the op, and why. Adding one here is a decision the Tech Lead reviews. */
const MAY_NAME: Record<string, string> = {
  "lib/sync/exec.ts": "emits it: the import, Retry, Undo and the Sync page's manual match",
  "lib/repo/write-ops.ts": "declares the op's type for apply_write_ops",
  "lib/plan/commit.ts": "reads it, in the colour-band guard over a payload, and emits none",
};

/** `op: "insert_copy",` — an op object being built, not a type or a comparison. */
const EMITS = /\bop\s*:\s*["']insert_copy["']\s*,/;

describe("UIL-098 · only the Dex import creates a copy", () => {
  it("the scan actually sees the code (guards a vacuous pass)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel === EMITTER)).toBe(true);
  });

  it(`insert_copy is emitted only in ${EMITTER}`, () => {
    const emitters = FILES.filter((f) => EMITS.test(f.src)).map((f) => f.rel);
    expect(emitters).toEqual([EMITTER]);
  });

  it("every file that names insert_copy is on the allow-list, with its reason", () => {
    const naming = FILES.filter((f) => f.src.includes("insert_copy")).map((f) => f.rel);
    expect(naming.sort()).toEqual(Object.keys(MAY_NAME).sort());
  });

  it("nothing inserts a copy directly, around apply_write_ops", () => {
    const direct = FILES.filter((f) => {
      const s = f.src.replace(/\s+/g, "");
      return (
        s.includes('.from("copy").insert(') ||
        s.includes('.from("copy").upsert(') ||
        s.includes(".from('copy').insert(") ||
        s.includes(".from('copy').upsert(") ||
        s.includes("copyRepo.insert(") ||
        s.includes("copyRepo.insertMany(")
      );
    }).map((f) => f.rel);
    expect(direct).toEqual([]);
  });
});
