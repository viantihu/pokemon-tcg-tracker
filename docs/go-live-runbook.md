# Go-live runbook: standing up Production and promoting the real collection

**Decision this encodes:** the real collection gets entered against **Testing** now,
while Production is still being stood up, and is moved across **once** at cutover. No
re-entry of the collection by hand.

This supersedes the "Testing data refresh cadence" open question in
`devops-strategy.md` §12. Until cutover, **Testing is sticky**: it holds real data and
must not be reset.

The runbook has two parts. **Part A** stands Production up as a working app on the
current schema. **Part B** moves the collection across. Part B cannot start until
every box in Part A is ticked; the promotion script checks the ones it can.

**Plan only.** Nothing in this document runs by itself. Every step names who runs it,
and the irreversible ones (A5, B5) wait for Karvi's explicit go on the day.

---

## 0. Order of operations at a glance

| # | Step | Runs it | Reversible? |
|---|---|---|---|
| A1 | Karvi's three decisions: hosting tier / backups, go-live date, UAT closed | Karvi | n/a |
| A2 | Measure the gap: what `main` lacks, what Production's DB holds | Tech Lead | read-only |
| A3 | Vercel **Production** environment variables set | Karvi (dashboard) | yes |
| A4 | GitHub `production` environment checked (already complete for Deploy) | Tech Lead | read-only |
| A5 | Promotion PR `develop` → `main`, merged as a **merge commit** | Tech Lead opens, QA merges after Karvi's go | no: it applies every pending migration to Production |
| A6 | Deploy on `main` green: `migrate` applied 0003 onward, `smoke` sees `/login` 200 | Tech Lead verifies | read-only |
| A7 | Karvi signs into Production once (creates the owner row) | Karvi | yes |
| A8 | Backups / PITR confirmed **on** for the Production project | Karvi (dashboard) | yes |
| B3 | Preconditions the script enforces | script | read-only |
| B5 | `promote-collection.mjs --dry-run`, then the real run | Karvi runs, Tech Lead reviews the dry-run output | dry run: yes. Real run: one transaction, but not idempotent |
| B6 | Verify in the Production app | Karvi | read-only |
| C | Post-cutover follow-ups (Testing becomes throwaway, tooling fixes) | Tech Lead / DevOps | see Part C |

---

# Part A: standing Production up

## A1. Decisions that belong to Karvi

None of these can be made by an engineer, and A5 must not start until all three are
answered.

- [ ] **Hosting tier and backups.** On 2026-09-09 the cutover was deferred partly
      because Supabase PITR is a paid add-on and free-tier projects pause after seven
      idle days. Either the Production project is on a tier with automated backups
      (and PITR if wanted), or she has accepted the exposure in writing. This gates A8.
- [ ] **Go-live date.** The promotion PR (A5) starts the production migration the moment
      it merges, so it is opened and merged on the day, not parked.
- [ ] **UAT closed.** Every open issue-log entry she wants fixed before real use is
      Fixed and deployed to Testing. Anything left open ships to Production as-is.

## A2. Measure the gap (read-only, repeatable)

