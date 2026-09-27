/**
 * UIL-127b — band order and the type map are read in ONE place (the Tech Lead's C7; the UIL-012 lesson).
 *
 * Since 0033 her colours are per owner, and `colorBandRepo.listOrdered` / `typeColorMapRepo.list` (lib/repo/
 * config.ts) are the one read point: her rows, else the global defaults. A reader that went to `color_band` or
 * `type_color_map` directly would read the DEFAULTS while every other screen read HERS, which is exactly how
 * UIL-012 split the band key space. So:
 *   - no TypeScript outside lib/repo/config.ts names either table in a query;
 *   - no live SQL function body reads either table, except apply_write_ops' `set_band_order` / `set_type_band`,
 *     which read them to validate a key or to copy the defaults into her rows.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    if (statSync(full).isDirectory()) return n === "node_modules" ? [] : files(full, ext);
    return ext.test(n) ? [full] : [];
  });
}

describe("UIL-127b · TypeScript reads colours only through lib/repo/config.ts", () => {
  it("no other app or lib file queries color_band or type_color_map", () => {
    const offenders = [
      ...files(path.join(ROOT, "app"), /\.tsx?$/),
      ...files(path.join(ROOT, "lib"), /\.tsx?$/),
    ]
      .filter((f) => path.relative(ROOT, f) !== path.join("lib", "repo", "config.ts"))
      .filter((f) => /\.from\(\s*["'](color_band|type_color_map)["']/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("config.ts itself still reads her rows first (so the scan above is not vacuous)", () => {
    const src = readFileSync(path.join(ROOT, "lib", "repo", "config.ts"), "utf8");
    expect(src).toMatch(/from\("owner_band_order"\)/);
    expect(src).toMatch(/from\("owner_type_band"\)/);
  });
});

describe("UIL-127b · no SQL function reads the GLOBAL colour tables outside the two writes that must", () => {
  const DIR = path.join(ROOT, "supabase", "migrations");
  const FILES = readdirSync(DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  /** The body each function runs today: its last definition across the migrations. */
  function liveBodies(): Map<string, string> {
    const live = new Map<string, string>();
    const re =
      /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(([^)]*)\)[\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\3/gi;
    for (const f of FILES) {
      for (const m of readFileSync(path.join(DIR, f), "utf8").matchAll(re))
        live.set(m[1].toLowerCase(), m[4]);
    }
    return live;
  }

  /** A read of the table as a relation: `from|join color_band`, not a `color_band` column. */
  const READ = /\b(from|join)\s+(color_band|type_color_map)\b/gi;

  it("every such read is inside set_band_order or set_type_band", () => {
    const found: string[] = [];
    for (const [name, body] of liveBodies()) {
      // Cut the body into its `when '<op>' then` branches, so a read is attributed to the branch it sits in.
      const parts = body.split(/\n\s*when '(\w+)' then/);
      for (let i = 0; i < parts.length; i += 2) {
        const branch = i === 0 ? "(head)" : parts[i - 1];
        for (const m of parts[i].matchAll(READ)) found.push(`${name}:${branch}:${m[0]}`);
      }
    }
    const outside = found.filter(
      (f) => !/^apply_write_ops:(set_band_order|set_type_band):/.test(f),
    );
    expect(outside).toEqual([]);
    expect(found.length).toBeGreaterThan(0);
  });
});
