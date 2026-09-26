/**
 * A "use server" file may export ONLY async functions (and types, which compile away).
 *
 * Next checks this when it LOADS the file, at runtime, not at build: a string exported from app/login/actions.ts
 * (#333) built green, passed every unit test (vitest imports the file without Next's loader), and then threw
 * E352 — 'A "use server" file can only export async functions, found string.' — the moment she pressed "Send
 * link", taking /login down (2026-09-26). This scans every "use server" file under app/ and lib/ with the
 * TypeScript parser and fails on anything else exported, so the mistake fails CI instead of her sign-in.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOTS = ["app", "lib"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** True when the file's directive prologue says "use server" (a function-level directive does not count). */
function isUseServerFile(sf: ts.SourceFile): boolean {
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === "use server") return true;
  }
  return false;
}

const has = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

const isAsyncFn = (e: ts.Expression | undefined): boolean =>
  !!e &&
  (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) &&
  has(e, ts.SyntaxKind.AsyncKeyword);

/** Every export of a "use server" source that is not an async function or a type, as "line: text". */
export function useServerViolations(source: string, file = "x.ts"): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (!isUseServerFile(sf)) return [];
  const bad: string[] = [];
  const flag = (node: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    bad.push(`${line}: ${node.getText(sf).split("\n")[0]}`);
  };
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    if (ts.isExportDeclaration(st)) {
      // `export { x }`, `export * from`, re-exports: only a type-only form is safe.
      const typeOnly =
        st.isTypeOnly ||
        (!!st.exportClause &&
          ts.isNamedExports(st.exportClause) &&
          st.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) flag(st);
      continue;
    }
    if (ts.isExportAssignment(st)) {
      if (!isAsyncFn(st.expression)) flag(st); // `export default <not an async function>`
      continue;
    }
    if (!has(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(st)) {
      if (!has(st, ts.SyntaxKind.AsyncKeyword)) flag(st);
      continue;
    }
    if (ts.isVariableStatement(st)) {
      if (!st.declarationList.declarations.every((d) => isAsyncFn(d.initializer))) flag(st);
      continue;
    }
    if (ts.isModuleDeclaration(st) && has(st, ts.SyntaxKind.DeclareKeyword)) continue;
    flag(st); // class, enum, namespace, anything else
  }
  return bad;
}

describe('every "use server" file exports only async functions', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(path.join(process.cwd(), r)));
  const useServer = files.filter((f) =>
    isUseServerFile(ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true)),
  );

  it("finds the action files (so an empty scan cannot pass)", () => {
    const rel = useServer.map((f) => path.relative(process.cwd(), f));
    expect(rel).toContain(path.join("app", "login", "actions.ts"));
    expect(rel).toContain(path.join("app", "(ui)", "sync", "actions.ts"));
    expect(rel.length).toBeGreaterThanOrEqual(8);
  });

  it("no action file exports anything but an async function or a type", () => {
    const found = useServer.flatMap((f) =>
      useServerViolations(readFileSync(f, "utf8"), f).map(
        (v) => `${path.relative(process.cwd(), f)}:${v}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe("the guard itself", () => {
  const file = (body: string) => `"use server";\n\nimport { z } from "zod";\n\n${body}\n`;

  it("allows async functions, async arrows, types and type-only re-exports", () => {
    expect(
      useServerViolations(
        file(`export async function a() {}
export const b = async () => 1;
export const c = async function () {};
export type T = { ok: true };
export interface I { x: number }
export type { Other } from "./other";
export default async function d() {}`),
      ),
    ).toEqual([]);
  });

  it.each([
    ["the #333 string", 'export const RATE_LIMITED = "Too many sign-in emails";'],
    ["a sync function", "export function f() {}"],
    ["a sync arrow", "export const g = () => 1;"],
    ["a class", "export class K {}"],
    ["an enum", "export enum E { A }"],
    ["a local re-export", "const x = 1;\nexport { x };"],
    ["a star re-export", 'export * from "./other";'],
    ["a default value", "export default 42;"],
    ["an object", "export const o = { a: async () => {} };"],
  ])("refuses %s", (_, body) => {
    expect(useServerViolations(file(body))).toHaveLength(1);
  });

  it('ignores a file whose "use server" is not its directive (an inline action in a component)', () => {
    expect(
      useServerViolations(
        `import x from "y";\nexport const A = 1;\nasync function f() { "use server"; }`,
      ),
    ).toEqual([]);
  });
});