Production today is a pre-UI stub. Measured 2026-09-18: `main` is at `b9c5cdc` (PR #12),
**182 commits behind `develop`**; it holds only `app/page.tsx` and `/api/health`,
migrations `0001`–`0002`, and the `ci.yml` + `deploy.yml` workflows. Live proof:
Production `/api/health` returns 200 (dependency-free, so it only proves the process
boots) and Production `/login` returns **404**.

Consequences worth naming so nobody re-diagnoses them at cutover:

- Production's DB has no `0003_config.sql`, so `color_band` and `type_color_map` are
  empty there. Once real code lands, every placement would fail `copy_color_band_fkey`
  until `0003` applies. It applies in A5/A6 and the symptom never appears; if it does,
  the `migrate` job did not run. It is not a second UIL-012.
- `smoke` on the `main` rail asserts `/login` → 200. Any push to `main` before the
  cutover goes red for that reason alone.

Re-measure right before A5:

```bash
git fetch origin && git rev-list --count origin/main..origin/develop
```

```bash
git ls-tree --name-only origin/develop supabase/migrations/
```

The second list is exactly what `migrate` will apply to Production, minus `0001` and
`0002`. Production is linear at `0001`+`0002`, and `main` pushes **without**
`--include-all` by design, so every newer file sorts after the remote head and the push
succeeds without the Testing-only self-heal.

## A3. Vercel Production environment variables

The **running app** reads its configuration from Vercel at request time (`lib/env.ts`,
parsed lazily so `next build` stays green before secrets exist). GitHub environment
secrets feed workflows only and do not make the app serve data. Both are needed; they
are different systems.

Vercel → project → Settings → Environment Variables, scoped to **Production**
(Preview and Production are separate variable sets; the develop URL runs as Preview,
which is how `/login` 500'd on Testing on 2026-09-09):

| Name | Value | Read by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://bqqerxpdxywnpvndhxbs.supabase.co` | `lib/env.ts` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the Production project's publishable / anon key | `lib/supabase/server.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | the Production project's secret / service-role key | `lib/supabase/admin.ts`, `app/api/catalog/sync/route.ts` (bearer for the mirror) |
| `ALLOWED_OWNER_EMAIL` | her sign-in email | `lib/auth/allowlist.ts` |
| `TCGDEX_BASE_URL` | `https://api.tcgdex.net/v2` (only if not already set project-wide) | catalog mirror |

Vercel binds variables at build time, so a value changed after A5 needs a redeploy of
`main` before it takes effect. Set them **before** A5 so the first production build is
the real one.

Check without exposing values: after A6, `smoke` fetching `/login` and getting 200
proves `ALLOWED_OWNER_EMAIL`, `NEXT_PUBLIC_SUPABASE_URL` and the anon key all parsed.
It does not exercise the service-role key; the first haul commit or the mirror does.

## A4. GitHub `production` environment (already sufficient for Deploy)

Measured 2026-09-18 via the GitHub API:

| Kind | Name | Present |
|---|---|---|
| var | `APP_URL` = `https://pokemon-tcg-tracker-sooty.vercel.app` | yes |
| var | `SUPABASE_PROJECT_REF` = `bqqerxpdxywnpvndhxbs` | yes |
| var | `SUPABASE_DB_POOLER_HOST` = `aws-0-us-west-2.pooler.supabase.com` | yes |
| secret | `SUPABASE_DB_PASSWORD` | yes |
| secret | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | **no**, and not needed |

`migrate` on `main` needs only the first four and connects straight to Postgres over the
**session-mode pooler on 5432** (never 6543, whose transaction mode breaks `db push`'s
advisory locks). It never touches the Supabase Management API, so the account's
Management-API privilege loss (UIL-024) cannot block the production migration. The two
missing secrets exist on `testing` for the `acceptance` job, which runs only on
`develop` (`if: github.ref_name == 'develop'`); nothing on the `main` rail reads them.
Add them only if acceptance is ever extended to Production.

Repo-level `DEPLOY_ENABLED` is `true`; if it were not, every Deploy job is skipped.

## A5. The promotion PR

- [ ] Open a PR from `develop` into `main`. CI runs on it (`ci.yml` fires on every
      `pull_request`), including `migration-order` against `main`'s history.
- [ ] Merge it as a **merge commit**, not a squash. A squash would give `main` a
      single new SHA whose history no longer matches `develop`'s, and every later
      `develop` → `main` PR would present the whole history as new again.
- [ ] `main` has **no branch protection** today (measured 2026-09-18; `develop` has
      `verify`, `migration-order` and `Vercel` required). Ask DevOps to mirror
      `develop`'s protection onto `main` before A5 so the same three checks gate it.
- [ ] Merge only after Karvi has said go on the day. This is the irreversible step:
      the merge pushes `main`, Vercel builds the production deployment, and Deploy
      applies every migration from `0003` onward to Production in one `migrate` job.

## A6. Verify Deploy on `main`

Deploy (`.github/workflows/deploy.yml`) triggers on the push to `main` with
`environment: production`.

- [ ] `migrate` green, and its **"Prove the migrations actually landed"** step lists
      every version in `supabase/migrations/` as applied. That step reads
      `supabase_migrations.schema_migrations` back over the pooler and fails on any
      version present in the repo but absent from Production.
- [ ] `smoke` green: `/api/health` 200 and `/login` 200 on `APP_URL`.
- [ ] `acceptance` is **skipped** on `main` by design. Its evidence is the green run on
      the same `develop` SHA that was merged.
- [ ] Vercel's commit status on the merge commit is `success`. A "Canceled" status means
      a newer push superseded that build; the testable SHA is the later one that
      contains it.

If `migrate` is red with "sorts behind the last remote version", stop: Production's
history is not the linear `0001`+`0002` this plan assumes. Do not add `--include-all`
to the `main` rail to get past it; find out what is in Production first.

## A7. First sign-in

- [ ] Karvi signs into Production once via magic link. This creates her `auth.users`
      row, which is the uuid the promotion remaps `owner_id` onto. Without it the
      script refuses to start (it must resolve exactly one owner).
- [ ] She sees an **empty** app. That is correct at this point.

## A8. Backups on before data

- [ ] Automated backups (and PITR if chosen in A1) are enabled on the Production
      project. Do this before B5, not after; the promotion is a one-shot write of
      everything she owns.

---

# Part B: promoting the collection

## B0. Why the copy is safe here

Three properties of the schema make a data promotion viable rather than a rebuild:

1. **Every primary key is `uuid default gen_random_uuid()`** (`0002_domain.sql`). No
   sequences to reset, and UUIDs are globally unique, so ids move over verbatim and
   every foreign key among the copied rows stays intact.
2. **No Supabase Storage.** Artwork is a perceptual-hash column on `catalog_card`, not
   a blob. Everything owned is rows.
3. **Production's schema comes entirely from migrations**, so it can be brought to the
   same shape before any data moves.

## B1. The failure mode the tooling exists to prevent

`owner_id` is `default auth.uid()` guarded by the `owner_all` RLS policy, but it has
**no foreign key to `auth.users`**. The Testing user uuid and the Production user uuid
are different values.

A plain `pg_dump | psql` therefore succeeds completely, reports zero errors, and leaves
Production showing an **empty collection forever**: RLS is filtering on a uuid that
never matches the login. Nothing in the database catches this. Nothing in the app logs
it. It looks exactly like "the import didn't work" with no error to chase.

`scripts/promote-collection.mjs` remaps `owner_id` on the way in and refuses to start
until it has resolved exactly one production owner uuid from `auth.users`. Do not
substitute a raw dump/restore for it.

## B2. What moves and what does not

| Copied from Testing | Why |
|---|---|
| `haul`, `binder`, `collection`, `presence_group`, `evolution_line`, `copy`, `line_slot`, `wishlist_item`, `binder_block`, `placement_decision`, `unresolved_entry` | the collection itself; `owner_id` remapped |
| `catalog_card` | the mirror her copies were reconciled against (23,548 cards / 214 sets on Testing as of 2026-09-14), including artwork hashes, clusters and the `0009` set metadata. Upserted, so a partially-mirrored Production is fine. Re-mirroring instead would be slow (one set per request) and would recompute clustering |
| `set_alias` | learned and manual set aliases her syncs produced |

| Not copied | Why |
|---|---|
| `color_band`, `type_color_map` | ship via migration `0003_config.sql`; Production already has them and copying collides |
| `last_sync_snapshot` | one sync's undo state. Carried over, her first Production "undo" would try to roll back a Testing-era sync |
| `binder_section` | a view, created by `0002_domain.sql` |

`copy` and `line_slot` reference each other and neither FK is `DEFERRABLE`, so the copy
is two-pass: `copy` lands with `line_slot_id` held back, then `line_slot`, then the
column is patched. Production's schema is **not** altered to enable this; migrations
stay the only thing that changes schema.

Columns added since the script was written (`collection.updated_at` in `0012`, the
UIL-078 decision markers in `0013`) copy with their rows: the script reads each table's
column list from `information_schema` on **both** sides, refuses to start if they
differ, and inserts every column it finds. Its table list is complete as of
2026-09-18: no migration from `0008` to `0012` creates a table, and the pending `0013`
and `0014` add columns and replace a function only. **Any future migration that creates
an owner-scoped table must also add it to `OWNER_TABLES` in the script**, or the
promotion silently leaves that table behind; the dry run's "tables have matching
columns" line names the tables it will copy, so read it against the schema on the day.

## B3. Preconditions (the script enforces all of these)

- [ ] **Identical migration histories.** The script compares
      `supabase_migrations.schema_migrations` on both sides and aborts on any
      difference. After A6 that means every version in `supabase/migrations/` on
      `main` (as of 2026-09-18: `0001`–`0012` on `develop`, with `0013` and `0014`
      open in PRs #188 and #194 and expected to land first).
- [ ] Supabase **automated backups / PITR are on** for the Production project (A8).
- [ ] She has **logged into the Production app once** via magic link (A7).
- [ ] Production's owner-scoped tables are **empty**. The script is not idempotent; a
      second run would duplicate the collection, so it refuses unless
      `--allow-nonempty` is passed deliberately.
- [ ] Testing holds rows for exactly **one** owner. If a `supabase db reset` left seed
      rows behind (owner `00000000-0000-0000-0000-000000000001`), the script lists the
      candidates and requires `--source-owner=<uuid>`.

## B4. Connection strings

The script takes both databases as Postgres URIs in `TESTING_DB_URL` and `PROD_DB_URL`.
Its header asks for the Supabase **direct connection** URI. Two things to know before
the day:

- The direct host `db.<ref>.supabase.co` publishes **IPv6 (AAAA) records only**. From a
  network without IPv6 (this was measured on GitHub's runners) it does not resolve. If
  the machine running the script cannot reach it, use the **session-mode pooler** URI
  instead: `postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432`. Session mode holds
  a multi-statement transaction correctly; the **transaction-mode pooler on 6543 does
  not** and is the one the header is warning about.
- Regions differ: Testing `cpmwdcmokbgcpmkvbtsw` is `us-east-1`, Production
  `bqqerxpdxywnpvndhxbs` is `us-west-2`.

Both passwords are the projects' database passwords (Karvi holds them; the Production
one is also the GitHub `production` secret). They are never pasted into a chat or a PR.

## B5. Procedure

Dry run first. It performs every check and every read, and writes nothing:

```bash
TESTING_DB_URL='postgres://...testing...' PROD_DB_URL='postgres://...prod...' ALLOWED_OWNER_EMAIL='...' node scripts/promote-collection.mjs --dry-run
```

Read the printed row counts against what the Testing app shows, and against the last
Testing diagnostic read (counts only, `ops/read-band-config`). Then run it for real:

```bash
TESTING_DB_URL='postgres://...testing...' PROD_DB_URL='postgres://...prod...' ALLOWED_OWNER_EMAIL='...' node scripts/promote-collection.mjs
```

Everything lands inside **one transaction** on Production: it all commits or none of it
does. After commit the script re-counts every table and fails loudly if any count
disagrees with what it read from Testing.

## B6. Verify in the app, not just the database

The script's own count check runs as the connection role, which bypasses RLS. The
count that matters is the one the app sees:

- [ ] Log into Production and confirm binder contents, haul history, and the
      unresolved queue match Testing.
- [ ] Open a binder and confirm placements render (proves `copy` ↔ `line_slot` survived).
- [ ] Open Collections and confirm the most-recently-modified order matches Testing
      (proves `collection.updated_at` came across, not just the column).
- [ ] Confirm the sync page shows **no** pending undo (proves `last_sync_snapshot` was
      correctly left behind).

---

# Part C: after cutover

- **Testing goes back to being throwaway**, but not immediately. Keep it untouched
  until B6 is confirmed, then treat it as disposable.
- **`reset-testing.yml` does not work today and must stay that way until B6.** It
  resets through `supabase link`, which needs the Management API the account lost
  access to (UIL-024), so it fails before it can destroy anything. That failure is
  currently the last line of defence for the real collection. After B6 it can be
  reworked to `db reset` over `--db-url` like `migrate`; not before.
- **The catalog mirror only knows Testing.** `catalog-mirror.yml` is pinned to
  `environment: testing`. The promotion copies `catalog_card` across, so Production
  does not need a mirror run at cutover, but the first new TCGdex set after go-live
  will. Follow-up: give the mirror an `environment` input so it can target Production.
- **Previews keep pointing at Testing.** That is now harmless, and it is the reason
  Production is never written by a PR preview.
- **Production is now the only place real data is entered.** The
  `devops-strategy.md` §5 principle applies from here on: no CSV-reconciliation or
  destructive-diff experiments against Production.
- **Branch protection on `main`** (A5) stays on. The `Vercel` context on `main` is the
  production deployment.

## Known exposure before cutover

**Every PR preview deploy points at the Testing database** (`devops-strategy.md` §5).
While the real collection lives in Testing, an in-flight feature branch writes to the
same rows she is cataloguing. This is the real risk in this plan, not the promotion
step. Two mitigations, either is enough:

- Do not merge or preview schema-touching or write-path branches while data entry is
  in progress.
- Keep the window short: promote as soon as Production is stood up rather than at the
  end of a long cataloguing effort.

`reset-testing.yml` is manual-only behind a typed confirmation, refuses the Production
project ref outright, and today fails at `supabase link` before touching anything. It
must not be repaired while Testing holds the real collection.

## Verification of the tooling itself

`tests/repo/promote-collection.test.ts` drives the promotion against two real Postgres
databases (PGlite/WASM, the project's standing pattern since Docker is unavailable),
both built from a migration list **frozen at `0001`–`0007`** by the test's own design.
It asserts the `owner_id` remap, RLS visibility under the production login, the
circular `copy` ↔ `line_slot` reconstruction, array/jsonb/date fidelity, catalog upsert
over a partial mirror, and every preflight refusal. The remap and the two-pass insert
were both confirmed by mutation: disabling either turns the suite red.

What that frozen list does **not** cover is any column added from `0008` onward
(`0009` set metadata, `0012` `collection.updated_at`, `0013` decision markers). Two
ways to close that before the day, either is enough: extend the test's `MIGRATIONS`
list to the full set on `main` (a small dev task; the app's own PGlite harness in
`tests/support/pglite-rpc.ts` already carries the full list after UIL-029), or treat
the `--dry-run` against real Production as the check, since its column comparison
runs against the live schema rather than a fixture.
