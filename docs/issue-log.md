# User-Reported Issue Log

Feedback from Karvi testing the running app. One entry per issue, appended in the order
reported. Claude maintains this file: when Karvi reports something during a testing session,
add an entry here before starting any fix.

**Not** a substitute for GitHub issues. This is the raw capture — what she saw, in her words.
Anything that becomes real work gets a linked PR in the entry.

## Fields

- **Status** — `Open` · `Investigating` · `Fixed` (code merged) · `Closed` (Karvi confirmed on a
  running environment) · `Won't fix` · `Not a bug`
- **Priority** — set jointly by Karvi and Claude. Claude proposes, Karvi has final say.
  - `High` — the app is not functional. Cannot go live without a resolution.
  - `Medium` — should be addressed sooner rather than later, but not urgent.
  - `Low` — does not block functionality. Can be addressed post go-live.
- **Area** — the screen or subsystem: Plan, Lookup, Lines, Collections, Backfill, Sync,
  Binders, Settings, Auth, Catalog, Deploy
- **Env** — where it was seen: Testing, Production, local

Priority is about impact on go-live, not effort to fix. When Claude's and Karvi's reads differ,
the entry records both.

---

## UIL-001 — "Back half from page" gives no indication of what it means

- **Reported:** 2026-09-13
- **Status:** Fixed — PR [#42](https://github.com/viantihu/pokemon-tcg-tracker/pull/42), awaiting QA review
- **Priority:** Low
- **Area:** Settings › Binders
- **Env:** Testing

The `Back half from page` field on the binder form has no helper text, so it is not clear from
the UI that it is the divider page where the back half starts, that pages 1..N-1 become the front
half, or that leaving it blank gives the binder **zero** back-half capacity and silently makes it
unable to hold any evolution line.

The blank-means-zero behavior is the real trap: `coalesce(back_half_start_page, pages + 1)` in
[`0002_domain.sql:295`](../supabase/migrations/0002_domain.sql:295) makes an unset value read as
"the whole binder is front half," and nothing in the UI says so.

Likely fix: helper text under the field, plus a warning on a general binder saved with no back
half set.

**Priority rationale:** the field works correctly once understood, and binder setup is a one-time
step she can be walked through. Copy-only fix, safe to ship after go-live.

## UIL-002 — No definition of what counts as a "page"

- **Reported:** 2026-09-13
- **Status:** Fixed — PR [#42](https://github.com/viantihu/pokemon-tcg-tracker/pull/42), awaiting QA review
- **Priority:** Medium
- **Area:** Settings › Binders
- **Env:** Testing

`Pages` and `Pockets/page` do not say whether a page means one side of a sheet or a whole sheet
(both sides). The distinction changes what she should enter: 40 pages × 9 pockets and 20 pages ×
18 pockets describe the same physical binder.

Nothing validates the pairing, and page counts are capacity-only (never an address), so a
mismatch does not error — it just makes every capacity number and every "time for a new binder"
call wrong by 2×.

Likely fix: label `Pockets/page` with the assumption ("9 = one side of a 3×3 sheet") and show the
derived total capacity live as she types, so a wrong pairing is visible immediately.

**Priority rationale:** higher than UIL-001 because the failure is silent and produces *wrong
data*, not just confusion — a 2× capacity error misroutes real cards and is only discovered
physically, at the binder. Worth fixing before the first real haul, not before go-live.

**Resolution for UIL-001 + UIL-002 (2026-09-13, PR [#42](https://github.com/viantihu/pokemon-tcg-tracker/pull/42)).** Fixed together — same form, same class of
failure.

- The binder form now shows the running total, front/back split and page ranges **live as she types**.
  For UIL-002 that is the actual safeguard: the app only ever multiplies pages x pockets, so rather
  than assert a convention it does not enforce, it shows the total she can check against the binder in
  her hands — which a 2x mistake visibly doubles.
- UIL-001's blank-divider case gets a **warning**, not helper text, because zero back-half capacity is
  a defect rather than a copy gap. Beyond the original suggestion: the binder **list** flags it too
  (`NO BACK HALF`), since an already-saved binder is where she would actually hit it, and a divider set
  past the last page gets the same warning naming the out-of-range page. Specialty binders are never
  flagged — they have no halves by design.
- The arithmetic is `binderSplit` in `lib/surfaces/capacity.ts`, mirroring the `binder_section` view
  including its `coalesce` and both `greatest(..., 0)` clamps. 12 cases run through **both** the helper
  and the real view on a real Postgres and must match, so the preview cannot drift from the DB and
  teach a wrong model of her own binders.

Not verified visually — rendering Settings needs Supabase credentials, so the numbers are proven
against Postgres but the layout is not. Worth a glance at the binder form on a narrow viewport.

## UIL-003 — Sync's added cards cannot be placed: "Place new cards" leads to an empty Haul Plan

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#35](https://github.com/viantihu/pokemon-tcg-tracker/pull/35) MERGED to `develop` 2026-09-13 (squash `86e52fc`), and **confirmed resolved by Karvi on Testing 2026-09-13** after UIL-004's catalog was populated.
- **Priority:** High (confirmed by Karvi)
- **Area:** Sync → Plan
- **Env:** Testing

Reported as "I completed a sync from my dex export, but I don't see anything in my haul plan."

**Not user error.** The Haul Plan is genuinely where sync's additions are supposed to land, and
the handoff to it was never built.

Sync deliberately creates new copies **unplaced** — the sync engine never places anything itself
([sync-architecture.md:39](sync-architecture.md:39), [exec.ts:227](../lib/sync/exec.ts:227)) — and
hands them to the routing cascade. [sync-ui-spec.md §B.6](sync-ui-spec.md) requires a
"**Place-now handoff** … an optional jump into the cascade to place them, so 'added' doesn't
dead-end in a list." The button exists ([SyncScreen.tsx:274](<../app/(ui)/sync/SyncScreen.tsx>:274),
"Place new cards" → `/plan`), but the destination cannot receive them:

- `PlanScreen` initializes `draft: []` and has no loader — it is a blank manual-entry form on
  every visit ([PlanScreen.tsx:41](<../app/(ui)/plan/PlanScreen.tsx>:41)).
- `/plan`'s only server actions are `lookupCatalog`, `runHaulPlan(draft)` (client-supplied),
  `commitHaulAction`, and `getMoveOptions` ([actions.ts](<../app/(ui)/plan/actions.ts>)). Nothing
  reads existing unplaced copies.
- No other surface adopts them either. Backfill's commits also build from typed entry, so there
  is no workaround path.

**The obvious workaround is actively harmful.** Retyping the cards into the Haul Plan and
committing calls `commitHaul`, which creates a *new* haul and *new* copy rows — sync already
created copies for those cards. Doing it by hand silently doubles her counts. Do not suggest this
as a stopgap.

Likely fix: a `loadPendingPlacements()` action that reads unplaced copies (`role='bulk'`, no
binder) and seeds the Plan draft with them, plus a commit path that **routes the existing copies**
rather than creating new ones. That second half is the real work — `commitHaul` is create-only
today.

**Priority rationale:** this breaks the app's whole reason to exist. Placement is the product
(README: "it is a placement engine, not a collection tracker"), and after an import there is
currently no way to place what was imported. The import path is the primary way cards enter the
system. Cannot go live on it.

**Resolution (2026-09-13, PR #35).** Both halves built.

- Read: `lib/plan/pending.ts` returns copies that hold no placement **and** have no
  `placement_decision` row. The decision row has to be the discriminator — the cascade can
  legitimately route a card *to* bulk, which leaves placement columns identical to an untouched
  sync add. Only the audit trail tells them apart, and that also makes the queue self-clearing
  whatever the destination turns out to be.
- Write: a draft entry can carry `existingCopyId`; the commit then routes that row (`update_copy`)
  rather than inserting a second copy. A routed copy keeps its Dex-owned variant, is never stamped
  with a `haul_id`, and a pass made only of routed copies writes no haul row at all.
- The copies being routed are withheld from `ctx.owned` for the run: they are the incoming stack,
  not the established collection. Without that, every imported card reads as a duplicate of itself
  and the whole stack routes to bulk. A test pins that failure mode, plus the invariant that a
  routed draft plans identically to the same cards typed by hand.
- `/plan` now opens with the waiting cards loaded and tagged, under a line saying they are already
  in the collection and that running the plan gives them a home rather than adding them again.

Verified on real Postgres (PGlite) through the real `apply_write_ops` RPC: one copy in, one copy
out, no haul row, audit with `haul_id: null`, and the queue empty afterwards including the
routed-to-bulk case. No migration needed.

## UIL-004 — Testing's catalog holds 3 cards, so a real Dex export resolves almost nothing

- **Reported:** 2026-09-13 (found while diagnosing UIL-003)
- **Status:** **Closed** — Testing's catalog holds **23,548 cards across 214 sets** (run
  [`34795733862`](https://github.com/viantihu/pokemon-tcg-tracker/actions/runs/34795733862),
  2026-09-13), against the 3 `seed.sql` shipped. The 4 sets still absent return zero cards from TCGdex
  itself. Not "217/218 with `dp5` pending" — see the corrections at the end of this entry.
- **Priority:** High
- **Area:** Catalog
- **Env:** Testing

Contributing cause to the same report, and possibly the whole of it.

`catalog_card` on Testing contains exactly three cards — Charmander `sv03-026`, Charmeleon
`sv03-027`, Ralts `sv01-084` from [`seed.sql`](../supabase/seed.sql). The catalog mirror has never
been run on any environment (no `Catalog Mirror` workflow run exists in Actions history).

`lib/sync/catalog-lookup.ts` resolves a Dex CSV row **only** against the local mirror, with no
lazy TCGdex fetch on a miss. So a real export parks essentially every row in the Unresolved queue
and adds ~zero copies — meaning the sync can report "complete" having changed nothing at all.

**How to tell which one she hit:** the Sync screen's `LAST SYNC` line reads "N added" if copies
were really created, or "no collection changes" if everything parked. The Unresolved panel shows
the parked count. If it says no collection changes, UIL-004 alone explains the empty plan and
UIL-003 has not actually been exercised yet.

Fix: run `catalog-mirror.yml` (all 218 TCGdex sets, one request per set) against Testing. Needs
`SUPABASE_SERVICE_ROLE_KEY` on the GitHub `testing` environment, and a push to
`ops/run-catalog-mirror` since the workflow is not on `main` yet.

**Priority rationale:** no real import can produce a usable result until the mirror is populated.
It is also cheap to clear — infrastructure, not code.

**Related work in flight (2026-09-13):** uncommitted changes in the working tree add a paged
`listAll` to `lib/repo` alongside the existing `list`, which silently truncates at PostgREST's
1000-row `max-rows` cap. That matters here: the moment the mirror grows from 3 rows to ~23.5k, any
full-table read of `catalog_card` through `list` starts returning a truncated 1000 rows with no
error. Populating the mirror and fixing the paging need to land together, or the import will
"succeed" against a silently partial catalog.

**Status (2026-09-13, PR #35).** Diagnosed and the workflow is fixed, but the run itself is
**blocked on one credential.**

The reason the mirror had never run is that the job *skipped itself*: nothing had ever set
`SUPABASE_SERVICE_ROLE_KEY` on the GitHub `testing` environment, and the workflow treated a missing
key as "skip cleanly." That is how a never-populated catalog stayed invisible until UAT. It now
**fails loudly** with instructions instead.

Attempted to remove the manual step by deriving the key from the `SUPABASE_ACCESS_TOKEN` the deploy
already uses (`GET /v1/projects/{ref}/api-keys?reveal=true`). That PAT is scoped and returns **403 —
"Your account does not have the necessary privileges"**; the legacy endpoint returns only
`{"enabled": ...}`, no key values. So the token cannot reveal project keys and there is no way to
reach the key from CI as configured. The derivation is kept as a best-effort first try (it costs one
request and will work with a full-access PAT), but it is not the path today.

**What unblocks it — one of:**

1. Copy the **secret key** (`sb_secret_…`) from the Supabase dashboard (project
   `cpmwdcmokbgcpmkvbtsw` → Project Settings → API Keys) into a GitHub **environment** secret named
   `SUPABASE_SERVICE_ROLE_KEY` on the `testing` environment. (`service_role` is the *legacy* key —
   use it only if this project still has legacy keys enabled.) The name is historical; what matters
   is that the value is the same one the app already has in Vercel, or `/api/catalog/sync` will 401
   on the bearer check.
2. Or replace `SUPABASE_ACCESS_TOKEN` with a PAT that has secret-read privileges.

Then push any commit to `ops/run-catalog-mirror` (the branch already exists) and the run mirrors all
~218 sets, one request per set, ~20–40 min. It is idempotent, so a partial run is safe to resume.

The workflow also no longer claims success from a health ping: it asks PostgREST for an exact
`catalog_card` count afterwards and fails if the mirror did not land.

The paging concern above is fixed in the same PR: `listAll` pages by primary key and advances by rows
*received* rather than requested, so a server cap smaller than the page size cannot skip rows. That
had to land with the mirror — the moment `catalog_card` grows past 1000 rows, an unpaged read starts
truncating silently.

**Still open, spun out of this:** Deploy's `acceptance` job skips on the same missing secret, so the
M1 acceptance suite that PR #33 added has never actually executed against Testing. Setting the secret
above fixes both at once.

**Correction (2026-09-13, PR [#37](https://github.com/viantihu/pokemon-tcg-tracker/pull/37)).** Karvi
flagged that `service_role` is Supabase's **legacy** key; the current system is `sb_publishable_…` /
`sb_secret_…`. Two bugs in #35's workflow followed from the old assumption:

- the Management API lookup filtered on `name == "service_role"`, which never matches on a project
  using the new keys. It now selects on the value's `sb_secret_` prefix and falls back to the legacy
  name.
- the mirror's own verification sent the key as `Authorization: Bearer` to Supabase's REST gateway.
  New-format keys are **not JWTs** and belong on the `apikey` header alone — as a Bearer token the
  platform rejects them with `Invalid JWT`, so the verify step would have failed against a secret key
  and looked like the mirror had not populated. The Bearer is now added only for a JWT-shaped key.

The mirror loop's own `Authorization: Bearer` is unchanged and correct for either format: that request
goes to our Next.js route, which string-compares against its own env var and never reaches Supabase.

**Resolved (2026-09-13).** Karvi added `SUPABASE_SERVICE_ROLE_KEY` to the GitHub `testing`
environment and the mirror ran: **217 of 218 sets, ~21.7k cards upserted**, against the 3 that
`seed.sql` shipped. A real Dex export will now resolve.

The run also confirmed the key format is `sb_secret_…` — this project IS on Supabase's new key
system, so PR #37's header fix was load-bearing, not precautionary. Without it the verify step would
have sent the secret key as a Bearer token and failed with `Invalid JWT`, making a successful mirror
look like a failed one.

**One loose end.** Set `dp5` (Majestic Dawn, 2008) returned HTTP 502 and the error body was
`{"ok":false,"error":"[object Object]"}` — useless. I re-fetched all 100 dp5 cards from TCGdex and ran
them through the real `toCatalogRow`, checking every value against the `catalog_card` constraints: no
duplicate ids, no nulls in NOT NULL columns, no numeric overflow, no check violations. The data is
clean, so the 502 was almost certainly transient. PR [#39](https://github.com/viantihu/pokemon-tcg-tracker/pull/39)
fixes the reason it was unknowable (see below) and gives each set one retry, so the next run picks
dp5 up. Practical impact until then: Dex rows from that one 2008 set park in the unresolved queue.

**Spun out — the error string, which was the real finding.** `err instanceof Error ? err.message :
String(err)` appears in 24 places across the server actions, and supabase-js rejects with a
`PostgrestError`, which is a plain object rather than an `Error`. So the fallback branch is the one
that runs for every DB failure in the app, and it renders `"[object Object]"`. That is not a mirror
bug; it means every database error surfaced during UAT tells Karvi nothing. Fixed in #39.

**Correcting this entry's own record (2026-09-13, PR [#46](https://github.com/viantihu/pokemon-tcg-tracker/pull/46)).**
The "217 of 218, `dp5` pending" above is wrong, and it understated the gap. Read from the run log of
`34787934423`, the latest completed mirror:

- `dp5 ok {"setId":"dp5",...,"fetched":100,"upserted":100}` — **dp5 succeeded.** The clean-data
  analysis above was correct that its 502 was transient; the retry was not needed.
- the run ends `Mirrored 205/218 sets; 13 failed` — **thirteen** other sets never landed:
  `swsh3.5 swsh4 2021swsh swsh4.5 A3 sv10 A3b sv10.5b sv10.5w A4 A4a mee me01`, every one a TCGdex
  503 surfaced as our 502.

These are not obscure sets. `sv10` (Destined Rivals), `swsh4` (Vivid Voltage) and `me01` are current
or recent, so this is materially worse than one 2008 set: Dex rows from thirteen sets, including ones
she is most likely to actually own, park in the unresolved queue. The "a real Dex export will now
resolve" claim above holds for ~94% of sets, not all of them.

**Why re-running was the wrong reflex.** Every failure this workflow has ever had is TCGdex throttling
us, and the failure count *grew* run over run — 2, then 1, then 13. Recovering thirteen sets by sending
218 requests at the API already throttling us is what produces the next run's failures. #39's backoff
treats the symptom within a run; it does not stop each run from re-requesting everything.

**Fixed in #46: the mirror resumes.** It now reads how many cards `catalog_card` already holds per set
and requests only sets that are absent or short of their TCGdex `cardCount.total`. A recovery run is a
handful of requests instead of 218.

- **Counts, not presence.** A half-landed set has rows but is still incomplete; a presence check would
  call it done and leave those cards permanently unresolvable — a silent version of this very bug.
- **Paging advances by rows received**, not by the page size requested, so a PostgREST `max-rows`
  below the page size cannot skip sets. Same failure `lib/repo`'s `listAll` was fixed for in #39.
- A failed read **warns loudly and falls back to a full run** rather than degrading quietly, which is
  the exact behaviour that let UIL-004 hide until UAT.
- `force_all: true` on a manual run re-requests everything, for when the mirror logic itself changes.

Verified against mocked PostgREST pages with a deliberate server cap (75) below the requested `limit`
(1000): it read all 153 rows across 3 pages, skipped the complete sets, and requested the absent one,
the partial one, and one with an unknown card count. Not verified against the live table, which needs
the run itself.

**CLOSED (2026-09-13) — the catalog is fully mirrored.** Resume run
[`34795733862`](https://github.com/viantihu/pokemon-tcg-tracker/actions/runs/34795733862) succeeded and
settles it:

- `catalog_card currently holds 23548 rows across 214 sets` — so the thirteen TCGdex-503 sets from the
  previous run (`sv10`, `swsh4`, `me01` and the rest) **had already landed** across earlier runs. The
  catalog was never missing them by the time this ran.
- The resume check found **6** sets to request rather than 218, and all 6 returned 200. No throttling,
  because 6 requests do not trigger it. This is the mechanism working as designed on its first real run.
- Final count `23548`, `Mirror populated`.

**The remaining 6 are TCGdex disagreeing with itself, not a gap.** The set detail endpoint returns
fewer cards than the brief set list advertises: `wp` 0 of 7, `jumbo` 0 of 160, `sp` 0 of 10, `rc` 0 of
25 (all `fetched: 0`), `tk-sm-l` 18 of 30, `mfb` 34 of 48 — promo, sample and jumbo pseudo-sets. The row
count did not move (23548 before, 23548 after), which confirms there was nothing to add. **A real Dex
export now resolves against everything TCGdex is willing to serve.**

Those sets can never satisfy `stored >= cardCount.total`, so every future run re-requests them. That is
6 requests, and it errs safe — the check never *skips* a set that needs mirroring. PR
[#49](https://github.com/viantihu/pokemon-tcg-tracker/pull/49) makes the run log say so explicitly
rather than leaving six phantom gaps for the next reader to chase. Deliberately **not** suppressed with
an allow-list, since a genuinely truncated set could later hide behind one.

## UIL-005 — Deploy's migration step is dead: the Supabase access token lost its privileges

- **Reported:** 2026-09-13 (found while running the catalog mirror for UIL-004)
- **Status:** Fixed — PR [#46](https://github.com/viantihu/pokemon-tcg-tracker/pull/46) removes the
  Management-API dependency entirely, so the revoked token is no longer a blocker. **Not caused by a
  misconfiguration on Karvi's side** — see the correction at the end of this entry.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Deploy
- **Env:** Testing (and Production, once it is used)

`Deploy → migrate` has failed on every push to `develop` today. `supabase link` returns:

> Authorization failed for the access token and project ref pair: "Your account does not have the
> necessary privileges to access this endpoint."

The same privilege wall that blocked reading project API keys for UIL-004. Nothing in the code
touches it — `deploy.yml` and `secrets.SUPABASE_ACCESS_TOKEN` are unchanged since it last worked. The
last green Deploy was **2026-09-09** (run `34312289864`), so the token has been narrowed, rotated, or
expired since then.

**Why this is High, not housekeeping.** Migrations are the half of the deploy this workflow owns;
Vercel deploys the app code on its own, on push, regardless. So the guard stated at the top of
`deploy.yml` — "MIGRATE BEFORE the deploy is trusted, so new code never meets an old schema" — has
already been violated: Testing is running `develop`'s code against the pre-0007 schema.

**Concrete effect right now.** Migration `0007_backfill_ops.sql` (PR #36) replaces `apply_write_ops`
to add the `insert_binder_block` and `union_collection_targets` branches that the new
`lib/backfill/commit.ts` emits. Testing still has 0006's version, whose `case` ends in
`raise exception 'apply_write_ops: unknown op %'` — so **a backfill commit on Testing will fail and
roll back completely.** Loud and non-corrupting, which is the good version of this failure, but
backfill is unusable there until 0007 applies.

Not affected: the UIL-003 placement fix. Routing sync's copies only uses ops 0006 already has
(`update_copy`, `insert_decision`, slot/line writes), so placement works on Testing today. Haul commit
and sync apply/undo are likewise unaffected.

Fix: restore a `SUPABASE_ACCESS_TOKEN` with access to project `cpmwdcmokbgcpmkvbtsw` (a full-access
personal access token), then re-run the failed Deploy. Worth doing at the same time as the UIL-004
key, since one privileged token would have covered both.

**Priority rationale:** every future schema change silently fails to reach Testing while this is
broken, and the app keeps deploying on top of the old schema. It is also the same class of bug as
UIL-004 — a pipeline step that reports a problem in a place nobody was looking.

**Update 2026-09-13 (after #38/#39 merged).** Still failing, confirmed on the `#39` merge commit
`fae077f` (Deploy run `34790064447`): same 403 from `supabase link`. Nothing merged today touches it —
it is purely the credential.

**Fixing the token alone will NOT green Deploy.** `SUPABASE_ANON_KEY` has never been set on the
`testing` environment (it holds only `SUPABASE_DB_PASSWORD` and `SUPABASE_SERVICE_ROLE_KEY`), and PR
#38 has now made the `acceptance` job **fail loudly instead of skip**. So restoring the token moves
Deploy from "red at `migrate`" to "red at `acceptance`". Its Management-API fallback cannot cover the
gap either, because that is the very call the token 403s on. Set both at once:

- repo secret `SUPABASE_ACCESS_TOKEN` → a Supabase PAT with access to `cpmwdcmokbgcpmkvbtsw`
- `testing` env secret `SUPABASE_ANON_KEY` → the **publishable** key (`sb_publishable_…`), matching
  what Vercel already has as `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**Caveat retired.** I had flagged that supabase-js 2.115 sends new-format keys as a Bearer token,
which Supabase's docs say the gateway rejects as `Invalid JWT` — a risk to every privileged read once
this project moved to `sb_secret_…`. The mirror run settles it empirically: it wrote ~21.7k rows
through `createAdminClient()` with the `sb_secret_…` key. The Bearer fallback is accepted for the data
API, so neither the app nor the acceptance suite trips on it. The note in `lib/supabase/admin.ts`
stands as a pointer for a future `Invalid JWT`, not as an active defect.

**Production is emptier still.** The `production` environment has only `SUPABASE_DB_PASSWORD` — no
service or anon key — and `main` is 28 commits behind `develop`. The cutover needs both keys there too,
and it needs this same token working against the strict (no `--include-all`) rail.

**Fixed (2026-09-13, PR [#46](https://github.com/viantihu/pokemon-tcg-tracker/pull/46)) — and the
diagnosis above needs correcting: this was never Karvi's misconfiguration.**

The secret's stored value was last written **2026-09-08 02:13 UTC**, and the last green Deploy ran
**2026-09-09 04:47 UTC**. So the token worked *after* it was last set, and nothing in this repo touched
it since. The privileges were revoked on the Supabase side, by something outside the repo. "I didn't
configure the keys properly" is not what happened here.

**The real fix is to stop depending on it.** `supabase link` is a Management API call, which is why a
PAT's *account-level* privileges could take down this project's migrations at all. `db push --db-url`
connects straight to Postgres and never touches that API. Confirmed by running it with no
`SUPABASE_ACCESS_TOKEN` in the environment: it goes directly to a Postgres auth attempt instead of
403ing. So `migrate` now uses `secrets.SUPABASE_DB_PASSWORD`, which was **already configured on both
environments** — no new credential.

That is a better outcome than restoring the token. A PAT's privileges are account-level and outside
this repo's control, and can be narrowed again at any time; the DB password is per-project and is what
`db push` authenticates with either way.

**The pooler is required, not a preference.** `db.<ref>.supabase.co` publishes AAAA records only — no
`A` record — and GitHub-hosted runners have no IPv6, so the direct host is unreachable from CI
(`dial error ... connect ECONNREFUSED 2600:1f18:...`). Supavisor is dual-stack. Its host is
region-pinned per project and **not derivable from the project ref**, so it is now
`vars.SUPABASE_DB_POOLER_HOST` per environment. Both are set, each confirmed by probe (a wrong host
answers `tenant/user postgres.<ref> not found`; the right one reaches real Postgres auth):

| env | project | pooler |
| --- | --- | --- |
| testing | `cpmwdcmokbgcpmkvbtsw` | `aws-0-us-east-1.pooler.supabase.com` |
| production | `bqqerxpdxywnpvndhxbs` | `aws-0-us-west-2.pooler.supabase.com` |

Port **5432**, not 6543: 5432 is session mode, which holds the multi-statement transactions and
advisory locks `db push` wraps each migration in. 6543 is transaction mode and would break them — the
same distinction `scripts/promote-collection.mjs` documents.

**Deploy now also asserts the schema actually moved.** `db push` exits 0 when there is nothing to do,
which in a log is indistinguishable from having applied everything. That is the hole this entry
describes: `migrate` reporting green while Testing sat on 0006 is what let 0007-era backfill code meet
a 0006 `apply_write_ops`. A new step reads `supabase_migrations.schema_migrations` back over the same
connection and fails if any local migration is absent — a **set difference, not a `max()` comparison**,
since `--include-all` can leave a hole in the middle of the history that comparing only the newest
version would call fully migrated.

**What this changes about the blockers listed above:**

- `SUPABASE_ACCESS_TOKEN` is **no longer needed for migrations** and is no longer a go-live blocker.
  The `acceptance` job still tries it as a best-effort shortcut for deriving its two keys and tolerates
  the 403, so nothing else has to be fixed for it.
- Production needs no token either — it needs `vars.SUPABASE_DB_POOLER_HOST` (now set) and its existing
  `SUPABASE_DB_PASSWORD`.
- **`SUPABASE_ANON_KEY` on `testing` is the one thing still outstanding**, and it genuinely cannot be
  derived: reading it is the same Management API call the PAT 403s on. It is the **publishable** key
  (`sb_publishable_…`), it is not secret (the app ships it to every browser), and it must match Vercel's
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Until it is set, Deploy moves from red at `migrate` to red at
  `acceptance` — which is #38 working as designed, not a regression.

`reset-testing.yml` still uses `supabase link` and is **deliberately left broken**: it is destructive,
and Testing holds the real collection until the cutover. Fixing it would only make it easier to run by
accident.

**Still worth Karvi's attention, and not something the code can answer:** *why* the account lost
privileges. A PAT that silently stops being able to see a project can mean the project moved
organizations, an org role was downgraded, or there is a billing/plan problem on the org. None of that
blocks Testing any more, but the same account owns the Production project, so it is worth a look at the
Supabase dashboard before the cutover.

## UIL-006 — Haul Plan makes her re-run the plan on every visit to the page

- **Reported:** 2026-09-13
- **Status:** Open
- **Priority:** Medium (Claude's read)
- **Area:** Plan
- **Env:** Testing

In her words: "When clicking 'Haul plan' I don't want to 'run the haul plan' every time I go back
to that page. The only time the haul plan needs to reload is if there's been a change in the sync."

The computed plan lives **only** in React state — `const [plan, setPlan] = useState<RunPlanResult |
null>(null)` in [`PlanScreen.tsx`](<../app/(ui)/plan/PlanScreen.tsx>). Navigating away unmounts the
component, so the plan, the check-off set (`done`), the cursor position (`cur`), and any placement
overrides are all discarded. Coming back gives a fresh form that has to be re-run from scratch.

The route compounds it: [`plan/page.tsx`](<../app/(ui)/plan/page.tsx>) is `export const dynamic =
"force-dynamic"` and `await loadPendingPlacementDraft()` on every request, so each visit also pays a
fresh DB read of the pending queue.

Worth noting this is a side effect of UIL-003 landing, not a regression it caused. Before the fix the
page had nothing to lose — the draft was always empty. Now it arrives pre-loaded with the synced
cards, which is exactly what makes re-running feel like wasted work.

Her invalidation rule is the right one and is cheap to honor, because `runHaulPlan` is a pure
recompute over `loadPlanContext` + the draft. A cached plan is valid until one of these happens:

- a sync apply or undo (changes what is owned, and what is waiting to be placed)
- a haul commit (routes copies, so the queue shrinks)
- she edits the draft (already handled — `mutateDraft` clears the plan today)

Likely fix: persist the run keyed on a version stamp that those three events bump, and rehydrate it
on mount instead of resetting. Check-off progress (`done`, `cur`) should ride along, since losing
your place halfway through physically sorting a stack is the same complaint.

**Priority rationale:** not High — the app works, and re-running is seconds. But this is the top of
Medium: the Haul Plan is the core daily screen, and the loss lands specifically on the pass where
she is standing at the binder working through a stack, which is when re-doing work is most
expensive. Worth fixing before the first real sorting session, not necessarily before go-live.

## UIL-007 — Scroll bar under the card list renders outside the panel border

- **Reported:** 2026-09-13
- **Status:** Fixed — PR [#47](https://github.com/viantihu/pokemon-tcg-tracker/pull/47), awaiting QA review
- **Priority:** **Medium** (raised from Low — see the reproduction below; it is not cosmetic)
- **Area:** Plan — **confirmed by Karvi 2026-09-13**
- **Env:** Testing

In her words: "Upon loading, the scroll bar underneath the card quantity spanned across the page
outside of its borders." Screen confirmed as the Haul Plan.

Still not reproduced directly — `/plan` is auth-gated, so this is read from the source. The scroll
container is the draft list, which is the only thing on the screen that can produce a bar on load:

```css
.draftlist {
  display: flex;
  flex-direction: column;
  max-height: 260px;
  overflow: auto;      /* BOTH axes — a too-wide row yields a horizontal bar */
}
```

**Correcting an earlier guess in this entry:** `.draftrow .di` *does* already set `min-width: 0`, so a
long card name is not the cause. The likelier culprit is new in UIL-003 — the synced-card badge:

```jsx
<span className="tag u">Waiting from sync · {d.dexVariantRaw ?? d.variant}</span>
```

`.tag` is `display: inline-block` with no wrapping or max-width, and `d.dexVariantRaw` is a raw Dex
string ("Reverse Holo", "1st Edition Holofoil"). It renders **only** for rows with an `existingCopyId`,
which is exactly the synced cards that now seed the page. So the badge sets a min-content width that
`.di` cannot shrink below, `.draftlist` overflows horizontally, and `overflow: auto` draws a full-width
bar along the bottom of the list — below the bordered `.draftrow`s, which is where "underneath" and
"outside of its borders" both land. `.draftlist` has no border of its own, so the bar reads as sitting
outside the rows entirely.

This also explains "upon loading" exactly: before UIL-003 the draft was always empty on arrival, so
neither the list nor the badge existed until she typed something.

Ambiguity left for whoever fixes it: "the card quantity" may mean the `{draft.length} cards in the
haul` line, which sits *below* the list — in which case the bar is above it, not underneath, and the
suspect is instead `.strip` (`overflow-x: auto`, `margin-left: 48px`) further down the page. A
screenshot settles it in one look. The fix below covers the draft-list case either way.

Likely fix: `overflow-y: auto` + `overflow-x: hidden` on `.draftlist`, and let `.tag` wrap or cap at
`max-width: 100%` so a long Dex variant string cannot set the row's min width. If it turns out to be
`.strip`, that one needs its `margin-left` moved to padding so the scroll area stays inside the panel.

**Priority rationale:** cosmetic. Nothing is unreachable or mis-recorded, and the fix is a couple of
CSS lines. Post go-live is fine.

**Reproduced, and both earlier hypotheses were wrong (2026-09-13, PR
[#45](https://github.com/viantihu/pokemon-tcg-tracker/pull/47)).** Rather than keep reading the source,
I rebuilt the screen standalone — the real `globals.css`, the real markup, the real
`width=device-width` viewport — and measured it in a browser.

- **Not the draft list, and not the badge.** At a true 375px viewport the seeded rows produce **zero**
  horizontal overflow. `.tag` computes to `white-space: normal`, so the "Waiting from sync · Trick or
  Trade 2023" badge *wraps* instead of setting a min-content width. The entry's corrected guess was as
  wrong as the one it corrected.
- **It is the haul bar's progress strip.** `.xp` renders one pip per card and `.xp i` carries a 2px
  border per side that flex cannot shrink, plus a 3px gap — a hard ~7px floor per card. Measured at 685
  cards on a 375px viewport: the strip is **4792px**, the haul bar overflows its own panel (4805 vs
  341), and **the page scrolls sideways by 4,447px**. Each pip measured exactly 4px, confirming the
  mechanism. That is why "spanned across the page outside of its borders" is literal, and the strip
  sits directly under the `685 cards` count, which matches "underneath the card quantity".
- **Same root cause as the other entries:** only reachable because UIL-003 made the plan arrive
  pre-populated. A typed haul is a handful of pips.

**Priority raised to Medium.** "Cosmetic, a couple of CSS lines" was wrong — the core daily screen
scrolls ~4,800px sideways on a phone, and this is a PWA she installs. Nothing is mis-recorded, so not
High.

Fix: `progressPips` (`lib/plan/progress.ts`) caps the strip at 40 pips — exact and per-card below the
cap so a normal haul is untouched, proportional buckets above it, with the precise figures already
shown as `N / total` beside the strip. Plus CSS guards so no future count can repeat it:
`min-width: 0` and `overflow: hidden` on `.xp`, `overflow-x: hidden` on `.draftlist` (the entry's
suggestion — right fix, wrong cause), and `max-width: 100%` on `.tag`. Re-measured after: strip 243px,
page overflow **gone**.

The `.strip` alternative above is not implicated — it belongs to the line-detail screen, not the Haul
Plan.

## UIL-008 — No progress indication during long operations

- **Reported:** 2026-09-13
- **Status:** Open
- **Priority:** Medium (Claude's read — could argue Low)
- **Area:** Sync, Plan
- **Env:** Testing

In her words: "Anytime there's a longer process (syncing inventory, creating haul plan), I want to
see a progress bar."

Today both long operations show only a disabled-button state: the Plan's run button swaps its label
to "Running…" ([PlanScreen.tsx:464](<../app/(ui)/plan/PlanScreen.tsx>:464)) and the Sync screen
flips a `busy` flag. There is no bar and no sense of how far along anything is.

One design constraint to settle before building it. A **determinate** bar needs the server to report
progress, and neither operation is structured to do that yet — each is a single server action that
returns once, so there is nothing to poll or stream mid-flight. Two honest options:

1. **Indeterminate** activity bar wherever `busy` is already tracked. Cheap, no server change, and
   it fixes "is this hung or working?" which is the actual anxiety.
2. **Determinate** bar, which means breaking each operation into reported steps — for sync, that maps
   naturally onto parse → resolve → classify → apply, and resolve is the slow one because it is
   per-row. Real work, and it is where a percentage would actually be meaningful.

Recommend shipping (1) now and (2) for sync only, since sync is the operation whose duration scales
with her collection. The catalog mirror is deliberately excluded: it is a GitHub Actions job, not an
in-app operation, so its progress belongs in the run log rather than the UI.

**Priority rationale:** Medium rather than Low because a silent multi-second operation is
indistinguishable from a hung one, and the fix for that is small. Called out as the softest of the
three, though — nothing is broken, so Low is defensible if she would rather this wait.


## UIL-009 — Clicking outside the collection popup discards everything typed

- **Reported:** 2026-09-13
- **Status:** Open
- **Priority:** High (Karvi's call)
- **Area:** Collections
- **Env:** Testing

In her words: "If I click out of a popup while creating a collection, the collection does not save, so
I have to start on my own."

Confirmed in the source. The collection editor is wrapped in a click-to-dismiss backdrop
([CollHub.tsx:512](<../app/(ui)/coll/CollHub.tsx>:512)):

```jsx
<div className="veil on" onClick={(e) => e.target === e.currentTarget && onClose()}>
```

and the host discards the editor outright ([CollHub.tsx:206](<../app/(ui)/coll/CollHub.tsx>:206)):

```jsx
onClose={() => setEditor(null)}
```

So a single stray click anywhere outside the panel unmounts the editor and throws away its state. No
confirmation, no draft retained, no undo. Building a finite collection means picking cards one at a
time, so the amount of work at risk grows the longer she stays in the dialog — the cost of the misclick
is highest exactly when she is nearly done.

The second modal on the screen has the same backdrop handler
([CollHub.tsx:644](<../app/(ui)/coll/CollHub.tsx>:644)) but it is the read-only log viewer, so
dismissing it loses nothing. This entry is only about the editor.

Likely fix, in order of preference:

1. Stop treating a backdrop click as dismiss for the editor. It is a form, not a lightbox. Keep Escape
   and the explicit Cancel button as the ways out.
2. If backdrop-dismiss stays, guard it: only auto-close when the form is untouched, and otherwise ask
   before discarding.
3. Independently, keep the editor's state alive across an accidental close (lift it out of the modal or
   hold the last draft) so "start over" is never the only option.

(1) alone resolves the report and is a one-line change. (3) is the durable version.

**Priority rationale:** High, agreed. It destroys work she has already done, with no recovery and no
warning, in the normal course of using the feature — and misclicks near the edge of a dialog are
routine, not exotic. Nothing about it is cosmetic.

## UIL-010 — Card search returns nothing for a full collector number like "099/182"

- **Reported:** 2026-09-13
- **Status:** Open
- **Priority:** High (Karvi's call)
- **Area:** Lookup / Collections
- **Env:** Testing

In her words: "In the search for cards while building a finite collection, I cannot search by the full
collectors number e.g. The search does not recognize 099/182 as a Minior card. In fact, it does not
return anything at all."

Reproduced by reading the query. `catalogCardRepo.search`
([catalog-card.ts](../lib/repo/catalog-card.ts)) builds one `ilike` per column from the raw string:

```ts
const q = query.replace(/[,()%*]/g, " ").trim();   // note: "/" is NOT stripped
const like = `%${q}%`;
.or(`name.ilike.${like},set_name.ilike.${like},local_id.ilike.${like},tcgdex_id.ilike.${like}`)
```

Typing `099/182` searches for the literal substring `099/182` in the name, set name, collector number
and TCGdex id. No column ever contains a slash, so **every** predicate fails and the result is empty —
which is exactly the "nothing at all" she saw, rather than a wrong-match problem.

Two distinct defects behind it:

1. **The printed form is never parsed.** `099/182` is `number/setTotal` — what is actually printed on
   the card and what a set checklist lists. `local_id` holds only the numerator. Nothing splits on the
   slash, so the denominator poisons the match.
2. **Padding is not normalized.** The schema is explicit that `local_id` keeps TCGdex's padding
   verbatim and that it *varies by set* — `0002_domain.sql` comments the column as "EXACT padding
   ('027','82')". So even `099` on its own fails against a set that stores `99`, and `99` matches
   `199`, `299`, `990` as substrings.

**Most of the fix already exists and is tested.** `lib/sync/resolve.ts` solves the padding half for the
sync engine and the Lookup search simply never calls it:

```ts
localIdCandidates("099")  // -> ["099", "99"]   (verbatim, zero-pad-3, stripped)
```

Suggested fix: parse a leading `NNN/TTT` (and bare `NNN`) out of the query, run the numerator through
`localIdCandidates`, and match `local_id` with equality against each candidate rather than `ilike`,
while keeping the existing free-text predicates for names. An exact-number match should also sort
ahead of name matches.

One constraint worth stating: **the `/182` cannot be used.** There is no set-total column on
`catalog_card`, so the denominator can only be discarded, not matched. Counting rows per `set_id` is not
a substitute — printed totals exclude secret rares, so the count and the printed total disagree by
design. Discarding it is correct, not a shortcut.

**Priority rationale:** High, agreed, and her framing is the reason. A finite collection is built from a
set checklist, and a checklist is a list of collector numbers — the number *is* the natural key for this
workflow, not the name. Searching by name is a workaround for a card she can already name, which is not
the case she is in. It also fails silently and totally, which reads as "the card isn't in the app."

## UIL-011 — Remove internal catalog-mirror language from the UI

- **Reported:** 2026-09-13
- **Status:** Open
- **Priority:** Low
- **Area:** Lookup, Plan, Backfill, Collections, Sync
- **Env:** Testing

In her words: "I want to remove all language about pull from catalog mirror. The end user does not need
to know these things."

The mirror is an implementation detail — that the app keeps a local copy of TCGdex rather than querying
it live is not something the reader of an empty-state message needs to reason about. Worse, the current
copy asks her to act on it ("needs a sync run"), which invites the wrong conclusion when a search simply
misses.

User-visible strings to rewrite:

| Location | Current |
| --- | --- |
| [CardLookup.tsx:77](<../app/(ui)/_components/CardLookup.tsx>:77) | "Searching the mirror…" |
| [CardLookup.tsx:81](<../app/(ui)/_components/CardLookup.tsx>:81) | "No match in the local mirror. (Full catalog needs a sync run.)" |
| [LookupScreen.tsx:53](<../app/(ui)/look/LookupScreen.tsx>:53) | "Not in the local mirror. A full catalog needs a sync run." |
| [BackfillScreen.tsx:340](<../app/(ui)/backfill/BackfillScreen.tsx>:340) | "Could not resolve that species from the mirror." |
| [CollHub.tsx:429](<../app/(ui)/coll/CollHub.tsx>:429) | "CSV MIRRORS BACK INTO DEX FOR SCANNING" |
| [SyncScreen.tsx:436](<../app/(ui)/sync/SyncScreen.tsx>:436) | "…they self-heal when the catalog catches up" |

Scope note: only rendered strings. The same words appear throughout code comments and module docs, where
"mirror" is the correct precise term for what the code does — those stay. The word "catalog" on its own
is fine to keep where it means "the set of cards that exist"; what goes is the plumbing ("local mirror",
"a sync run", "self-heal") and the implication that she should do something about it.

Suggested replacements are a copy call rather than an engineering one, so these are starting points:
"Searching…", "No card found." / "No match — check the number or try the card name.", and for the sync
queue something that states the situation without the mechanism ("Not in the card list yet. These stay
here and are added automatically once they appear.").

Worth pairing with UIL-010: the empty state she hit on `099/182` is exactly the message above, so the
old copy actively misled her about why the search failed. Fixing the search without fixing the message
still leaves the next miss confusing.

**Priority rationale:** Low as a defect — nothing malfunctions and no data is at risk. Flagged as worth
doing alongside UIL-010 anyway, since the two land on the same screen and the same moment of confusion.
