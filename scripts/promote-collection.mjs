#!/usr/bin/env node
/**
 * Promotes the real collection from the Testing database to Production at go-live.
 *
 * Why this exists: the plan is to enter the real collection against Testing while
 * Production is still being stood up, then move it across once. That is safe here
 * for three structural reasons, all verified against supabase/migrations:
 *
 *   1. Every primary key is `uuid default gen_random_uuid()` (0002_domain.sql). There
 *      are no sequences to reset, and UUIDs are globally unique, so ids copy over
 *      verbatim and every foreign key between the copied rows stays intact.
 *   2. There is no Supabase Storage in this app. Artwork is a perceptual-hash column
 *      on catalog_card, not a blob. Everything owned is rows.
 *   3. Production's schema is defined entirely by migrations, so it can be brought to
 *      byte-identical shape before any data moves.
 *
 * THE FAILURE MODE THIS SCRIPT EXISTS TO PREVENT: `owner_id` is `default auth.uid()`
 * with an RLS policy (`owner_all`), but it has NO foreign key to auth.users. The
 * Testing user uuid and the Production user uuid are different. A plain pg_dump /
 * pg_restore therefore inserts every row successfully, reports zero errors, and then
 * the production app shows an empty collection forever, because RLS filters on a uuid
 * that never matches the login. Every owner-scoped row here is rewritten to the
 * PRODUCTION owner uuid on the way in, and the script refuses to run until it can
 * resolve exactly one such uuid from production's auth.users.
 *
 * Two other traps, handled below:
 *   * `copy` and `line_slot` reference each other (0002 lines 160/177/186). Neither FK
 *     is DEFERRABLE, so the copy is two-pass: insert `copy` with line_slot_id NULL,
 *     insert `line_slot`, then patch line_slot_id back. Nothing about production's
 *     schema is altered to make this work — migrations stay the only thing that
 *     changes schema.
 *   * color_band + type_color_map ship via migration 0003, so production already has
 *     them and copying would collide; last_sync_snapshot is one sync's undo state, and
 *     carrying it over would make the first production "undo" try to roll back a
 *     Testing-era sync. All three are excluded on purpose (see EXCLUDED).
 *
 * Everything runs inside one transaction on production: it either all lands or none
 * of it does.
 *
 * Usage:
 *   TESTING_DB_URL=postgres://... PROD_DB_URL=postgres://... \
 *     node scripts/promote-collection.mjs --dry-run
 *   ... node scripts/promote-collection.mjs --owner-email=her@example.com
 *
 * Connection strings are the Supabase "direct connection" URIs (Project Settings ->
 * Database). The direct URI, not the pooler: the pooler's transaction mode cannot hold
 * the multi-statement transaction this needs.
 *
 * Flags:
 *   --dry-run              read + check everything, write nothing (default off)
 *   --owner-email=<email>  resolve the production owner from auth.users by email
 *                          (defaults to $ALLOWED_OWNER_EMAIL, the app's allow-list)
 *   --target-owner=<uuid>  skip email lookup and use this production owner uuid
 *   --source-owner=<uuid>  which Testing owner to promote (required only if Testing
 *                          holds rows for more than one owner, e.g. seed + real data)
 *   --allow-nonempty       proceed even though production already holds owner rows.
 *                          Off by default: a second run would duplicate everything.
 *
 * The core is exported so tests/repo/promote-collection.test.ts can drive it against
 * two fresh PGlite databases (the project's standing pattern — Docker is unavailable).
 */

/**
 * Shared, non-owner tables. Testing is authoritative: its catalog is what the copies
 * were reconciled against, and its learned set aliases are what its syncs produced.
 * Upserted rather than inserted so a partially-mirrored production catalog is fine.
 */
export const SHARED_TABLES = [
  { table: "catalog_card", conflict: ["tcgdex_id"] },
  { table: "set_alias", conflict: ["locale", "dex_code"] },
];

/**
 * Owner-scoped tables, in foreign-key-safe insert order. `copy` lands before
 * `line_slot` with line_slot_id held back (see the two-pass note in the header).
 */
