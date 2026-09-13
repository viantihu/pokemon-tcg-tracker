# Go-live runbook: promoting the real collection from Testing to Production

**Decision this encodes:** the real collection gets entered against **Testing** now,
while Production is still being stood up, and is moved across **once** at cutover. No
re-entry of the collection by hand.

This supersedes the "Testing data refresh cadence" open question in
`devops-strategy.md` §12. Until cutover, **Testing is sticky**: it holds real data and
must not be reset.

---

## 1. Why the copy is safe here

Three properties of the schema make a data promotion viable rather than a rebuild:

1. **Every primary key is `uuid default gen_random_uuid()`** (`0002_domain.sql`). No
   sequences to reset, and UUIDs are globally unique, so ids move over verbatim and
   every foreign key among the copied rows stays intact.
2. **No Supabase Storage.** Artwork is a perceptual-hash column on `catalog_card`, not
   a blob. Everything owned is rows.
3. **Production's schema comes entirely from migrations**, so it can be brought to the
   same shape before any data moves.

## 2. The failure mode the tooling exists to prevent

`owner_id` is `default auth.uid()` guarded by the `owner_all` RLS policy, but it has
**no foreign key to `auth.users`**. The Testing user uuid and the Production user uuid
are different values.

A plain `pg_dump | psql` therefore succeeds completely, reports zero errors, and leaves
Production showing an **empty collection forever** — RLS is filtering on a uuid that
never matches the login. Nothing in the database catches this. Nothing in the app logs
it. It looks exactly like "the import didn't work" with no error to chase.

`scripts/promote-collection.mjs` remaps `owner_id` on the way in and refuses to start
until it has resolved exactly one production owner uuid from `auth.users`. Do not
substitute a raw dump/restore for it.

## 3. What moves and what does not

| Copied from Testing | Why |
|---|---|
| `haul`, `binder`, `collection`, `presence_group`, `evolution_line`, `copy`, `line_slot`, `wishlist_item`, `binder_block`, `placement_decision`, `unresolved_entry` | the collection itself; `owner_id` remapped |
| `catalog_card` | the mirror her copies were reconciled against, including artwork hashes and clusters. Upserted, so a partially-mirrored Production is fine. Re-mirroring instead would be slow (one set per request) and would recompute clustering |
| `set_alias` | learned set aliases her syncs produced |

| Not copied | Why |
|---|---|
| `color_band`, `type_color_map` | ship via migration `0003_config.sql`; Production already has them and copying collides |
| `last_sync_snapshot` | one sync's undo state. Carried over, her first Production "undo" would try to roll back a Testing-era sync |
| `binder_section` | a view, created by `0002_domain.sql` |

`copy` and `line_slot` reference each other and neither FK is `DEFERRABLE`, so the copy
is two-pass: `copy` lands with `line_slot_id` held back, then `line_slot`, then the
column is patched. Production's schema is **not** altered to enable this — migrations
stay the only thing that changes schema.

## 4. Preconditions (the script enforces all of these)

- [ ] `main` is green and Deploy has pushed migrations `0001`–`0007` to Production.
      The script compares `supabase_migrations.schema_migrations` on both sides and
      aborts on any difference.
- [ ] Supabase **automated backups / PITR are on** for the Production project
      (`devops-strategy.md` §6). Do this before, not after.
- [ ] She has **logged into the Production app once** via magic link. The
      `auth.users` row must exist before there is a uuid to remap onto.
- [ ] Production's owner-scoped tables are **empty**. The script is not idempotent; a
      second run would duplicate the collection, so it refuses unless
      `--allow-nonempty` is passed deliberately.
- [ ] Testing holds rows for exactly **one** owner. If a `supabase db reset` left seed
      rows behind (owner `00000000-0000-0000-0000-000000000001`), the script lists the
      candidates and requires `--source-owner=<uuid>`.

## 5. Procedure

Both connection strings are the Supabase **direct connection** URIs (Project Settings →
Database) — not the pooler, whose transaction mode cannot hold the multi-statement
transaction this needs.

Dry run first. It performs every check and every read, and writes nothing:

```bash
TESTING_DB_URL='postgres://...testing...' PROD_DB_URL='postgres://...prod...' ALLOWED_OWNER_EMAIL='...' node scripts/promote-collection.mjs --dry-run
```

Read the printed row counts against what the Testing app shows. Then run it for real:

```bash
TESTING_DB_URL='postgres://...testing...' PROD_DB_URL='postgres://...prod...' ALLOWED_OWNER_EMAIL='...' node scripts/promote-collection.mjs
```

Everything lands inside **one transaction** on Production: it all commits or none of it
does. After commit the script re-counts every table and fails loudly if any count
disagrees with what it read from Testing.

## 6. Verify in the app, not just the database

The script's own count check runs as the connection role, which bypasses RLS. The
count that matters is the one the app sees:

- [ ] Log into Production and confirm binder contents, haul history, and the
      unresolved queue match Testing.
- [ ] Open a binder and confirm placements render (proves `copy` ↔ `line_slot` survived).
- [ ] Confirm the sync page shows **no** pending undo (proves `last_sync_snapshot` was
      correctly left behind).

## 7. After cutover

- Testing goes back to being throwaway. `reset-testing.yml` becomes safe to use again.
- Production is now the only place real data is entered. The `devops-strategy.md` §5
  principle applies from here on: no CSV-reconciliation or destructive-diff experiments
  against Production.

## 8. Known exposure before cutover

**Every PR preview deploy points at the Testing database** (`devops-strategy.md` §5).
While the real collection lives in Testing, an in-flight feature branch writes to the
same rows she is cataloguing. This is the real risk in this plan, not the promotion
step. Two mitigations, either is enough:

- Do not merge or preview schema-touching or write-path branches while data entry is
  in progress.
- Keep the window short: promote as soon as Production is stood up rather than at the
  end of a long cataloguing effort.

`reset-testing.yml` is manual-only behind a typed confirmation, so nothing wipes
Testing by accident — but it must not be run while it holds the real collection.

## 9. Verification of the tooling itself

`tests/repo/promote-collection.test.ts` drives the promotion against two real Postgres
databases (PGlite/WASM, the project's standing pattern since Docker is unavailable),
both built from `0001`–`0007`. It asserts the `owner_id` remap, RLS visibility under
the production login, the circular `copy` ↔ `line_slot` reconstruction, array/jsonb/date
fidelity, catalog upsert over a partial mirror, and every preflight refusal. The remap
and the two-pass insert were both confirmed by mutation: disabling either turns the
suite red.
