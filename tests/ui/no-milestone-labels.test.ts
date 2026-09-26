/**
 * UIL-116 — no build-milestone label (M1 … M12, the dev-spec's phases) in anything she can see.
 *
 * "resolve in Lines · M7", "Confirm-or-override lands in Lines (M7)" and a Lookup tag "LINE · M7" all reached
 * her screens: the milestone was the author's name for a screen, never hers. A source scan over app/, with
 * comments stripped first (they are full of milestone references, and those are for us), so a label can
 * only fail here by being in code that renders.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx|ts)$/.test(n) ? [full] : [];
  });
}

/** Source with block, JSX and line comments removed. Crude, and enough: no string here holds a slash-star. */
function withoutComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const MILESTONE = /\bM(1[0-2]|[1-9])\b/;
const FILES = files(path.join(process.cwd(), "app")).map((f) => ({
  rel: path.relative(process.cwd(), f),
  code: withoutComments(readFileSync(f, "utf8")),
}));

describe("UIL-116 · no milestone label reaches her screens", () => {
  it("the scan sees the screens (guards a vacuous pass)", () => {
    expect(FILES.some((f) => f.rel.endsWith("PlanScreen.tsx"))).toBe(true);
    expect(FILES.length).toBeGreaterThan(40);
  });

  it("no rendered code in app/ names a build milestone", () => {
    const hits = FILES.flatMap((f) =>
      f.code
        .split("\n")
        .map((line, i) => ({ where: `${f.rel}:${i + 1}`, line }))
        .filter((l) => MILESTONE.test(l.line)),
    );
    expect(hits).toEqual([]);
  });
});
