/**
 * UIL-119 — no Haul Plan path writes a wish (Karvi's ruling: an empty line stage goes on her wishlist only when
 * SHE adds it; the Tech Lead's review asked for this net).
 *
 * The behavioural tests in no-auto-wish.test.ts pin the two writers the Haul Plan has today. This one pins that no
 * NEW path grows a wish: it walks every module the Haul Plan's screen and server actions import, transitively, and
 * fails on any that BUILDS an `insert_wishlist` op.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENTRIES = ["app/(ui)/plan/page.tsx", "app/(ui)/plan/actions.ts"];

/** An import specifier as a repo file, or null for a package. */
function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? spec.slice(2)
    : spec.startsWith(".")
      ? path.join(path.dirname(from), spec)
      : null;
  if (base === null) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return path.normalize(c);
  }
  return null;
}

function importsOf(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      !(ts.isImportDeclaration(n) && n.importClause?.isTypeOnly)
    ) {
      out.push(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every repo module the Haul Plan loads. */
function planModules(): string[] {
  const seen = new Set<string>();
  const queue = ENTRIES.map((e) => path.normalize(e));
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(f, readFileSync(f, "utf8"))) {
      const r = resolve(f, spec);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  return [...seen].sort();
}

/**
 * True when a source BUILDS a wish op: an object literal `{ op: "insert_wishlist" }`, however the value is wrapped
 * (`as const`, `satisfies`, parentheses; QA's A2 mutant on #397) and whether the key is quoted or not. The op's type
 * (a property signature in lib/repo/write-ops.ts) and a count (`o.op === "insert_wishlist"`) are not. Out of scope:
 * a value held in a variable first (`const kind = "insert_wishlist"; ({ op: kind })`), which no writer here does.
 */
function buildsAWishIn(source: string, file = "x.ts"): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)
      ? unwrap(e.expression)
      : e;
  let found = false;
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.name.text === "op"
    ) {
      const v = unwrap(n.initializer);
      if (ts.isStringLiteralLike(v) && v.text === "insert_wishlist") found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
const buildsAWish = (file: string) => buildsAWishIn(readFileSync(file, "utf8"), file);

describe("UIL-119 · no Haul Plan path writes a wish", () => {
  const modules = planModules();

  it("walks the Haul Plan's real writers (a sanity check on the walk itself)", () => {
    expect(modules).toEqual(
      expect.arrayContaining([
        path.normalize("lib/plan/commit.ts"),
        path.normalize("lib/line/line-choice.ts"),
        path.normalize("lib/line/write.ts"),
      ]),
    );
  });

  it("no module it loads builds an insert_wishlist op", () => {
    const offenders = modules.filter(buildsAWish);
    // PRE-FIX: lib/plan/commit.ts (writeNewLine's loop, one wish per empty stage of a line it started).
    expect(offenders).toEqual([]);
  });

  it("sees a wish op however its value is written, and not its type or a count (QA's A2 on #397)", () => {
    for (const src of [
      `ops.push({ op: "insert_wishlist", line_slot_id: null });`,
      `ops.push({ op: "insert_wishlist" as const });`,
      `ops.push({ op: "insert_wishlist" satisfies string });`,
      `ops.push({ op: ("insert_wishlist") });`,
      `ops.push({ "op": "insert_wishlist" });`,
      "ops.push({ op: `insert_wishlist` });",
    ]) {
      expect(buildsAWishIn(src), src).toBe(true);
    }
    for (const src of [
      `type W = { op: "insert_wishlist"; line_slot_id: string | null };`,
      `const n = ops.filter((o) => o.op === "insert_wishlist").length;`,
      `ops.push({ op: "insert_slot" as const });`,
    ]) {
      expect(buildsAWishIn(src), src).toBe(false);
    }
  });
});
