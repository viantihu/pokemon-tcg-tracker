#!/usr/bin/env node
/**
 * Fails a PR that adds a migration sorting BEHIND one already on the base branch.
 *
 * Supabase applies migrations in filename order and `supabase db push` refuses to
 * insert a local migration that sorts before the last version in the remote
 * history table. So a PR that adds 0003_* after 0004_* has already shipped does
 * not break CI — it breaks every future deploy, silently, until someone resets
 * the database. That happened once (PR #13 vs the already-pushed 0004) and cost
 * 18 consecutive red Deploy runs. This is the guard for it.
 *
 * Usage: node scripts/check-migration-order.mjs [baseRef]   (default origin/develop)
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const DIR = "supabase/migrations";
const baseRef = process.argv[2] ?? "origin/develop";

/** Leading numeric version of a migration filename, e.g. "0004_catalog_artwork.sql" -> 4. */
function version(file) {
  const match = /^(\d+)_/.exec(file);
  return match ? Number(match[1]) : null;
}

function migrationsAt(ref) {
  const out = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", DIR], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(DIR.length + 1))
    .filter((file) => file.endsWith(".sql"));
}

const local = readdirSync(DIR).filter((file) => file.endsWith(".sql"));
const base = migrationsAt(baseRef);

const errors = [];

const unversioned = local.filter((file) => version(file) === null);
if (unversioned.length > 0) {
  errors.push(`migrations must start with a numeric version: ${unversioned.join(", ")}`);
}

const seen = new Map();
for (const file of local) {
  const v = version(file);
  if (v === null) continue;
  if (seen.has(v)) errors.push(`duplicate migration version ${v}: ${seen.get(v)} and ${file}`);
  else seen.set(v, file);
}

const baseVersions = base.map(version).filter((v) => v !== null);
const highestOnBase = baseVersions.length > 0 ? Math.max(...baseVersions) : 0;
const added = local.filter((file) => !base.includes(file));

for (const file of added) {
  const v = version(file);
  if (v !== null && v <= highestOnBase) {
    errors.push(
      `${file} sorts at or behind ${highestOnBase}, the highest migration already on ${baseRef}. ` +
        `Migrations are forward-only: renumber it above ${highestOnBase}.`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}

console.log(
  added.length > 0
    ? `Migration order OK — added ${added.join(", ")} above ${highestOnBase} on ${baseRef}.`
    : `Migration order OK — no new migrations vs ${baseRef}.`,
);