export const OWNER_TABLES = [
  "haul",
  "binder",
  "collection",
  "presence_group",
  "evolution_line",
  "copy",
  "line_slot",
  "wishlist_item",
  "binder_block",
  "placement_decision",
  "unresolved_entry",
];

/** Deliberately not copied. Keyed by table -> the reason, printed in the plan. */
export const EXCLUDED = {
  color_band: "ships via migration 0003; production already has it",
  type_color_map: "ships via migration 0003; production already has it",
  last_sync_snapshot:
    "one sync's undo state; carrying it over would let production's first undo roll back a Testing sync",
  binder_section: "a view, created by migration 0002",
};

/** The circular reference: held back on insert, patched after line_slot lands. */
const DEFERRED = { table: "copy", column: "line_slot_id" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised for every expected, actionable failure so the CLI can print it without a stack. */
export class PromotionError extends Error {}

function fail(message) {
  throw new PromotionError(message);
}

/** node-postgres reports `rowCount`; PGlite reports `affectedRows`. */
function affected(result) {
  return result?.rowCount ?? result?.affectedRows ?? 0;
}

// -----------------------------------------------------------------------------
// Introspection
// -----------------------------------------------------------------------------

/** Applied migration versions, oldest first, from Supabase's own history table. */
async function migrationHistory(client) {
  const { rows } = await client.query(
    `select version from supabase_migrations.schema_migrations order by version`,
  );
  return rows.map((r) => r.version);
}

/** table -> [{ column, isJson }] for the public schema, in ordinal order. */
async function columnsByTable(client) {
  const { rows } = await client.query(
    `select table_name, column_name, data_type
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.table_name)) map.set(row.table_name, []);
    map.get(row.table_name).push({
      column: row.column_name,
      isJson: row.data_type === "json" || row.data_type === "jsonb",
    });
  }
  return map;
}

/**
 * Resolves the single production owner uuid. Refuses to guess: zero matches means the
 * production app has never been logged into (the uuid does not exist to remap onto),
 * and more than one means the allow-list is not doing what this script assumes.
 */
async function resolveTargetOwner(client, options) {
  if (options.targetOwner) {
    if (!UUID_RE.test(options.targetOwner)) {
      fail(`--target-owner is not a uuid: ${options.targetOwner}`);
    }
    const { rows } = await client.query(`select id from auth.users where id = $1`, [
      options.targetOwner,
    ]);
    if (rows.length === 0)
      fail(`--target-owner ${options.targetOwner} is not a user in production`);
    return options.targetOwner;
  }

  const email = (options.ownerEmail ?? "").trim().toLowerCase();
  if (!email) {
    fail(
      "no production owner given. Pass --owner-email=<email> (the app's ALLOWED_OWNER_EMAIL) or --target-owner=<uuid>.",
    );
  }

  const { rows } = await client.query(`select id from auth.users where lower(email) = $1`, [email]);
  if (rows.length === 0) {
    fail(
      `no production auth.users row for ${email}. Log into the production app once with the magic ` +
        `link first — the uuid has to exist before the collection can be remapped onto it.`,
    );
  }
  if (rows.length > 1) fail(`${rows.length} production users match ${email}; pass --target-owner`);
  return rows[0].id;
}

/** Distinct owner_ids present in Testing's owner-scoped tables, with row counts. */
async function findSourceOwners(client) {
  const unions = OWNER_TABLES.map(
    (t) => `select owner_id, count(*)::int as n from public."${t}" group by owner_id`,
  ).join(" union all ");
  const { rows } = await client.query(
    `select owner_id, sum(n)::int as rows from (${unions}) all_rows group by owner_id order by 2 desc`,
  );
  return rows;
}

async function rowCounts(client, tables) {
  const counts = new Map();
  for (const table of tables) {
    const { rows } = await client.query(`select count(*)::int as n from public."${table}"`);
    counts.set(table, Number(rows[0].n));
  }
  return counts;
}

// -----------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------

/**
 * Chunked, parameterized multi-row insert. Chunk size is derived from the column count
 * so a wide table cannot blow past Postgres' 65535-parameter ceiling.
 */
async function insertRows(client, table, columns, rows, { conflict, upsert } = {}) {
  if (rows.length === 0) return 0;

  const names = columns.map((c) => c.column);
  const quoted = names.map((n) => `"${n}"`).join(", ");
  const chunkSize = Math.max(1, Math.floor(30000 / names.length));

  let suffix = "";
  if (conflict) {
    const target = conflict.map((c) => `"${c}"`).join(", ");
    const sets = names
      .filter((n) => !conflict.includes(n))
      .map((n) => `"${n}" = excluded."${n}"`)
      .join(", ");
    suffix =
      upsert && sets
        ? ` on conflict (${target}) do update set ${sets}`
        : ` on conflict (${target}) do nothing`;
  }

  let inserted = 0;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((col) => {
        const raw = row[col.column];
        // jsonb has to be handed over as text: the driver would otherwise render a JS
        // array as a Postgres array literal, which is not valid json.
        values.push(col.isJson && raw !== null && raw !== undefined ? JSON.stringify(raw) : raw);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    const result = await client.query(
      `insert into public."${table}" (${quoted}) values ${tuples.join(", ")}${suffix}`,
      values,
    );
    inserted += affected(result);
  }
  return inserted;
}

/** Patches the held-back circular FK once both sides exist. */
async function patchDeferred(client, copyRows) {
  const pending = copyRows.filter(
    (r) => r[DEFERRED.column] !== null && r[DEFERRED.column] !== undefined,
  );
  if (pending.length === 0) return 0;

  const result = await client.query(
    `update public."${DEFERRED.table}" as t
        set "${DEFERRED.column}" = patch.target
       from unnest($1::uuid[], $2::uuid[]) as patch(id, target)
      where t.id = patch.id`,
    [pending.map((r) => r.id), pending.map((r) => r[DEFERRED.column])],
  );
  return affected(result);
}

// -----------------------------------------------------------------------------
// Core
// -----------------------------------------------------------------------------

/**
 * Runs the promotion. `source` and `target` are anything with a node-postgres-shaped
 * `query(sql, params) -> { rows }` — the CLI passes pg.Client, the tests pass PGlite.
 * Returns a report; throws PromotionError on any preflight failure, having written
 * nothing.
 *
 * @param {object} options
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any> }} options.source
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any> }} options.target
 * @param {string} [options.ownerEmail]
 * @param {string} [options.targetOwner]
 * @param {string} [options.sourceOwner]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.allowNonempty]
 * @param {(message: string) => void} [options.log]
 */
export async function promoteCollection({
  source,
  target,
  ownerEmail,
  targetOwner,
  sourceOwner,
  dryRun = false,
  allowNonempty = false,
  log = () => {},
}) {
  log("Preflight");

  // --- Schemas must be the same shape. ---------------------------------------
  const [sourceMigrations, targetMigrations] = await Promise.all([
    migrationHistory(source),
    migrationHistory(target),
  ]);
  if (sourceMigrations.join(",") !== targetMigrations.join(",")) {
    const missing = sourceMigrations.filter((v) => !targetMigrations.includes(v));
    const extra = targetMigrations.filter((v) => !sourceMigrations.includes(v));
    fail(
      `migration histories differ, so the schemas are not the same shape.\n` +
        `  Testing:    ${sourceMigrations.join(", ") || "(none)"}\n` +
        `  Production: ${targetMigrations.join(", ") || "(none)"}\n` +
        (missing.length ? `  Production is MISSING: ${missing.join(", ")}\n` : "") +
        (extra.length ? `  Production has EXTRA: ${extra.join(", ")}\n` : "") +
        `  Fix: get main green and let Deploy push migrations to Production first.`,
    );
  }
  log(`  migrations match on both sides (${targetMigrations.length} applied)`);

  const [sourceColumns, targetColumns] = await Promise.all([
    columnsByTable(source),
    columnsByTable(target),
  ]);

  const allTables = [...SHARED_TABLES.map((s) => s.table), ...OWNER_TABLES];
  for (const table of allTables) {
    const from = sourceColumns.get(table);
    const to = targetColumns.get(table);
    if (!from) fail(`table ${table} does not exist in Testing`);
    if (!to) fail(`table ${table} does not exist in Production`);
    const present = new Set(to.map((c) => c.column));
    const missing = from.map((c) => c.column).filter((n) => !present.has(n));
    if (missing.length > 0) {
      fail(`Production's ${table} is missing column(s) present in Testing: ${missing.join(", ")}`);
    }
  }
  log(`  ${allTables.length} tables have matching columns`);

  // --- Resolve both owners. --------------------------------------------------
  const resolvedTarget = await resolveTargetOwner(target, { ownerEmail, targetOwner });
  log(`  production owner resolved: ${resolvedTarget}`);

  const sourceOwners = await findSourceOwners(source);
  if (sourceOwners.length === 0) fail("Testing holds no owner-scoped rows; nothing to promote");

  let resolvedSource;
  if (sourceOwner) {
    if (!UUID_RE.test(sourceOwner)) fail(`--source-owner is not a uuid: ${sourceOwner}`);
    if (!sourceOwners.some((o) => o.owner_id === sourceOwner)) {
      fail(`--source-owner ${sourceOwner} owns no rows in Testing`);
    }
    resolvedSource = sourceOwner;
  } else if (sourceOwners.length > 1) {
    const listing = sourceOwners.map((o) => `    ${o.owner_id}  ${o.rows} rows`).join("\n");
    fail(
      `Testing holds rows for ${sourceOwners.length} owners, so the real collection is ambiguous ` +
        `(the seed uses 00000000-0000-0000-0000-000000000001). Pass --source-owner=<uuid>:\n${listing}`,
    );
  } else {
    resolvedSource = sourceOwners[0].owner_id;
  }
  const sourceTotal = sourceOwners.find((o) => o.owner_id === resolvedSource)?.rows ?? 0;
  log(`  testing owner to promote: ${resolvedSource} (${sourceTotal} rows total)`);

  if (resolvedSource === resolvedTarget) {
    log("  note: source and target owner uuids are identical; no remap needed");
  }

  // --- Production must be virgin, or this is not idempotent. ------------------
  const before = await rowCounts(target, OWNER_TABLES);
  const occupied = [...before].filter(([, n]) => n > 0);
  if (occupied.length > 0 && !allowNonempty) {
    fail(
      `Production already holds owner rows, and this script is not idempotent — a second run ` +
        `would duplicate the collection:\n` +
        occupied.map(([t, n]) => `    ${t}: ${n}`).join("\n") +
        `\n  Fix: promote into a virgin Production, or pass --allow-nonempty if you are certain.`,
    );
  }
  log("  production owner tables are empty");

  // --- Read everything from Testing. -----------------------------------------
  log("\nReading from Testing");
  const payload = new Map();

  for (const { table } of SHARED_TABLES) {
    const { rows } = await source.query(`select * from public."${table}"`);
    payload.set(table, rows);
    log(`  ${table.padEnd(20)} ${String(rows.length).padStart(6)} rows`);
  }

  for (const table of OWNER_TABLES) {
    const { rows } = await source.query(`select * from public."${table}" where owner_id = $1`, [
      resolvedSource,
    ]);
    // The remap that makes the collection visible under the production login.
    for (const row of rows) row.owner_id = resolvedTarget;
    payload.set(table, rows);
    log(`  ${table.padEnd(20)} ${String(rows.length).padStart(6)} rows`);
  }

  for (const [table, reason] of Object.entries(EXCLUDED)) {
    log(`  ${table.padEnd(20)} ${"skipped".padStart(6)}  — ${reason}`);
  }

  const plan = {
    sourceOwner: resolvedSource,
    targetOwner: resolvedTarget,
    counts: Object.fromEntries([...payload].map(([t, rows]) => [t, rows.length])),
  };

  if (dryRun) {
    log("\n--dry-run: every check passed and nothing was written.");
    return { ...plan, dryRun: true, written: false };
  }

  // --- Write to Production, all or nothing. ----------------------------------
  log("\nWriting to Production (single transaction)");
  await target.query("begin");
  try {
    for (const { table, conflict } of SHARED_TABLES) {
      const n = await insertRows(target, table, sourceColumns.get(table), payload.get(table), {
        conflict,
        upsert: true,
      });
      log(`  ${table.padEnd(20)} ${String(n).padStart(6)} upserted`);
    }

    const copyRows = payload.get(DEFERRED.table);
    for (const table of OWNER_TABLES) {
      let columns = sourceColumns.get(table);
      if (table === DEFERRED.table) {
        // Pass 1 of the circular FK: hold the column back entirely.
        columns = columns.filter((c) => c.column !== DEFERRED.column);
      }
      const n = await insertRows(target, table, columns, payload.get(table));
      log(`  ${table.padEnd(20)} ${String(n).padStart(6)} inserted`);

      if (table === "line_slot") {
        // Pass 2: both sides now exist, so the held-back FK can be closed.
        const patched = await patchDeferred(target, copyRows);
        log(
          `  ${`${DEFERRED.table}.${DEFERRED.column}`.padEnd(20)} ${String(patched).padStart(6)} patched`,
        );
      }
    }

    await target.query("commit");
  } catch (error) {
    await target.query("rollback");
    throw error;
  }

  // --- Verify what actually landed. -----------------------------------------
  log("\nVerifying");
  const after = await rowCounts(target, OWNER_TABLES);
  const mismatches = [];
  for (const table of OWNER_TABLES) {
    const expected = payload.get(table).length + (before.get(table) ?? 0);
    const actual = after.get(table);
    if (expected !== actual) mismatches.push({ table, expected, actual });
    log(
      `  ${expected === actual ? "ok  " : "FAIL"} ${table.padEnd(20)} expected ${expected}, got ${actual}`,
    );
  }

  const { rows: visible } = await target.query(
    `select count(*)::int as n from public.copy where owner_id = $1`,
    [resolvedTarget],
  );
  log(`  ${visible[0].n} copies owned by ${resolvedTarget}`);

  if (mismatches.length > 0) {
    fail(
      `row counts do not match after commit; investigate before using production:\n` +
        mismatches.map((m) => `    ${m.table}: expected ${m.expected}, got ${m.actual}`).join("\n"),
    );
  }

  log("\nPromotion complete.");
  return { ...plan, dryRun: false, written: true, visibleCopies: Number(visible[0].n) };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { dryRun: false, allowNonempty: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--allow-nonempty") options.allowNonempty = true;
    else if (arg.startsWith("--owner-email=")) options.ownerEmail = arg.slice(14);
    else if (arg.startsWith("--target-owner=")) options.targetOwner = arg.slice(15);
    else if (arg.startsWith("--source-owner=")) options.sourceOwner = arg.slice(15);
    else throw new PromotionError(`unknown argument: ${arg}`);
  }
  return options;
}

async function cli() {
  const pg = (await import("pg")).default;

  // Lossless reads. node-postgres parses date/timestamp into JS Date by default, which
  // round-trips a `date` through the local timezone and can shift haul.date by a day.
  // Keep every temporal type as the raw string Postgres sent.
  pg.types.setTypeParser(1082, (v) => v); // date
  pg.types.setTypeParser(1114, (v) => v); // timestamp
  pg.types.setTypeParser(1184, (v) => v); // timestamptz

  const options = parseArgs(process.argv.slice(2));
  options.ownerEmail ??= process.env.ALLOWED_OWNER_EMAIL;

  const testingUrl = process.env.TESTING_DB_URL;
  const prodUrl = process.env.PROD_DB_URL;
  if (!testingUrl) {
    throw new PromotionError(
      "TESTING_DB_URL is not set (Supabase Testing -> direct connection URI)",
    );
  }
  if (!prodUrl) {
    throw new PromotionError(
      "PROD_DB_URL is not set (Supabase Production -> direct connection URI)",
    );
  }
  if (testingUrl === prodUrl) {
    throw new PromotionError("TESTING_DB_URL and PROD_DB_URL point at the same database");
  }

  const source = new pg.Client({ connectionString: testingUrl });
  const target = new pg.Client({ connectionString: prodUrl });
  await source.connect();
  await target.connect();
  try {
    await promoteCollection({ ...options, source, target, log: (m) => console.log(m) });
  } finally {
    await source.end();
    await target.end();
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  cli().catch((error) => {
    console.error(error instanceof PromotionError ? `error: ${error.message}` : error);
    process.exit(1);
  });
}
