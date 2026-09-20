# User-Reported Issue Log

Feedback from Karvi testing the running app. One entry per issue, appended in the order
reported. Claude maintains this file: when Karvi reports something during a testing session,
add an entry here before starting any fix.

**Not** a substitute for GitHub issues. This is the raw capture — what she saw, in her words.
Anything that becomes real work gets a linked PR in the entry.

## Fields

- **Status** — `Open` · `Investigating` · `Fixed` (code merged — not the same as deployed and
  confirmed; entries carry that distinction in prose when it matters) · `Closed` (Karvi confirmed
  on a running environment) · `Won't fix` · `Not a bug`
- **Priority** — set jointly by Karvi and Claude. Claude proposes, Karvi has final say.
  - `High` — the app is not functional. Cannot go live without a resolution.
  - `Medium` — should be addressed sooner rather than later, but not urgent.
  - `Low` — does not block functionality. Can be addressed post go-live.
- **Area** — the screen or subsystem: Plan, Lookup, Lines, Collections, Backfill, Sync,
  Binders, Settings, Auth, Catalog, Deploy
- **Env** — where it was seen: Testing, Production, local

Priority is about impact on go-live, not effort to fix. When Claude's and Karvi's reads differ,
the entry records both.

**This file lags live status by design, and that is a known cost of the write convention, not an
error.** Status transitions batch behind a single owning session rather than racing each entry's
write to avoid clobbering concurrent writers — so at any given moment some entries may show `Open`
after being confirmed Fixed or Closed elsewhere. **For a queue-gating question — "is X actually
unblocked, can Y start now" — check with whoever currently owns status transitions; do not read
that answer off this file alone.** Content (root cause, evidence, priority rationale) is always
current as of its last write; only the Status field itself can lag.

---

## UIL-001 — "Back half from page" gives no indication of what it means

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#42](https://github.com/viantihu/pokemon-tcg-tracker/pull/42) MERGED to `develop`, QA-reviewed, deployed to Testing. Awaiting Karvi's confirmation; the binder-form layout was proven against the real DB view but not rendered in a browser, so her pass is the visual check. **Confirmed resolved by Karvi on Testing.**
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
- **Status:** **Closed** — PR [#42](https://github.com/viantihu/pokemon-tcg-tracker/pull/42) MERGED to `develop`, QA-reviewed, deployed to Testing. Awaiting Karvi's confirmation; the binder-form layout was proven against the real DB view but not rendered in a browser, so her pass is the visual check. **Confirmed resolved by Karvi on Testing.**
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

**Confirmed exercised end to end at real scale, not just PGlite (2026-09-14).** Read from Testing:
**702** `placement_decision` rows against her ~685-row export, **0** unplaced copies remaining. Not
just merged — she has placed essentially her entire import through this path.

**And the "silently doubles her counts" fear is now falsified by measurement, on a real repeat import
(2026-09-14).** Karvi ran a *second* sync of her dex export; it added **+2 copies, not +702**. The
reconciler correctly saw the existing 702 already in the collection and added only the genuinely new
cards. This entry's original warning — that retyping/re-importing would double her counts — was the
reason routing (not re-inserting) was built; this is the first time that path has been proven against an
actual repeat import rather than a test fixture.

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
- **Status:** **Closed** — PR [#46](https://github.com/viantihu/pokemon-tcg-tracker/pull/46) removed the
  Management-API dependency entirely, and the last outstanding item (`SUPABASE_ANON_KEY` on the `testing`
  environment) was set by Karvi 2026-09-14 02:23Z. **Deploy is now green end to end** — run
  [`34799214277`](https://github.com/viantihu/pokemon-tcg-tracker/actions/runs/34799214277) on `15a79de`:
  `Vercel` · `migrate` · `smoke` · `acceptance` all success. **Not caused by a misconfiguration on
  Karvi's side** — see the correction at the end of this entry.
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
- **Status:** **Closed** — PRs [#44](https://github.com/viantihu/pokemon-tcg-tracker/pull/44) (squash
  `7d967d3`) and [#48](https://github.com/viantihu/pokemon-tcg-tracker/pull/48) (squash `76ec4d7`)
  merged to `develop`, and **confirmed resolved by Karvi on Testing 2026-09-13**.
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

**Resolution (2026-09-13, PRs #44 + #48).** Her invalidation rule implemented as stated.

- #44 caches the run in `sessionStorage` keyed on a state stamp (`lib/plan/fingerprint.ts`) and
  rehydrates on mount, carrying the check-off set and cursor along so a half-finished sorting pass
  survives navigating away. The cache **drops** on a stamp mismatch rather than rendering stale.
- #48 fixed the stamp, which was the load-bearing half. #44 hashed plain **counts** for copies,
  lines and slots, so the two in-place edit paths on the M7 line screen — moving a copy between
  binder halves, and resolving a line slot — changed what the cascade routes to while leaving the
  count identical. A returning visit then served a cached plan tagged `RESUMED` computed against
  state that had moved, which could silently flip "duplicate → bulk" into "shelve it". The stamp now
  carries the placement-bearing columns themselves (a multiset of copy placement tuples, plus slot
  and line rows), with the `placement_decision` count as a backstop for any write not enumerated.

**Closed by Karvi 2026-09-13** on Testing.

## UIL-007 — Scroll bar under the card list renders outside the panel border

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#47](https://github.com/viantihu/pokemon-tcg-tracker/pull/47) MERGED to
  `develop` (squash `0224383`), and **confirmed resolved by Karvi on Testing 2026-09-14**. The strip was
  measured in a 375px harness during development; her pass is the confirmation in the running app.
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
- **Status:** **Closed** — PR [#64](https://github.com/viantihu/pokemon-tcg-tracker/pull/64) MERGED to
  `develop` (squash `88a546c`), QA-reviewed, confirmed **deployed** to Testing. Shipped **option (1)
  only**, an indeterminate activity bar, and the PR argues *against* the determinate bar this entry
  recommended — see the resolution note. Awaiting Karvi's confirmation, including the question of whether
  the bar still earns its place now that UIL-020 has made the sync much faster. **Confirmed resolved by Karvi on Testing.**
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
- **Status:** **Closed** — PR [#56](https://github.com/viantihu/pokemon-tcg-tracker/pull/56) MERGED to
  `develop` 2026-09-14 (squash `0f16007`), QA-reviewed, and confirmed **deployed** to Testing on
  `258db13` (`Vercel`/`migrate`/`smoke`/`acceptance` all green). Awaiting Karvi's confirmation — the
  behaviour is interaction-only and was never exercised in a browser. **Confirmed resolved by Karvi on Testing.** Note her later ruling: the confirm-on-dismiss dialog this added was subsequently REMOVED by UIL-038's autosave, and she confirmed that removal too — so this entry is closed on the behaviour that shipped here, not on a dialog that still exists.
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

**Resolution (2026-09-13, PR [#56](https://github.com/viantihu/pokemon-tcg-tracker/pull/56)).** Took
option (1) as recommended — **the backdrop no longer dismisses the editor at all.** It is a form, not a
lightbox.

Went further than the entry on the other two exits, because they would have left the same hole: Close
and Escape destroyed the same work just as silently. Both now confirm, but **only once something has
changed**, so dismissing an untouched dialog is still a single click. "Dirty" is measured against the
state captured when the editor opened, not against emptiness — editing an existing collection starts
populated, so an emptiness test would nag on every open. Escape had **no handler at all** before, which
the entry assumed it did; it has one now, routed through the same guard, since a modal with no keyboard
exit is its own problem.

Option (3) — keeping the draft alive across an accidental close — is not needed once none of the three
exits can discard silently, and it would mean lifting editor state out of the modal for a case that can
no longer happen. Left undone deliberately rather than overlooked.

The read-only log modal keeps backdrop-dismiss: nothing there can be lost.

Not verified in a browser — the screen needs credentials this session lacks, so the guard logic is not
exercised end to end. Worth one pass: try all three exits on a part-built collection (backdrop should do
nothing; Close and Escape should ask), then confirm an untouched dialog still closes in one click.

## UIL-010 — Card search returns nothing for a full collector number like "099/182"

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#55](https://github.com/viantihu/pokemon-tcg-tracker/pull/55) MERGED to
  `develop` 2026-09-14 (squash `15a79de`), QA-reviewed, deployed to Testing, and **confirmed resolved by
  Karvi on Testing 2026-09-15**: a full collector number is found. Note PR [#58](https://github.com/viantihu/pokemon-tcg-tracker/pull/58) (squash
  `d40536c`) follows it with a comment-only change recording that `localIdCandidates` in
  `lib/sync/resolve.ts` is now load-bearing for **search** as well as sync — a change to its padding
  rules moves two subsystems, and nothing in the file said so.
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

**Resolution (2026-09-13, PR [#55](https://github.com/viantihu/pokemon-tcg-tracker/pull/55)).** Fixed at
`catalogCardRepo.search`, which is where **all five** search surfaces (plan, backfill, collections,
lookup, sync) bottom out, so one fix covers every one.

`parseCardQuery` (`lib/catalog/collector-number.ts`) pulls a printed number out of the query and
discards the denominator, then runs the numerator through the existing tested `localIdCandidates` for
the padding half. `local_id` is matched by **equality against the candidates**, not `ilike` — a
substring `99` also matches `199`, `299` and `990`. The exact-number query runs separately from the
free-text one and ranks above it, because a shared `limit` would let a dozen name matches crowd out the
card she actually asked for. The `/` is now stripped from the free-text pattern too; leaving it in was
what made every predicate fail.

Also handles `minior 099` (searches name and number), `TG05/TG30`, and a bare `99`. A set code like
`sv03` is deliberately NOT read as a number.

The entry's constraint on the denominator is confirmed and kept: there is no set-total column, and
counting rows per `set_id` is not a substitute, because printed totals exclude secret rares — `Shuckle
136/132` legitimately exceeds its own denominator. Discarding it carries no information loss the catalog
could have checked.

24 new tests (14 parser, 10 on the search itself over a fake `DbClient`: ranking, exact-vs-substring,
dedup across the two queries, digital-only exclusion, limit). Not verified in a browser — the screens
need credentials this session lacks, so the parse and ranking logic is unit-tested but the live
type-ahead ordering is not exercised end to end.

**Left alone deliberately:** the empty-state copy ("No match in the local mirror…") belongs to UIL-011.
Worth noting for that triage though — the string was accurate when Testing held 3 cards, but the mirror
is now complete (23,548 cards / 214 sets), so it now advises a sync run that has already happened.

## UIL-011 — Remove internal catalog-mirror language from the UI

- **Reported:** 2026-09-13
- **Status:** **Fixed** — PR [#259](https://github.com/viantihu/pokemon-tcg-tracker/pull/259) MERGED to
  `develop` 2026-09-20 (squash `e67d9ab`), QA-gated on the merged tree (981 tests; the five screens
  reverted to the old wording fails all 9 cases of the new `tests/ui/no-plumbing-language.test.ts`, one
  string restored fails 3), confirmed **deployed** to Testing (Deploy, migrate, smoke, acceptance and
  Vercel green on `e67d9ab`). Six rendered strings rewritten, in Karvi's reviewed wording: the search grid
  says "Searching…" and "No card found — check the number or try the card name."; the Lookup empty answer
  says the same; the Backfill banner says "Could not find that species' evolution line."; the Sync note
  says the waiting rows "resolve automatically once the card is in the catalog"; the Collections footer
  says "CSV EXPORTS BACK INTO DEX FOR SCANNING". Code comments and module docs keep "mirror" as the
  precise term; the three "Waiting on catalog" labels stay under this entry's own rule, and her
  2026-09-14 broadening ("database", "entry") is a wider pass awaiting her word. Step for Karvi when UAT
  resumes: search for a number that does not exist, open Lookup with no match, and read Sync's waiting
  note; none should mention a mirror or a sync run.
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

**Broadened (2026-09-14, Karvi, low priority per her own framing).** Her fuller direction: "any time
there is mention of the 'catalog' or 'mirroring' I want to replace it with more 'vintage' language like
database or entry." This goes further than the original scope above, which kept "catalog" where it means
"the set of cards that exist" — she now wants the word itself gone in favor of period-appropriate
terms ("database," "entry"), not just the sync-mechanism implications. Recording as a direction for
whoever does the copy pass rather than rewriting the string table above: the destination vocabulary
changed, the "don't expose the plumbing" principle didn't.

## UIL-012 — Committing a haul fails with a foreign-key violation on `color_band`

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#57](https://github.com/viantihu/pokemon-tcg-tracker/pull/57) MERGED to
  `develop` 2026-09-14 (squash `474df08`), QA-reviewed, deployed to Testing on `258db13`, and **exercised
  on Karvi's real data 2026-09-14**: `placement_decision` went 0 → 1 after her own haul commit with no
  `color_band` FK crash. Closed on that measurement rather than a verbal confirmation (weaker evidence,
  recorded as such — see the confirmation paragraph below). **The trigger was NOT the config tables** —
  see the correction at the end of this entry, which overturns the two narrowings above it.
- **Priority:** High
- **Area:** Plan
- **Env:** Testing

**Exercised on Karvi's real data 2026-09-14 (the confirmation this entry had been waiting for).** On her
Testing environment after a real haul commit, `placement_decision` went 0 → 1 — a card was placed and
committed with no `copy_color_band_fkey` crash. The fix isn't just merged and PGlite-verified; it has now
run against her actual collection. (Status transition to Closed is the Senior BA's to record; recording
the confirming measurement here as content.)

Verbatim error she hit on commit:

```
insert or update on table "copy" violates foreign key constraint "copy_color_band_fkey"
[code: 23503; details: Key is not present in table "color_band".]
```

She noted she had not checked off every item in the haul. That is not the cause — check-off is a
physical worklist aid only; `commitHaulAction` sends the whole `input.draft` regardless of what is
ticked. The commit is atomic (`apply_write_ops`), so **nothing was half-written** — the whole haul
rolled back.

### Root cause: `band()`'s fallback returns a display name into DB-key space

Two vocabularies exist for a colour band, and they are deliberately kept apart:

| | Values |
| --- | --- |
| DB (`color_band.band`, the FK target) | `red`, `dark_blue`, `light_blue`, `white` … |
| Engine display names (`BAND_ORDER`) | `Red`, `Dark blue`, `Light blue`, `White` … |

[`lib/plan/adapt.ts`](../lib/plan/adapt.ts) documents the contract explicitly: the engine is fed the
DB `type_color_map` so that it "operates entirely in DB-key space," which keeps a stored
`copy.color_band` equal to `band(card, map)`. `lib/plan/context.ts` honours it — `typeColorMap` and
`orderedBandKeys` are both built from DB rows, and `DEFAULT_TYPE_COLOR_MAP` is referenced nowhere
outside `bands.ts`.

The fallback breaks the contract ([`lib/engine/bands.ts`](../lib/engine/bands.ts)):

```ts
export const WHITE: Band = "White";          // display name

export function band(card, map: TypeColorMap): Band {
  const resolved = map[effectiveType(card)];
  return (resolved as Band) ?? WHITE;         // <-- leaves DB-key space on any miss
}
```

On a hit the value is a DB key (`white`). On a **miss** it is the literal `"White"`, which is not a
row in `color_band` — so the insert violates `copy_color_band_fkey`. The catch-all that exists to
make unmapped cards safe is the one path that makes them fail.

`bandPosition()` has the mirror-image assumption: it looks its argument up in `BAND_ORDER`, so a
DB-key band always scores "unknown, sort last." Grouping still works because `groupPlan` is given
`orderedBandKeys`, but the helper is wrong for every real value it will see.

### What triggers a miss

`effectiveType` returns `types[0]`, else `trainerType`/`"Trainer"` for Trainers, else `"Colorless"`.
The DB map covers Fire, Fighting, Lightning, Dragon, Grass, Darkness, Water, Psychic, Fairy,
Colorless, Metal, Trainer, Supporter, Item. Every path *should* land on one of those, which is why
this survived 258 tests and the seed's three cards. Candidates for what actually missed, in order:

1. **A `types[0]` value outside the 14 keys**, now that the catalog holds 23,548 real cards
   rather than 3. This is the first haul run against real mirrored data.
2. **`type_color_map` empty or short on Testing.** Filled by migration `0003_config.sql`, and
   migrations only started reaching Testing again with #46 at 01:20Z. If the table is empty, *every*
   card misses and no haul can ever commit.
3. A stored `types` value that is not canonical English (casing or locale drift from a set mirrored
   outside `/en/`).

**One question separates (1) from (2) in a single glance: did the plan group her cards into several
named colour bands, or did everything land in one band?** An empty `type_color_map` sends *every*
card to the same fallback, so a single undifferentiated band means cause (2) and no haul can commit on
Testing at all. Several correctly-named bands with one card failing means cause (1), and then the
card list for that haul names the offending type.

### Fix

The one-line correction is to make the fallback resolve in the caller's space rather than return a
constant: fall back to the map's own white key (or accept the white key as a parameter) so an
unmapped type lands in the white band instead of violating the FK. Worth pairing with:

- a guard in `commitHaul` that rejects a band not present in `orderedBandKeys` **before** the write,
  so the failure names the card and the type instead of surfacing raw Postgres;
- a startup or context-load assertion that `type_color_map` and `color_band` are non-empty, which
  would make cause (2) visible instantly rather than as a 23503 at commit time;
- `bandPosition` taught to accept DB keys.

**Priority rationale:** High. It blocks committing a haul, which is the app's core daily loop and the
whole point of the product, and it appeared on the first real run against the populated catalog — so
it is squarely in the way of go-live rather than an edge case. It is loud and non-corrupting (atomic
rollback, nothing partially saved), which is the good version of this failure, but the operation is
unavailable until it is fixed. If cause (2) is what happened, *no* haul can commit on Testing at all.

### Narrowed 2026-09-14 — real card data cannot trigger this; suspect the config tables

Two checks changed the diagnosis, so whoever picks this up should **not** go hunting for an exotic card
type.

**1. Every type real data can produce is mapped.** TCGdex's canonical lists:

- `GET /v2/en/types` → `Colorless, Darkness, Dragon, Fairy, Fighting, Fire, Grass, Lightning, Metal,
  Psychic, Water` — **all 11 are in `type_color_map`.**
- `GET /v2/en/trainer-types` → `Item, Rocket's Secret Machine, Stadium, Supporter, Technical Machine,
  Tool`. Four of those are *not* mapped — but they can never reach the map, because
  `toCatalogCard` hardcodes `trainerType: null` (the column does not exist on `catalog_card`), so
  `effectiveType` collapses every Trainer to the literal `"Trainer"`, which **is** mapped.

Tracing `effectiveType` for a DB-loaded card, all three branches land on a mapped key: `types[0]` (11/11
mapped), `"Trainer"` (mapped), or the `"Colorless"` fallthrough (mapped). **So hypothesis (1) is out.**

**2. Migration `0003_config.sql` *is* applied on Testing.** Verified in Deploy run `34796853747`:

```
Local migrations:              0001 0002 0003 0004 0005 0006 0007
Applied on this environment:   0001 0002 0003 0004 0005 0006 0007
Schema matches the repo: all 7 migrations applied.
```

So the migration that fills both config tables has run. That weakens the plain "empty table" version of
hypothesis (2) — but **it does not clear the data**, for a specific reason: 0003 inserts with
`on conflict do nothing`. If either table was ever populated by hand with **display-name** values
(`color_band.band = 'Red'`, or `type_color_map.band = 'White'`), those hand-written rows do not conflict
with the migration's key-form rows, so the migration would silently add its own alongside them and
report success. A `type_color_map` row whose `band` reads `'White'` returns `'White'` straight out of
the map — no fallback involved — and violates the FK exactly as observed.

**Therefore the remaining candidates, in order:**

1. `type_color_map` holds one or more rows whose `band` value is a display name rather than a key, so
   the map returns an invalid band without ever touching the fallback.
2. `color_band` is missing the row the map legitimately points at (e.g. no `white`), so a correct
   lookup still fails the constraint.
3. The `band()` fallback is genuinely being hit because a needed `type_color_map` row is absent.

All three are **data** questions answerable in one query, which this session cannot run (no service
key):

```sql
select band, display_name, position from color_band order by position;
select card_type, band from type_color_map order by card_type;
```

Expect exactly the ten key-form bands and the fourteen mappings listed in `0003_config.sql`. Anything
capitalised or missing is the bug.

**The `band()` fallback should still be fixed** — returning a display-name constant from a function
documented to work in DB-key space is a latent defect that will bite the next unmapped type whether or
not it is what broke this commit. But it is now the *second* thing to do, not the first.

### Corrected 2026-09-14 — the fallback IS the defect, and the trigger is a missing config row

**Retracting the two candidates above.** The "display-name row in `type_color_map`" and "`color_band`
missing the row the map points at" hypotheses are both impossible, for one reason I missed:
[`0002_domain.sql:38`](../supabase/migrations/0002_domain.sql:38) constrains the map to the band table.

```sql
create table type_color_map (
  card_type text primary key,
  band      text not null references color_band (band)   -- <-- FK
);
```

Every value the runtime map can hold is therefore FK-guaranteed to exist in `color_band` already. A
`type_color_map` row reading `'White'` would *require* a `color_band` row `'White'`, and if that row
exists then `copy.color_band = 'White'` satisfies `copy_color_band_fkey` and there is no error. The
hypothesis cancels itself. Credit to the tech-lead session for catching it.

**What remains is a single path, and it is a code defect.** Since every *successful* lookup returns an
FK-valid key, the only way `copy.color_band` receives an absent value is the fallback:

```ts
export const WHITE: Band = "White";           // DISPLAY name
export function band(card, map): Band {
  const resolved = map[effectiveType(card)];
  return (resolved as Band) ?? WHITE;          // fires only when the lookup is UNDEFINED
}
```

`lib/engine/bands.ts` is written wholly in **display space** — `BAND_ORDER` is `"Red"…"White"` and
`DEFAULT_TYPE_COLOR_MAP` is `Fire: "Red"`. Production runs it in **key space**, because
`lib/plan/context.ts:144` builds the map straight from DB rows (`'red'`, `'dark_blue'`, `'white'`). A
hit returns key form and inserts cleanly; the fallback returns `"White"`, which no `color_band` row
matches, and the insert dies with exactly the error she saw.

**So the trigger is a `type_color_map` row that is *absent*, not mis-cased.** The fallback fires only on
`undefined`. Karvi is the only one who can check this — the DB password and secret key exist only in
GitHub secrets and Vercel env, and nothing surfaces their values, so no session here can query Testing.
Supabase SQL editor, project `cpmwdcmokbgcpmkvbtsw`:

```sql
select count(*) from type_color_map;                       -- expect 14
select card_type, band from type_color_map order by card_type;
```

Expected rows: `Colorless→white, Darkness→dark_blue, Dragon→olive, Fairy→pink, Fighting→orange,
Fire→red, Grass→green, Item→white, Lightning→yellow, Metal→white, Psychic→purple, Supporter→white,
Trainer→white, Water→light_blue`. **A missing `card_type` names the card class that crashes her commit.**
If all 14 are present and correct, this trace is wrong and it goes back to the drawing board.

**Both halves need fixing, and the order matters for the write-up:** the missing row is the *trigger*,
the broken fallback is the *defect*. Restoring the row unblocks her; leaving the fallback alone means
the next missing row does this again. A missing config row should degrade to the white band, which is
what the catch-all was written to do.

**Why 374 green tests missed it.** Every engine test injects `DEFAULT_TYPE_COLOR_MAP`, which is display
form (`tests/engine/bands.test.ts`, `cascade.test.ts`, `line.test.ts` all set `MAP =
DEFAULT_TYPE_COLOR_MAP`). Nothing anywhere exercises `band()` against a key-form map, so the engine is
verified only in a space production never uses. **A regression test for this has to inject key-form
bands**, or it will pass while the bug is live.

**Related dead code, same root confusion.** `app/(ui)/coll/actions.ts:87` reads
`band(toCatalogCard(row), typeColorMap) ?? "white"`. The `?? "white"` can never fire, because `band()`
returns the `WHITE` constant rather than anything nullish. Someone sensed the hazard and guarded it in
the wrong place — worth fixing alongside, since it currently reads as protection that does not exist.

`bandPosition()` remains wrong for the same reason noted in the original entry: it indexes
`BAND_ORDER`, so every real key-form band scores "unknown, sort last."

### Resolution 2026-09-14, PR [#57](https://github.com/viantihu/pokemon-tcg-tracker/pull/57) — and both narrowings above were wrong about the trigger

**The config tables were never at fault.** Read twice against live Testing nine minutes apart, via a
read-only `workflow_dispatch` job using the existing `SUPABASE_SERVICE_ROLE_KEY` (runs
[`34798772519`](https://github.com/viantihu/pokemon-tcg-tracker/actions/runs/34798772519) and
[`34799273970`](https://github.com/viantihu/pokemon-tcg-tracker/actions/runs/34799273970)): **ten
key-form bands, all fourteen mappings, no orphans, nothing capitalised** — matching `0003_config.sql`
exactly. So no missing row, no mis-cased row, and **no corrective migration was needed.**

**The real trigger bypasses the map entirely.** `lib/engine/cascade.ts:378` — STEP 6, Trainer /
Supporter / Item / Energy — hard-coded the display literal:

```ts
target: { kind: "front-half", binderId: frontHalfBinderId(ctx, "White"), band: "White" },
```

Every other cascade step routes through the injected key-form map. STEP 6 alone stored `"White"`, which
no `color_band` row matches. And `lib/plan/adapt.ts:82` sets `category: isNonPokemon ? "Trainer" :
"Pokemon"`, so **every** non-Pokémon card lands there — one Trainer or Energy card in a haul killed the
entire commit. This was never an edge case; it fired on any real haul.

It also explains the symptom nobody had accounted for: the **plan preview** computed the band via
`band(card, map)` and got `white`, while the **commit** used `result.target.band` and got `"White"`. The
preview looked correct and only the commit failed, after she had built the whole haul.

**Shipped in #57:** STEP 6 uses the map's white key; `band()`'s fallback resolves via `whiteKey(map)`
rather than a constant; `assertPlacementBandsConfigured` guards the write set in `commitHaul` so any
future band mismatch names **the card and its type** instead of surfacing a raw 23503;
`assertBandConfig` fails fast at plan-context load if the config tables are empty or hold a non-key
band; `bandPosition` accepts DB keys. Reproduction pinned on PGlite against the real 0001–0007
migrations and the real `apply_write_ops`: a Nest Ball (Trainer/Item) now commits with
`color_band = 'white'`, and **reverting only the STEP 6 line makes that test fail with
`copy_color_band_fkey`**. 370 passing, +12 new. No worked example changed its answer.

Note `assertBandConfig` is **provably not the fix** — the config read shows it passes on Testing today.
It guards a future hand-edit. Recording that explicitly so it is not later remembered as what resolved
UIL-012.

**Process lesson, worth more than the bug.** This entry was narrowed twice toward the config tables, and
by the third round the narrowing was being treated as a premise rather than a hypothesis. Three sessions
agreed with each other; none had checked whether `copy.color_band` had a second writer. It does. The
available inference from *"the map is clean and has no unmapped types"* was that **something bypasses the
map** — and that inference was reachable without any new data. A fourth session found it by testing the
narrowing instead of building on it. When writing a narrowing, mark plainly what is **verified** versus
what is **inferred**.

## UIL-013 — Engine tests run in a colour-band vocabulary production never uses, so band bugs pass a green suite

- **Reported:** 2026-09-13 (not from Karvi — surfaced during UIL-012's investigation, independently
  confirmed from two directions)
- **Status:** **Fixed** — PR [#237](https://github.com/viantihu/pokemon-tcg-tracker/pull/237) MERGED to
  `develop` 2026-09-20 (squash `e5203b8`), QA-gated on the merged tree (890 tests; re-introducing UIL-012's
  exact shape, `band()` returning the "White" literal for Trainers, fails three named tests that could not
  fail under the old display-form map; `whiteKey` → `WHITE` fails the three fallback tests). Test-only,
  zero behaviour change: every engine suite now runs on `KEY_FORM_TYPE_COLOR_MAP`, built from migration
  0003's rows the same way `lib/plan/context.ts` builds production's map, and `DEFAULT_TYPE_COLOR_MAP` is
  deleted (zero readers in `lib/`, `app/` or `tests/`). `BAND_ORDER` (the `Band` type derives from it) and
  `WHITE` (last-resort fallback) are kept, readers listed in the PR. No branded type: that is the RCA's
  RC-1 and stays parked until UAT closes. Nothing for Karvi to test; closes on evidence. Karvi never ruled
  the priority; the Medium read stands as recorded.
- **Priority:** Medium (Senior BA's proposed read — Karvi has not ruled yet)
- **Area:** Plan / Engine (test infrastructure)
- **Env:** n/a — the defect is in the repo, not a running environment

Not a UAT report. Logged here because it is the reason a High-priority, core-loop-breaking defect
(UIL-012) shipped past a fully green test suite, and it will do so again on the next band change.

**The finding.** Two vocabularies exist for a colour band, deliberately kept apart: DB keys (`red`,
`dark_blue`, `white`) and engine display names (`Red`, `Dark blue`, `White`).
[`lib/plan/adapt.ts:9-10`](../lib/plan/adapt.ts:9) documents the contract — the engine is fed the DB
`type_color_map` "and it operates entirely in DB-key space." [`lib/plan/context.ts:143-144`](../lib/plan/context.ts:143)
honours it: `typeColorMap` is built straight from DB rows (`t.band`), always key-form. Production is
**always** key-form.

Every engine test instead feeds `DEFAULT_TYPE_COLOR_MAP` ([`lib/engine/bands.ts:40`](../lib/engine/bands.ts:40)),
which is **display-form** (`Fire: "Red"`). Its only callers are three test files —
`tests/engine/cascade.test.ts`, `tests/engine/line.test.ts`, `tests/engine/bands.test.ts` — and its own
definition. Nothing in `lib/` or `app/` reads it. The entire band system has only ever been exercised in
a vocabulary nothing in production uses.

**Why it's a defect, not a curiosity.** [`lib/engine/cascade.ts:378`](../lib/engine/cascade.ts:378)
hard-codes `band: "White"` for Trainer / Supporter / Item / Energy, bypassing the injected map entirely.
In production that stores a value `color_band` has no row for, so any haul containing a Trainer or
Energy card died on `copy_color_band_fkey` — the app's core action, broken (UIL-012). In a test built on
`DEFAULT_TYPE_COLOR_MAP`, that same literal is indistinguishable from the correct value, so 258 passing
tests certified code that could not commit a real haul.

**Corroborating detail.** [`lib/backfill/resolve.ts:31`](../lib/backfill/resolve.ts:31) falls back to
`"white"` (key-form, FK-valid); [`lib/engine/bands.ts:84`](../lib/engine/bands.ts:84) falls back to
`WHITE`, i.e. `"White"` (display-form, not FK-valid). Same intent, two spellings — nothing anywhere
enforces which vocabulary a given code path owes the database.

**Suggested fix.** Either delete `DEFAULT_TYPE_COLOR_MAP` and move engine tests onto key-form fixtures,
or keep both vocabularies and make the boundary impossible to cross — a branded type so a display name
cannot type-check where a key is expected. The second is the durable version. PR #57 fixes the concrete
UIL-012 instances and gives the tests it touches key-form fixtures; it does not touch the suite-wide
fixture problem, which is why this needs its own entry rather than a line inside UIL-012.

**Ambiguity left for the implementer:** whether display names (`BAND_ORDER`, `DEFAULT_TYPE_COLOR_MAP`)
are still needed anywhere, or are vestigial from before the DB owned the band vocabulary. If vestigial,
deleting one vocabulary beats policing the boundary between two.

**Priority rationale (Senior BA's read, Medium).** Nothing a user can see is broken by this entry on its
own — normally Low. But it is the mechanism that let UIL-012 stay invisible behind a green suite, and it
will hide the next band-related regression the same way. Argued against High because nothing is
*currently* broken by it once UIL-012's fix lands. Flagging to Karvi for her ruling; record her read here
once she gives it.

**Addendum (2026-09-13, after PR #57 merged).** Extending and correcting this entry now that the concrete
instance has actually landed.

- **The `cascade.ts:378` literal is gone, not just isolated.** PR #57 changed STEP 6 to pass `b` (the
  map's own white key) instead of the literal, and gave `band()`'s fallback the same treatment
  (`whiteKey(map)`, [`lib/engine/bands.ts`](../lib/engine/bands.ts)). Verified directly against
  `origin/develop` (not a local checkout, which had gone stale by this point): **no display-form literal
  is used as a placement band value anywhere in `lib/engine/` any more.** A claim that `cascade.ts:378`
  was "the only one left" was itself already stale by the time it was raised — as a *misuse*, it was
  zero, not one.

  **Narrower than "zero literals remain", and the difference is this entry's whole premise.** Verified on
  `origin/develop` after #57: `WHITE: Band = "White"` still exists (`bands.ts:34`) as `whiteKey`'s
  last-resort constant, `BAND_ORDER` is still ten display-form strings, and **`DEFAULT_TYPE_COLOR_MAP` is
  still display-form** (`Fire: "Red"`, `Colorless: "White"`). `BAND_ORDER` is legitimate — display names
  are what it is *for*. The other two are what items (1) and (2) below are about. An unqualified "zero
  literals remain" would read as though this entry had already been fixed by #57, which it has not.
- **Two distinct problems remain here, not one.** (1) The engine test suite still runs entirely on
  `DEFAULT_TYPE_COLOR_MAP` (display-form), so it still certifies a vocabulary nothing in production uses
  — PR #57 added key-form fixtures only to the tests it touched, not suite-wide. (2) The display/key
  boundary has no type-level enforcement: nothing stops a future call site from typing a display-form
  literal, and a same-shaped bug would again pass every test for the same reason. These share a cause but
  the fixes land in different places — test fixtures vs. a branded type — so both are recorded here as
  numbered items in one entry rather than split into two, since neither is actionable without the other's
  context.
- **Verified vs. inferred, so a reader knows what's load-bearing:** verified — `DEFAULT_TYPE_COLOR_MAP`
  has no production caller (grepped `lib/` and `app/` directly); the cascade.ts fix is merged and
  confirmed by reading `origin/develop`. Inferred — that a *future* call site would repeat the mistake;
  that's a risk argument, not an observed defect, which is why priority stays Medium rather than climbing
  toward the UIL-012 it grew out of.

Neither (1) nor (2) blocks anything — UIL-012 itself is fixed by #57. This entry is now purely about the
suite's ability to catch the *next* one.

**Correction (2026-09-13) — the addendum above overstated the finding, and this supersedes it.**
QA checked the premise directly on `origin/develop` rather than accepting it, and found "every engine
test uses display form" is true of exactly **three** files, not the suite:

| Form | Files |
| --- | --- |
| DISPLAY (`Fire: "Red"`) | `tests/engine/{cascade,bands,line}.test.ts` |
| KEY (`Fire: "red"`) | `tests/plan/{commit-atomicity,plan-run,route-existing-copies}`, `tests/backfill/{commit-atomicity,binder-section,plan}`, `tests/surfaces/recompute`, `tests/repo/m1-acceptance` |

The split is **by layer, not universal**: only `lib/engine`'s own unit tests use display form; every
layer above already exercises DB keys. [`lib/plan/adapt.ts:8-11`](../lib/plan/adapt.ts:8) documents the
engine as deliberately agnostic to which form it's fed — those three files passing with `"Red"` is
arguably that design working as intended, not a gap. An entry saying they were wrong would have someone
rewrite tests that demonstrate the thing they were written to demonstrate.

**The real defect was narrower: a coverage gap on the cascade's STEP 6 write path, not a vocabulary
mismatch.** `tests/plan/commit-atomicity.test.ts` already used key form (`Trainer: "white"`) **and**
already wrote through the real `apply_write_ops` RPC on PGlite — it was already positioned to catch
`cascade.ts:378`. It didn't, because no case in it ever committed a Trainer or Energy card. PR #57 added
exactly that case ([`commit-atomicity.test.ts:298`](../tests/plan/commit-atomicity.test.ts:298), "commits
a Trainer into the DB-key white band"); reverting only the STEP 6 line makes it fail with
`copy_color_band_fkey` (2 tests fail, 408 pass). The vocabulary framing was a plausible-sounding red
herring that more than one of us accepted before checking it.

**The rule to record** (the dev session's formulation, which caught this): require key-form fixtures for
code that **resolves or defaults** a band, not for code that merely **carries** one. Narrower than "fix
the whole suite's vocabulary," and it's the rule that would actually have caught this.

**What still stands from the addendum above, unchanged:**

- The `backfill/resolve.ts:31` (`"white"`) vs. `bands.ts`'s `WHITE` (`"White"`) pair — the strongest
  single piece of evidence in this entry. Same intent, two spellings, one FK-valid, no single owner for
  "the white key."
- The suggested fix, **re-ordered**: the cheap version is to make `DEFAULT_TYPE_COLOR_MAP` itself
  key-form — it has no live caller, so the change is free — and derive display names from
  `color_band.display_name` rather than keeping two constants that can drift. A branded `BandKey` type
  is now the nice-to-have, not the primary recommendation; it's a large surface change for a symptom the
  cheap fix already removes.
- `bandPosition()` accepting both a display name and a DB key (added in #57) is a temporary shim, not a
  feature — it fixed a real bug (a key-form value used to sort "unknown, sort last") but means the
  function can never tell a caller they're in the wrong space. Worth narrowing to keys-only once fixtures
  are converted, as part of this cleanup rather than a permanent behaviour.
- **The test for whether any fix actually worked:** after it lands, is there exactly **one** definition
  of "the white key" that both the engine and backfill consult? Today there are two.

**Priority: Low.** QA agreed Low on the ranking; its class-of-mistake argument (the cheap fix eliminates
a class of mistake, not just an instance) stands as a reason to do the fix, not as a reason to rank it
higher — an earlier version of this entry attributed a Medium position to QA that it never actually
held, and this replaces it. The hole that let UIL-012 through is closed (#57 added the missing
Trainer/Energy commit case), so nothing is currently unprotected. Karvi has not ruled.

**Enforceable rule, restated more precisely:** a display-form string counts against the rule only
inside the file's own `TypeColorMap`/`color_band` fixture, not inside a display-lookup map
(`bandDisplayByKey`/`bandDisplay`). And `tests/engine/bands.test.ts` isn't merely an exception to that
rule — `expect(whiteKey(DEFAULT_TYPE_COLOR_MAP)).toBe("White")` is precisely where both vocabularies
belong, since that file's job is proving `whiteKey` returns the caller's own space regardless of which
one it's handed.

**Addendum (2026-09-13) — checked the "clean 3-vs-8 split" claim itself, since QA flagged it as a crude
grep rather than a finding.** A wider grep for display-form band strings across the test suite also hits
`tests/backfill/{binder-section,commit-atomicity,plan}`, `tests/engine/bands`, `tests/line/{decisions,move}`,
`tests/plan/plan-run`, and `tests/surfaces/{lookup,wishlist}` — which sounds like it breaks the clean
split. Read all nine directly rather than trusting the grep's shape:

- **Eight of the nine** (every one except `bands.test.ts`) hit only because they build a `bandDisplayByKey`
  map or a `bandDisplay` field — e.g. `new Map([["red", "Red"], ["white", "White"]])`
  ([`tests/plan/plan-run.test.ts:95-99`](../tests/plan/plan-run.test.ts:95)). That is a key→label lookup
  table, the exact shape `lib/plan/context.ts` builds in production for rendering — not a competing
  `TypeColorMap` fixture. Their actual band-map fixtures are unambiguously key-form, matching the original
  count.
- **`tests/engine/bands.test.ts`** is the one genuine exception, and it's the legitimate case QA flagged:
  it feeds `whiteKey()` both a key-form map and `DEFAULT_TYPE_COLOR_MAP` directly, on purpose, to prove the
  function returns the *caller's own* white key regardless of which vocabulary it was handed
  ([`tests/engine/bands.test.ts:102`](../tests/engine/bands.test.ts:102), `expect(whiteKey(DEFAULT_TYPE_COLOR_MAP)).toBe("White")`).
  That's a test of the boundary itself, which is exactly where both forms belong.

**The answerable version of "which vocabulary is this fixture asserting in":** a display-form string
counts against the rule only when it appears inside the file's own `TypeColorMap`/`color_band` fixture —
not when it's inside a `bandDisplayByKey`/`bandDisplay` lookup, which is legitimate in any file. By that
test the 3-vs-8 split holds exactly as first counted, and now has a criterion a reviewer can actually
apply instead of a raw grep count.

## UIL-014 — No way to remove a card from a collection on the Collections page

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#67](https://github.com/viantihu/pokemon-tcg-tracker/pull/67) MERGED to
  `develop` (squash `c99bd080`), QA-reviewed, deployed to Testing (all four conditions green, migration
  0008 reached Testing), and **confirmed resolved by Karvi on Testing 2026-09-15** — the first time this
  interaction-only behaviour was exercised in a browser.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Collections
- **Env:** Testing

In her words: "There is no way for me to remove cards from a collection from the collections page. If
I chose to remove a card from a collection that I own, I will need to find a new location for it." That
second sentence is the correct mental model — removal is architecturally a *move*, not a delete — and
the app has no path to either.

**Confirmed: a total gap for open collections, and a hazardous half-measure for finite ones.**

`CollectionsView` ([`CollHub.tsx:314-364`](<../app/(ui)/coll/CollHub.tsx>:314)) renders a per-card action
only for a target **not yet** owned (`+ Wishlist`); an owned card gets a static `<span
className="cpill have u">Owned</span>` with no control at all. Open-mode cards render even less — just
`In collection`, no button of any kind.

The only removal-shaped control anywhere in the hub is the Edit modal's target-list "✕"
([`CollHub.tsx:582`](<../app/(ui)/coll/CollHub.tsx>:582), wired to `removeTarget` at line 503), and it is
gated to `state.mode === "finite"` — open collections get no card-list editor at all. Worse, it does not
do what it looks like it does: `removeTarget` only edits the in-memory chase-list draft, and
`saveCollection` ([`actions.ts:190-227`](<../app/(ui)/coll/actions.ts>:190)) persists that as
`patch.target_catalog_card_ids` — it never touches the `copy` row. So clicking "✕" removes the card from
the *chase list* while its physical copy stays exactly where it was, still shelved in the collection's
binder. That copy becomes invisible in every collection and wishlist view (both are keyed off
`target_catalog_card_ids`) while still occupying a real pocket — an orphaned, untracked copy, created by
the one control that looks like a remove button.

**Why there's no removal, architecturally.** `copy` has no `collection_id`
([`0002_domain.sql:146-162`](../supabase/migrations/0002_domain.sql:146)); collection membership is
inferred at read time from `collection.current_binder_ids` and `target_catalog_card_ids`
([`actions.ts:110-112`](<../app/(ui)/coll/actions.ts>:110)) matched against shelved copies. A card is "in"
a collection because a `copy` is shelved in one of its binders and its catalog id is on the chase list —
there is no single field to clear. Removing it for real means rewriting the `copy`'s placement, which is
exactly why she anticipated needing "a new location for it."

**The fix already exists elsewhere and is unused here.** `lib/line/move.ts`'s `placementForMove` plus
`lib/line/write.ts`'s `applyMove` (`applyMove`: [`write.ts:34-64`](../lib/line/write.ts:34)) already
compute and persist exactly this rewrite — for a `{kind: "bulk"}` or `{kind: "shelf", ...}` destination,
it updates `copy.role/binder_id/binder_half/color_band/line_slot_id` and reopens a vacated line slot. It
is called today via `moveCardAction` ([`app/(ui)/line/actions.ts:50-63`](<../app/(ui)/line/actions.ts>:50))
and surfaced through the generic, card-agnostic `MoveOverlay`/`MovePanel` components already wired into
`LineScreen.tsx:322` and `PlanScreen.tsx:386`. `CollHub.tsx` and `coll/actions.ts` import neither. Suggested
fix: give an owned card in `CollectionsView` a "Remove" action that opens the same `MoveOverlay` (default
destination bulk, or let her pick a shelf) and calls the existing `moveCardAction`/`applyMove` path —
wiring, not new placement logic, the same shape as UIL-003's fix reusing `lib/sync/resolve.ts`.

**Ambiguity left for the implementer:** whether "remove from collection" should always default to bulk,
or offer the same shelf/collection picker `MoveOverlay` already gives on the Line screen. Also worth
deciding whether the finite editor's "✕" should be disabled/relabeled once a target is owned, or made to
actually invoke the move — right now it silently orphans a copy for every owned card someone drops from
the chase list, which should probably be treated as part of this fix rather than a separate entry.

**Priority rationale.** High: this isn't a missing nice-to-have, it's a core collection-management action
with no path at all for open collections, and the one control that looks like it does the job instead
creates an invisible, untracked physical copy — the same class of silent-wrong-data hazard as UIL-002,
but on live inventory rather than a one-time setup field. Flagging for Karvi's confirmation since severity
calls are hers.

**Correction (2026-09-13).** The `CollHub.tsx` line numbers above were read from a local checkout that
had gone stale — PR #56 (UIL-009's fix) landed shortly before this entry was written, touched the same
file, and shifted them. Current lines on `origin/develop`: `CollectionsView` 228-375, the `Owned` span
321, `In collection` 359, `removeTarget`'s definition 537, the "✕" button 633. `actions.ts` citations
are unaffected — #56 didn't touch that file. Substance unchanged: re-verified against current
`origin/develop` that no removal path, `MoveOverlay` import, or `moveCardAction` call exists in either
file.

## UIL-015 — Collector-number search returns unrelated cards while the actual match is missing

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#73](https://github.com/viantihu/pokemon-tcg-tracker/pull/73) MERGED to
  `develop` (squash `a88dc5c`), QA-reviewed, deployed to Testing, and **confirmed resolved by Karvi on
  Testing 2026-09-15**: the collector-number search returns the actual match, correctly matched.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Lookup / Collections
- **Env:** Testing

In her words, retesting UIL-010's fix from the "New Collection" set-list search: "This number
should've returned Wurmple from ASC, illustrated by Usgmen." Typing `011/217` instead returned five
McDonald's Collection promo cards (Pidove, Klang, Fletchling, Zigzagoon, Meowth — sets `2011bw` through
`2016xy`), all with `local_id: "11"`, all unrelated to the query. No Wurmple, no `me02.5` (TCGdex's
"Ascended Heroes," printed total 217, containing `me02.5-011` — Wurmple, matching her denominator
exactly, so this is very likely a real upstream card, not a nonsense query).

**Not the same defect UIL-010 fixed — a gap in how the fix matches, not whether it matches at all.**
UIL-010's search now correctly *finds* rows instead of returning nothing; this report is that it can
find the *wrong* rows with no way to prefer the right one.

**Root cause.** [`lib/catalog/collector-number.ts:52`](../lib/catalog/collector-number.ts:52) parses
`011/217` and discards the denominator entirely — `{ text: "011", localIds: localIdCandidates("011"),
numberOnly: true }`. `localIdCandidates` ([`lib/sync/resolve.ts:65-73`](../lib/sync/resolve.ts:65))
builds `["011", "11"]` (verbatim/padded, then stripped). The search
([`lib/repo/catalog-card.ts:99-107`](<../lib/repo/catalog-card.ts>:99)) then runs:

```ts
.in("local_id", parsed.localIds)        // ["011", "11"] — both forms, equal weight
.order("set_id", { ascending: true })   // alphabetical, not relevance
.order("local_id", { ascending: true })
.limit(limit);
```

This is a strict equality match — not the `ilike` substring bug UIL-010 fixed — but `.in()` treats every
candidate as equally valid with **no set-scoping and no precedence**. Any card anywhere in the 23,548-row
catalog whose `local_id` is literally `"11"` is as good a hit as one whose `local_id` is `"011"`. The
five McDonald's sets (`2011bw`…`2016xy`, 12-card promo sets that store their numbers unpadded) all have an
11th card, all match the stripped candidate, and `set_id` sorts them ahead of `me02.5` alphabetically
(digits before letters) — a sort accident, not relevance. If `me02.5-011` is in the mirror with its
verbatim padded id, it should be in the same result set, just outranked and pushed past `limit` by
McDonald's cards that shouldn't be competing at all.

**Why the denominator can't be the fix.** UIL-010 already established that `217` can't be matched against
a per-set row count — printed totals exclude secret rares, so counting rows per `set_id` disagrees with
the real total by design. That constraint still holds here; this isn't "use the 217 you have," it's that
the candidate list itself has no internal precedence.

**Suggested fix.** `localIdCandidates` already orders its output from most- to least-specific
(verbatim/padded forms before the stripped form) — the bug is that the query flattens that order into one
`.in()`. Try the padded/verbatim candidates as their own exact-match query first; only fall back to the
stripped candidate as a second query if the first returns nothing. That alone would have kept `me02.5-011`
from ever competing with a bare `"11"`.

**Ambiguity / unverified:** whether `me02.5-011` (Wurmple) actually exists in the Testing mirror. TCGdex
confirms the card and the printed total, and UIL-004's closeout doesn't list `me02.5` among the sets
TCGdex under-serves — so it's very likely present — but nobody in this investigation had Supabase
credentials to check the live `catalog_card` row directly. Worth a direct check before assuming the fix
above is sufficient on its own; if the row is genuinely missing, this is a mirror gap layered under a
ranking bug, not a ranking bug alone.

**Priority rationale.** High, same reasoning as UIL-010 itself: a finite collection is built from a set
checklist, the collector number is the natural key for that workflow, and this feature now returns
*confident-looking wrong cards* for a real, correctly-typed number rather than an honest empty result —
worse than UIL-010's original failure for exactly the reason UIL-011 flagged about misleading empty
states, but inverted: this one looks like it worked. Flagging for Karvi's confirmation, and flagging to
the Senior BA that UIL-010's "Fixed" status may need revisiting, since this is Karvi's own confirmation
attempt on Testing surfacing a real gap in that fix.

**The mechanism is now certain, not probable, and her card is confirmed in the mirror.** Verified
directly against TCGdex: the twelve McDonald's Collection set ids are numeric-prefixed (`2011bw` through
`2024sv`); digits sort before letters, so all twelve precede `me02.5` under
`.order("set_id", { ascending: true })` ([`catalog-card.ts:104-107`](<../lib/repo/catalog-card.ts>:104));
each holds 12–25 cards so each has an `011`/`11`; `.limit()` fills from `2011bw` up and never reaches
her set. Exactly the five unrelated results she saw. Also confirmed: TCGdex reports
`me02.5` as `cardCount: {official: 217, total: 295}` and the set-detail endpoint serves exactly 295 —
not a truncated set from UIL-004's six-pseudo-set family. That's a per-set count proxy, not a per-row
assertion about `me02.5-011` specifically (still not independently checked against the live mirror row),
but it's the strongest evidence available without DB access.

**What the fix above still leaves arbitrary.** `set_id` alphabetical ordering was never a design choice
— there's no release-date column to sort by instead. So after this fix, a tie between two *padded exact
matches* in different sets is still broken arbitrarily. See UIL-026.

**Scale is why this stayed invisible until 23,548 rows, the same shape as UIL-007.** `.order("set_id")`
being alphabetical, and digits sorting before letters, was true on day one — it just had nothing to bite
on with the 3-row seed catalog. At real scale, twelve numerically-named sets happened to sort ahead of a
real card's set and fill the limit first. Fine at small scale, wrong at production scale, same lesson
UIL-007's progress strip already recorded.

**The fix (PR [#73](https://github.com/viantihu/pokemon-tcg-tracker/pull/73), squash `a88dc5c`) is
independently reproduced, not just claimed.** Ran the revert check myself in an isolated worktree:
pre-fix `search()` against the current, corrected test double fails 5 of 15 tests, including both
original UIL-010 assertions by name ("ranks the exact number match first, ahead of name matches",
"finds both cards for a name plus a number, number first"); 10 pass. Third independent confirmation of
the same result, from a third starting point. Status transition is the Senior BA's to record.

**The `sync` safety claim in the resolution below needs the right discriminator, and it isn't "is the
file in the diff."** `catalog-card.ts` serves both Lookup's `search()` (this fix) and sync's
`findBySetLocal`/`findBySetLocalMany` (reached through `lib/sync/catalog-lookup.ts`, itself called from
`lib/sync/resolve.ts`). PR #73's diff touches only `search()` — confirmed directly against the PR's
patch, one hunk, starting well after `findBySetLocalMany`'s definition — and `lib/sync/resolve.ts` isn't
in the diff at all. That's the correct way to state sync is unaffected: at the *function* level, not by
checking whether a particular file appears in the changed-files list, since the same file serves both
call paths and "the file changed" would have proved nothing either way.

## UIL-016 — No card images on the Haul Plan worklist or spotlight panel

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#78](https://github.com/viantihu/pokemon-tcg-tracker/pull/78) MERGED to
  `develop` (squash `ff4afa4`), confirmed deployed to Testing, and **confirmed resolved by Karvi on
  Testing 2026-09-14**. `imageUrl` is threaded onto `PlanItem` at the adapter boundary as
  required-not-optional, so unwired plumbing is a compile error rather than a silent blank. A third site
  (`:238`, feeding `MoveTargetCard`) was fixed too — the entry named two.
- **Priority:** High (Karvi's call)
- **Area:** Plan
- **Env:** Testing

In her words: "Icons are not loading." Every row in the worklist and the "NOW HANDLING" spotlight shows
letter-abbreviation initials (`INF`, `BLA`, `RAP`, `CLO`, `GT`…) instead of the card's artwork.

**Not a loading failure — `imageUrl` is never passed in on this screen.** `CardFace`
([`CardFace.tsx:27-42`](<../app/(ui)/_components/CardFace.tsx>:27)) is built correctly: it renders a
live `<img>` from `imageUrl` and only falls back to initials on a missing URL or a load error. Other
screens pass a real URL — `LookupScreen.tsx:75`, `CollHub.tsx:317/356/697` — and so does Plan's own
**intake** draft list, before a plan is run
([`PlanScreen.tsx:527`](<../app/(ui)/plan/PlanScreen.tsx>:527), `imageUrl={d.card.imageUrl}`).

Once a plan is run, though, the worklist and spotlight are built from `PlanItem`, not the draft card, and
both hard-code `null`:

```tsx
// PlanScreen.tsx:807 (worklist row)
<CardFace name={item.name} imageUrl={null} size="s" />
// PlanScreen.tsx:858 (spotlight)
<CardFace name={item.name} imageUrl={null} size="l" />
```

This isn't a one-line oversight with the value sitting nearby unused — it was never threaded through the
type chain. `PlanItem` ([`lib/plan/types.ts:23-38`](../lib/plan/types.ts:23)) has no `imageUrl` field;
`toPlanItem` ([`lib/plan/assemble.ts:41-61`](../lib/plan/assemble.ts:41)) builds the row from
`incoming.card` + the engine's result with nothing to copy an image from; `incoming.card` is a
`CatalogCard` ([`lib/engine/types.ts:49-73`](../lib/engine/types.ts:49)) — the **engine's own** type,
which has no `imageUrl` at all, since the engine is deliberately I/O-free placement logic and image data
was never in its scope. So the fallback is the *only* reachable state once a plan runs, regardless of
whether TCGdex artwork exists for the card.

**Suggested fix.** Carry `imageUrl` from the catalog row into `PlanItem` alongside the other display
fields `toPlanItem` already copies (name, etc.), so the engine's own types stay untouched and only the
adapter layer changes — the same shape as other fixes in this log that added a field at the boundary
rather than widening the engine's scope.

**Priority rationale (Karvi's call): High.** Every row on the screen she uses to physically sort a stack
of cards shows no image, which defeats a large part of what a "spotlight" view is for — confirming she's
holding the right card. Not data loss, but a core-daily-screen usability gap at real haul scale (this
haul was 702 cards).

**Design principle from Karvi, worth generalizing beyond this screen:** "Any search for cards
(collections, inventory, etc.) should focus on the image thumbnail more than anything. Pokemon card
collecting is a visual hobby, so the visual matters a lot." Lookup and Collections already pass a real
`imageUrl` into `CardFace` today, so they aren't broken by this gap — but the principle is a reason to
treat the thumbnail as the primary identifying element in any future search/result UI on this app, not
just to patch the one screen where it's currently missing.

## UIL-017 — Internal field name "cardClass" leaks into the routing explanation

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#77](https://github.com/viantihu/pokemon-tcg-tracker/pull/77) MERGED to
  `develop` (squash `99877b3`), confirmed deployed, and **confirmed resolved by Karvi on Testing
  2026-09-14**. Fixed at the display boundary: `toPlanItem` now calls `describeReason` instead of passing
  `result.reason` through, so the engine's internal trace never reaches the screen. See the correction
  below — three of the six lines this entry accused do not leak, and two it missed do.
- **Priority:** Medium (Karvi's call)
- **Area:** Plan
- **Env:** Testing

The spotlight panel showed, verbatim: "cardClass = specialty (Illustration rare); routes to the specialty
binder." `cardClass` is an internal field name, not something a reader should need to parse.

**Root cause.** [`lib/engine/cascade.ts:235-239`](../lib/engine/cascade.ts:235):

```ts
if (incoming.card.cardClass === "specialty") {
  return {
    ...head,
    step: "card-class",
    reason: `cardClass = specialty (${incoming.card.rarity ?? "specialty"}); routes to the specialty binder.`,
```

This `reason` string is the engine's own internal trace of *why* it made a decision, and it flows to the
screen with no copy-editing layer in between:
[`lib/plan/assemble.ts:58`](../lib/plan/assemble.ts:58) (`reason: result.reason`) →
[`PlanScreen.tsx:888-889`](<../app/(ui)/plan/PlanScreen.tsx>:888) (`{item.reason}`, rendered as-is).

**Related but distinct from UIL-011.** UIL-011 catalogues internal "mirror/sync" jargon (a different
table of 6 strings, none in `cascade.ts`). This is confirmed a new location and a different class of
leak — engine field/type names, not sync terminology.

**Correction — the original line list was wrong, verified line by line against `cascade.ts` directly.**
Lines **197** ("collection-claim") and **279** ("duplicate", bulk box) have **no leak** — neither reads
from `b`. Line **380** ("trainer" step) is a hardcoded `"White"` string literal, not a variable read —
also not a leak. Retracting all three from the original list.

**What's actually there is a second, distinct leak: the raw DB key for a colour band reaching the
screen, not `cardClass`-shaped at all.** Every one of these embeds `b` — the band in DB-key space
(`dark_blue`), not the display form (`Dark blue`) the rest of the panel uses — directly into a
user-facing sentence:

- [`:295`](../lib/engine/cascade.ts:295) ("line-existing," the fill branch): `` `Fills the open
  ${existing.slot.stage} slot of the existing ${b} line, in the back half.` ``
- [`:313`](../lib/engine/cascade.ts:313) ("line-existing," the already-holds branch): `` `The ${b} line
  already holds this stage...` ``
- [`:334`](../lib/engine/cascade.ts:334) ("line-new"): `` `Creates a viable ${b}
  ${via.chain[0]?.name ?? ""} line...` ``
- [`:364-366`](../lib/engine/cascade.ts:364) ("line-nonviable," the fallback — easy to miss because the
  `${b}` sits at the tail of a multi-line template literal): `` `Not viable (...); to the front half,
  ${b} band.` ``
- [`:389`](../lib/engine/cascade.ts:389) ("basic-no-line," twice in one string): `` `Basic with no
  line; to the front half, ${b} band (prefer a binder with open ${b} space...` ``

Five sites, all the same shape, two of them (`:295`, `:364-366`) easy to miss on a quick grep because
the leak isn't in the same line as the `reason:` keyword. PR #77 (merged) restructures the same-colour
member *count* out of these strings into a new `sameColorMembers` field.

**Correction (2026-09-14) — I asked the wrong question and the leak is actually fixed. Retracting "still
live regardless of what #77 lands."** I checked *"does #77 edit `b` at these five lines?"* — no — and
concluded the leak survives. Wrong question. #77 fixes it one layer up, by **replacing the pass-through
entirely** rather than editing the leaking lines: [`lib/plan/assemble.ts`](../lib/plan/assemble.ts) adds
`describeReason(incoming, result, l)`, and `toPlanItem` now uses that instead of `reason: result.reason`
([`assemble.ts:130`](../lib/plan/assemble.ts:130)). The engine's raw trace — `b` included — never reaches
the screen at all any more; `describeReason` builds new reader-facing copy per `CascadeStep`, translating
the band through `bandName`/`bandDisplayByKey` at the display boundary instead. `cascade.ts` keeping the
raw key at those five lines is now correct and intended: the engine stays in DB-key space, exactly as
UIL-013's contract says it should, and the translation happens where it's rendered, not where it's
decided. The PR's own tests pin the refuting check directly: `expect(reason).not.toMatch(/\bred\b/)` next
to `expect(reason).toMatch(/\bRed\b/)`, same for green and white.

**The generalizable rule, worth stating outright since this is the third time today the wrong-question
version of this mistake has been made:** when a claim is "X isn't fixed," the check is *"can the bad
output still occur?"*, never *"was line N edited?"* A fix one layer away from the line you're
watching passes the second question and fails the first.

**What still stands: the connection to UIL-013, and the priority.** This was the display half of
UIL-013's two-vocabulary problem — UIL-012 a display name reaching the database, this a database key
reaching the screen — and it's now **fixed** rather than open, closing the loop on all three: UIL-012,
UIL-013, and this one all trace to the same boundary, and all three are now addressed.

**Priority rationale (Karvi's call): Medium** — recorded for history; the underlying leak this rated is
resolved by #77. Status transition is the Senior BA's to record.

## UIL-018 — Colour band sections have no way to collapse

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#78](https://github.com/viantihu/pokemon-tcg-tracker/pull/78) MERGED to
  `develop` (squash `ff4afa4`), confirmed deployed, and **confirmed resolved by Karvi on Testing
  2026-09-14**. A folded band renders **nothing below its header** — rows absent from the tree, not
  CSS-hidden (measured 702 rows / 381 KB expanded → 0 rows / 7.6 KB folded). Fold state rides in the
  resume payload but deliberately **not** in the plan fingerprint, so folding a band cannot invalidate a
  computed plan.
- **Priority:** High (Karvi's call)
- **Area:** Plan
- **Env:** Testing

In her words: "Color rows need to be collapseable." Each band section (e.g. "RED FIRE — 43 CARDS",
"ORANGE FIGHTING — 71 CARDS") renders every row inside it, always, with no way to hide a section she's
already worked through.

**Confirmed: no collapse mechanism exists anywhere in the tree.**
[`PlanScreen.tsx:697-732`](<../app/(ui)/plan/PlanScreen.tsx>:697) maps every band's subgroups and every
subgroup's rows unconditionally:

```tsx
g.subgroups.map((sub) => (
  <div key={sub.kind}>
    <div className="subhead u">{sub.label}</div>
    {sub.rows.map((it) => (<PlanRow key={it.incomingId} item={it} ... />))}
  </div>
))
```

A search of the file for any collapse/expand affordance (`collapse`, `expand`, `<details`,
`aria-expanded`) returns nothing; the only `toggle*` in the file is `toggleDone` (the check-off state),
unrelated to section visibility. `BandChip.tsx` is purely presentational. So every row in every band is
always mounted — on a 702-card haul, a single band can be 70+ rows rendered at once with no way to get
past it except scrolling through all of it.

**Suggested fix.** Give each band header (`.bandhead`) a collapsed/expanded toggle, defaulting open,
persisted the same way check-off progress already survives navigation (UIL-006's fingerprint cache) so
collapsing a finished band doesn't reset on the next visit.

**Priority rationale (Karvi's call): High.** At real haul scale this isn't a nice-to-have — it's the
difference between a usable worklist and a page she has to scroll through linearly for hundreds of rows
to reach the next thing she can act on.

## UIL-019 — Haul progress header scrolls out of view instead of staying pinned

- **Reported:** 2026-09-13
- **Status:** **Closed** — PR [#109](https://github.com/viantihu/pokemon-tcg-tracker/pull/109) MERGED to
  `develop` 2026-09-14 (squash `e911c8c`), QA-reviewed, deployed to Testing, and **confirmed by Karvi on
  Testing 2026-09-14**: "the progress bar now sticks as intended." The pin works; the overlap it causes
  on desktop is tracked separately as UIL-058 (her rule: every report gets its own number), not a reopen.
- **Priority:** Medium (Karvi's call)
- **Area:** Plan
- **Env:** Testing

In her words: "The top progress header must be frozen (minimized but visible)." The strip showing overall
haul progress (matching the "43 / 702" the spotlight panel also shows) scrolls away with the rest of the
page once she scrolls the worklist — confirmed by the screenshot, where it's off-screen entirely while
mid-list rows are visible.

**Root cause.** [`app/globals.css:216-223`](../app/globals.css:216), the `.haulbar` rule, has no
`position` property at all:

```css
.haulbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 9px 13px;
  margin-bottom: 10px;
}
```

`.app` ([`globals.css:134-137`](../app/globals.css:134)) has no height/overflow constraint either, so the
document body is the scroll container — there's no inner scroll region for `.haulbar` to stick within
even if it had `position: sticky`. By contrast, `.bandhead` (the per-band "RED FIRE" header) *does* get
`position: sticky; top: 0;` ([`globals.css:290-296`](../app/globals.css:290)), and `.spot` (the right
detail panel) gets it on mobile only (`globals.css:1568-1574`) — but the overall haul progress bar is
targeted by neither rule at any breakpoint. It's a plain sibling in normal flow, before `.alertbar` and
`.planwrap` ([`PlanScreen.tsx:672-682`](<../app/(ui)/plan/PlanScreen.tsx>:672)), so it scrolls like
ordinary content.

**Suggested fix.** `position: sticky; top: 0` on `.haulbar`, matching the pattern `.bandhead` already
uses — plus, per her "minimized but visible" phrasing, a collapsed/compact variant once scrolled (a
`IntersectionObserver` or scroll-position class toggle) rather than the full-height bar staying pinned
at full size.

**Priority rationale (Karvi's call): Medium.** Losing sight of overall progress mid-sort is a real
annoyance on a long haul but doesn't block anything — she can still scroll back up to check.

## UIL-020 — Sync resolves Dex rows one at a time, serially, and the slowness was already known

- **Reported:** 2026-09-13 (not from Karvi — found while building UIL-008's progress bar)
- **Status:** **Closed** — PR [#70](https://github.com/viantihu/pokemon-tcg-tracker/pull/70) MERGED to
  `develop` (squash `585e8d9`), QA-reviewed, deployed to Testing, and **confirmed resolved by Karvi on
  Testing 2026-09-15** after real re-imports of her ~705-copy export. The improvement had only been
  arithmetic from query counts (~1,000 round trips → roughly one per owned set); her syncs are the
  wall-clock measurement, and she calls it resolved.
- **Priority:** Medium (Senior BA's read)
- **Area:** Sync
- **Env:** n/a — the defect is in the repo, not a running environment

**Root cause.** [`lib/sync/pipeline.ts:161`](../lib/sync/pipeline.ts:161), inside `for (const r of
dexRows)`:

```ts
const resolved = resolveDexId(r, aliasMap);
const hit = await lookup(r, resolved);   // awaited once per row
```

Serial by construction — the loop cannot start row N+1's lookup until row N returns. The same pattern
repeats at [`:179`](../lib/sync/pipeline.ts:179) for the retry-only path. At ~685 rows in the export that
surfaced UIL-006 through UIL-013, and 30–50ms per lookup, that's 20–35 seconds, scaling linearly with
collection size.

**Why this belongs next to UIL-008, not inside it.** UIL-008 asked for a progress bar because the
operation feels hung. This is *why* it takes long enough to feel hung, and it reframes UIL-008's
determinate-vs-indeterminate question: make it fast first, then ask whether a percentage is still wanted
— a four-second sync probably needs neither.

**This is not a new finding — it was flagged and dropped once already.** It was raised when M4 merged,
labelled non-blocking, and merged with no owner and no tracking entry. The lesson worth recording: a
finding filed as non-blocking with no owner and no entry doesn't get deprioritized, it evaporates — it
resurfaced only because someone built a UI feature over the top of it and noticed the wait. Contrast with
the plan-cache staleness gap (UIL-006 → fixed via #48) and the backfill atomicity gap (fixed via #36),
both of which got an owner and a tracking item at the time and landed as fixes. This is what the other
path looks like: three weeks and a UI feature later.

**The obvious fix (batch the lookups) is wrong as stated, and would trade a slow bug for a silent
correctness regression.** [`lib/sync/catalog-lookup.ts:12`](../lib/sync/catalog-lookup.ts:12) documents
that a set-name match learned on one row must "drain the remaining rows of that set within the SAME
pass, not only the next one" — the mechanism at
[`:76-78`](../lib/sync/catalog-lookup.ts:76): a set-code miss resolves the set by name, a unique match
learns and persists an alias (also cached in `sessionAliases`), then retries. **Row N's lookup can teach
an alias that changes how row N+1 resolves.** The loop is not incidentally serial; it has a real
intra-pass data dependency. A naive `Promise.all` or single `in`-list rewrite would break this: fired
concurrently, rows in an unknown set wouldn't see the alias the first row learned, and would resolve
differently depending on scheduling — a correctness regression that would present as a speedup.

**Suggested fix.** Batch while preserving drain semantics — e.g. resolve rows grouped by set, batching
within a set only after that set's alias (if any) is already known, or batching everything with known
aliases in one pass and handling alias-learning rows separately. `tests/sync/alias-drain.test.ts` is the
existing guard; any equivalence test for a rewrite must use an export containing an unknown set code that
gets name-resolved mid-pass — an export whose sets are all already aliased would pass while proving
nothing.

**Priority rationale (Senior BA's read): Medium.** Nothing is broken and the sync produces correct
results — she can wait 30 seconds. But it's on the primary path cards enter the system by, the cost grows
with her collection, it is the root of a complaint she actually made, and the fix is more delicate than it
first looks — a reason to do it deliberately with tests, not a reason to defer it.

## UIL-021 — A wall-clock test assertion will fail unrelated PRs at random

- **Reported:** 2026-09-13 (not from Karvi — found while building UIL-008)
- **Status:** **Fixed** — both halves, 2026-09-20. The wall-clock assertion: PR
  [#254](https://github.com/viantihu/pokemon-tcg-tracker/pull/254) (`91b3a2f`) deletes
  `expect(elapsedMs).toBeLessThan(10000)` from `tests/catalog/artwork.test.ts`; the two naive-vs-banded
  output-equivalence tests are the guard PR #25 actually needed and stay, with a comment saying why there
  is no timing bound (the outputs are identical by design, so only a clock could distinguish them, and a
  clock on a shared runner measures the runner). The suite-level half, the same class one level up: PR
  [#256](https://github.com/viantihu/pokemon-tcg-tracker/pull/256) (`d40159b`) sets vitest's
  `testTimeout` and `hookTimeout` to 20 s as hang protection, because PGlite-backed files (a fresh WASM
  Postgres plus every migration each) crossed the 5 s default at random under parallel load on two of
  three full runs, and `promote-collection`'s setup hook crossed the 10 s hook default the same way;
  two full runs 972 green afterwards, and #254's own first CI run hit exactly that flake before #256
  landed. Test infrastructure only; nothing for Karvi to test; closes on evidence.
- **Priority:** Low, with a counter-argument recorded
- **Area:** Catalog (test infrastructure)
- **Env:** n/a — the defect is in the repo, not a running environment

**Root cause.** [`tests/catalog/artwork.test.ts:303`](../tests/catalog/artwork.test.ts:303):

```ts
// Banding must avoid the ~276M-pair all-vs-all scan; comfortably under a generous CI bound.
expect(elapsedMs).toBeLessThan(10000);
```

It measured 9101ms on PR #64's first CI run and passed at 91% of its own "generous" budget. #64 touched
two screens and a stylesheet, no clustering code; a re-run with no changes went green. It's a timing
budget on a shared runner, so it will keep tripping at random for PRs that have nothing to do with it.

**Suggested fix, two honest options.** Raise the bound substantially, or assert the asymptotic property
instead — a comparison test directly above this one already pins LSH banding against the naive
all-pairs scan (`clusterArtwork` vs `clusterArtworkNaive`), which arguably makes the timing assertion
redundant. This is the perf guard added in PR #25 and shouldn't be weakened unilaterally by whoever
happens to be passing through when it trips.

**Priority rationale: Low, with a counter-argument worth recording.** By the log's own rule, priority is
impact on go-live, and this has none — nothing user-facing, no data at risk. The counter-argument: a gate
that reds at random teaches everyone to re-run rather than investigate, and "a check that fails for
reasons nobody looks at" is the exact shape that let UIL-004 hide for weeks. The gate depends on this
suite meaning something. Still lands on Low; both readings flagged for Karvi.

**Update 2026-09-18: a second, related failure mode on this same test, found during UIL-066's recovery
— moved here rather than logged separately.** The "scale sanity" test this entry's own root cause
quotes normally runs in 2.7–3.2s, comfortably inside its **internal** `toBeLessThan(10000)` assertion
above but close enough to **vitest's own 5s default execution timeout** that concurrent load pushes it
over: it timed out on 5 of 6 simultaneous reruns right after the Actions-billing recovery, passing
unchanged on retry every time. Same underlying shape as this entry's root cause — a wall-clock bound on
a shared, variably-loaded runner — but a different bound (vitest's own timeout, not the assertion this
entry's suggested fix targets) and confirmed only under exactly that kind of retry burst, not in
general. Fix: PR [#175](https://github.com/viantihu/pokemon-tcg-tracker/pull/175) (merged) sets an
explicit, longer vitest timeout on this one test — addresses the execution timeout specifically; does
not touch the internal `toBeLessThan(10000)` assertion this entry's own suggested fix is still open
against.

## UIL-022 — Moving a card into a collection from the Line or Plan screen orphans it

- **Reported:** 2026-09-13 (not from Karvi — found while building UIL-014's fix)
- **Status:** **Closed** — PR [#82](https://github.com/viantihu/pokemon-tcg-tracker/pull/82) MERGED to
  `develop` (squash `e0773e2`), QA-reviewed, confirmed deployed. **No migration needed** — every op
  already existed (`union_collection_targets` shipped in 0007). Awaiting Karvi's confirmation, and note
  the Haul Plan path is the one to test: it is a **separate** code path from the Line screen, so fixing
  only `applyMove` would have left half of this live. See the corrections below. **Confirmed resolved by Karvi on Testing 2026-09-18.**
- **Priority:** High (Senior BA's read)
- **Area:** Line, Plan, Collections
- **Env:** Testing

Same orphan class as UIL-014, reachable from a different surface, and live today (not gated behind
UIL-014's fix).

**Root cause.** Collection membership is derived from two facts together: a copy is shelved in one of the
collection's binders, **and** its catalog id is on that collection's `target_catalog_card_ids`
([`app/(ui)/coll/actions.ts:110-112`](<../app/(ui)/coll/actions.ts>:110), same mechanism UIL-014
describes). [`lib/line/move.ts`](../lib/line/move.ts) handles a `{kind: "collection"}` destination
(cases at lines 28, 53, 89) and moves the copy's placement into the binder — but nothing in that path
unions the card into the destination collection's target list. Verified: `union_collection_targets`
(added by migration 0007) has exactly **one** production caller,
[`lib/backfill/commit.ts:143`](../lib/backfill/commit.ts:143). The Line/Plan move path is not a caller.

**Effect.** The card sits physically in the destination collection's binder while absent from its own
target list — invisible in the very collection holding it, while occupying a real pocket. Reached from
the Line screen's move panel and the Plan screen's placement override, both of which she uses on every
sorting pass.

**Independently corroborated — genuinely independent this time.** QA reached the same conclusion reading
`lib/line/write.ts`/`lib/line/move.ts` on PR #67's branch while reviewing it, before seeing this entry;
different starting point, same finding. `applyMove` ([`lib/line/write.ts`](../lib/line/write.ts))
contains no reference at all to `union_collection_targets` or `target_catalog_card_ids` — not a wrong
call, an absent one. And #67's own test proves the removal flow gets this right for the equivalent case:
[`tests/coll/remove-from-collection.test.ts:291`](../tests/coll/remove-from-collection.test.ts:291),
"into ANOTHER collection sharing the same binder: it joins that chase list, so it stays tracked" — so the
move panel's omission is the odd one out, not an open design question.

**Suggested fix, refined after reading `lib/coll/remove.ts` directly.** Its own header explains exactly
why it doesn't call `applyMove`: [`lib/coll/remove.ts:18-20`](../lib/coll/remove.ts:18) — "It deliberately
does NOT reuse `lib/line/write.ts`'s `applyMove`, which predates M10 and still issues four separate
statements with no transaction... that path is worth converting on its own" (that path is UIL-023). It
*does* reuse `placementForMove` (`lib/line/move.ts`) unchanged for the placement arithmetic, and builds
its own op list for `apply_write_ops` rather than calling `applyMove`. So the fix here isn't "call
`remove.ts`'s function from the move panel" — the request shapes differ. It's: **convert `applyMove` to
build ops for `apply_write_ops` the same way `remove.ts` does** (UIL-023's fix), reusing
`placementForMove` for arithmetic exactly as `remove.ts` already does, and add the
`union_collection_targets` op for a `{kind: "collection"}` destination the same way `remove.ts` does for
its cross-collection case. Fixing UIL-023 is very likely the same piece of work that fixes this entry,
not two separate efforts — worth sequencing together rather than assigning separately.

**Priority rationale (Senior BA's read): High.** Same reasoning Karvi accepted for UIL-014 — it silently
produces wrong data about live inventory, no error, no indication, on two screens used every sorting
pass. Not a missing feature; an action that appears to succeed and leaves the collection wrong.

**Correction (2026-09-14, PR #82) — the suggested fix above was wrong, and "two screens, one path" was
wrong too. Fixed now; both corrected here rather than left standing.**

- **No migration was needed.** `union_collection_targets` already shipped in migration 0007 — every op
  the fix needed already existed (`update_copy`, `update_slot`, `update_line` from 0008, the union from
  0007, `insert_decision`). The "add the equivalent forward op" line above sent the next reader looking
  for work that was already done.
- **Two separate code paths, not one path reached from two screens.** `moveCardAction` has exactly one
  caller ([`app/(ui)/line/LineScreen.tsx:136`](<../app/(ui)/line/LineScreen.tsx>:136)) — it never runs
  for the Plan screen. Plan's placement override is draft-time, keyed by draft id, and applied at commit
  by `writeOverriddenCard` ([`lib/plan/commit.ts:198`](../lib/plan/commit.ts:198),
  [`:306`](../lib/plan/commit.ts:306)). The orphan was real at **both**, independently, and fixing
  `applyMove` alone would have left half of this bug live on the Plan screen — the surface she uses
  most — while the Line-screen fix tested green. Recorded as two sites sharing one defect, not one
  path with two entry points.
- **A third orphan path, found and closed in the same PR:** `union_collection_targets` silently writes
  nothing when no row matches ([`0007_backfill_ops.sql:251-253`](../supabase/migrations/0007_backfill_ops.sql:251)
  documents this as intentional for the backfill tagger it was built for) — but here, a no-op union is
  indistinguishable from this entry's bug. Reachable from a tab left open across a Collections edit: the
  destination collection deleted, or re-pointed to a different binder mid-move. Both cases are now
  refused server-side rather than silently swallowed.

## UIL-023 — `applyMove` is a fourth write path and it is not atomic

- **Reported:** 2026-09-13 (not from Karvi — found while building UIL-014's fix)
- **Status:** **Closed** — PR [#82](https://github.com/viantihu/pokemon-tcg-tracker/pull/82) MERGED to
  `develop` (squash `e0773e2`), QA-reviewed, confirmed deployed. `applyMove` is now **one**
  `apply_write_ops` call, verified by QA at `write.ts:87` with only reads preceding it. `applyDecision`
  remains un-transacted **deliberately** — converting it needs a migration, since `wishlist_item` can
  only be INSERTed through the RPC, and this entry's root cause was scoped to `applyMove`. **Confirmed resolved by Karvi on Testing 2026-09-18.**
- **Priority:** Medium (Senior BA's read)
- **Area:** Line
- **Env:** Testing

**Root cause.** [`lib/line/write.ts:11-12`](../lib/line/write.ts:11), in its own header comment:

> "No cross-statement transaction (supabase-js; migrations frozen) — writes are ordered and small."

`applyMove` issues separate awaited writes — `copyRepo.update`, then `lineSlotRepo.update`, then
`evolutionLineRepo.update`, plus a `PlacementDecision` insert. It predates M10 (which made haul, sync,
and backfill commits atomic via `apply_write_ops`) and was never converted. A failure between statements
can leave a copy moved with its vacated slot still marked filled, or a `complete` line that should have
demoted to `open`. There is no compensating-rollback code anywhere in this app — PRs #30 and #36 removed
the last of it — so nothing catches a partial write here.

**Correcting a loose claim this entry itself has propagated.** M10's outcome is sometimes summarised as
"all write paths are atomic." That's true of haul, sync, and backfill commits, and false as a general
claim — `applyMove` is the fourth path and isn't one of them. Worth being precise about which three,
since the loose version nearly caused UIL-014's fix to wire collection removal *through* `applyMove`,
which would have added a fifth un-transacted write on top of an existing one.

**Suggested fix.** The pattern now exists (migration 0008, UIL-014) for converting an M7-era write path
to an atomic RPC. Same conversion for `applyMove`.

**Priority rationale (Senior BA's read): Medium, not High.** The write window is small and ordered, so
likely partial states are recoverable rather than corrupting, and no report of it happening exists. But
it's a known un-transacted multi-row write on live inventory, the app's stated invariant is atomic
writes, and the cost of fixing it has dropped now that the conversion pattern exists. Low is defensible;
Medium because this is the one place the stated invariant doesn't hold.

## UIL-024 — Production readiness: missing keys are mechanical, the access-token privilege loss is not, and `main` is further behind than recorded

- **Reported:** 2026-09-13 (not from Karvi — surfaced resolving UIL-005; firsthand account from the
  tech-lead session)
- **Status:** Open
- **Priority:** High for the cutover, not for today's UAT (both sessions' read)
- **Area:** Deploy
- **Env:** Production

Not a UAT report — flagging now so it doesn't get lost once Testing itself is green.

**Part 1 — missing keys, mechanical, narrower in scope than first thought.** The GitHub `production`
environment holds only `SUPABASE_DB_PASSWORD`; its pooler host is wired
(`vars.SUPABASE_DB_POOLER_HOST`, `aws-0-us-west-2.pooler.supabase.com`, project `bqqerxpdxywnpvndhxbs`),
so `migrate` alone would work on `main` today. **Correction to how this was first framed: the running
app does not read these from GitHub at all.** GitHub environment secrets are consumed by workflows only;
the deployed app reads `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` from **Vercel's**
environment at request time ([`lib/env.ts`](../lib/env.ts), parsed lazily so `next build` stays green
before secrets exist). So the missing GitHub secrets block `acceptance` (and any future workflow needing
data-API access) on the `main` rail — they do not, by themselves, stop the app from serving. Still a real
gap, just a narrower one than "the app can't serve real data."

**Part 2 — `main` is a pre-UI stub, not a working app missing credentials.** Lead with what can't
drift: `main` is pinned at commit `b9c5cdc` (PR #12) and has not moved once through any of this UAT
cycle. It contains:

- **Routes:** only `app/page.tsx` and `app/api/health/route.ts`. No `/plan`, `/sync`, `/look`, `/coll`,
  `/settings`, no `/login` — confirmed by listing `main`'s tree directly, not by guessing from a live
  request.
- **Migrations:** only `0001_init.sql` and `0002_domain.sql`. **Production's `color_band` and
  `type_color_map` are empty** — 0003 (which fills them) has never reached `main`.
- **Workflows:** only `ci.yml` and `deploy.yml`. No `catalog-mirror.yml`, no `reset-testing.yml`.

**The commit-gap number is illustrative, not a fact to restate.** It was 28 as first logged, 52 when the
tech-lead measured it, 56 when re-verified minutes later, 58 an hour after that, 61 as of this
correction — every increment is `develop` advancing (several of them this log's own PRs), never `main`
moving. Re-check live rather than trust any number here: `git fetch origin && git rev-list --count
origin/main..origin/develop`. **The gap widening for as long as UAT continues is normal, not
deterioration** — a reader in two weeks seeing 90-odd commits should read a branch doing its job, not
neglect.

Live confirmation from the tech-lead session: `https://pokemon-tcg-tracker-sooty.vercel.app/api/health`
returns 200 (a dependency-free check — proves only that the process booted);
`https://pokemon-tcg-tracker-sooty.vercel.app/login` returns 404, which the route listing above makes a
certainty rather than a surprise — there is no login page on `main` to return anything else.

**Two consequences worth naming before cutover, not after:**

1. Once develop's code lands on `main` without a full 0001–0008 migration run first, **every** placement
   would fail `copy_color_band_fkey` — not just Trainers as in UIL-012 — because the band config tables
   are empty, not misconfigured. The cutover fix is that 0003–0008 apply as part of the promotion; naming
   it here so nobody re-diagnoses a second UIL-012 from scratch under time pressure.
2. `smoke`'s assertion that `/login` returns 200 will correctly pass once `main` holds develop's code —
   but would fail today, for an unrelated reason, if anyone pushes a trivial commit to `main` before the
   cutover.

**Part 3 — the access-token privilege loss: cause is unknown by decision, not by lack of means.**
`SUPABASE_ACCESS_TOKEN` lost Management API privileges — confirmed account-level, not project-level (the
same wall blocked reads on both `cpmwdcmokbgcpmkvbtsw` and `bqqerxpdxywnpvndhxbs`). Corrected window: the
secret was last **written** 2026-09-08 02:13 UTC, but the last **green Deploy** was 2026-09-09 04:47 UTC
— so the token worked *after* it was last set, and the actual window with no repo-side change is
2026-09-09 04:47 → 2026-09-13. That rules out "Karvi misconfigured it," which she was told twice and
which was never true.

**401 vs. 403 rules out expiry, deletion, and rotation.** An expired, deleted, or revoked PAT returns
401; this token returns 403 ("does not have the necessary privileges") — Supabase authenticates the
token and refuses the *authorization*, a different failure mode entirely.

**The diagnostic that exists and was declined.** Three account-scoped read-only GETs separate the
remaining live hypotheses: `GET /v1/profile` (which account the token actually belongs to — the
decisive one), `GET /v1/organizations`, `GET /v1/projects`. A wrong/duplicate account (the leading
candidate — the only hypothesis explaining a privilege change with no repo-side cause: sign up by email,
later sign in with Google, end up with two accounts, PAT minted on the second) shows as a profile email
she doesn't log into. Removed-from-org or a moved project shows as the org/project lists omitting the
two project refs. A role downgrade shows as both lists including them while per-project calls still 403.
**The Supabase dashboard cannot substitute for this** — it shows the account she is logged into, never
which account the token belongs to; she could check a correct-looking Owner role indefinitely and learn
nothing if it's the duplicate-account case.

Karvi was offered the probe, a dashboard check, rotation, or deferral, and **chose to rotate the token
without diagnosing.** Record the cause as unknown by decision. Mitigation that makes the rotation
diagnostic by accident: mint the new PAT while logged into the account whose dashboard actually lists
`cpmwdcmokbgcpmkvbtsw` — if the new token works, it was the wrong account or a role change; if it still
403s, the account itself lost access and the probe becomes worth running.

**Why this doesn't block anything today.** After PR #46, nothing that runs uses this token unconditionally
except [`reset-testing.yml`](../.github/workflows/reset-testing.yml), which must never run (Testing holds
the only copy of the real collection until cutover). `deploy.yml`'s `migrate` doesn't use it at all;
`acceptance` and `catalog-mirror` reach for it only as a best-effort fallback when a key is missing, and
both `testing` keys are now set. A bad rotation can't break anything currently running — and, symmetrically,
nothing will confirm a good one.

**One thing this replaces:** an earlier framing called this "discovered by accident." That's wrong — the
catalog mirror needed a key the same account-level wall was blocking, so UIL-004's credential path and
UIL-005's migration path were one job with one external cause, not two unrelated accidents. Two symptoms
in unrelated subsystems tracing to a single external change is the shape that makes a cause worth finding
rather than routing around.

**Suggested fix.** Set `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` on the `production` GitHub
environment (unblocks `acceptance` on `main`); ensure the full migration history (0001–0008) applies to
`main`/production as part of cutover, not assumed from `develop`'s state; and treat the access-token
mystery as closed-by-decision unless the rotated token also 403s, at which point the `/v1/profile` probe
above is the next step.

**Priority rationale.** High for the cutover, not for today's UAT — nothing here affects Karvi's testing
on Testing. Between the two halves, Part 2 (production's actual state) outranks Part 3 (the privilege
mystery): it's fully known with a concrete fix, while Part 3 remains a genuine unknown accepted by
decision. Both sessions flagged this; Karvi has been told at a high level and has not ruled on priority.

## UIL-025 — Finite/Open mode toggle renders with a large dead area inside its own border

- **Reported:** 2026-09-13
- **Status:** **Fixed** — PR [#260](https://github.com/viantihu/pokemon-tcg-tracker/pull/260) MERGED to
  `develop` 2026-09-20 (squash `0de7d66`), confirmed **deployed** to Testing (all gates green on
  `9ae0587`). One declaration, `width: fit-content` on `.modetoggle` in `app/globals.css`, chosen over
  `align-self` because the class also sits in row-flex containers where `align-self` would not hug the
  width. Evidence is measurement, not a rule-text test: the static harness on compiled CSS, before and
  after, at 375 and 1440, by both the dev and QA independently: the editor's Finite/Open border went
  from 355 px wide (229.8 px of dead border at 375; 1,286.8 px at 1440) to 125.2 px, dead space 0; the
  builder's "Own it?" toggle likewise to 186.3 px, dead space 0; the header toggle and the Lines ORDER
  toggle unchanged; no horizontal overflow. Step for Karvi when UAT resumes: open a collection's editor;
  the Finite/Open border should hug its two buttons.
- **Priority:** Low (Karvi's call)
- **Area:** Collections
- **Env:** Testing

In her words: "The finite/open options do not look right." The bordered toggle box around Finite/Open
extends far wider than the two buttons inside it, leaving a large blank rectangle inside the same
border to the right of "Open."

**Root cause: two conflicting `.orow` rules.** [`app/globals.css:1421-1423`](../app/globals.css:1421)
defines `.orow` as a plain block; a second rule at
[`app/globals.css:2425-2430`](../app/globals.css:2425) redefines the same class as
`display: flex; flex-direction: column`. In a column flex container, the cross axis is horizontal, and
flexbox's default `align-items: stretch` stretches every child to the container's full width unless the
child opts out. `.modetoggle` ([`app/globals.css:1949-1953`](../app/globals.css:1949),
`display: flex; border: 3px solid var(--ink); flex: 0 0 auto`) has no `align-self`, and `flex: 0 0 auto`
only governs the main axis — it does nothing to stop the cross-axis stretch. So `.modetoggle` (the
border owner) stretches to fill `.orow`'s full width, while `.modebtn` (the buttons inside it) keep
their intrinsic content width, leaving the gap between "Open" and the border's right edge.

**Suggested fix.** Add `align-self: flex-start` to `.modetoggle` (or `width: fit-content`), so the
border hugs its two buttons regardless of which `.orow` rule wins.

**Priority rationale (Karvi's call): Low.** Purely visual — Finite/Open both still work correctly, and
nothing is mis-recorded.

## UIL-026 — Mirror the printed set total AND release date, so tied collector-number matches can be ranked instead of sorted alphabetically

- **Reported:** 2026-09-13 (not from Karvi — surfaced by the tech-lead session while reviewing UIL-015)
- **Status:** **Closed** — PR [#110](https://github.com/viantihu/pokemon-tcg-tracker/pull/110) MERGED to
  `develop` 2026-09-14 (squash `f3248d9`, migration `0009` adds `set_card_count` + `set_release_date`
  and the search ranks by denominator match then recency), deployed to Testing, the data verified
  **populated by count, not by a green run** (both new columns non-NULL on **23,548 / 23,548** rows,
  `sv04-099` carries `182`, re-verified intact after the 2026-09-15 Testing data refreshes), and
  **confirmed resolved by Karvi on Testing 2026-09-15**: the collector-number search now ranks the real
  match first. The acceptance test was her own `099/182` search, not the deploy.
- **Priority:** Medium (Senior BA's read) — 5th in queue; UIL-022/023 are dev-assigned Highs, three
  other Highs are ahead of it, and Karvi's rule is Lows/Mediums wait for all Highs.
- **Area:** Catalog, Lookup / Collections
- **Env:** n/a — the defect is in the repo, not a running environment

**Context.** UIL-015's fix (query padded candidates before the stripped fallback) resolves Karvi's
"011/217" case, but the denominator she typed is still discarded once it's parsed — and after the fix,
`set_id` alphabetical ordering is the only thing left to break a tie between two sets that both have a
padded exact match on the same local id. That ordering was never a design choice; there's no
release-date column to sort by instead.

**The premise for discarding the denominator is sound, but beatable.**
[`lib/catalog/collector-number.ts`](../lib/catalog/collector-number.ts) documents why the typed total
can't be used as a filter: there's no set-total column on `catalog_card`, and printed totals exclude
secret rares, so a real card like `Shuckle 136/132` legitimately exceeds its own denominator — counting
rows per set would wrongly disqualify it. That reasoning holds. But TCGdex separately publishes exactly
this number as `cardCount.official` — for `me02.5` it's confirmed **217**, the exact denominator Karvi
typed (verified live against TCGdex directly). It simply isn't mirrored: verified against
`0002_domain.sql`, `catalog_card` has `set_id`, `set_name`, `set_series` and no count column at all.

**Scope grew to two columns, not one — `set_card_count_official` AND `set_release_date`, in the same
pass.** Both are already in hand at upsert time: [`lib/catalog/mirror.ts:166`](../lib/catalog/mirror.ts:166)
calls `tcgdex.getSet(setId, locale)`, and that same response carries `cardCount` and `releaseDate`
alongside `serie.name`/`serie.id`, which the mirror already extracts — confirmed directly against
`TcgdexSet` in [`lib/catalog/tcgdex.ts:73-78`](../lib/catalog/tcgdex.ts:73). Zero extra requests, no new
API surface; both thread through `toCatalogRow`'s existing `opts` bag the same way `setSeries` does
today. The reason to do both at once is cost, not tidiness: the expensive part isn't the columns, it's
the `force_all` mirror re-run below, and paying that cost once for two columns beats paying it twice for
one.

**What the two columns buy together, so this doesn't read as a solved problem:** exact-padded-form
match, then denominator match, then most-recent set — a real three-level ordering instead of an
alphabetical accident. Only the first level exists today (UIL-015); this entry builds the other two.

**Three specifics that would otherwise get lost:**

1. **Only the set-DETAIL response carries both fields — the card-detail's embedded `set` object has
   `cardCount` but NOT `releaseDate`.** Verified live: `GET /cards/me02.5-011`'s embedded `set` is
   `{cardCount, id, logo, name, symbol}` — no `releaseDate` key at all. This only works from the
   set-detail path, which is the path the mirror already uses (`getSet`, not the per-card embed). Worth
   recording so nobody later "simplifies" this to read from the card payload and silently drops the
   date — the same shape of hazard as `localIdCandidates` being load-bearing for search with nothing in
   the file saying so.
2. **Coverage is sampled, not proven.** 25 of 218 sets checked; all 25 had a `releaseDate`, including
   four of the six UIL-004 pseudo-sets (`miscp` 1996-01-01, `wp` 1999-09-01, `jumbo` 2000-02-01, `sp`
   2002-08-01 — spot-checked live, exact matches). Encouraging, not proof. Both columns must be
   **nullable, with NULLs ordered last**, rather than assuming full coverage.
3. **The old placeholder dates are stand-ins, not real ship dates.** `1996-01-01`, `2000-02-01`,
   `2002-08-01` are first-of-month/year placeholders — fine for *ordering*, but this column is
   **ordering-only as a hard constraint, not a caveat to read past**: if a release date is ever surfaced
   in the UI, it needs a real source, not this column. `1996-01-01` shown to Karvi as Base Set's actual
   release date would be a small, quiet lie in her own app about her own hobby, and it cannot decide
   which of two 1990s promos actually came first.

**The `force_all` requirement is not "remember to pass a flag" — without it, the run reports success
while doing nothing.** The resume check (added for UIL-004) sees 23,548 rows across 214 sets already at
their full `cardCount.total` and reports "Every set is already mirrored… Nothing to do," exiting 0. A
run that populates **nothing** reports **success**: both new columns stay NULL on every existing row,
ordering silently falls back to arbitrary, and the log says it worked. Naming this explicitly because
it's precisely the failure shape that let UIL-004 hide in the first place — a green result nobody
interrogated is worse than a red one, and this is the same trap on the same workflow.

**Migration numbering needs no coordination — it's enforced mechanically, not negotiated between
sessions.** `scripts/check-migration-order.mjs` runs as a required `migration-order` job on every PR
([`ci.yml:16-31`](../.github/workflows/ci.yml:16), gated on `pull_request`, checked against
`origin/${{ github.base_ref }}`) and fails the PR if a new migration sorts behind one already merged to
the base branch. Its own header records why: PR #13's `0003` landing after `0004` had shipped cost 18
consecutive red Deploys. `develop` is at `0008` now; whoever merges second here simply renumbers and
pushes.

**Suggested fix: a ranking signal, not a filter.** Prefer a result whose set's official count equals the
typed denominator, then prefer the most recent `set_release_date` among remaining ties — never exclude
on either, which is what keeps the `Shuckle 136/132` case safe. For Karvi's query the count alone is
already decisive: `me02.5` is 217 and none of the twelve competing McDonald's sets are (12–25).

**Priority rationale (Senior BA's read): Medium.** The search already works correctly after UIL-015;
this makes the ranking principled rather than an alphabetical accident. Not High — nothing is broken and
no data is at risk right now. Not Low either, because the current tie-break is genuinely arbitrary rather
than merely imperfect, and this is the only available principled disambiguator. **Stays Medium after the
second instance below, and worth saying explicitly so the lack of escalation doesn't read as neglect:**
Karvi's queue rule gates Lows behind open Highs, not Mediums, so this can be assigned and worked without
inflating its rank — and inflating it would be wrong regardless, since the search genuinely returns her
card both times, just not first. **Assigned to the tech-lead now.**

**Second reported instance — the argument for the fix is no longer hypothetical.** Karvi hit this gap
again (logged separately as UIL-044 in her own words, since the log records what she personally
observed even when the cause is already tracked here — this entry is where the fix belongs, not there):
typing `099/182` returned five cards sharing `local_id` "099," with the real match — Minior, Paradox
Rift — landing fourth of five rather than first. Confirmed live against the exact failing query:
`GET /cards/sv04-099` returns Minior with `set.cardCount.official: 182` — **exactly** the denominator she
typed — while none of the other four colliding sets' official counts match (193, 197, 165, 91). One gap,
two independent reports, the second arriving after the first (UIL-015) was already fixed. **For this
exact query, the fix's ordering is decisive, not just principled:** exact-padded-form match (already
shipped) finds all five; denominator match would then promote Minior alone to first, since no other set
sharing a `099` has an official count of 182.

## UIL-027 — "Commit the haul" is the wrong model: a card should be shelved the moment "Done" is clicked

- **Reported:** 2026-09-13
- **Status:** **Closed** — server half PR [#83](https://github.com/viantihu/pokemon-tcg-tracker/pull/83)
  and client half PR [#109](https://github.com/viantihu/pokemon-tcg-tracker/pull/109) MERGED to `develop`
  2026-09-14 (#109 squash `e911c8c`), deployed to Testing, and **confirmed resolved by Karvi on Testing
  2026-09-14**: Done shelves the card immediately and the "Commit the haul" button is gone. Verified by
  content on `origin/develop` (`shelveCardAction` wired in `PlanScreen.tsx`; no Commit button rendered),
  not by PR state — an earlier stacked PR (#98) reported MERGED while shipping nothing.
- **Priority:** High (Claude's read — this is a core-workflow redesign, needs Karvi's confirmation)
- **Area:** Plan
- **Env:** Testing

In her words: "We need to rework the haul workflow. Every single card will require a decision, so
'committing the haul' does not make sense. That button basically treats unshelved cards as being in
inventory, when that defeats the entire purpose of the app. When the user clicks 'Done', that card has
been shelved and should be put in inventory. Any card that has not received a location should still
appear on that 'haul plan' page. That said, I don't see a purpose for 'Committing the haul'."

**This is not a bug in the sense the rest of this log uses the word — it's a deliberate design that her
mental model doesn't match, and the log should say precisely what today's design is before proposing to
change it.**

**What "Done, next card" actually does today: nothing persists.** It's pure client state
([`PlanScreen.tsx:326-333`](<../app/(ui)/plan/PlanScreen.tsx>:326), `toggleDone` mutates a `Set<string>`)
— no network call, no server action. It drives the worklist checkmarks, the progress pips, and the
`cur`/`advance` cursor, and nothing else. `done` never appears in `CommitActionInput`, `CommitInput`, or
`DraftItem` — confirmed by grepping `lib/plan/*.ts`.

**What "Commit the haul" actually does: everything, unconditionally, in one shot.**
[`PlanScreen.tsx:279-296`](<../app/(ui)/plan/PlanScreen.tsx>:279) sends the **entire draft array** to
`commitHaulAction` → `commitHaul` ([`lib/plan/commit.ts:93-102`](../lib/plan/commit.ts:93)), with no
filter by `done` anywhere in the path. `commitHaul` re-runs the cascade over the whole draft and writes
every card — ticked or not — in one `apply_write_ops` transaction. Her framing is exactly accurate:
clicking "Done" is a physical worklist aid with zero database effect; the placement she just decided on
doesn't exist until a single all-or-nothing click covers every card in the haul, including the hundreds
she never looked at. This is already independently confirmed in UIL-012's own record: "check-off is a
physical worklist aid only; `commitHaulAction` sends the whole `input.draft` regardless of what is
ticked."

**And the inverse is also true: nothing persists if she never clicks Commit.** Working through 50 of 700
cards and closing the tab writes zero rows — not even those 50. The `done` set, the cursor, and the
computed plan live only in a `sessionStorage` cache (UIL-006), explicitly documented as a client
convenience, not a database record, and it evaporates on cache clear or another device.

**Why it's built this way — a real tradeoff, not an oversight.** `lib/plan/commit.ts`'s own header is
explicit: the whole write set is computed in TS, then applied in **one transaction**, specifically so "a
commit that fails partway now leaves ZERO rows" — this replaced an earlier per-row
compensating-rollback design. `PlanScreen.tsx` states the same intent in its commit-button copy: "The
commit is the one write that must not be interrupted... Saying so is the point: it discourages a
reload." This is the M10 atomicity guarantee, and it is deliberately whole-haul, not per-card. Nothing in
the code shows any consideration of a per-card commit model — check-off was designed purely as a
worklist aid, never as a trigger for a write.

**The tension her request surfaces.** Her model — each "Done" immediately shelves that card — requires
converting the unit of atomicity from "the whole haul" to "one card." That's buildable (there's already
a per-card write shape: `union_collection_targets`/single-copy ops in `lib/coll/remove.ts` show the
pattern), but it changes what "atomic" protects: today, a mid-haul failure (like UIL-012's FK violation)
rolls back everything, so a bad haul never leaves a half-sorted mess in the database. Under her model, a
failure on card 340 of 700 would leave cards 1–339 genuinely shelved and 341–700 untouched — which is
**closer to what she's asking for**, not further from it (partial real progress instead of an
all-or-nothing gate), but it is a different integrity guarantee than the one M10 was built to provide,
and whoever picks this up should say so rather than quietly narrowing it.

**What already satisfies half of her request today, with no change needed.** "Any card that has not
received a location should still appear on that haul plan page" — this already works: `/plan` re-derives
its pending queue from the DB's actually-unplaced copies (`loadPendingPlacementDraft`, UIL-003's fix),
not from a session cache. The part that needs to change is only the "Done" side — turning it from a
no-op checkbox into a real write.

**Suggested direction, not a final design:** convert "Done, next card" into a per-card `apply_write_ops`
call for just that one card's routing decision, and either remove "Commit the haul" entirely (her
stated read) or repurpose it into something that only matters if a hybrid batch/manual mode survives —
that's a call for whoever designs this, not something to guess at here.

**Ambiguity left for the implementer, explicitly not resolved by this entry:**

- Does removing "Commit the haul" mean *every* Done click is its own transaction (matching her words
  exactly), or does she want a lighter-weight batching (e.g. commit every N cards) for reasons of
  server load or undo-ability? Worth confirming before building, since "no purpose for committing the
  haul" could mean either.
- What replaces the "commit is the one write that must not be interrupted" framing in the UI once writes
  happen continuously per card — does "Undo" (the toggle-done reversal) need to become a real undo of a
  real write, not just an unchecked box? Today `Undo` on a done row only flips `done` back to false; it
  writes nothing, so under her model it would need to actually reverse the shelving.
- Does the haul-level progress bar / haul_id concept still make sense once there's no single haul-level
  commit event — `commitHaul` currently stamps a `haul_id` on every copy it writes in one call
  ([`lib/plan/commit.ts`](../lib/plan/commit.ts)); a per-card model needs to decide whether a `haul_id`
  still groups "cards decided in this sitting" or is dropped.

**Priority rationale.** High: this is her own description of the core screen defeating the app's stated
purpose, not a peripheral complaint, and it changes the transaction model for every future haul. Not
something to patch quietly — flagging as a redesign that needs its own scoped implementation, likely
larger than any single entry above it today.

**Update 2026-09-17: the dead bulk-commit entry point is being deleted, on her explicit instruction.**
While designing UIL-069's colour-mismatch choice, the question came up of what a whole-haul bulk commit
should do when there's no per-card screen to ask on. Verified directly: `commitHaulAction`
([`app/(ui)/plan/actions.ts:124`](<../app/(ui)/plan/actions.ts>:124)) has **zero callers** anywhere in
`app/` or `lib/` on `origin/develop` — this per-card rework left it unreachable since #83/#109, and it
was never removed at the time. Asked whether to delete it or keep it in case bulk commit ever returned,
her words: **"delete it, we're not going back to bulk commit."** So `commitHaulAction` and `commitHaul`
come out; `buildHaulCommitPayload` and the rest of the shared write machinery **stay**, since
`commitCardPlacement` (the per-card path this entry's fix put in place) depends on them directly
([`lib/plan/commit.ts:132`](../lib/plan/commit.ts:132) and
[`:216`](../lib/plan/commit.ts:216) both call it) — this removes the unreachable bulk entry point, not
the plumbing underneath it. Also settles, by superseding it, a briefly-considered approach of refusing
a band-mismatch card specifically in the bulk path (UIL-069) — moot once the bulk path itself is gone.

**Update 2026-09-18: done, not just planned.** PR [#176](https://github.com/viantihu/pokemon-tcg-tracker/pull/176)
(squash `4655145`, deployed on `c6ef4c4`) deleted `commitHaulAction` and `commitHaul` — zero callers
re-verified before removal, matching the earlier check above. `buildHaulCommitPayload` and the shared
write machinery are unchanged, confirmed by grep: no remaining reference to either deleted function
anywhere in `app/` or `lib/`.

## UIL-028 — The batched catalog lookup is unpaged, so raising its chunk size would silently truncate results

- **Reported:** 2026-09-13 (not from Karvi — found by QA reviewing #70's sync batching, corroborated
  independently)
- **Status:** **Fixed** — PR [#255](https://github.com/viantihu/pokemon-tcg-tracker/pull/255) MERGED to
  `develop` 2026-09-20 (squash `d1d971f`), QA-gated on the merged tree (967 tests; guard removed or made a
  no-op → the two throwing cases resolve silently with 1,000 rows), confirmed **deployed** to Testing
  (Deploy, migrate, smoke, acceptance and Vercel green on `d40159b`). `findBySetLocalMany` now selects
  each chunk with `{ count: "exact" }` and runs `assertReadComplete` (the UIL-031 guard), so a chunk cut by
  PostgREST's `max-rows` throws by name with the remedy ("lower chunkSize, never raise it; the sync must not
  mark these ids fetched") instead of truncating silently; default chunk stays 200; the comment names both
  constraints (URL length and the unpaged per-chunk cap) and the failure mode. The count is computed inside
  the same statement over the index-served filtered set, not a second scan. Sync semantics untouched.
  Nothing for Karvi to test; closes on evidence.
- **Priority:** Low, held behind all open Highs and Mediums per Karvi's queue rule
- **Area:** Sync, Catalog
- **Env:** n/a — latent in the repo, not currently reachable

**Nothing is broken today.** Stating that first so this doesn't read as a live bug.

**Root cause.** [`lib/repo/catalog-card.ts:71-85`](<../lib/repo/catalog-card.ts>:71),
`findBySetLocalMany(db, setId, localIds, chunkSize = 200)`, issues a plain
`.select("*").eq("set_id", setId).in("local_id", chunk)` per chunk with **no `.range()` paging** —
verified directly, confirmed absent. Each chunk is subject to PostgREST's `max-rows` cap (1000 on
Supabase).

**Why it's safe today, and only today.** A 200-`localId` chunk within one `set_id` returns roughly 200
rows — you'd need an average of five duplicate printings per `(set_id, local_id)` to reach the cap,
which a healthy mirror never has. But nothing in the code states that coupling: the comment at
[`catalog-card.ts:69`](<../lib/repo/catalog-card.ts>:69) explains the chunking as being about **URL
length** — confirmed, that's the only reason given — a different constraint from the row cap, and
reading it would actively suggest that raising `chunkSize` for speed (2000 looks harmless) is safe. It
isn't: it would silently truncate results.

**The failure mode if that happens.** [`lib/sync/catalog-lookup.ts:203-206`](../lib/sync/catalog-lookup.ts:203)
marks every requested `localId` as `fetched` once the query for its chunk returns — regardless of
whether a matching row actually came back for that specific id (confirmed: `fetched.add` runs over every
requested id, not over the rows actually returned). A key marked fetched but truncated by the cap reads
as a **proven absence** rather than an unchecked one — real cards would quietly park in the unresolved
queue, looking like a catalog gap rather than a bug. No error, no test failure; existing tests use small
fixtures well under any cap.

**What's correctly safe, recorded so nobody re-audits it.** `fetched.add` running *after* the awaited
query returns (not before) means a failed query throws and propagates before anything is marked
fetched — the dangerous direction (treating an un-run query as a proven absence) is closed. Chunking
does correctly prevent the URL itself from blowing up.

**Suggested fix.** Page the chunk query the way `lib/repo`'s `listAll` already does for UIL-004 — advance
by rows *received*, not rows requested — so the coupling between `chunkSize` and `max-rows` stops
mattering regardless of what either value is set to. Cheap alternative: a comment on `chunkSize` naming
the `max-rows` constraint explicitly, though that only protects for as long as someone reads it.

**Priority rationale: Low, and explicitly not for being unimportant.** Not reachable at current values,
no data at risk today, small fix. Held Low because it needs a code change to become live — but it's the
same class as the `list()` truncation found earlier today and the same class as UIL-004 itself: a silent
partial result that reads as a complete one, invisible until the exact moment it isn't. Recorded as its
own entry rather than left in a message, per the lesson UIL-020 already recorded: a finding with no
owner and no tracking item doesn't get deprioritized, it evaporates.

## UIL-029 — Hand-written `DbClient` test doubles are unverified, so a fixture can certify the wrong behaviour

- **Reported:** 2026-09-13 (not from Karvi — found by the UIL-010/015 dev session, in its own test file,
  reported against itself)
- **Status:** **Fixed** — every harness-fidelity fault this entry recorded is closed, and the harness now
  has tests of its own. Fifth instance (hand-kept migration lists): PR
  [#218](https://github.com/viantihu/pokemon-tcg-tracker/pull/218) (`2e0a98c`), both harnesses read
  `supabase/migrations/` from disk and `harness-applies-every-migration.test.ts` fails if a migration on
  disk was not applied. The last hand-written `DbClient` double, `tests/catalog/mirror.test.ts`, moved onto
  the PGlite shim: PR [#244](https://github.com/viantihu/pokemon-tcg-tracker/pull/244) (`aa1fe23`). The
  contract suite the entry asked for: PR [#245](https://github.com/viantihu/pokemon-tcg-tracker/pull/245)
  (`e1e171d`), `tests/support/pglite-client.contract.test.ts`, 19 cases against real Postgres and 1,200
  rows, pinning count-under-range as the total, order direction, `head: true`, `maybeSingle` on 0/1/2
  rows, numeric and timestamptz shapes, and unmodelled shapes throwing; nine mutations all killed. Three
  more fidelity gaps found and fixed while writing it, each pinned: timestamptz returned as a `Date`
  where PostgREST gives an ISO string (now an ISO string); `maybeSingle` on two rows returned the first
  silently where PostgREST errors (now `PGRST116` in `error`); Postgres errors rejected raw where
  supabase-js returns `{ data: null, error }` (now in `error`, so the `if (error) throw error` branches in
  `lib/repo` are reachable from PGlite for the first time). `upsert()` without `onConflict` now conflicts
  on the table's primary key read from `pg_index`, so `setAliasRepo.upsert` runs end to end on PGlite: PR
  [#253](https://github.com/viantihu/pokemon-tcg-tracker/pull/253) (`ffb7dfb`). Test-only throughout;
  nothing for Karvi to test; closes on evidence. The next fidelity gap gets a new entry, not this one.
- **Priority:** Medium (Senior BA's read) — the one Medium with a live argument for jumping the queue,
  since it protects every fix currently being written; not reassigned ahead of the four open Highs unless
  Karvi says otherwise
- **Area:** all (test infrastructure)
- **Env:** n/a — in the repo, not a running environment

**The concrete instance, already fixed in this one file as part of landing UIL-015.** Two of that
session's own UIL-010 tests asserted "exact match ranks first" and **passed while the bug was live** and
Karvi was seeing five wrong McDonald's cards. The fake `DbClient` in
[`tests/catalog/card-search.test.ts`](../tests/catalog/card-search.test.ts) re-sorted on each `.order()`
call instead of composing them the way PostgREST does, and compared with `localeCompare`, which does not
put digits before letters — the exact mechanism of UIL-015 (`2011bw` sorting before `me02.5`). Confirmed
directly: the file's current comment names both defects explicitly (`:110-116`) as the reason the fake
used to mask the bug. Measured against pre-fix source: the unfaithful fake (as it shipped) failed 1 test;
a faithful one fails 5, including the two that should have caught it.

**Why Medium, not Low.** This is UIL-013's failure mode — a fixture contradicting production — in a
different file, found hours after the same session helped diagnose UIL-012, which was itself hidden by
display-form band fixtures. Three occurrences of one shape in one day, by different people, is the tool
permitting it silently rather than anyone being careless. Unlike UIL-013, this one demonstrably hid a
live High-priority bug from a green suite rather than being a latent risk. `tests/support/pglite-client.ts`
says the same thing in its own header, independently: "[a hand-rolled fake] cannot prove those ops do
what the author expected once Postgres runs them... UIL-012 shipped through a fully green suite exactly
that way." Not High: no user-facing defect exists right now, and every fix currently in flight is being
revert-checked against pre-fix source, which is the active mitigation.

**The risk is not uniform across the six files — triaged by class, which narrows the fix.**

- **Dangerous: doubles modelling PostgREST query semantics** — ordering, `limit`, `in`, filter
  composition. These can disagree with the server about *which rows come back*, which is exactly how
  this bug hid. `tests/catalog/card-search.test.ts`, `tests/catalog/mirror.test.ts`,
  `tests/sync/catalog-prefetch.test.ts`, `tests/repo/list-all-paging.test.ts` (the last as an inline fake
  table object, `db: { from: () => query } as unknown as DbClient`, same exposure with no named
  function).
- **Harmless: call-recorders that only assert on what was *sent*, not what comes back.** Corrected
  classification for `tests/sync/exec-atomicity.test.ts`: not "mixed," genuinely **safe**. Verified its
  `FakeDb.rpc` captures the call and every assertion checks the captured payload
  (`expect(fake.rpcCalls[0].fn).toBe("apply_write_ops")`, checks on `ops`/`resync_group_ids`) — it
  emulates no query semantics because nothing in the file asserts on a query *result* from the fake; the
  data-shape assertions in the same file go through real Postgres via `pglite-rpc`. **The sharper
  discriminator, checkable from a test's assertions alone rather than requiring a read of the fake
  itself: a double that asserts on what was *sent* is safe; a double that asserts on what comes *back* is
  exposed.** That makes the count **five** files, not six.
- **`tests/plan/pending-placements.test.ts` — and I got this one wrong first and am correcting it in
  place.** I earlier concluded its no-op `order()` was harmless because `lib/plan/pending.ts` never calls
  `.order()`. That checked the wrong file: `loadPendingPlacements` calls `copyRepo.listUnplaced`, and
  [`lib/repo/copy.ts:52-53`](../lib/repo/copy.ts:52) **does** order `.order("created_at").order("id")`,
  documented as "oldest first, so the queue is worked in the order the cards entered the collection."
  So the fake's no-op `order()` meant that contract was **never assertable** — and it matters concretely:
  she works the stack top to bottom and the haul-bar pips are indexed by that order, so a silent reversal
  in `listUnplaced` would be a real, visible-to-her defect the suite could not have caught. This belongs
  in the dangerous bucket, not a harmless third case. (The lesson repeats today's recurring one: I
  checked `pending.ts` because it's the file the test is named for, not `copy.ts` where the ordering
  actually lives — a claim answering the wrong question.)

**#80 (open) fixes two of the dangerous set — `pending-placements` and `list-all-paging` — and the
audit that produced it is the most useful part.** All numbers below observed by reverting and running,
not predicted:

- `tests/repo/list-all-paging.test.ts` was a **near-miss**: its `order()` was a no-op, so nothing
  noticed if the paged read stopped ordering by primary key. Removing `.order(pk)` from `pageAll`
  ([`lib/repo/base.ts:49`](../lib/repo/base.ts:49)) now fails **4 tests**; before, **zero**. Not
  cosmetic: paging is only coherent over a stable window — without a stable order a paged walk can repeat
  or skip rows between requests, which is UIL-004's "partial result reads as complete" through a
  different door, and `listAll` is what reads the 23,548-row `catalog_card`.
- `tests/sync/catalog-prefetch.test.ts` needed **nothing** — it implements only `eq`/`in` for a query
  that uses only `eq`/`in`. Worth recording as the discriminator working: the risk isn't "hand-rolled,"
  it's "hand-rolled *and* modelling an operator the assertions depend on." A double that implements
  exactly what's called is correct scope.

**So the remaining scope after #80 is `tests/catalog/mirror.test.ts` only** — `card-search.test.ts` was
already fixed landing UIL-015, and `exec-atomicity.test.ts` is confirmed safe above, not scope at all.

**#80 buys time, not immunity — the entry stays open with reduced scope, not closed.** The doubles still
model only the operators the code under test happens to call today, so the next new operator is
unprotected again. The durable answer remains the real-Postgres client: repo-level query behaviour tested
through `tests/support/pglite-client.ts` cannot drift the way a hand-rolled fake silently can.

**`tests/support/pglite-client.ts` is the mitigation pattern, not a suggestion — it already exists.**
Backed by real Postgres, real migrations, real RLS, real `apply_write_ops`; deliberately narrow (only
the read surface `lib/repo` actually uses), and throws loudly rather than lying if a repo call shape
grows past what it models. This is what made PR #67's suite trustworthy, and it's the same class of
fidelity issue UIL-013 already described for engine-test fixtures, generalized: **a hand-written test
double is production code with no tests of its own.** Nothing checks that ours models PostgREST
correctly, and this entry is the second and third time in one day that gap produced a real miss.

**Suggested fix.** Move `mirror.test.ts` onto `tests/support/pglite-client.ts`, the one file left after
#80 and the reclassification above. Where a real DB is genuinely too heavy for a given test, add a
conformance test that runs the same queries through both the fake and PGlite and asserts identical
results instead — the durable version, since it makes the double's fidelity a tested property instead of
an assumption.

**A related failure mode in the *mutation* check, worth recording alongside the revert-check rule
above.** A mutation test on a different PR produced a false negative: its first mutation added a dead
statement instead of neutering the branch it was meant to test, and reported "0 failed" — which reads as
"the suite would catch a real mutation" when it proves nothing. Same family as the revert-check finding
above: **a check meant to catch a lying test can lie in the same way the test does**, and the fix is the
same — verify the check itself changed something observable, don't trust a clean report on faith.

**How this was found, and the sharper rule it implies.** The revert check (run a test against pre-fix
source, confirm it fails) was adopted to prove a test catches its own bug. It turns out to do more: it
audits the test double itself. The precise logic — a test that passes pre-fix is *positive* evidence the
harness is wrong, because a correct harness, a live bug, and a correct assertion cannot all hold at
once. So the rule isn't "revert-check migrations" — it's **run the revert check on every fix, and treat
an unexpected pass as a harness bug until proven otherwise.** The dev session found this only because the
headline test passed pre-fix, made no sense, and got chased down instead of accepted as green.

**Independently reproduced twice more, from two different starting points.** One session reverted
`search()` to its pre-fix form while keeping the current, corrected fake and got 5 failures naming both
original UIL-010 tests explicitly. A second, isolated run (this session, in a throwaway worktree, node
untouched) reproduced the identical result: 5 of 15 fail, 10 pass, same two named tests among the
failures. Three sessions, three different entry points, same number.

**Priority rationale (Senior BA's read): Medium.** Not High — nothing user-facing is broken right now,
and the fixes currently in flight are already being revert-checked as a mitigation. Genuinely the one
open Medium with an argument for jumping ahead of it, since a fix here protects every other fix's own
tests from the same failure mode — flagging that explicitly rather than letting it sit purely on
priority-number ordering. Karvi has not seen this yet.

**The revert-check rule catching itself, before review this time.** Building the fix for UIL-031's fifth
site, a page-tracking test double reset its own counter on every `.from()` call — and since the
production paging function calls `.from()` fresh per page, the test could only ever observe the last
page. It would have passed against a fake that couldn't distinguish paged from unpaged reads. Caught by
the author, pre-review, by applying this entry's own rule ("an unexpected pass is a harness bug until
proven otherwise") to the harness being written for the fix. Second time today the rule has caught a
lying double; the first time before anyone else needed to.

**A third and fourth instance, found building #121 (UIL-045) and confirmed against `origin/develop`
`7e377fa` with #121 open — this is `tests/support/pglite-client.ts` itself, the mitigation pattern this
entry recommends everyone move onto, having exactly the fidelity gap the entry describes.**

1. **`order()` silently ignored a descending request.** `order(col: string): this` took no options
   parameter at all, and `compile()` always emitted `order by ... asc` — a caller passing
   `{ ascending: false }` (as several real repo methods do) would get ascending results with no error.
   Confirmed on `7e377fa`; #121's fix (`order(col, opts?: { ascending?: boolean })`, honouring it) says
   why in its own comment: "silently sorting ascending for a `{ ascending: false }` caller is the shape
   of double that certifies wrong behaviour."
2. **`count` reported the page size as the total, once `.range()` existed to page at all.** The fake had
   no `.range()` on `7e377fa`; #121 adds it (needed for `pageAll`/`listAll`, UIL-031) and, in the same
   change, fixes `count: this.wantCount ? rows.length : null` to run a separate unranged `count(*)`
   query instead — `rows.length` under a range is the page size, and reporting that as the total is
   exactly how `assertReadComplete` (UIL-031) would be fooled into certifying a truncated read as
   complete. Both faults were introduced and fixed within the same PR, before either reached a test that
   would have relied on them silently.

**A related seed-fidelity gap, same investigation, not a `DbClient` fault but the same shape.**
[`seedCatalogCards`](../tests/support/pglite-rpc.ts:77) inserts only `tcgdex_id` and `name` — `set_id`,
`local_id`, and `artwork_group_id` all stay null. `isDuplicateCard`
([`lib/engine/duplicate.ts:19-26`](../lib/engine/duplicate.ts:19)) requires both fields of either match
condition to be truthy (`a.artworkGroupId && b.artworkGroupId`, or `a.setId && a.localId`) — so **no two
cards seeded this way can ever be detected as duplicates**, regardless of what the test intends. Any
cascade duplicate-detection assertion built on this seed alone passes while proving nothing, the same
failure shape this entry is about, one layer over in test *data* rather than a test *double*. Open
follow-up rather than its own UIL: audit what else in the suite leans on the id-only seed for a property
it can't actually exercise.

**A fourth instance, in the same mitigation-pattern file, found building PR #182 (open) — confirmed on
`origin/develop` `5f0715e`.** `tests/support/pglite-rpc.ts`'s own `MIGRATIONS` array
([`:17-26`](../tests/support/pglite-rpc.ts:17)) stops at `0008_collection_removal_ops.sql` — 0009
(set metadata) and 0010 (the UIL-062 slot-release repair) were never added, so **every PGlite-backed
test in the repo has been running against a schema two versions behind `develop`**, not the one version
the earlier findings above already flagged this file for. #182 restores them (plus 0011). The
implication is the same shape as the other three, one level up: any PGlite test that passed while
depending on a column or behaviour added in 0009 or 0010 was passing for the wrong reason, and any test
that *should* have failed against the real, current schema had no way to.

**Four distinct harness-fidelity faults now, found across two days, in the file this entry's own
suggested fix recommends moving everyone onto.** `count` returning the page size as the total under a
`.range()` (would have re-armed UIL-031's truncation hazard silently); `order()` ignoring `{ ascending:
false }`; `seedCatalogCards` writing only `id`/`name`, making every cascade duplicate assertion built on
it vacuous; and now the migrations array running two versions behind. **Every one of the four was found
by a developer checking, not by a test failing** — which is this entry's own thesis, restated by its own
mitigation pattern needing the same kind of check applied to itself four separate times. Staying Open
on that basis, not closed by any one of the four fixes.

**A fifth instance, and worse than the fourth — a second, independent copy of the same hardcoded
list, further behind.** [`tests/backfill/binder-section.test.ts:27-32`](../tests/backfill/binder-section.test.ts:27)
has its **own separate** `MIGRATIONS` array, not shared with `pglite-rpc.ts`'s — confirmed directly, and
it stops at `0004_catalog_artwork.sql`, roughly nine migrations behind `develop` as of this writing.
Same shape, same cause: a literal list that has to be remembered and updated by hand every time a
migration is added, in a second location nobody was checking. **Fix direction, generalized rather than
patched per-copy:** both harnesses should read `supabase/migrations/` at runtime (sorted, all `.sql`
files) instead of maintaining a duplicated literal — from
[`docs/root-cause-analysis.md`](../docs/root-cause-analysis.md) §9 step 1, which also recommends a
DbClient contract suite and a 1000-plus-row fixture as the durable answer to this entry's whole class
of gap (RC-5) — noted here as a forward pointer, not yet built.

**A sixth shape, found while building UIL-074, not yet a fault.** PR
[#239](https://github.com/viantihu/pokemon-tcg-tracker/pull/239) (merged `bd6156c`) surfaced that the
PGlite shim hands `created_at` back as a JavaScript `Date`, where PostgREST returns an ISO string.
UIL-074's own loader compares epochs, so it is correct under either representation — this is not a live
defect. It is the same family as the numeric-parser fix in [#186](https://github.com/viantihu/pokemon-tcg-tracker/pull/186):
a fake diverging from the server on a value's *type*, not its ordering or filtering. Recorded so a future
test that string-compares a `timestamptz` off this shim doesn't pass or fail for the wrong reason.

## UIL-030 — `openBlockNeeds` is never set, so the "repurposed binder block" offer is unreachable

- **Reported:** 2026-09-14 (not from Karvi — found by the Senior Dev session while fixing UIL-017)
- **Status:** **Fixed** — built end to end in two PRs, both deployed. Karvi's ruling 2026-09-20: "a must
  have — the user must be able to track where ALL cards are, including blocks"; the field was never wired
  because nothing behind it existed (no block destination, only Backfill ever wrote a `binder_block`).
  **Definition, now recorded:** an open binder block need is a `line_slot` with state `block` and no
  line-terminated `binder_block` backing it, counted once per plan run in `lib/plan/context.ts` into
  `ctx.openBlockNeeds`. **PR A, the data path:** [#276](https://github.com/viantihu/pokemon-tcg-tracker/pull/276)
  (squash `83fbe56`): the count and candidates, the engine's `offerBlockRepurpose` as a field, a
  `MoveDestination` of kind `block`, and the commit and `applyMove` writes (the copy as role `block` in the
  line's binder back half plus `insert_binder_block` line-terminated / repurposedDuplicate with the copy id,
  so the need closes and the duplicate's location is tracked); 7 PGlite and 3 unit cases; nothing visible
  changed. **PR B, the offer:** [#279](https://github.com/viantihu/pokemon-tcg-tracker/pull/279) (squash
  `fe970db`), QA-gated (1047 tests; candidates passed but the section suppressed fails 3 DOM cases, the
  offer-text guard dropped fails the spotlight case), confirmed **deployed** (all gates and Vercel green on
  `fe970db`): the spotlight shows "Offered as a repurposed binder block — <species> LINE has a reserved
  pocket with nothing in it"; the move sheet leads with "USE AS A BINDER BLOCK · FILLS A RESERVED POCKET"
  chips only when the Plan passes candidates (Lines and Lookup never do, pinned); the override reads
  "Block · <species> line · <binder> · Back". Test debt, not a hold: dropping only the `offerBlockRepurpose`
  guard in moveTargetFor leaves every test green; b0 owes a plan-move-target case. Step for Karvi when UAT
  resumes: on the Haul Plan, a second copy of a card whose line has a blocked stage shows the offer; Change
  position, pick the line, Done; the Lines screen then shows that slot's block backed by the duplicate.
- **Priority:** High (Karvi's own ruling, 2026-09-20: a must-have — "the user must be able to track where
  ALL cards are, including blocks"). Was Low, Senior BA's read.
- **Area:** Plan / Engine
- **Env:** n/a — in the repo, not a running environment

**Root cause: a declared-and-read engine field that no caller ever writes.** Verified directly on
`origin/develop`:

- [`lib/engine/cascade.ts:56`](../lib/engine/cascade.ts:56) — `openBlockNeeds?: number;` declared on the
  context.
- [`lib/engine/cascade.ts:245`](../lib/engine/cascade.ts:245) — read: `resolveDuplicate(…,
  ctx.openBlockNeeds ?? 0)`.
- [`lib/engine/duplicate.ts:79`](../lib/engine/duplicate.ts:79) / [`:101`](../lib/engine/duplicate.ts:101)
  — read again, and `offerBlockRepurpose: openBlockNeeds > 0`.

A grep across `lib/` and `app/` finds **no writer** — nothing ever sets it. So it is always 0,
`offerBlockRepurpose` is always `false`, and the "Offered as a repurposed binder block." clause on the
duplicate/bulk path ([`cascade.ts:279`](../lib/engine/cascade.ts:279)) **has never rendered in the
shipped app.**

**Two possibilities, and this entry deliberately does not pick one — because only Karvi can.** Either
the feature was designed and never wired (then the gap is the *wiring*, and deleting the field would
quietly drop a real product intent), or it's a vestige (then the field, the copy, and `duplicate.ts`'s
`openBlockNeeds` parameter should all go). Deciding requires knowing whether "repurpose an open binder
block" is still a product idea — a product call, not an engineering one.

**Why the Senior Dev was right to leave it while fixing UIL-017.** It declined to add an engine field
just to make the unreachable copy explainable — that would be building plumbing for a message nobody
can see. Recording the decision is the point here, more than the code.

**Second instance of dead-guard code today, worth a cross-reference.** `app/(ui)/coll/actions.ts:87`'s
`band(...) ?? "white"` fallback can never fire (noted in UIL-012's record — `band()` always returns a
value). Two independent unreachable-defensive-code findings in one day suggests a dedicated pass for
dead guards might eventually be worth more than either individual fix.

**Priority rationale (Senior BA's read): Low.** Genuinely Low, not "Low because we're busy" — nothing
malfunctions, no data is at risk, and no user-visible behaviour changes either way until someone decides
which direction to resolve it. **Flagging specifically for Karvi:** the decision of whether the
binder-block repurposing idea is live or vestigial is hers, and it determines whether the fix is "wire
it up" or "delete it."

## UIL-031 — Four unpaged reads on tables her usage grows, so each can silently start returning a partial result

- **Reported:** 2026-09-14 (not from Karvi — found proactively, looking for the "fine at small scale,
  wrong at real scale" pattern rather than waiting for her to hit it)
- **Status:** **Fixed** — PRs [#90](https://github.com/viantihu/pokemon-tcg-tracker/pull/90) (squash
  `dd9c88d`, truncation made impossible to ignore), [#96](https://github.com/viantihu/pokemon-tcg-tracker/pull/96)
  (squash `ca9b982`, the reconciler's current-state read paged) and
  [#104](https://github.com/viantihu/pokemon-tcg-tracker/pull/104) (squash `77812f4`, `listUnplaced` paged
  instead of throwing) MERGED to `develop` 2026-09-14, QA-reviewed, confirmed **deployed** to Testing (all
  four conditions green on `7cb1a36`). #90's premise — PostgREST silently caps the response — is now
  *observed* through supabase-js on her real data, not deduced. No user-visible test step: this was latent
  at her scale, so Fixed stands until a real-data read past the cap confirms it.
- **Priority:** Medium
- **Area:** Sync, Plan
- **Env:** Testing — **latent, not live**, confirmed by a live count (see below)

**Four call sites, all confirmed unpaged on `origin/develop`:**

- [`lib/repo/sync.ts:29-33`](../lib/repo/sync.ts:29), `unresolvedEntryRepo.listWaiting` —
  `select("*").eq("status","WAITING")`, no `.range()`.
- [`app/(ui)/sync/actions.ts:130`](<../app/(ui)/sync/actions.ts>:130) — plain
  `unresolvedEntryRepo.list(db)`, same exposure.
- [`lib/repo/copy.ts:46-57`](../lib/repo/copy.ts:46), `copyRepo.listUnplaced` — filtered and ordered
  correctly, but still a bare `select("*")` with no `.range()`.
- [`lib/repo/base.ts:87-94`](../lib/repo/base.ts:87), `createRepo(...).list` generically — its own
  doc comment already says why this is dangerous: "PostgREST caps every response at the project's
  server-side `max-rows`... this SILENTLY TRUNCATES on any table bigger than that. Use it only where the
  table is known-small."

**Why this one is worse than UIL-028's chunked-lookup risk.** UIL-028 is latent behind a config change
nobody has made yet. These four degrade **on their own**, purely as a function of her using the app —
the unresolved queue and the pending-placement queue both only grow.

**Reconciliation depends on `listWaiting` returning everything.**
[`lib/sync/pipeline.ts:146`](../lib/sync/pipeline.ts:146) drives archive/drop decisions straight off its
result — `if (resolvedCsvKeys.has(rk)) archiveEntryIds.push(e.id); else if (!csvKeys.has(rk))
dropEntryIds.push(e.id)`. Truncated past the cap, every entry past the first page is silently never
reconciled: never archived when the catalog resolves it, never dropped when it leaves her export.
`lib/sync/exec.ts:266`'s `liveWaiting` has the same exposure. That directly contradicts a promise the
Sync screen makes — "they self-heal when the catalog catches up," one of the strings UIL-011 is
rewriting. Past the cap, self-healing silently stops and nothing says so.

**`listUnplaced` truncating is a different, arguably worse failure: cards past the cap never appear in
the Haul Plan and never get placed, with no error at all** — not a slow-healing queue, an invisible one.

**Latent, not live — verified by a live read-only count against Testing, not assumed:**

```
unresolved_entry WAITING:            8   (992 headroom below the 1000-row cap)
copy unplaced (bulk, no binder/slot): 0
placement_decision rows:            702
```

Both queues are nowhere near the cap today. **This also settles an old worry from UIL-004**, which
raised concern that thirteen unmirrored TCGdex sets would park "cards she is most likely to own" in the
unresolved queue — that did not materialize; only 8 rows total ever parked, against a 23,548-card
catalog. Anywhere this log frames the unresolved queue as a live problem, it should stop; an overstated
worry misleads the same way an understated bug does.

**A fifth site, found by sweeping every unpaged `list()` call in `lib/`, is a different and more severe
tier — its live status is not yet known, and this entry's "verified latent" claim does not cover it.**
[`lib/sync/pipeline.ts:106`](../lib/sync/pipeline.ts:106),
`loadCurrentGroups`: `` const [groups, copies] = await Promise.all([presenceGroupRepo.list(db),
copyRepo.list(db)]); `` — its own doc comment names exactly what this feeds: "Current presence groups
with each copy's placement snapshot (**the reconciler's `current`**)." Every other site above is a
display list or a structurally small table; this one is the **input to a reconciliation decision**. A
truncated read here doesn't show her a short list — it makes the sync conclude she owns fewer copies
than she actually does, and **add copies for cards she already has**, the exact doubling UIL-003 warned
against. And unlike `WAITING`/unplaced above, this one is plausibly already reachable: 702 placement
decisions against a ~685-row export puts `copy` and `presence_group` plausibly in the 700–1,000 row
band, not nowhere-near-the-cap. Counts for both tables have been requested; **if either comes back over
1000, this site becomes its own High entry** rather than staying folded into this one's Medium.

**The sweep also found no sixth surprise — the class is bounded at what's already listed, which is the
reassuring half of the same audit.** Checked and confirmed structurally safe, not merely unexamined:
`binderRepo`, `collectionRepo`, `binderSectionRepo` (a view over binders), `binderBlockRepo` — all
bounded by binder/collection counts that can't approach four digits. `typeColorMapRepo` — fixed at 14
rows by migration 0003. `setAliasRepo` — bounded by ~218 TCGdex sets. `lastSyncSnapshotRepo` — checked
specifically because "a snapshot per sync" looks like it should accumulate; it doesn't:
[`lib/sync/exec.ts:324-326`](../lib/sync/exec.ts:324) deletes every prior snapshot in the same
transaction that inserts the new one (`for (const pr of prior) ops.push({ op: "delete_snapshot", id:
pr.id })`), so the table holds exactly one row, always. And the big tables are already paged correctly
in every other decision path — `listAll` is used repeatedly across `lib/plan/context.ts`,
`lib/line/load.ts`, and `lib/plan/fingerprint.ts` — so this is a codebase that applied the paging
discipline and missed one site, not one that never had it.

**The fix is stronger than "add paging," and this supersedes an earlier, weaker version of this
recommendation.** A filtered variant of `pageAll` is opt-in — and opt-in is exactly what failed four
times today. A fifth call site can still write a bare `.select()`, pass every test at fixture scale, and
go wrong only in production, only silently. The better property: **make truncation impossible to ignore
rather than merely avoidable.** PostgREST reports the true row count in `Content-Range` when asked; a
repo-layer read can detect its own truncation — if rows returned equals the server cap and the reported
total exceeds it, throw rather than return a plausible short list. That converts the whole class from
*silent wrong answer* to *loud failure at the call site*, matching three deliberate choices this project
has already made the same way: the mirror's skip-turned-fail (#38), `acceptance` failing rather than
skipping, and `migrate` reading `schema_migrations` back rather than trusting `db push`'s exit code.

**Caveat that keeps this from over-scoping:** some reads legitimately want a bounded page (search
results with an explicit `limit`, like UIL-015's fix). Detection has to key on *"the cap truncated me,"*
not *"I got fewer rows than exist,"* or every deliberately-limited search becomes a false error.

**Suggested fix, in order:** build the detection on the unfiltered read path first — that's the part
that turns a silent defect into a loud one, and it protects every call site including ones not yet
written. Add the filtered `pageAll` variant alongside it for the four call sites above, since paging is
still correct and desirable where it applies; keep `pageAll`'s existing `LIST_ALL_HARD_CAP` behaviour
(it throws rather than paging forever) as the model.

**Third instance of the unpaged-read shape today** — `list()` truncation fixed in #39, UIL-028's chunk
cap, this. Three of one shape says the guard belongs at the repo layer, not remembered per call site.

**One open question, deliberately not logged as a finding.** `WAITING` = 8 and `RESOLVED`/`DISMISSED`
both = 0 — no entry has ever been archived or dropped, so `pipeline.ts`'s reconciliation may never have
actually run against real data. Worth a `reason`-enum breakdown before treating that as a defect; it may
be entirely explained by what's actually in the queue.

**Priority rationale.** Medium for the four display/small-table sites: not High, since nothing is
broken at today's queue sizes and no data is corrupted there. Not Low: it degrades silently as she uses
the app, defeats a behaviour the UI explicitly promises, and is the third instance of one unaddressed
class.

**Completeness audit — the open-ended "are there more of these" question is now closed, not just
narrowed.** Every exported repo in `lib/repo/` was checked for its own bespoke `list()` that would
bypass `base.ts`'s guard (added by #90) entirely — `base.ts`'s detection lives inside the shared
`createRepo(...)` implementation, so a repo defining its own `list()` method skips it regardless of what
that guard does. Of every repo, exactly two escape it, and both are checked, not merely unexamined:
[`lib/repo/binder-section.ts:5`](../lib/repo/binder-section.ts:5) (`binderSectionRepo.list`, a **view**
over binders — structurally bounded by binder count) and
[`lib/repo/sync.ts:40`](../lib/repo/sync.ts:40) (`setAliasRepo.list`, bounded by ~218 TCGdex sets).
Neither can approach four digits. **After #90 and #96, no read that can grow with her usage is
unguarded.** The one residual risk: a *future* bespoke repo would silently escape the guard the same
way these two structurally-safe ones do — worth a comment on `base.ts`'s `list()` saying so, as a small
follow-up rather than a defect, since the guard protects the shared implementation, not the pattern.

**The fifth site is fixed, independently of whether the detection guard fires.**
[`lib/sync/pipeline.ts:106`](../lib/sync/pipeline.ts:106)'s two reconciler-input reads
(`presenceGroupRepo.list`/`copyRepo.list`) now use `listAll` via PR #96 — the severity split above is
resolved by removing the exposure rather than by the counts landing one way or the other.

**Fixed** — PR [#90](https://github.com/viantihu/pokemon-tcg-tracker/pull/90) shipped the detection
approach this entry recommended (`assertReadComplete`); PR [#96](https://github.com/viantihu/pokemon-tcg-tracker/pull/96)
paged the fifth site. Both merged. Status transition is the Senior BA's to record.

**The last open caveat on `assertReadComplete` is now retired — observed, not deduced (2026-09-14).**
The detection's premise (a truncated PostgREST read reports `data.length` at the cap while `count`
exceeds it) was measured through supabase-js on Testing: `data.length=1000, count=23548`. It had been
carried all day as "deduced from the header spec, not yet seen through the client"; it holds as written.

## UIL-032 — The plan fingerprint doesn't cover `current_binder_ids`, so a cached plan can survive a collection being re-pointed

- **Reported:** 2026-09-14 (not from Karvi — found reviewing UIL-022's fix)
- **Status:** **Fixed** — PR [#236](https://github.com/viantihu/pokemon-tcg-tracker/pull/236) MERGED to
  `develop` 2026-09-20 (squash `88c6de8`), QA-gated on the merged tree (893 tests; three pre-fix-failing
  cases, two pure and one PGlite through the real `loadPlanFingerprint`, which returned identical stamps
  before the fix), confirmed **deployed** to Testing (Deploy, migrate, smoke, acceptance and Vercel green
  on `88c6de8`). The fingerprint's collection entry is now `[id, targetCount, sorted current_binder_ids]`
  and the stamp version moved to v3, so re-pointing a collection at a different binder invalidates a
  cached plan the same way deleting it always did. No migration. Step for Karvi when UAT resumes: with a
  plan already computed, re-point a collection at another binder, then reopen the Plan; it should
  recompute rather than serve the cached plan.
- **Priority:** Medium
- **Area:** Plan, Collections
- **Env:** Testing

**Root cause.** [`lib/plan/fingerprint.ts:172`](../lib/plan/fingerprint.ts:172) stamps collections into
the cache key as `[id, targetCount]` pairs only. Deleting a collection changes its id set and correctly
invalidates a cached plan. Re-pointing a collection at a **different** binder — same id, same target
count, different `current_binder_ids` — changes nothing the stamp looks at, so a cached plan stays
"valid" against state that has actually moved.

**This is the same gap UIL-006 was fixed twice for, one field over.** #44 hashed plain counts; #48 had
to carry the placement-bearing columns themselves because in-place edits (moving a copy, resolving a
line slot) left the count-based stamp unchanged while what the cascade would route had changed. This is
that exact failure mode, on a field #44/#48 never had reason to consider because collection-rebinding
didn't exist as an action yet when the stamp was designed.

**Suggested fix.** Add `current_binder_ids` (or a hash of it) to the collection entry the fingerprint
already carries — same shape as the existing `[id, targetCount]` pair, just one field wider.

**Update 2026-09-20: QA's mutations found the fix bites two ways but not a third — closed same day.**
Poisoning the digest fails 3 tests and poisoning the loader mapping fails 1, but dropping the `sort` on
`current_binder_ids` left every test green, so the stamp's order-independence (two collections re-pointed
to the same binder set in a different order should still fingerprint identically) was unpinned. PR
[#242](https://github.com/viantihu/pokemon-tcg-tracker/pull/242) (merged `dc0ce08`, test-only) adds a
binder-order case; reverting the `sort` now fails it.

**Priority rationale.** Medium rather than High because it needs a Collections edit mid-plan to reach,
and the failure is a stale plan rather than corrupted data — but UIL-006's own precedent is that a
stale plan misleads her at the binder, which is exactly the moment a wrong answer costs the most.

## UIL-033 — `logCardIntoCollection` is a fourth definition of "joining a collection," and it isn't atomic

- **Reported:** 2026-09-14 (not from Karvi — found reviewing UIL-022's fix)
- **Status:** **Fixed** — PR [#224](https://github.com/viantihu/pokemon-tcg-tracker/pull/224) MERGED to
  `develop` 2026-09-19 (squash `a910d83`), QA-gated on the merged tree (851 tests; two pre-fix-failing
  cases, "two cards logged at the same time both end up on the target list" and "copy, audit row and tag
  land together — or none of them do"; dropping the union op fails 3, tolerating a no-row match fails the
  "vanished collection is NAMED" case), confirmed **deployed** to Testing (Deploy, migrate, smoke,
  acceptance and Vercel green on `a910d83`). Logging a card into a collection is now ONE `apply_write_ops`
  call: copy, decision and the collection's target-list union land together or not at all, so two logs
  into the same collection no longer lose a tag. **Qualifier:** if the collection is deleted between the
  read and the write, the card is still shelved in the binder and the Collections screen shows an alert
  naming that ("That collection changed under you, so the card was shelved in the binder but not added to
  this list. Reload to see what changed, then move it from the binder view.") rather than rolling back;
  making the RPC refuse outright needs a new `apply_write_ops` body (migration 0015) and is parked until
  UAT resumes. Step for Karvi when UAT resumes: log two cards into one collection in quick succession;
  both should appear on the collection's list.
- **Priority:** Medium
- **Area:** Collections
- **Env:** Testing

**Root cause.** [`app/(ui)/coll/actions.ts:271-296`](<../app/(ui)/coll/actions.ts>:271),
`logCardIntoCollection`, does three separate awaited writes with no transaction: `copyRepo.insert`,
then a **TypeScript read-modify-write** union on `target_catalog_card_ids`
(`const targets = col.target_catalog_card_ids ?? []; ... [...targets, tcgdexId]`), then
`placementDecisionRepo.insert`. It never goes through `apply_write_ops` or the RPC's
`union_collection_targets`.

**Two problems, not one.** First, it's a non-atomic multi-step write on live inventory — UIL-023's
class of defect, on a fourth write path. Second, and worse for the long run: it is now the **fourth**
independent implementation of "what joining a collection means" after `lib/backfill/commit.ts`,
`lib/coll/remove.ts`, and #82's Line/Plan move-path fix. Four places that must independently agree on
one piece of domain logic is the same shape as UIL-012's white-key problem — two places spelling the
same intent differently, and one eventually drifting — except at four sites instead of two, which is
worse odds, not better.

**Suggested fix.** Frame as consolidation, not just an atomicity patch: route this through the same
`apply_write_ops` op set the other three already use (`insert_copy`, `union_collection_targets`,
`insert_decision`), rather than adding a fifth bespoke implementation to fix a fourth one.

**Update 2026-09-19: citation corrected and one hazard added, from**
[`docs/root-cause-analysis.md`](../docs/root-cause-analysis.md) **§7a.** The read-modify-write append
moved in a refactor — it now lives at
[`lib/coll/log.ts:122`](../lib/coll/log.ts:122) (`target_catalog_card_ids: [...targets, tcgdexId]`),
not the `app/(ui)/coll/actions.ts:271-296` this entry originally cited. The defect is unchanged: a
TypeScript array append written back whole **loses a concurrent write without erroring** — two appends
racing on the same collection each read the same base array, and the second clobbers the first's
addition, silently. An atomic server-side union already exists for exactly this
(`union_collection_targets`, migration 0007, built by `collectionTargetJoinOp` in `lib/line/move.ts`)
and is what the fix should route through. **Second, smaller hazard to fold into the same fix:**
`union_collection_targets` writes nothing when no row matches
([`lib/line/write.ts:193`](../lib/line/write.ts:193) documents this as deliberate for the backfill
tagger), and that silence is indistinguishable from success at the call site — a consolidated path
should surface a no-op union rather than swallow it.

**Second update 2026-09-19: the debt QA flagged on #224 is closed, same day.** Splitting the write back
into two `apply_write_ops` calls (copy + audit, then the union join alone) still passed all nine existing
tests, because the original atomicity test's poison sat in the copy insert and never reached the join — a
gap in the test, not a live defect. PR [#227](https://github.com/viantihu/pokemon-tcg-tracker/pull/227)
(merged `1223e71`, test-only, no production code) adds a test that poisons the **join** instead (a trigger
raising on any `collection` update), asserting a two-call write commits the copy and audit row before the
join fails, while a single-call write leaves zero copies, zero decisions and an empty target list.
Revert-checked: reintroducing the two-call split now fails this new test.

**Priority rationale.** Medium: same class as UIL-023 (small ordered writes, no report of a real
partial-write incident), raised by the four-site drift risk rather than by an observed failure — and now
by the concurrency-loss shape the RCA names, still unobserved but no longer only a tidiness argument.

## UIL-034 — The Collections page mounts every card of every collection at once, with no fold

- **Reported:** 2026-09-14 (not from Karvi — found proactively, looking for the next instance of the
  "fine at small scale, wrong at real scale" pattern)
- **Status:** **Closed** — PR [#106](https://github.com/viantihu/pokemon-tcg-tracker/pull/106) MERGED to
  `develop` 2026-09-14 (squash `c6e83b8`), QA-reviewed, deployed to Testing, and **confirmed working by
  Karvi on Testing 2026-09-14** while retesting it — her follow-on ask that the fold state persist across
  visits is its own entry, UIL-059 (Low, her priority call pending). Collections default to folded with
  collapse-all / expand-all controls; a newly created collection opens expanded.
- **Priority:** Medium (Senior BA's read — flagged that Karvi rated the equivalent Haul Plan issue
  High, so this may come in above Medium if she reports it first)
- **Area:** Collections
- **Env:** Testing

**Verified on `origin/develop`.** [`app/(ui)/coll/CollHub.tsx:326`](<../app/(ui)/coll/CollHub.tsx>:326)
maps every collection; [`:388`](<../app/(ui)/coll/CollHub.tsx>:388) (finite mode) and
[`:430`](<../app/(ui)/coll/CollHub.tsx>:430) (open mode) each map every card within it, each rendering
a `<CardFace ... size="m" />`. No fold, no cap, no windowing anywhere in the file — confirmed by
grepping for any collapse/fold/expanded state, which returns nothing.

**Imminent, not theoretical, because of the workflow this page exists for.** She is actively building
finite collections from set checklists — the workflow UIL-010 and UIL-015 exist to support. A modern
set is 200–300+ cards (`me02.5`, UIL-015's own example, is 295 per TCGdex). Three or four finite
collections is 600–1,200 card tiles with artwork, all mounted, on one page load.

**This is UIL-018's defect on a different screen, with images instead of text rows.** UIL-018 was 702
rows all mounted on the Haul Plan — Karvi rated it High, fixed in #78. Same mechanism, same cause.

**One thing already mitigating it, so this entry isn't overstated.** #78 added `loading="lazy"
decoding="async"` to the shared `CardFace`
([`app/(ui)/_components/CardFace.tsx`](<../app/(ui)/_components/CardFace.tsx>), confirmed present, with
a comment explicitly citing UIL-016's mount-scale reasoning). That stops off-screen tiles from firing
image requests. It does **not** stop the mount cost — the DOM is still fully built for every tile.

**Suggested fix: reuse UIL-018's fold, don't invent a new one.** #78 built real per-band folding on the
Haul Plan where a folded section renders nothing below its header — rows absent from the tree, not
CSS-hidden. Confirmed directly in [`PlanScreen.tsx`](<../app/(ui)/plan/PlanScreen.tsx>): its own comment
states the same constraint this entry is raising — "Hiding a folded band with CSS would fix the
scrolling and none of the cost — the rows would still be [mounted]." A collection card is the same shape
as a band section: a header with counts, a grid beneath. Point at that implementation rather than
inventing a second one, since "add a collapse" too easily means `display: none`, which fixes nothing.

**Ambiguity left for the implementer.** Whether a collection defaults folded or expanded — UIL-018
chose all-expanded because she works one band at a time on the Haul Plan, but Collections is a browse
surface with a different rhythm, and defaulting folded may suit it better. Whether fold state persists
across visits. And whether the progress bar / `n / total` stays visible when folded — it should, since
that's the reason to look at the page at all even when collapsed.

**Cross-reference: the fourth instance of one pattern today.** UIL-007 (progress strip, one pip per
card, 4,447px of sideways scroll at 685 cards), UIL-015 (search limit filled by alphabetically-earlier
sets at 23,548 rows), UIL-018 (702 rows mounted), and this. All four were invisible at seed scale.
Worth stating plainly somewhere durable: **"works with three cards in the catalog" has never been
evidence of anything in this app.**

**Priority rationale (Senior BA's read): Medium.** Not High: nothing is wrong today, no data is at
risk, and it depends on how many finite collections she actually builds. Not Low: it degrades the exact
workflow she is using right now, arrives without warning as she adds collections, and the fix already
exists one screen over — cheap to do, expensive to leave. Flagging explicitly that Karvi rated the
identical Haul Plan case High, so this read shouldn't be treated as settled if she hits it first.

## UIL-035 — Search and lookup swallow every error and report "not found," so an outage looks like a missing card

- **Reported:** 2026-09-14 (not from Karvi — found proactively)
- **Status:** **Closed** — all three sites fixed and deployed; not Karvi's report, so it closes on QA's
  gate and content verified on `origin/develop`, not on a confirmation from her. Sites one and two: PR
  [#168](https://github.com/viantihu/pokemon-tcg-tracker/pull/168) MERGED 2026-09-18 (squash `9d36796`,
  deployed on `04dea51`) — `lookupCatalog` and backfill's search **throw** instead of returning `[]`, and
  the shared `CardLookup` shows "Could not search the catalog: … — the card may well exist; the catalog just
  did not answer. Try again." while keeping the last good results; an empty list now means the mirror was
  asked and had nothing. Site three: PR [#201](https://github.com/viantihu/pokemon-tcg-tracker/pull/201)
  MERGED 2026-09-18 (squash `fc8646b`), QA-gated on the merged tree (787 tests, build), confirmed
  **deployed** (Deploy and Vercel both green on `fc8646b`) — `LookupScreen`'s own `catch → notFound` is gone;
  `lookupAnswer` returns a result union (`{ ok: false, error }`) rather than throwing, because Next 16
  redacts forwarded server errors in production so a throw could never say WHAT failed, and the screen keeps
  a `failed` state separate from `notFound` (verified in `LookupScreen.tsx` / `actions.ts` on
  `origin/develop`). Revert-checked: restoring `catch → notFound` fails the state test. Same PR shipped
  UIL-051.
- **Priority:** Medium (Senior BA's read)
- **Area:** Lookup, Plan, Backfill
- **Env:** Testing

**Verified on `origin/develop`. Three sites, escalating:**

```ts
// app/(ui)/plan/actions.ts:46-56, lookupCatalog
/** Type-ahead against the local mirror. Returns [] on error so typing never breaks. */
...
} catch {
  return [];
}
```

```ts
// app/(ui)/backfill/actions.ts:48-50
} catch {
  return [];
}
```

```ts
// app/(ui)/look/LookupScreen.tsx:32-35, onPick
} catch {
  setAnswer(null);
  setNotFound(true);
}
```

The first two turn any failure — a Supabase outage, an expired session, a malformed query — into an
empty result set. The third is worse: it **explicitly sets "not found,"** so an infrastructure failure
renders as a factual claim that her card is not in the app.

**Checked and correctly NOT swept into this entry:**
[`CollHub.tsx:508`](<../app/(ui)/coll/CollHub.tsx>:508)'s `catch { setCopied(false) }` is a clipboard
write failing and being reported as "didn't copy" — that's the right behaviour for that failure, not
this pattern.

**Why this is worth an entry, not a shrug.** The intent behind all three is legitimate — don't let a
transient blip break type-ahead. But the trade converts an **infrastructure failure** into a **factual
assertion about her collection**, and that shape has already produced a real confused report: UIL-015's
search returned nothing and her words were "In fact, it does not return anything at all" — a reasonable
conclusion that the card wasn't there. It was; twelve McDonald's sets sorted ahead of it. An error path
that renders identically to a genuine miss makes that whole class of confusion unfalsifiable from the
screen alone.

**A house-style violation this project has already corrected three times elsewhere: skip/fail
distinctions matter here too.** The catalog mirror's skip-turned-fail-loudly (#38), `acceptance` failing
rather than skipping (#38), `migrate` reading `schema_migrations` back rather than trusting `db push`'s
exit code (#46), and #39 — which exists *because* database errors used to render as `"[object Object]"`
and told her nothing. Same principle, not yet applied to search.

**Direct interaction with UIL-011, which must be read alongside this entry, not after it.** UIL-011 is
rewriting these exact empty states — "No match in the local mirror. (Full catalog needs a sync run.)"
toward something like "No card found." That change makes the copy **more confident and more wrong**:
today's wording at least hints at machinery; a clean "No card found." asserts a fact about the catalog
that an error path can produce just as easily as a genuine miss. **UIL-011's implementer must not ship
copy that claims a card doesn't exist unless the query actually succeeded** — if this entry isn't fixed
first, UIL-011's rewrite needs its own distinguishable error state to render instead of reusing the
not-found copy. Recording the constraint here since it's the entry a UIL-011 implementer needs to read.

**Suggested fix.** Distinguish failure from emptiness explicitly — a discriminated result
(`{ ok: true, rows }` / `{ ok: false, error }`) from each action, or let it throw and have the caller
render "couldn't search just now" separately from "no match." Type-ahead's non-breaking behaviour is
preserved either way; what changes is that a failure says so. #39's error-message work already produces
a legible message to show, rather than needing new plumbing.

**Update 2026-09-18: two of the three sites fixed, one deliberately left — confirmed against PR
[#168](https://github.com/viantihu/pokemon-tcg-tracker/pull/168) (squash `9d36796`, merged).** Sites
one and two now throw instead of swallowing: `app/(ui)/plan/actions.ts`'s `lookupCatalog` and
`app/(ui)/backfill/actions.ts`'s search. `CardLookup.tsx` (the shared component both feed into) now
separates the two cases for every caller, including the ones this PR didn't touch — an injected
`search` that throws gets a legible message ("Could not search the catalog … the card may well exist;
the catalog just did not answer") instead of a blank or a false miss, and **last good results stay on
screen** rather than being cleared by a transient failure mid-typing. Chose a throw over the
discriminated-result shape this entry originally suggested, and for a stated reason: `CardLookup`'s
`search` prop type is shared across five screens under three different owners, and a throw keeps that
signature byte-identical rather than forcing edits into files this fix had no business touching.

**Update 2026-09-18: the third site is fixed too — all three, not two of three.** PR
[#201](https://github.com/viantihu/pokemon-tcg-tracker/pull/201) (squash `fc8646b`, merged) removed
`LookupScreen.tsx`'s own `catch → notFound`. `lookupAnswer` now returns a result union
(`{ ok: false, error }` / `{ ok: true, answer: null }`) instead of throwing — deliberately, because
Next 16 redacts a forwarded server error in production, so a throw could never say *what* failed. The
screen keeps a `failed` state separate from `notFound`, so an outage reads as "could not look this up"
rather than a claim her card doesn't exist. Revert-checked: restoring the old `catch → notFound`
behaviour fails the state test. This is the same PR that shipped UIL-051.

**Test-debt note from QA at merge, verbatim, worth carrying forward rather than treating as closed on
green:** "#201's action-level failure path is unpinned (its tests cover `lookup-state` and the render;
mutating `lookupAnswer`'s catch back to not-found passes 18/18)." So the *screen's* handling of the two
states is pinned; the *action*'s own catch block silently reverting to the old behaviour would not be
caught today. Recorded here rather than left implicit in the status line's own detail.

**Priority rationale (Senior BA's read): Medium.** Not High: nothing is corrupted, no data is at risk,
and all three paths work correctly when the database does. Not Low: it makes a real failure
indistinguishable from a normal answer on the surfaces she uses most, it has already contributed to one
confused report, and UIL-011 is about to sharpen the misleading version rather than fix it. Karvi hasn't
seen this yet.

**Cross-reference: the fifth instance today of the dominant pattern** — a silent partial or failed
result reading as a complete, valid one. UIL-004 (job skipped, reported success), UIL-028/UIL-031
(unpaged/chunked reads truncate silently), UIL-029 (a test double lying in agreement with a live bug),
and this. Five in one day is a property of the codebase, not five coincidences.

## UIL-036 — Clicking a card thumbnail should enlarge it — designed in the prototype, never ported

- **Reported:** 2026-09-14
- **Status:** **Fixed** — PR [#232](https://github.com/viantihu/pokemon-tcg-tracker/pull/232) MERGED to
  `develop` 2026-09-20 (squash `8eebc93`), QA-gated on the merged tree (894 tests; dropping the art guard
  fails "zoomable but NO art", swapping high.webp for low.webp fails the lightbox test), confirmed
  **deployed** to Testing (Deploy, migrate, smoke, acceptance and Vercel green on `88c6de8`). The
  prototype's lightbox is ported as written: a card thumbnail with real art gets a zoom-in cursor and a
  button role; clicking it opens the high-resolution image with a name and set/number caption; any
  click or Escape closes it. Wired on the Plan (worklist rows, spotlight), Lookup (answer face) and
  Collections (both tile grids, the Log-a-card picked row); a block with no art stays a plain thumbnail.
  Measured with the static harness: at 375 the card is 293×410 (78vw, aspect 0.714) over the veils; at
  1440 it caps at 360×504, centred. **Follow-ons, not done here:** the decision card's faces and the
  search-result tiles (whose faces sit inside a button, so a nested button role is invalid). Test debt,
  not a hold: the click-anywhere dismiss is not pinned by a static render; b0's tiny follow-up. Step for
  Karvi when UAT resumes: on the Plan, tap any card thumbnail; the large image should open, and one tap
  anywhere or Escape should close it.
- **Priority:** Medium (Karvi's call)
- **Area:** Plan
- **Env:** Testing

In her words (via the second Junior BA session): clicking a card's image thumbnail on the Haul Plan
should enlarge it — this was part of the original prototype and never got implemented.

**Confirmed: the prototype has a complete, working lightbox that was never ported.**
[`docs/design/prototype.html`](../docs/design/prototype.html) implements this in full:

- **CSS** (`:196-213`): `.face.zoomable { cursor: zoom-in }` plus a `.lightbox` overlay
  (`position: fixed; inset: 0; ...; cursor: zoom-out`) toggled by a `.on` class.
- **HTML** (`:687-693`): a `#lightbox` div holding `#lbcard` (the enlarged image) and `#lbcap` (name +
  set/number caption), with a "CLICK ANYWHERE OR PRESS ESC TO CLOSE" hint.
- **JS** (`:1017-1029, :1751-1766`): every thumbnail built by `face()` gets a `zoomable` class and a
  `data-zoom` attribute set to `img(code, 'high')` — **only when the card has real art**, per the
  prototype's own comment: "only a card with real art is zoomable; a block has nothing to enlarge." A
  document-level click listener opens the lightbox on any `.zoomable` thumbnail; backdrop click or
  Escape closes it.

**None of it reached the React app.** `CardFace.tsx` renders a bare `<span class="face">` with an
`<img>` whose only handler is `onError` (the initials fallback) — no click, no `zoomable` class, no
cursor styling. `PlanScreen.tsx` uses `<CardFace ... />` at three sites (worklist rows and the
spotlight card) with no wrapping click handler at any of them. A repo-wide search for
"lightbox"/"zoom"/"enlarge" across `app/` returns nothing. This isn't scoped to Plan either — Lookup
and Collections render the same bare `CardFace` with the same gap.

**No existing pattern to reuse directly, but one useful precedent and one useful non-precedent.** No
screen has an image viewer today. `MoveOverlay.tsx`'s `veil`/`dsheet panel` dialog shell (backdrop-click
detection via `e.target === e.currentTarget`, an Escape listener, `role="dialog"`) is the closest
reusable overlay skeleton — but it's a form panel, and `CollHub.tsx` explicitly notes elsewhere "this is
a form, not a lightbox" (UIL-009's fix), meaning the team has already drawn this line once: an
image-enlarge lightbox is a different interaction than a dismiss-with-care form dialog and shouldn't
inherit that dialog's careful-dismiss semantics — it should close on any click, same as the prototype.

**The higher-resolution image already exists; only the lightbox is missing.** `CardFace.tsx` always
requests `${imageUrl}/low.webp`. TCGdex's base image path supports a quality suffix
([`lib/catalog/tcgdex.ts:13`](../lib/catalog/tcgdex.ts:13): "`image` is a base path... append
`/<quality>.<ext>`"), and the prototype's own zoom feature requests `high` for the enlarged view —
`low`/`high` are the two quality values the app already knows about. So this isn't gated on new data;
the thumbnail's `imageUrl` already carries everything needed to build the high-quality request.

**Suggested fix.** Port the prototype's pattern rather than designing a new one: a `zoomable` variant
on `CardFace` (gated on the card actually having art, matching the prototype's own guard) that opens a
lightbox rendering `${imageUrl}/high.webp`, closing on backdrop click or Escape — deliberately not
reusing `MoveOverlay`'s careful-dismiss guard, since an image viewer has nothing to lose on an accidental
close.

**Update 2026-09-20: the click-anywhere/Escape dismiss debt named above is closed.** Restricting the
backdrop click to `target === currentTarget` had left all five lightbox tests green, since a static
render cannot see event handlers fire. PR
[#241](https://github.com/viantihu/pokemon-tcg-tracker/pull/241) (merged `672727d`, test-only) pins the
dismissal policy as pure functions instead of relying on a DOM click to prove it.

**Priority rationale (Karvi's call): Medium.** Not a bug — a designed feature that never shipped. Worth
doing because it's a designed, already-scoped piece of the product (down to the CSS and JS existing
verbatim) rather than a new idea to evaluate, and it's on the screen she uses most.

## UIL-037 — After overriding a card's placement, both the spotlight panel and the worklist row still show the original suggestion

- **Reported:** 2026-09-14
- **Status:** **Closed** — PR [#109](https://github.com/viantihu/pokemon-tcg-tracker/pull/109) MERGED to
  `develop` 2026-09-14 (squash `e911c8c`), QA-reviewed, confirmed **deployed** to Testing (all four
  conditions green on `7cb1a36`). The spotlight panel and the worklist row now name the override
  destination instead of the original suggestion. Awaiting Karvi's confirmation — she confirmed UIL-027
  from the same PR but has not spoken to this one, so it is not claimed on her behalf. **Confirmed resolved by Karvi on Testing** — the override destination is named on both the spotlight panel and the worklist row.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Plan
- **Env:** Testing

In her words: "When an override occurs, I need to be able to see where the new card is being placed on
the main haul plan page itself. In the screenshot, I overrode the placement from specialty binder to
bulk bin, but that's not obvious in the screen. The big block that says 'specialty binder' should
actually say where the card is moving to, not the suggestion." Screenshot confirms: after overriding
Infernape, the spotlight panel's destination block still reads "To the specialty binder / KB-S01," and
the "MOVED · OVERRIDE AT COMMIT" badge names no destination at all. On the worklist, Infernape,
Clobbopus, and Great Tusk ex — all overridden — still show a plain "SPECIALTY BINDER" chip.

**Confirmed: two distinct gaps, not one, and the first is a pure display bug while the second is a real
plumbing gap.**

**Gap 1 — the spotlight panel has the override in scope and simply doesn't read it.**
[`PlanScreen.tsx:1038-1041`](<../app/(ui)/plan/PlanScreen.tsx>:1038):

```tsx
<div className="doit">
  <b>{act.big}</b>
  <span className="sg u">{item.destination}</span>
</div>
```

`act.big`/`item.destination` come from the immutable `PlanItem` the original cascade run produced
([`lib/plan/assemble.ts:24,58`](../lib/plan/assemble.ts:24)) — never from the override. Two lines
below, [`:1043`](<../app/(ui)/plan/PlanScreen.tsx>:1043) renders
`{override ? <div className="movedtag u">Moved · override at commit</div> : null}` — `override` is
already the function's own parameter at this point, unused by the block above it. This is a display
omission, not missing data.

**Gap 2 — the worklist row never receives the override at all.** `PlanRow`
([`PlanScreen.tsx:976-981`](<../app/(ui)/plan/PlanScreen.tsx>:976)) is called with only `{ item,
current, done, onSelect, onToggle }`. Tracing the chain: `PlanView` holds the `overrides` map
([`:653`](<../app/(ui)/plan/PlanScreen.tsx>:653)) but passes it only to `Spotlight`
([`:824`](<../app/(ui)/plan/PlanScreen.tsx>:824)) — never to `BandSection`
([`:792-806`](<../app/(ui)/plan/PlanScreen.tsx>:792), no `overrides` in its prop list) or down to
`PlanRow`. The row's `SPECIALTY BINDER` chip is `act.label` from `ACTION_META`, keyed only off the
original `item.action` — there is no path for an override to reach it.

**No data-integrity risk — the commit itself is correct.** `commitHaul`'s `writeOverriddenCard` already
writes the overridden destination, not the suggestion (confirmed elsewhere in this log). The bug is
purely that the review screen — the one place she can check her own decision before an irreversible
commit — shows the wrong thing.

**A reusable label function already exists and the data it needs is already fetched.**
[`lib/line/move.ts:49-66`](../lib/line/move.ts:49), `describeMove(dest: MoveDestination, names:
MoveNameLookups): string`, is pure (its `WriteOp` import is type-only) and already produces exactly this
kind of sentence for the Line screen's move panel. `PlanScreen` already fetches the `MoveOptions` shape
`describeMove`'s name lookups need — it's the same data already loaded for `MoveOverlay`
([`PlanScreen.tsx:179`](<../app/(ui)/plan/PlanScreen.tsx>:179)) — so this is wiring, not a new fetch: an
adapter mirroring `nameLookups()` (currently server-only, in
[`app/(ui)/line/actions.ts:31-42`](<../app/(ui)/line/actions.ts>:31)) plus passing `overrides` (or its
computed labels) down through `BandSection` to `PlanRow`, and reading `override` in the `.doit` block
that already has it in scope.

**Suggested fix.** In the spotlight panel: when `override` is set, render `describeMove(override,
names)` in place of `item.destination` (and give the "Moved · override at commit" badge the actual
destination name instead of leaving it generic). On the worklist: thread `overrides` down to `PlanRow`
and swap the chip label to the override's destination when one exists, same source function.

**Priority rationale.** High: this isn't cosmetic — it's the review screen for an action she's about to
make irreversible-feeling by clicking "Commit the haul" (see UIL-027), and right now it actively shows
her the wrong thing for every card she's deliberately overridden. She can't verify her own decisions on
the one screen built for verifying them. Flagging for her confirmation since severity calls are hers.

## UIL-038 — No concept of a draft collection; saving is immediately live

- **Reported:** 2026-09-14 (surfaced while retesting UIL-009, not the same defect — see note below)
- **Status:** **Closed** — PR [#126](https://github.com/viantihu/pokemon-tcg-tracker/pull/126) MERGED to
  `develop` 2026-09-16 (squash `e1f6a45`), QA-gated on the merged tree with the guards mutation-verified,
  confirmed **deployed** to Testing (Vercel / migrate / smoke / acceptance all green on `075f170`).
  **Scoped from Karvi's own answer to what "draft" protects against — losing in-progress work, not hiding
  half-built collections** — so no `status` gating and no migration. The editor now creates the collection
  the moment it opens and autosaves each edit (debounced, serialized so a fast name-then-binder edit can't
  land out of order); closing an entirely empty one (no name AND no targets AND untouched binder) deletes
  it; an incomplete collection carries a **Draft** badge. **UIL-009's "discard changes?" confirm is
  removed by design** — with nothing left to lose there is nothing to discard; recorded here because it is
  a visible behaviour change on a screen she has already confirmed, not a regression. Reversibility split
  held: name edits and target adds autosave, while **target removal and binder rebind stay an explicit
  click** with the UIL-014 / UIL-040 refusals surfacing inline, so a stray click cannot take effect before
  she notices. One defect QA found and the UX Dev fixed on the same head: an existing collection could
  lose its binder if she opened "+ New binder" and then edited any other field before naming it — the
  server now falls back to the collection's current binder when the pick is unresolved. No component-render
  test infrastructure exists in this repo, so the click/type/close wiring is covered at the server and
  scheduler layers rather than through the DOM. Awaiting Karvi's confirmation. **Confirmed resolved by Karvi on Testing 2026-09-18** — including the removal of UIL-009's "discard changes?" dialog, which was a visible behaviour change on a screen she had already signed off, so her confirmation covers that too.
- **Priority:** Unscoped — needs Karvi's clarification before a priority means anything
- **Area:** Collections
- **Env:** Testing

In her words: "Concept of active and draft collections."

**Not a UIL-009 regression or a UIL-009 rescope — a separate, larger idea that surfaced while retesting
it.** UIL-009 was specifically about a backdrop click discarding an in-progress edit; that entry's own
status is untouched by this one. Recording that explicitly since the ambiguity was flagged rather than
assumed either way.

**Confirmed: no draft state exists today.** `collection.status` is a real column
([`0002_domain.sql:109`](../supabase/migrations/0002_domain.sql:109), `default 'active'`) but has no
CHECK constraint and is dead: a repo-wide search finds nothing in `app/` or `lib/` that ever reads or
writes it. `saveCollection` ([`app/(ui)/coll/actions.ts`](<../app/(ui)/coll/actions.ts>)) never touches
`status`. The moment a collection saves, `target_catalog_card_ids` is live and immediately read by
`loadCollHub` for ownership/wishlist derivation — `CollHub.tsx`'s own empty-state copy says as much:
"Create one — it becomes a placement target immediately." The only existing toggle,
`mode` (`finite`/`open`, migration 0005), is orthogonal — it governs set-list vs. running-count, not
draft-vs-real.

**Left deliberately unscoped rather than guessed at.** "Draft" could mean several different things —
a collection she's still deciding whether to keep, one she's partway through building the chase list for
and doesn't want counted yet, or something else entirely — and each implies a different fix (a status
flag that hides it from stats, a genuinely separate staging table, an explicit "publish" step). This
entry exists to record that the gap is real and total; scoping the actual design needs her input on what
"draft" is protecting her from.

**Priority rationale.** Not rated. A priority on an unscoped idea would be a guess dressed as a
judgment. Recommend treating this as a question to put back to her before it becomes a numbered
priority at all.

## UIL-039 — Card search for building a collection needs to be its own filterable, grid page with bulk add

- **Reported:** 2026-09-14 (surfaced while retesting UIL-009)
- **Status:** **Fixed** — PR [#155](https://github.com/viantihu/pokemon-tcg-tracker/pull/155) MERGED to
  `develop` 2026-09-16 (squash `83e1e44`), QA-gated on the merged tree, confirmed **deployed** to Testing
  (all four conditions green on that SHA). Card search for building a collection is now its own grid page
  at `/coll/search`, image-first per her standing visual-search principle, filterable by **illustrator**
  (her stated primary case, not just one filter among several), set, species, type and an explicit
  "cards I own" / "cards I'm missing" / "all cards" toggle, with the collector-number-aware free text kept
  as a fallback. Bulk add ticks tiles and commits the selected ids in **one** write through UIL-038's
  draft-tolerant path, so there is no separate Save step. The editor's inline `CardLookup` add is removed
  and replaced by a link in **the same PR** — verified in review that both directions work before the
  removal landed, since a gap there would have left her unable to add a card at all. Cost stated rather
  than implied: `browse()` pages at 60 rows with `range()` and deliberately **no** `count: "exact"` (an
  exact count belongs on a read-everything query where partiality is a bug, not on a paginated browse where
  it is the design — `hasMore`/`nextOffset` are the contract), and the owned/unowned filter is bounded at
  15 pages × 60 = 900 rows, never the 23,548-row catalog. No migration. **Known gap, being fixed
  separately:** the search link does not flush the autosave debounce before navigating, so up to 600ms of
  typing can be lost — a data-loss path inside the feature built to prevent data loss, so it is not
  being left as a rough edge. Awaiting Karvi's confirmation.
- **Priority:** Medium (Claude's read — a redesign of working functionality, not a defect; needs
  Karvi's confirmation)
- **Area:** Collections
- **Env:** Testing

In her words: "Card search shouldn't be a scrollable inline search — it should be its own page, cards
displayed in a block/grid format, filterable by illustrator, expansion, Pokémon, and collector number,
with a bulk selector to add multiple cards at once."

**Confirmed: today's search is one component, one text field, one-at-a-time, used everywhere.**
[`CardLookup.tsx`](<../app/(ui)/_components/CardLookup.tsx>) is a single free-text `<input>` with an
inline absolutely-positioned dropdown (`role="listbox"`) — not a page, not a grid — reused unchanged
across the Collections editor, the Log-card modal, Backfill's `StageRow`, and the Lookup screen. Its
only search entry point, `catalogCardRepo.search(db, query: string, limit = 12)`
([`lib/repo/catalog-card.ts:105`](<../lib/repo/catalog-card.ts>:105)), takes one string and matches
name/set name/local id/tcgdex id — nothing else. Every add path (`CollectionEditor.addTarget`,
`LogCardModal`, `StageRow`) is a single `onPick` callback; a repo-wide search for a multi-select
mechanism found none anywhere in the app.

**What each requested filter needs, checked individually rather than assumed available. The hardest-
sounding one is actually the cheapest, and it's her real workflow, not just a filter.**

- **Illustrator — already fully mirrored, and it's not just a filter, it's the primary use case this
  page is for.** Verified end to end: the column ([`0002_domain.sql:57`](../supabase/migrations/0002_domain.sql:57))
  is populated by the mirror ([`lib/catalog/mirror.ts:96`](../lib/catalog/mirror.ts:96),
  `illustrator: card.illustrator ?? null`) from a typed TCGdex field
  ([`lib/catalog/tcgdex.ts:55`](../lib/catalog/tcgdex.ts:55)) — **all 23,548 rows already have it.** No
  schema change, no 218-request re-mirror, nothing queued behind UIL-026's work. It's a pure
  query-and-UI job: `search()` doesn't select it and `LookupCard`
  ([`lib/plan/plan-types.ts:13-25`](../lib/plan/plan-types.ts:13)) doesn't carry it to the client, but
  the data itself is done. And the app's own design document names this as the actual reason the
  feature exists — [`docs/design/prototype.html:1198`](../docs/design/prototype.html:1198), the
  collections rationale: "A collection is a themed group (**illustrator sets are Karvi's real case**)
  that she sizes herself." So this isn't the fourth filter in a list — it's the workflow the other three
  filters support.
- **Expansion (set)** — already filterable in principle (`set_name`/`set_id` are searched today), just
  not exposed as a distinct filter control separate from free text.
- **Pokémon (species)** — a repo primitive already exists,
  `catalogCardRepo.findByDexId` ([`lib/repo/catalog-card.ts:93`](<../lib/repo/catalog-card.ts>:93)), but
  it's called nowhere — dead code today, reusable rather than needing to be written from scratch.
- **Collector number** — already solved by UIL-010/UIL-015's fix; reusable as-is.

**So of the four filters, none needs new data, and only species-by-name needs any new query logic at
all** — the rest is wiring existing columns and an unused repo primitive to a new UI. **Bulk add** is
the one genuinely greenfield piece: no partial version exists to extend.

**Aligns with the visual-search design principle already on record.** A grid of card art with filters
is exactly the "thumbnail as the primary identifying element" direction she stated after UIL-016 — this
request is that principle applied to the search surface specifically, not a new, separate idea.

**Cross-reference UIL-034 — build this on a page that already folds, don't fight one that doesn't.** A
block-grid page with bulk-add lands on exactly the same surface UIL-034 flags for having no fold at all.
Whoever builds this should sequence it so the search results grid doesn't inherit UIL-034's problem on
day one of existing.

**Suggested scope, not a full design:** a dedicated search page/panel with a grid of `CardFace`-style
tiles, filter controls for set and species reusing `findByDexId`, illustrator wired through `search()`
and `LookupCard` the same way the other fields already are, and a multi-select-and-add-all action —
built once, reused by Collections, Backfill, and Lookup the way `CardLookup` already is, so this doesn't
become a second implementation to keep in sync with the first (the class of problem UIL-033 flagged for
collection-joining logic).

**Priority rationale.** Medium: nothing here is broken — today's search finds cards correctly, just
one at a time with one field. This is a workflow improvement, not a bug, so it competes with other
Mediums rather than jumping the queue — but the illustrator finding above is worth weighing if Karvi
reads this, since it means her stated primary use case is currently entirely unsupported, not merely
inconvenient. Karvi's own priority read wasn't given for this one specifically; flagging for hers.

## UIL-040 — Rebinding a collection to a different specialty binder changes the record but silently orphans the cards already shelved in the old one

- **Reported:** 2026-09-14 (surfaced while retesting UIL-009)
- **Status:** **Fixed** — both steps deployed. **Step 2** (move the stranded copies so the rebind can
  succeed): PR [#289](https://github.com/viantihu/pokemon-tcg-tracker/pull/289) MERGED to `develop`
  2026-09-20 (squash `f94e2cc`), **migration `0017`** (0015's `apply_write_ops` verbatim plus one
  `set_collection_binders` branch, 16 lines; no DDL, no DML), QA-gated on the merged tree (1095 tests, build,
  migration-order "added 0017 above 16"; mutations all biting: 0017 absent → 6 PGlite cases fail, the op
  dropped → 4, the stays rule disabled → 1, the button never rendered → 7 DOM cases), confirmed **deployed**
  (migrate applied 17 of 17; Vercel, smoke, acceptance green on `f94e2cc`; the Senior BA's AFTER read, run
  35493539362: collection 11, binder 3, set_alias 22, catalog_card 36,329, card tables 0 since her 05:22Z
  clear, zero row deltas). What she sees: the step-1 refusal stays and now ends "Move them with it, or keep
  this collection in its current binder", and the alertbar gains one button whose label is the whole
  action, "Move 3 cards to <binder> and rebind"; no second modal. Click → one `apply_write_ops` transaction:
  each shelved copy of a card this collection chases moves to the new binder (`update_copy`), any slot it
  defensively held is reopened and its line demoted, `set_collection_binders` re-points the collection, and
  one `insert_decision` per copy records "moved with <collection>: your call, no rule applied". Nothing is
  ever deleted. A card another collection still on the old binder also chases STAYS and is named under
  the bar (Senior BA default, flagged to Karvi). The editor flushes its autosave before the move and
  applies the current draft on success; Close is disabled while moving (Full Stack Dev - 1's review of the
  CollHub hunk, ack in the PR). **Recorded limit:** when every blocked card is one that stays, nothing moves
  and the button reads "Rebind and leave N cards in <old binder>", but the refusal above still says "would
  strand"; the guard fires on presence in the old binder, as Karvi confirmed it, so this is a wording
  choice to revisit only if she trips on it. Step for Karvi: edit a collection whose cards are shelved in
  its binder, pick a different specialty binder; read the refusal, press the Move-and-rebind button; the
  cards should show as owned in the new binder and the collection's chip settle there. **Step 1** (PR
  [#102](https://github.com/viantihu/pokemon-tcg-tracker/pull/102), squash `9497c6c`, deployed 2026-09-14;
  **confirmed by Karvi on Testing 2026-09-18**): a rebind that would strand shelved copies is refused, with
  a message naming what would be orphaned. Worth keeping on record because it bounds her always-movable
  ethos (UIL-072): she explicitly endorsed a refusal here, so that ethos is about never gating a card
  **move** behind another question; it is not a blanket rule that the app may never refuse an action, and
  step 2 keeps the refusal while putting its remedy on the same screen.
- **Priority:** High (Claude's read — this is a live orphan hazard, not just a missing feature; needs
  Karvi's confirmation)
- **Area:** Collections
- **Env:** Testing

In her words: "After a collection is created, the user should be able to move it to a different
specialty binder." Investigated expecting a missing feature; found a partially-working one with a real
data hazard underneath — worth reading past the request as stated.

**The UI capability already exists and already writes to the database — that's not the gap.**
`CollHub.tsx`'s edit flow (`openEdit`) opens pre-populated with the current binder, and the same
`CollectionEditor` form used for creation is reused for edit with its binder picker fully clickable, not
locked. `saveCollection` ([`app/(ui)/coll/actions.ts`](<../app/(ui)/coll/actions.ts>), the update path)
writes `current_binder_ids: [binderId]` unconditionally — picking a different binder and saving really
does change the association. So the reason she couldn't find this may be that it's not discoverable
(no obvious "this changes the binder" affordance), not that it's missing — worth confirming with her
which it was before scoping a fix.

**The real defect: this only rewrites the collection record, never the physical copies.** `saveCollection`
never touches `copy.binder_id` — nothing relocates the cards already shelved in the old binder to the
new one. `loadCollHub`'s "owned" derivation is keyed off `col.current_binder_ids` matched against
shelved copies (the same mechanism UIL-014/UIL-022 describe): after a rebind, any card physically
shelved in the *old* binder no longer matches the collection's (new) binder list, and **reads as
un-owned** — invisible in the collection and back on the wishlist, while still occupying a real pocket
in the old binder. `blockedTargetDrops` ([`lib/coll/remove.ts:308-338`](../lib/coll/remove.ts:308)),
built to guard exactly this class of orphan for target-list *drops*, is never invoked for a binder-id
*change* with the target list unchanged — so the one guard already built for this shape of bug doesn't
cover this path.

**Same orphan class as UIL-014/UIL-022, a fourth site.** Every prior instance was found by proactive
review; this one is a live, user-requested feature. If it's implemented literally as it works today —
letting the edit form's existing write path stand in as "the fix" — it ships the orphan hazard as a
feature.

**Distinct from UIL-043's guard, which lives in the same function and could otherwise be mistaken for
covering this.** UIL-043 describes `saveCollection`'s existing target-drop refusal — a different
condition, already built, already shipped. This entry's rebind path has no guard of its own; the two
should not be read as the same protection.

**Suggested fix.** A binder change must relocate the collection's shelved copies as part of the same
atomic write that updates `current_binder_ids` — reusing the placement-rewrite machinery UIL-014's fix
(`lib/coll/remove.ts` → `apply_write_ops`) already established, not the current bare
`collectionRepo.update`.

**Priority rationale.** High: this isn't a feature request that happens to be missing — it's a write
path that already runs today and already produces the orphan hazard the moment someone uses the binder
picker in an edit, whether or not she's found it yet. Same reasoning Karvi accepted for UIL-014 and
UIL-022. Flagging for her confirmation since severity calls are hers, but recommending this not be
treated as merely a feature request.

## UIL-041 — Audit the design prototype against the shipped app, once, rather than finding gaps one at a time

- **Reported:** 2026-09-14 (not from Karvi — the Senior BA's suggestion, prompted by UIL-036)
- **Status:** **Fixed** — PR [#262](https://github.com/viantihu/pokemon-tcg-tracker/pull/262) MERGED to
  `develop` 2026-09-20 (squash `3e71bd6`), docs only. The deliverable was the checklist and it exists:
  [`docs/design/prototype-audit.md`](design/prototype-audit.md), every interactive behaviour in
  `docs/design/prototype.html` (50 `onclick` handlers, 11 listeners, ~40 ids) mapped to the React file
  that ports it, 90 rows in six tables: 43 ported, 26 partial (exists, one named piece missing), 10
  replaced or dropped with the deciding issue-log entry or code comment cited, and **11 not ported** — no
  counterpart and no recorded decision. Those eleven are candidates, not bugs, and none was built: log a
  not-in-catalog card as typed; starting count for an open collection; a collection note field; success
  toasts on Collections; a "THE LINE" jump to a card's line; the NEXT UP strip; keyboard shortcuts;
  "Place it myself" resolving a decision; new binder or collection from the Move panel; Lookup suggestion
  chips; Lookup box focused on arrival. Sent to Karvi 2026-09-20 to pick which become entries; the rest
  get recorded in the audit as deliberately dropped so they stop resurfacing one at a time, which was
  this entry's whole point. Nothing for Karvi to test; closes on the deliverable.
- **Priority:** Low as a defect, high value as process
- **Area:** Plan, Lookup, Collections, Backfill
- **Env:** n/a — a process gap, not a code defect

**Why this entry exists.** UIL-036 (card-thumbnail enlarge) turned out to be a feature fully designed in
[`docs/design/prototype.html`](../docs/design/prototype.html) — CSS, HTML, and JS all present — that
simply never got ported to the React app. That is unlikely to be the only one:
`docs/design/prototype.html` contains interactive functions beyond `openZoom`/`closeZoom` with no
obvious React counterpart checked yet, including collection-editor and log-search flows. Left as is,
Karvi discovers each gap the same way she found UIL-036 — by remembering the prototype and noticing the
app doesn't match it, one surprise at a time.

**Suggested fix: a single enumeration pass, not a redesign.** List every interactive feature in the
prototype (buttons, modals, hover/click behaviors, transitions) and mark each one ported / not ported /
deliberately dropped, with a one-line reason for anything marked dropped. The deliverable is a checklist
she can read once, not code — closing the open-ended "what else is in there" question rather than
leaving it to surface piecemeal.

**Priority rationale.** Low as a defect, since nothing here is broken — the prototype not matching the
app isn't itself a bug, and several mismatches may be intentional design evolution rather than gaps.
High value as process: one list beats six more surprises, and it's cheap relative to the alternative
(each surprise costing its own investigation, as UIL-036 did).

## UIL-042 — `placement_decision` is load-bearing for queue state, not just an audit trail — clearing it silently re-queues the whole collection

- **Reported:** 2026-09-14 (not from Karvi — surfaced investigating today's 702-decision event; credit
  the tech-lead session)
- **Status:** **Fixed** — PR [#240](https://github.com/viantihu/pokemon-tcg-tracker/pull/240) MERGED to
  `develop` 2026-09-20 (squash `1de1a4e`), documentation only, the entry's own lighter reading: a doc
  comment on `loadPendingPlacements` in `lib/plan/pending.ts` stating that the absence of a
  `placement_decision` row is what "still waiting" means, and a callout under the go-live runbook's B2
  promotion table: never clear or prune `placement_decision`, on Testing or Production, because deleting
  rows re-queues every affected card as if it had never been placed (the 702-row clear of 2026-09-14).
  No explicit pending flag (the entry's counter-argument stands: a second source of truth can disagree
  with the placement columns) and no migration comment yet; that rides on the next real migration rather
  than opening 0015 for a comment. The runbook is the Tech Lead's file; both Tech Lead sessions were gone
  when this landed, so the hunk is on the Senior BA's authority. Nothing for Karvi to test.
- **Priority:** Medium
- **Area:** Plan, Collections
- **Env:** Testing

**Context, stated first because it explains why this is worth an entry rather than a bug report.** All
702 of Karvi's placement decisions were deleted at some point today, and all 702 copies reset to
`role=bulk` with null binder and slot. **The application cannot do this** — verified independently:

- No `delete_decision` op exists in `apply_write_ops` — checked identically across
  [`0006_commit_rpc.sql:212-218`](../supabase/migrations/0006_commit_rpc.sql:212),
  [`0007_backfill_ops.sql:275-281`](../supabase/migrations/0007_backfill_ops.sql:275), and
  [`0008_collection_removal_ops.sql:276-282`](../supabase/migrations/0008_collection_removal_ops.sql:276)
  — only `delete_copy`, `delete_unresolved_entry`, `delete_snapshot`. No
  `delete from placement_decision` exists anywhere in `supabase/` or `lib/`.
- FKs on `copy_id`/`haul_id` are `on delete set null`, so deleting copies could never cascade into this
  table — and copies weren't deleted anyway (`copy` held at 702 throughout).
- A sync undo is separately ruled out three ways: `invertSnapshot`
  ([`lib/sync/undo.ts:132-147`](../lib/sync/undo.ts:132)) never references `placement_decision` at
  all; undo would have deleted the copies sync created (`copy` didn't move); and it would have removed
  newly parked queue entries (`unresolved_entry` held at 8).
- `reset-testing.yml` is ruled out — confirmed present on `develop` but absent from `main`, so not
  dispatchable as the default-branch workflow.

**So this was a manual database operation. The entry is about the consequence, not who did it.**

**The finding.** `loadPendingPlacements` uses the *absence* of a `placement_decision` row as its
discriminator for "this copy is still waiting to be placed"
([`lib/plan/pending.ts:13-17`](../lib/plan/pending.ts:13)) — and that design is correct, not the
problem. The cascade can legitimately route a card *to* bulk, which leaves the placement columns
indistinguishable from an untouched sync add; only the audit row tells them apart, which is also what
makes the queue self-clearing regardless of destination. UIL-003's own resolution documents exactly this
reasoning.

**The consequence nobody had written down: clearing this table doesn't just lose history, it re-queues
everything.** The table's name reads as a log — "it's the audit trail, it's safe to clear" is exactly
how a reasonable person would reason about a table with that name — but it is queue *state*. Deleting it
resets the whole placement pass.

**The loss is asymmetric, and that's what matters for anyone who does this again.** No cards are lost —
all 702 copies stayed intact, and re-running the plan writes fresh decision rows and drains the queue
normally. But the record of which card went where and *why*, from her first placement pass, is gone
permanently — nothing reconstructs it.

**Suggested fix, deliberately presented as two readings rather than one recommendation.** (1) Document
the table's load-bearing role in a migration comment and in `pending.ts`, so the name stops implying
it's safe to clear. (2) Consider an explicit "pending" marker instead of inferring it from absence —
but the counter-argument is real: the current design is deliberate and well-reasoned (per UIL-003's own
account), and an explicit flag introduces a second source of truth that can disagree with the placement
columns. Documentation over redesign is the lighter-weight fix; recording both since this is a real
design tradeoff, not an obvious call.

**Priority rationale.** Medium: no code defect exists and no user-facing behaviour is currently wrong.
Not Low, because the failure mode is silent, total, and reachable by routine maintenance on a table
whose own name invites exactly that mistake, and it destroys the one thing in this system that isn't
reconstructible.

**Cross-reference: the sixth instance of the day's dominant pattern** — a silent, plausible-looking
result standing in for a correct one. Here the plausible result is "the queue is full of unplaced
cards," which is true, and gives no hint that it's true because history was cleared rather than because
a sync ran.

**Update 2026-09-20: the lighter, documentation-only reading above shipped.** PR
[#240](https://github.com/viantihu/pokemon-tcg-tracker/pull/240) (merged `1de1a4e`) states the load-bearing
fact directly in `lib/plan/pending.ts`'s doc comment and adds the same warning as a callout in
`docs/go-live-runbook.md`, directly under the B2 promotion table — the one ops document that lists the
tables. No pending flag, no migration, zero behaviour change.

## UIL-043 — Offer the move inline from the collection editor's owned-target row

- **Reported:** 2026-09-14 (not from Karvi — a follow-up suggestion from QA and the UX Dev, on
  UIL-014's shipped behaviour)
- **Status:** **Fixed** — PR [#273](https://github.com/viantihu/pokemon-tcg-tracker/pull/273) MERGED to
  `develop` 2026-09-20 (squash `2850d20`), QA-gated on the merged tree (1011 tests, build; QA read the
  whole CollHub diff: 84 added / 11 removed lines ignoring whitespace, all of them this feature; the
  367-line stat is re-indentation), confirmed **deployed** to Testing (Deploy, migrate, smoke, acceptance
  and Vercel green on `2850d20`). Karvi's ruling ("do not drop it, this is a must have") built as: an owned
  card's row in the collection editor keeps exactly what UIL-014 shipped (no ✕, server-side refusal) and
  gains a Move control beside the Owned pill; it opens the same shared move sheet the card's own Remove
  uses, seeded on the collection's binder, performs the same removal-as-a-move, and the row leaves the
  list when it lands; disabled, not hidden, until move options load or while a new draft has no binder.
  The hint under the list now says to use Move on the row. Six-case DOM click-path test; mutations:
  row-removal deleted → 1 fails, sheet seeded on bulk → 2 fail, Move made a no-op → 4 fail. Step for
  Karvi when UAT resumes: open a collection's editor, press Move on an owned card's row, pick a
  destination; the card should move and leave the list.
- **Priority:** High (Karvi's own ruling, 2026-09-20: "do not drop it, this is a must have"). Was Low.
- **Area:** Collections
- **Env:** Testing

**Not a defect in UIL-014 — a convenience on top of a design Karvi already chose.** UIL-014's fix
put three options to her: refuse-and-direct, make the "✕" perform the move directly, or hide "✕"
for owned rows with a server-side refusal as a stale-tab backstop. **She chose the third, and it
shipped as chosen** — [`CollHub.tsx:758-760`](<../app/(ui)/coll/CollHub.tsx>:758) shows `Owned ·
remove on the card` in place of the "✕" for an owned target, and
[`app/(ui)/coll/actions.ts:196`](<../app/(ui)/coll/actions.ts>:196) documents the server-side guard
as the backstop, not the primary path: "Dropping an un-owned target — a gap she has stopped
chasing — strands nothing and is still allowed." The guard only refuses the one case that would
orphan a physical card; every other drop already goes through.

**Disambiguation from UIL-040, since both describe `saveCollection` and could otherwise read as the
same guard.** This entry is about the **target-drop** guard — removing a card from the chase list —
which exists and works as described above. UIL-040 is about a **different** condition in the same
function, the **specialty-binder rebind** (the chip selector at
[`CollHub.tsx:709-717`](<../app/(ui)/coll/CollHub.tsx>:709)), which **had no guard as of `550a803`**
(PR #102 was open, proposing exactly that guard, at the time this note was written — check UIL-040's
own status before assuming either way). Nothing here implies the rebind case is protected by *this*
entry's guard; UIL-040 remains the entry for that gap.

**The suggestion.** Since the collection's binder is already on screen at that row, offer the move
inline from the owned-row state itself rather than sending her to the card to remove it from there
— saving the one extra hop the current design accepts as its cost.

**Framing that must survive into any implementation:** this is additive, not corrective. Nothing
about the shipped behaviour is wrong, and a future session reading this entry should not treat it
as license to change what Karvi already decided — hiding "✕" and refusing server-side stays exactly
as shipped; this only adds a shortcut next to it.

**Priority rationale.** Low: nothing is broken, the current behaviour was a deliberate choice, and
the cost being addressed is one extra click, not a data risk or a blocked workflow.

## UIL-044 — Collector-number search still ranks a padded exact match arbitrarily when it collides with other sets — confirmed as UIL-026's gap, not a new defect

- **Reported:** 2026-09-14 (found while retesting UIL-010's fix, same search box UIL-015 was found in)
- **Status:** **Closed** — same fix as UIL-026 (PR [#110](https://github.com/viantihu/pokemon-tcg-tracker/pull/110),
  squash `f3248d9`, deployed, ranking columns verified populated 23,548 / 23,548), and **confirmed
  resolved by Karvi on Testing 2026-09-15** together with UIL-026 — this entry was that acceptance test.
- **Priority:** See UIL-026; this is real-world evidence the gap is worth acting on, not a new priority
  call
- **Area:** Collections, Lookup
- **Env:** Testing

In her words: "That number should've ONLY returned the minior card, but instead, it was at the bottom
of the list." Typing `099/182` in the "New Collection" set-list search returned five cards sharing the
exact local id `099` across five different sets — Rabsca (Paldea Evolved), Greavard (Obsidian Flames),
Kingler (151), **Minior (Paradox Rift)**, and Pineco (Paldean Fates) — with Minior fourth of five, not
first and not alone.

**Confirmed: this is UIL-026's exact mechanism, hit without any padding ambiguity at all.** Unlike
UIL-015's case, `099` needs no stripped/padded disambiguation — all five results are exact matches on
the same 3-digit local id, so [`catalog-card.ts`](<../lib/repo/catalog-card.ts>)'s single per-candidate
query (`.eq("local_id", "099").order("set_id", { ascending: true })`) returns all five in one call, tied
on local id, and orders them alphabetically by `set_id` alone. Verified the actual set ids account for
the exact order she saw: `sv02` (Paldea Evolved) < `sv03` (Obsidian Flames) < `sv03.5` (151) < `sv04`
(Paradox Rift) < `sv04.5` (Paldean Fates) — precisely Rabsca, Greavard, Kingler, Minior, Pineco. Minior
lands fourth of five (Pineco is technically last), which is close enough to "at the bottom" that her
description and the mechanism agree.

**The denominator she typed is the decisive signal, confirmed live rather than assumed.** TCGdex reports
`sv04` (Paradox Rift) as `cardCount.official: 182` — **exactly** the denominator she typed — while the
other four sets are 193, 197, 165, and 91. None of the others match; only Minior's set does. This is
UIL-026's proposed fix (rank by the typed denominator matching a set's official count) demonstrated on
a real, concrete case rather than the synthetic `me02.5` example that entry was written from.

**Not logging this as a new defect or a new fix.** The root cause, the mechanism, and the suggested fix
are already fully described in UIL-026 ("Mirror the printed set total AND release date, so tied
collector-number matches can be ranked instead of sorted alphabetically"). Recording this here because
the log's convention is that what she reports gets its own entry in her words — but the entry that
needs attention is UIL-026, not this one. Worth the Senior BA weighing whether a second, concrete UAT
hit on the same gap changes UIL-026's position in the queue; not asserting a priority change here.

## UIL-045 — The Haul Plan's forecast is computed against pre-haul state, so a card that interacts with an earlier card in the same haul can be shelved somewhere other than the screen showed

- **Reported:** 2026-09-14 (not from Karvi — traced in source by the Full Stack Dev; relevant tonight,
  she is about to place 702 cards)
- **Status:** **Fixed** — PR [#121](https://github.com/viantihu/pokemon-tcg-tracker/pull/121) MERGED to
  `develop` 2026-09-15 (squash `72fd94d`), QA-gated on the merged tree with mutations verified, confirmed
  **deployed** to Testing (Vercel / migrate / smoke / acceptance all green on tip `378b570`). Shipped as
  briefed — re-derive **only the spotlight card**, just-in-time — plus the stronger guarantee the design
  review reached: the write stays server-authoritative (carrying a client placement would silently drop
  line creation, slot fills and holo swaps), the client returns a **digest of what it displayed**, and on
  a mismatch the server throws `PlacementChangedError` having written **nothing**. So: what she saw is
  what was written, or she is told it changed — never silently one then the other. The spotlight now
  reads "was … — now …" with the cascade's reason when the re-derivation differs, and Done is disabled
  ("Checking…") while the re-check is in flight. Overridden cards were already safe and are unchanged.
  Test debt once carried into UIL-061, since paid: the digest's fill / new-line / swap components ARE pinned by `tests/plan/spotlight-drift.test.ts` (PR #151; dropping each fails 2 / 1 / 2 cases, audited 2026-09-20 in #287). Awaiting Karvi's confirmation on a second copy of an already-shelved card.
- **Priority:** High (Senior BA's read)
- **Area:** Plan
- **Env:** Testing

**The defect, in one line: for a card she has not overridden, what gets written is re-derived at commit
time, not what she was shown — and the two can disagree.** `commitCardPlacement`
([`lib/plan/commit.ts:138`](../lib/plan/commit.ts:138)) loads a fresh `loadPlanContext` on every Done
([`:152`](../lib/plan/commit.ts:152)) and re-runs `placeCard` via `planFromDraft`
([`:153`](../lib/plan/commit.ts:153)) — it never receives the `PlanItem` she looked at. So the row on
screen is one computation and the write is a second, independent one.

**Why the forecast drifts from the write.** `planFromDraft`
([`lib/plan/context.ts:199-218`](../lib/plan/context.ts:199)) loops `placeCard(incoming, pc.ctx)` and
**never mutates `pc.ctx` between cards** — verified directly, the loop body computes each row and pushes
it, touching nothing in the context. So every forecast row is computed against **pre-haul** state, as if
no other card in the haul existed. The per-card commit, by contrast, re-loads context fresh each Done,
and by then the cards she already placed this sitting are real rows in the DB — so the commit sees a
state the forecast never did. The card lands where the commit re-derives; the screen showed her where
the pre-haul forecast landed.

**Why this is worse than a wrong write, and is the exact failure this app exists to prevent.** The DB
and the write agree with each other — the disagreement is between the DB and *her physical shelf*, because
she places the card where the screen told her while the DB recorded somewhere else. Nothing on screen
flags the divergence. A wrong write is loud; this is silent.

**The most common trigger is not line creation — it's owning two of the same card.** The first copy
forecasts "front half"; the second re-derives to "duplicate → bulk box," because by commit time the first
copy exists. Two cards of one evolution line is the same shape: both forecast "start a new line," and the
second re-derives to "fill the placeholder the first just created." The most ordinary case there is —
a duplicate — is the one that triggers it.

**Overridden cards are structurally safe, and the entry should say so to bound the blast radius.**
`buildHaulCommitPayload` ([`lib/plan/commit.ts:213`](../lib/plan/commit.ts:213)) short-circuits an
overridden card to `writeOverriddenCard` → `placementForMove(dest)` ([`:249-252`](../lib/plan/commit.ts:249)),
skipping the cascade entirely. Post-UIL-037 the sentence she reads and the columns written both derive
from the same `MoveDestination`, so for an overridden card divergence is impossible. This defect is only
about cards she lets the cascade place.

**Two attributions that must be in the entry so this isn't misfiled:**

1. **Not caused by UIL-027, and does not block its per-card-commit work (#109).** The old whole-haul
   batch commit maintained live `slotsByLine`/`passLines` mirrors across its loop, so it *already*
   diverged from this same naive pre-haul display in exactly this way — **the gap has been live since
   M6.** Per-card commit inherited it unchanged; what UIL-027 removed was the single end-of-haul review
   moment, not the divergence. Fixing this is independent of UIL-027.
2. **The obvious fix — "re-forecast the tail when a line is created" — is insufficient and should not be
   recorded as the plan.** It misses the duplicate case, which is the common one. (This was an earlier
   suggested fix; noting it as considered-and-rejected so no one re-proposes it.)

**Recommended fix (the Full Stack Dev's, endorsed by the Senior BA): re-derive only the spotlight card,
just-in-time, not the whole tail.** She acts on one card at a time, and the spotlight row is the only one
whose accuracy actually puts a card in a pocket — so re-plan that single card against current state on
each cursor move, and leave the rest of the worklist as an acknowledged estimate. The alternative
(re-forecasting the whole tail on every Done) is not just heavier, it's prohibitively so: `loadPlanContext`
is **9 parallel reads**, and #86 cached only one of them — the other eight, including `copyRepo.listAll`
which pages with her collection, still run per Done. A whole-tail re-forecast is ~8–10 queries × ~685
clicks; spotlight-only avoids that entirely.

**Priority rationale (Senior BA's read): High.** It silently produces a physical placement that disagrees
with the record, on the app's core daily action, reachable by the most ordinary case there is — owning
two of the same card. Not blocked on anything, not caused by anything in flight. The Senior BA is telling
Karvi directly, since she is mid-placement tonight and needs to know the screen can be wrong for
duplicates and line-mates until this lands.

**Update 2026-09-18: partial fix, and this stays one entry rather than splitting — her explicit
grouping instruction.** In her words, given directly on this exact case: "I want to track these in the
same issue rather than different ones. As a BA, you should be grouping issues by functional
requirements, not technical ones." The functional requirement this entry is actually about is **"the
displayed placement must match what actually gets written"** — one requirement, two surfaces. #121
closed it for the spotlight only; it is still open for the worklist table, for the identical
duplicate/line-mate cases described above.

**Confirmed precisely why the table still drifts, even after #121.** `runHaulPlan`
([`app/(ui)/plan/actions.ts:97-101`](<../app/(ui)/plan/actions.ts>:97)) calls `planFromDraft` **once**,
against pre-haul state, and its `items`/`groups` become the `plan` React state
([`app/(ui)/plan/PlanScreen.tsx:162,343`](<../app/(ui)/plan/PlanScreen.tsx>:162)) that the worklist
table renders row by row. `refreshSpotlightAction` ([`actions.ts:229-257`](<../app/(ui)/plan/actions.ts>:229))
— #121's actual fix — is a **separate** call whose result lands in a **separate**, single-slot state
variable, `fresh`, keyed to whichever card is currently the spotlight
([`PlanScreen.tsx:480-513`](<../app/(ui)/plan/PlanScreen.tsx>:480)). Nothing ever feeds a re-derived
placement back into `plan.groups`. So the table cell for a duplicate or line-mate keeps showing
whatever the one-time pre-haul pass computed — "front half," say — for the entire sitting, even after
that exact card has been correctly re-derived to "duplicate → bulk" in the spotlight and correctly
**written** that way at commit. The write is right; the spotlight she confirms against is right; the
table row for that same card, once she's scrolled past it, is not.

**Cross-reference UIL-037 (same standard, already shipped for a different pair of surfaces).** UIL-037
made the spotlight and worklist chip agree on an *overridden* card's destination. This is the
cascade-placed-card version of the identical requirement, and it's the standard this fix should be
held to: spotlight and worklist row must never disagree, for any card, overridden or not.

**Reopening note for the Senior BA, not a status change I'm making myself:** the current `Fixed` status
line describes #121 accurately for the spotlight; whether that line should now read as a partial fix,
or whether this warrants its own transition, is a call for whoever owns status here — flagging rather
than touching it.

**Update 2026-09-18: a second, independently-worded report confirms this is the right entry for it.**
Karvi separately asked that "the haul plan and the spotlight of the other cards should reflect what
happened to those cards" when placing a card alongside other compatible cards in the same haul — same
functional requirement as this entry's own title, in her own words a second time, not a new gap. No new
mechanism to add; recorded here so the two reports aren't read as two separate things later.

**Update 2026-09-19: this entry sits inside a broader fix sequence, per**
[`docs/root-cause-analysis.md`](../docs/root-cause-analysis.md) **RC-4, verified directly.** RC-4 step 1
is #121's spotlight fix, already shipped — the RCA's own words: "the single highest-value test in this
document, fails today," done via the digest-compare-and-refuse mechanism. The worklist-table gap this
entry's 2026-09-18 update covers is step 2. **RC-4 step 3 — a stateful forecast for the tail of the
worklist — is confirmed still open** by the RCA itself, which names #121's own description as the
reason it was scoped out (cost, not oversight). Recorded
as a pointer so whoever picks up step 3 knows it exists rather than treating steps 1–2 as the whole fix.

## UIL-046 — Unresolved entries never record a retry attempt, so "self-heal when the catalog catches up" may never actually run

- **Reported:** 2026-09-14 (not from Karvi — measured on Testing by the Senior BA/tech-lead)
- **Status:** **Closed** — verified behaviourally on Testing 2026-09-19 (see the end of this line); not
  Karvi's report, so it closes on that read plus #208's real-Postgres test, not on a confirmation from
  her. Fix: PR [#183](https://github.com/viantihu/pokemon-tcg-tracker/pull/183) MERGED to
  `develop` 2026-09-18 (squash `62fa838`), QA-gated on the merged tree (701 tests, build), confirmed
  **deployed** to Testing (Deploy and Vercel both green on `d1bfce3`, which contains it). The cause was
  narrower than the title feared: the self-heal DID run, on the retry path and on a full import — what
  never existed was the evidence, because `retryUnresolvedNow` returned early on `promoted === 0` and
  wrote nothing, so `last_retry_sync` and `retry_count` (both already surfaced by the queue) were never
  stamped. The sweep now stamps every WAITING entry it examined and did not promote, especially when
  nothing resolved; the waiting set is read before the apply so a just-promoted row is never stamped as a
  failed retry, and the stamp is its own `apply_write_ops` call so telemetry can neither fail nor be
  rolled back by a genuine promotion. **QA's caveat, recorded at merge, verbatim:** "the retry-recording
  write (`stampRetrySweep`) is NOT pinned by any behavioural test. Short-circuiting it passed all 9 tests,
  because every test in `tests/sync/retry-telemetry-and-alias-guard.test.ts` is a source-text assertion
  over the file, not an execution. What IS verified: the `update_unresolved_entry` op exists in
  `write-ops.ts` and in the RPC (0006–0008) and is exercised by `tests/sync/exec-atomicity.test.ts`, and
  `EntryPatch` already carries `retry_count` and `last_retry_sync`, so the write is well-formed. A PGlite
  test proving waiting rows gain `last_retry_sync` and `retry_count`+1 while promoted rows don't is owed."
  So the dev's "revert-checked" claim rests on a source-text test, and this entry does not close on it: it
  closes on the Tech Lead's Testing read of `retry_count` / `last_retry_sync` across the 7 WAITING rows
  after the next retry sweep (expect all 7 stamped unless one promotes). **Both halves of that debt are
  now paid.** Suite: PR [#208](https://github.com/viantihu/pokemon-tcg-tracker/pull/208) MERGED 2026-09-19
  (squash `cef3919`) adds the behavioural PGlite test proving waiting rows gain `last_retry_sync` and
  `retry_count`+1 while promoted rows do not; it exposed no defect. Testing: she ran a sync between the
  Tech Lead's 23:5xZ and 01:00Z reads (runs `35407106965` → `35411245355`), and `last_retry_sync` went
  not-null **1 of 8 → 8 of 8** while `retry_count` went from two distinct values to one, with WAITING
  still 7 and RESOLVED still 1 — every examined-and-not-promoted row was stamped and nothing promoted,
  which is the expectation set above. The same PR (#183) carries UIL-047's C3 guard (a manual match
  never learns a set alias across locales), recorded under UIL-047, which stays Open on C1/C2.
- **Priority:** Medium (Senior BA's read — explicitly provisional; verify the cause before treating the
  ranking as settled)
- **Area:** Sync
- **Env:** Testing

**Measured on Testing after Karvi's second sync (run `34901060401`):**

```
unresolved_entry WAITING:            8 → 6   (two cleared)
retry_count on the surviving six:    min 0, max 0
rows with last_retry_sync set:       0 of 6
```

**A second sync ran and no surviving entry records a retry attempt.** The Sync screen tells her
unresolved rows "self-heal when the catalog catches up." If the auto-retry never runs — or runs but
never stamps that it did — those rows only ever clear when she manually matches them. That's a
promise-versus-behaviour gap, not data loss.

**Two things that keep this honest, and both must stay in the entry:**

1. **The two that cleared may have cleared by manual match, not auto-retry.** A `copy` +2 /
   `presence_group` +1 delta fits `manualMatch` ([`lib/sync/exec.ts:423`](../lib/sync/exec.ts:423))
   exactly — it creates copies, marks the entry RESOLVED, and learns the alias. So this is evidence the
   auto-retry doesn't *stamp* its attempts, **not** evidence reconciliation is broken — the queue
   demonstrably drained (8 → 6).
2. **It may be telemetry, not logic.** A dead retry path and a retry that runs without writing its
   counters have the identical symptom and opposite fixes. **Whoever takes this must check whether the
   retry path reaches `UNKNOWN_SET` entries at all, and whether it writes `retry_count`/`last_retry_sync`,
   before ranking it or proposing a fix.**

**Source evidence for whoever investigates, gathered here so the cause question starts narrowed rather
than cold.** `retry_count` IS written in the codebase, in two places — the import-parks path
([`lib/sync/exec.ts:278`](../lib/sync/exec.ts:278), `retry_count: prior.retry_count + 1` for a CSV row
that stays unresolved) and `manualMatch` ([`exec.ts:489`](../lib/sync/exec.ts:489)). But the **retry-only
self-heal branch** in [`lib/sync/pipeline.ts:188-218`](../lib/sync/pipeline.ts:188) only acts on entries
that *resolve* — it pushes them to `archiveEntryIds` and writes nothing at all for an entry that stays
unresolved, so a retry-only sweep never increments the counter on a still-waiting row. Whether Karvi's
second sync took the import path (which would have parked-and-incremented any still-unresolved CSV row)
or left the six untouched because they weren't in that export at all is the open question — the counters
being flat is consistent with "the six weren't in the second CSV" as much as with "the retry path
doesn't stamp." That distinction is exactly what needs checking before a fix.

**Do not record which of `RESOLVED`/`DISMISSED` the two cleared entries became** — the read can't
distinguish them and nobody has asked Karvi. Two named entries did leave the queue (Battle Academy 2022
Eevee Deck and Storm Emeralda); six remain.

**Settled: telemetry, by design, not a dead retry path — both the "self-heal" mechanism and the "why the
counters are flat" question checked directly against source.**

- **The retry-only sweep never touches a still-unresolved row, on either outcome.**
  [`retryUnresolvedNow`](<../app/(ui)/sync/actions.ts>:90) runs the pipeline with `bytes=null`, and if
  nothing promotes it returns `{ applied: false }` **without calling `executeApply` at all** — no write
  happens, so nothing could be stamped. Even when something *does* promote,
  [`pipeline.ts:188-218`](../lib/sync/pipeline.ts:188)'s retry-only branch only ever pushes entries that
  now resolve into `archiveEntryIds`; there is no `else` arm for a still-unresolved entry, so `parks`
  stays empty on this path and a surviving WAITING row is never in the write set to begin with.
- **The import-reparks path can stamp the counter, but a repeated identical export never reaches it.**
  [`exec.ts` step 5](../lib/sync/exec.ts:278) does write `retry_count + 1`/`last_retry_sync` for a CSV
  row that comes back still unresolved — but only if `applySync` actually runs.
  [`SyncScreen.tsx:80-85`](<../app/(ui)/sync/SyncScreen.tsx>:80) returns on `preview.kind === "noop"`
  ("Already in sync — nothing to apply") without calling `applySync`, and
  [`pipeline.ts:242-253`](../lib/sync/pipeline.ts:242) explicitly classifies an identical re-park (same
  quantity, same reason) as **not meaningful**, which is what makes the preview a noop. So a repeat
  export of the same still-unresolved rows never reaches the write step that would stamp them — exactly
  what she measured.

**Both self-heal promises are actually kept; only the "last checked" stamp is missing.** A resolving
entry is archived on import and promoted on retry either way. What's missing is a write recording that a
check happened when nothing changed — so the queue view
([`toEntryView`](<../app/(ui)/sync/actions.ts>), which maps `last_retry_sync`) shows "never retried" for
rows that have, in fact, been checked repeatedly and correctly found still unresolved.

**Falsifier run before concluding this:** read the noop branch specifically for any `applySync` call —
there is none.

**Priority rationale.** No behaviour defect — self-healing works exactly as promised for any entry that
actually resolves; this is a missing stamp on a checked-and-still-unresolved outcome, not a dead retry
path or lost data. The Senior BA is putting a revised Low to Karvi now that the cause is settled;
recording that as proposed rather than final since priority is her call.

**Note:** the fix's own test-debt gap — `stampRetrySweep` unpinned by any behavioural test — is already
quoted in full in the status line above (QA's caveat at merge). Not repeated here; see the status line
for the exact wording and what remains to close it (the Tech Lead's Testing read of `retry_count` /
`last_retry_sync` across the 7 WAITING rows after the next sweep).

## UIL-047 — Japanese cards are unfindable and can be confidently mis-matched, because the catalog mirror is English-only

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet — three separate reports, one root cause)
- **Status:** **Fixed** — C1, C2 and C3 all built, deployed and mirrored; awaiting Karvi's confirmation on
  her first import against the Japanese catalog. After UIL-083's fix the ja resume run (Tech Lead, run
  35492136717, 05:37Z) went green, 73 of 73 sets, and the read afterwards (run 35492218209) shows
  catalog_card 36,329 = en 23,548 + **ja 12,781** across 184 sets, set_alias 22 unchanged, source=user 0;
  69 ja sets are served short of what TCGdex's own set list claims (versus 6 for en), which is upstream
  and is re-requested on every ja run, cheap and safe. Because Karvi cleared Testing's card tables at
  05:22Z (unresolved_entry is 0), the earlier "Retry now drains the five rows" step no longer applies;
  the step is now the import itself. **Step for Karvi:** import your Dex export; Japanese cards should
  resolve on the way in (each shows a JA tag on its tile, set id without the `ja:` prefix), and only cards
  TCGdex carries in no locale should park in Sync, where the stand-in form (UIL-060) applies. Match one
  Japanese card by hand where the set is unknown and the app should learn the alias (ja, code) → `ja:set`;
  a Japanese card matched to an English printing still does not auto-learn, and says so. Closed on her
  confirmation. **Earlier history:** Karvi ruled 2026-09-20: pull the Japanese catalog this phase ("user
  has a lot of Japanese cards"). PR
  [#280](https://github.com/viantihu/pokemon-tcg-tracker/pull/280) MERGED to `develop` 2026-09-20 (squash
  `545759f`), migration `0016` (`locale` on `catalog_card`, default 'en'; non-en rows namespaced
  `ja:<set>-<local>` / `ja:<set>` with a check tying the prefix to the locale both ways; the (set_id,
  local_id) index replaced by (locale, set_id, local_id); DDL only), QA-gated (1056 tests; five mutations
  bite: un-namespaced ja ids, locale-blind artwork clustering, a tautological namespace check, an
  unscoped set-name fallback, a disabled guard refusal), **deployed** with the Senior BA's before/after read
  (runs 35480409591 → 35480908041: `locale` absent → present 23,548/23,548, en 23,548, ja 0, every other
  count identical, zero row deltas). What landed: the mirror workflow takes a `locale` input (en default,
  one locale per run, the Tech Lead's patch verbatim, resume counts filtered by locale and source); the
  route and `mirror.ts` thread the locale and namespace ja rows; artwork clustering is partitioned by
  locale so a JP printing is never called its EN twin's duplicate; the resolver namespaces ja passthroughs
  and scopes the set-name fallback; one `normalizeLocale()` maps the CSV's "Japanese" to the `ja` key;
  the C3 guard became locale-mismatch based (a ja entry matched to a ja card learns (ja, code) → `ja:set`;
  a ja entry matched to an en card still does not auto-learn and says so, because the cross-locale hazard
  C3 closed is not removed by the mirror); tiles and the spotlight show a JA tag with the prefix stripped.
  Her two existing ja aliases (ja:m6 → swshp among them) are left exactly as she set them, pinned by a
  migration test. The largest ja set (MC, 774 cards) measured 5.1 s in one request, so no splitting.
  **First ja mirror run, 2026-09-20 05:01Z (run 35490587409, dispatched by the Senior BA on Karvi's
  "resume"):** 175 of 184 sets mirrored; the Senior BA's read afterwards (run 35491315646): catalog_card
  36,041 = en 23,548 (unchanged) + **ja 12,493**; set_alias 22, unresolved_entry 8 (WAITING 7), copy 706,
  source=user 0, all unchanged. Nine sets never succeeded on two code causes, now UIL-083 (set ids with
  "+" decoded as a space; a fractional Pokédex number on Rayquaza ★ rejected by an integer column); 64
  further sets landed short of TCGdex's advertised count or got HTTP 503, which is upstream (UIL-004's
  pattern) and is re-requested on every resume run. **Remaining:** UIL-083's fix, one resume dispatch
  (`locale: ja`, never force_all), a read of the ja count, then Sync → Retry now should drain the five
  Japanese "Waiting on catalog" rows wherever the Dex code equals the ja set id, and searching a Japanese
  card should show a JA-tagged tile. Fixed on that read; Closed on her confirmation.
  C3 guard: PR [#183](https://github.com/viantihu/pokemon-tcg-tracker/pull/183) (squash `62fa838`,
  2026-09-18) — a manual match on a non-English entry never learns a cross-locale set alias, because the
  mirror is English-only so any such alias is wrong by construction. C3 remedy: PR
  [#194](https://github.com/viantihu/pokemon-tcg-tracker/pull/194) (squash `541c65c`, 2026-09-19, migration
  `0014`), QA-gated on the merged tree (827 tests; 0014's function is 0013's text plus the eight-line
  `delete_set_alias` branch and nothing else; five mutations all bite), confirmed **deployed** (Deploy and
  Vercel green on `07b0c88`): Sync gains a LEARNED SET ALIASES panel and a two-step inline **Forget** that
  deletes the alias and re-parks that set's "needs your match" entries to "waiting on catalog" in one
  transaction; already-matched cards stay put until her next import. Predicate read from code, not memory:
  WAITING + UNKNOWN_CARD + matching locale and Dex set code; on her data the Tech Lead's read says it hits
  **exactly one row** (the earlier "two Battle Academy cards" was wrong and is retracted). The migration
  itself changes no rows. **Open on C1/C2**: whether a Japanese printing is a distinct card or the same
  card in another language determines the schema, so nothing is built either way until she rules; until
  then she should not manual-match the five Japanese `UNKNOWN_SET` rows.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Catalog, Sync, Lookup, Plan
- **Env:** Testing

Three of her reports are the same defect seen three ways:

- "Non-american cards do not appear in the lookup or on the haul plan. For example, I own a Japanese
  Garbodor, which has the collector number 057/086."
- "This card is actually a Japanese Pawmi." (the app matched it as the wrong card)
- "Floragato was not found in the sync match because it is a Japanese card, which has been causing
  issues. Same with Purrloin."

**Root cause C1 — the mirror only ever fetches English, and there is nowhere to store anything else.**
[`.github/workflows/catalog-mirror.yml:170`](../.github/workflows/catalog-mirror.yml:170) walks
`$TCGDEX_BASE_URL/en/sets`; no `locale` is threaded through
([`app/api/catalog/sync/route.ts:45`](<../app/api/catalog/sync/route.ts>:45)), so
[`lib/catalog/tcgdex.ts:118`](../lib/catalog/tcgdex.ts:118) falls to `opts.locale ?? "en"` on every
request. `catalog_card` ([`0002_domain.sql`](../supabase/migrations/0002_domain.sql)) is keyed on
`tcgdex_id` alone with **no locale column** — so a Japanese printing can't even be stored alongside its
English counterpart without a PK collision. UIL-004's 23,548-row / 214-set figure is all-English by
construction. So Japanese Garbodor `057/086` simply does not exist in the mirror, and the lookup/plan
search ([`lib/repo/catalog-card.ts`](../lib/repo/catalog-card.ts) `search`, locale-unaware) cannot
return a row that isn't there. That is her first report, verbatim.

**Root cause C2 — the resolver knows about Japanese but the lookup key doesn't.**
[`lib/sync/resolve.ts:32`](../lib/sync/resolve.ts:32) correctly tags a Japanese Dex row `locale: "ja"`,
but `catalog-lookup.ts`'s `findBySetLocal` has no locale parameter and queries the English-only mirror,
so the primary hit misses, the English `set_name` fallback returns nothing, and the row parks in
`unresolved_entry` with `reason: "UNKNOWN_SET"`. That is exactly the path Floragato and Purrloin took —
her third report.

**Root cause C3 — a manual match will silently teach a cross-locale alias, and there is no undo.** This
is the most dangerous of the three and the likely source of "actually a Japanese Pawmi."
[`lib/sync/exec.ts:437-448`](../lib/sync/exec.ts:437): on manual-matching an `UNKNOWN_SET` Japanese row,
the only card the user can pick is an English printing (there are no others), so the op writes
`set_alias(locale='ja', dex_code=<jp code>, tcgdex_set_id=<english set id>)`. `set_alias.tcgdex_set_id`
is plain `text` with no locale-scoped FK. Afterward, alias-drain resolves *every* subsequent Japanese
row from that set to English printings sharing the collector number — a confident wrong match, not a
miss. There is no `delete_set_alias` path in the app, so one bad manual match silently corrupts every
future Japanese import from that set.

**Suggested fix (data + code, both needed — fixing one alone leaves the other's symptom).** Add a
`locale` column to `catalog_card` in a new migration and to the `(set_id, local_id)` index; thread
`opts.locale` through `syncSet`/`syncAll` (they already accept it — call-site plumbing only) and add
`/ja/` sets to the mirror workflow; thread a `locale` argument through `findBySetLocal`/`search` and the
plan/backfill/lookup/coll action surfaces (each already knows the owner session, and the Dex import row
already carries the locale via `resolve.ts`). Guard `upsert_set_alias` against a locale mismatch between
the entry and the chosen card so C3 can't teach a cross-locale alias.

**Priority rationale.** High: an entire locale of her real collection is invisible to sync and lookup —
the app's core intake and find paths fail wholesale for it — and C3 additionally risks silent data
corruption with no in-app recovery. She has hit it three distinct ways in one session. This is the
largest single item in this batch.

**Real-data observation, confirmed (not hypothesized) against run
[`34977540936`](https://github.com/viantihu/pokemon-tcg-tracker/actions/runs/34977540936) on
2026-09-15 — supersedes the earlier hedged version of this note.** `set_alias` holds **21 rows** and
survived every Testing refresh; two are hers, both manual, both cross-locale:
`ja:m6 → swshp` (2026-09-14T21:18:56Z) and `en:ba22e → swshp` (2026-09-14T21:19:28Z). Of the 8 WAITING
entries, the per-row breakdown (read directly from the run's log) confirms the mechanism exactly: the
**2 aliased** codes (`ja:m6`, `en:ba22e`) are **UNKNOWN_CARD**; the **6 un-aliased** codes
(`en:swsh45sv`, `ja:mc`, `ja:mem`, `ja:mez`, `ja:s12a`, `ja:sv9`) are **UNKNOWN_SET**. So "one match
drains the set" does hold — an alias resolves every row in its set at import — and C3's mechanism is
now observed, not hypothetical: `ja:m6 → swshp` is a permanent cross-locale alias, taught because
TCGdex carries no Battle Academy set to point at instead. It fails safe here only because `swshp` (the
English SWSH promo set it was aliased to) doesn't carry that specific card number either — a lucky miss,
not a designed one; a different card number could have matched confidently and wrongly, which is
exactly what C3 warns about.

**The two UNKNOWN_CARD rows are UIL-060's exact case, not a separate mechanism — cross-reference both
ways.** Once resolved to a set (correctly or not), a card TCGdex simply doesn't carry lands as
UNKNOWN_CARD — the same "external database has no record for this card" gap UIL-060 proposes a
stand-in-record fix for. The six UNKNOWN_SET rows remain this entry's own C1/C2 (no set to resolve to at
all); the fix decision here still has to cover the already-learned bad alias, not just prevent new ones.

**Update 2026-09-19: the "no `delete_set_alias` path" line above is now false — corrected, not
deleted, so the record of what was true when written stays.** PR #194 (see the status line for the full
mechanism — a LEARNED SET ALIASES panel with a two-step Forget) adds exactly that op. Not repeating the
mechanism here to avoid the two descriptions drifting apart; see the status line.

**Tech Lead's before/after Testing read confirms the migration itself changed nothing — the button
hasn't been pressed yet.** Runs before (01:00Z) and after (20:52Z, run `35468672267`) 0014 landed show
every figure identical: `set_alias` 22 (3 manual, 19 name-resolved), the `ja:m6 → swshp` alias still
present as 1 row, `unresolved_entry` 8 (WAITING 7 = 5 UNKNOWN_SET + 2 UNKNOWN_CARD, RESOLVED 1,
DISMISSED 0), the Forget predicate matching 1 row, `collection` 11, `copy` 706. Migration 0014 shipped
the capability; it did not itself touch data, and nobody has clicked Forget on Testing yet.

## UIL-048 — "Logging" a card she already owns into a collection creates a second physical copy row

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Closed** — PR [#119](https://github.com/viantihu/pokemon-tcg-tracker/pull/119) MERGED to
  `develop` 2026-09-15 (squash `637668b`), QA-gated on the merged tree, confirmed **deployed** to Testing
  (Vercel / migrate / smoke / acceptance all green on `637668b` and on the `a59bc4e` tip). Logging a card
  she already owns is now: already in this collection's binder → no-op (tag only, no insert); owned but
  shelved elsewhere or in bulk → refused, naming where it is and pointing at Move; not owned → one copy
  inserted as before. Guard verified by mutation (guard removed → `expected 2 to be 1` on the copy row
  count). Testing showed **0** existing duplicate pairs, so nothing needed cleaning up. **Confirmed
  resolved by Karvi on Testing 2026-09-15.**
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Collections
- **Env:** Testing

In her words: "I logged an owned card to a collection. It added 2 of that card even though I only own 1."

**Root cause.** `logCardIntoCollection` ([`app/(ui)/coll/actions.ts:271-296`](<../app/(ui)/coll/actions.ts>:271))
does an **unconditional** `copyRepo.insert` — a new shelved `copy` row — with no check for an existing
shelved copy of that `catalog_card_id` in the binder, then idempotently unions the id into
`target_catalog_card_ids`. So logging a card she already owns leaves **two `copy` rows** for one
physical card. The "2" she sees is literal: `RemoveCardButton`
([`CollHub.tsx:571-575`](<../app/(ui)/coll/CollHub.tsx>:571)) renders `Remove {count} ▸` where
`count = card.copyIds.length`, and `copyIds` ([`actions.ts:114-116`](<../app/(ui)/coll/actions.ts>:114))
is every shelved copy of that card in the collection's binders — now two. (`ownedCount`/`totalCount` are
per-catalog-card, so those still read 1/1; the "2" is the copy count specifically.)

**Relationship to UIL-033.** UIL-033 already flags this same function as non-atomic and as a fourth
divergent definition of "join a collection," but frames it as a consistency/atomicity risk. The
**duplicate-copy-on-logging-an-owned-card** symptom is a new, user-visible failure mode within UIL-033's
blast radius that UIL-033 does not currently name. Worth fixing together — the consolidation UIL-033
proposes (route through `apply_write_ops`'s collection-join ops) is the natural place to add the "don't
insert a second copy if one is already shelved here" guard.

**Priority rationale.** High: it silently creates phantom inventory — a copy row for a card that doesn't
physically exist — which is exactly the class of wrong-data-about-her-real-collection the app exists to
prevent. Same severity reasoning Karvi accepted for UIL-014/UIL-022.

## UIL-049 — A duplicate that is also a specialty card routes to the specialty binder instead of bulk

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Fixed** — PR [#164](https://github.com/viantihu/pokemon-tcg-tracker/pull/164) MERGED to
  `develop` 2026-09-18 (squash `b5d0690`), QA-gated on the merged tree, confirmed **deployed** to Testing
  (Deploy green on `04dea51`, which contains it). The cascade now checks **duplicate before card class**, so
  a second copy of the same specialty printing routes to bulk, exactly her rule; a specialty card that is
  _not_ a duplicate still goes to the specialty binder. The reorder exposed specialty cards to the holo-swap
  branch for the first time, and that branch built a `front-half` target on the specialty binder — a
  placement the write layer cannot express. The same PR fixes it by inheriting a `specialty` target when
  the displaced copy had no binder half, so holo-swap keeps its meaning (holo takes the normal's place, the
  normal goes to bulk). **This entry's earlier "holo-swap still fires correctly" note was tested and found
  false** — the test written to check it failed on the first run; body correction routed to intake.
  Awaiting Karvi's confirmation when UAT resumes.
- **Priority:** Medium (Claude's read — a routing-policy change, not a malfunction; needs Karvi's confirmation)
- **Area:** Plan
- **Env:** Testing

In her words: "All cards, regardless of whether they are specialty or not, must be suggested as 'Bulk'
if they are duplicates."

**Current behavior, confirmed in source.** The cascade evaluates card class before duplication:
STEP 2 specialty ([`lib/engine/cascade.ts:236-245`](../lib/engine/cascade.ts:236)) returns before
STEP 3 duplicate ([`:246-287`](../lib/engine/cascade.ts:246)). So a specialty card that duplicates an
already-shelved copy routes to the specialty binder, not bulk — the opposite of her rule.

**Suggested fix.** Her ask is a pure block swap: move the STEP 3 duplicate block above STEP 2 specialty.
No signature or data-model change. Interactions checked: holo-swap still fires correctly (a specialty
holo over a shelved specialty normal still inherits the slot, displaces the normal to bulk); STEP 1
collection-claim stays ahead of both and is unaffected (she didn't scope collections into this). One
subtlety worth recording: `resolveDuplicate` matches on `artwork_group_id` (perceptual-hash cluster) or
same `(set_id, local_id)`, and a full-art specialty usually has *different* art from the standard print,
so this only fires for a second copy of the same specialty printing — which is precisely the case she
described.

**Correction 2026-09-18: the "interactions checked" note above was wrong about holo-swap, and PR
[#164](https://github.com/viantihu/pokemon-tcg-tracker/pull/164) (squash `b5d0690`, merged) is what
caught it.** The claim that holo-swap "still fires correctly" after the block swap was written from
reasoning, not a test — and when #164 actually implemented the reorder and tested it, the assertion was
false. The reason is precise: moving duplicate detection ahead of card class **exposes specialty cards
to the holo-swap branch for the first time** — before the reorder, a specialty card returned at the
card-class step and never reached the swap at all. The holo-swap branch builds its target from the
*displaced* copy's placement, and a specialty copy has no binder half and no colour band, so the naive
reorder emitted `{ kind: "front-half", binderId: <the specialty binder> }` — **a target the write layer
cannot express**, since `placementForMove` clears half and band for a collection/specialty destination.
That would have been a malformed target reaching the commit, not the clean displace-to-bulk the note
claimed.

**What shipped.** #164 fixes it by inheriting a `specialty` target (not a front-half one) when the
displaced copy has no binder half — preserving holo-swap's meaning exactly (the holo takes the normal's
place, the normal goes to bulk) while emitting a placement that can actually be written. Revert-checked
each half against its own test: putting card class back above duplicate fails the bulk test; dropping
the no-binder-half inheritance fails the holo-swap test. The lesson for this log: an "interactions
checked" note written from reading rather than from a failing-then-passing test is exactly the kind of
claim that reads as verified while being wrong — the same shape UIL-029 is about, one level up in a
log entry rather than a test double.

**Priority rationale.** Medium: nothing is broken or mis-recorded today — the current routing is a
defensible default, just not her stated policy. It's a deliberate behavior change she's requesting, so it
competes with other Mediums rather than being a bug that jumps the queue.

## UIL-050 — Shelved count can exceed a binder's capacity because editing a binder never rebalances what's already in it

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Fixed** — PR [#171](https://github.com/viantihu/pokemon-tcg-tracker/pull/171) MERGED to
  `develop` 2026-09-18 (squash `3bdb29d`), QA-gated on the merged tree, confirmed **deployed** to Testing
  (Deploy and Vercel both green on `f1b788f`, which contains it). Capacity is derived live from
  pages / pockets / divider while the shelved count is a straight count of `copy` rows, and `saveBinder`
  wrote new dimensions with no check that what was already shelved still fit — so shrinking pages or moving
  the divider could leave more cards shelved than pockets. **Design decision, flagged and approved: the
  save is blocked and the message names which section would strand how many cards**, rather than silently
  rebalancing pages or the divider — moving her cards without asking is the UIL-061 mistake, and she has
  said she validates placements herself. A brand-new binder has nothing shelved, so nothing to check. QA
  finding closed before merge: the guard and its read were each tested in isolation but nothing proved
  `saveBinder` called them (the #146 pass-through shape), so a direct `saveBinder` wiring test was added.
  The PR body's "follow-up owed after #159" was discharged before merge: the rebased head (`5328b0a`) reads
  the null-half bucket through `copyRepo.listShelvedInSection` with a single PGlite `.is()` shim, no
  duplicate read left (QA, in code; 766 tests on the merged tree). Awaiting Karvi's confirmation when UAT
  resumes: shrink a binder below what it holds and the save should refuse with the count.
- **Priority:** Medium (Claude's read — needs Karvi's confirmation)
- **Area:** Binders, Settings
- **Env:** Testing

In her words: "Shelved is greater than capacity. This is physically impossible."

**Root cause: capacity dropping below an unchanged shelved count, not a bad count.** The `binder_section`
view ([`0002_domain.sql:286-346`](../supabase/migrations/0002_domain.sql:286)) derives capacity live from
`pages / pockets_per_page / back_half_start_page`, while shelved count is a straight count of `copy` rows
per `(binder_id, binder_half)` — two independent sources. `saveBinder`
([`app/(ui)/settings/actions.ts:56-96`](<../app/(ui)/settings/actions.ts>:56)) writes new
pages/PPP/divider with **no check that the currently shelved copies still fit**. Shrinking pages, moving
the divider forward, or clearing `back_half_start_page` (UIL-001's "NO BACK HALF" trap — back capacity
collapses to 0 while copies already at `binder_half='back'` still count) all produce
`shelved > capacity`. `free_pockets` is clamped at 0, but Shelved and Capacity render raw side by side
([`CapacityScreen.tsx:110-118`](<../app/(ui)/binders/CapacityScreen.tsx>:110)).

**Suggested fix.** A missing invariant on edit, not a formula bug: either block `saveBinder` when the
change would strand shelved copies (naming how many and where), or rebalance the affected copies at save
time. Pairs naturally with UIL-001's existing binder-form warnings.

**Priority rationale.** Medium: no data is lost and nothing is misrouted, but the binder capacity numbers
are the core of her "time for a new binder" planning, and a visibly impossible number erodes trust in all
of them. Not High since it takes a binder edit to trigger and nothing physically breaks.

## UIL-051 — Lookup has no way to move a card

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Fixed** — PR [#201](https://github.com/viantihu/pokemon-tcg-tracker/pull/201) MERGED to
  `develop` 2026-09-18 (squash `fc8646b`), QA-gated on the merged tree (787 tests, build, `lib/line`
  untouched), confirmed **deployed** to Testing (Deploy and Vercel both green on `fc8646b`). Lookup now shows
  **a Move on every owned copy row** under the address block — the entry's own ask, "a Move affordance per
  copy row" — opening the same `MoveOverlay` / `MovePanel` the Lines screen uses (imported, not edited), so
  a card found by lookup can be moved from where she found it. Per her ruling on refusals, the one blocked
  case (a binder block) names the condition and the remedy on its row; an unowned card shows no Move; Move
  is disabled mid-move. Static-rendered: the three notices kept apart, one Move per movable copy, the
  block row's wording. **Not rendered live: the move itself and the overlay interaction** (needs browser +
  DB), so her pass is the first real exercise of it. Fence held to `app/(ui)/look/*`. Awaiting Karvi's
  confirmation when UAT resumes: look up a card she owns, press Move on a copy, and place it.
- **Priority:** Medium (Claude's read — needs Karvi's confirmation)
- **Area:** Lookup
- **Env:** Testing

In her words: "Lookup provides no way to move cards."

**Confirmed: the Lookup screen is structurally read-only today.**
[`app/(ui)/look/LookupScreen.tsx`](<../app/(ui)/look/LookupScreen.tsx>) renders search, a card face, the
card's address, and a facts grid — no button, form, or action anywhere in the file. Contrast the Line
screen ([`LineScreen.tsx:322`](<../app/(ui)/line/LineScreen.tsx>:322)) and Plan screen
([`PlanScreen.tsx:387`](<../app/(ui)/plan/PlanScreen.tsx>:387)), which both mount `MoveOverlay` wired to
`moveCardAction` ([`app/(ui)/line/actions.ts:50`](<../app/(ui)/line/actions.ts>:50)).

**Suggested fix — additive wiring, not a new mechanism.** `moveCardAction(copyId, destination)` is
generic and RLS-scoped and reusable as-is; the one gap is that `LookupCopy`
([`app/(ui)/look/actions.ts`](<../app/(ui)/look/actions.ts>)) maps the owned copy but drops its `id`.
Thread `copyId` through, add a "Move" affordance per copy row, and mount the same `MoveOverlay`. Note
this overlaps UIL-037's fix area (the override-display work also touches how a destination is shown) and
UIL-023/UIL-022 (converting the move write path to atomic ops) — worth sequencing after those so Lookup
doesn't wire up a move path that's about to be reworked underneath it.

**Priority rationale.** Medium: a genuine missing capability on a daily screen, but not blocking — she
can move a card from the Line or Plan screen today. Reuses existing machinery, so cheap once the move
path it depends on is settled.

## UIL-052 — Collections aren't sorted by most-recently-modified, and the schema has no signal to sort by

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Fixed** — PR [#182](https://github.com/viantihu/pokemon-tcg-tracker/pull/182) MERGED to
  `develop` 2026-09-18 (squash `4c8c3cc`), QA-gated on the merged tree (703 tests, build,
  migration-order "added 0012 above 11"), confirmed **deployed** to Testing with migration
  `0012_collection_updated_at.sql` applied, and **verified by row count, not by a green run** (Tech Lead's
  before/after pair, runs `35349693892` → `35405786157`): `collection.updated_at` ABSENT → PRESENT,
  11 rows before and after, 11 not-null, 11 distinct, **0 rows where `updated_at` differs from
  `created_at`**, 0 rows with either NULL, min/max identical to `created_at`'s. That last figure is the
  ruling made measurable: the backfill is from `created_at`, not a uniform `now()` and not NULL, so the
  existing collections keep a truthful prior order instead of all jumping to the top at once. Three
  triggers (`is distinct from` guarded) bump `updated_at` on every real modification, removals included by
  her widened definition of "modified"; no trigger has fired yet because she has not touched a collection
  since deploy, which is the expected reading. `loadCollHub` now actually sorts by it. Awaiting Karvi's
  confirmation when UAT resumes: edit one collection and it should move to the top of the list.
- **Priority:** Low (Claude's read — needs Karvi's confirmation)
- **Area:** Collections
- **Env:** Testing

In her words: "Sort the collections on the 'Collections' page by most recently modified. Modified means
either a card was recently added to it through shelving/re-shelving or a placeholder was added."

**Confirmed: the sort signal doesn't exist yet.** `collection` has `created_at` but **no `updated_at`**
([`0002_domain.sql:102-111`](../supabase/migrations/0002_domain.sql:102)); `collectionRepo.list`
([`lib/repo/base.ts`](../lib/repo/base.ts)) has no `.order()`, so collections render in effectively
insertion order ([`CollHub.tsx:369-383`](<../app/(ui)/coll/CollHub.tsx>:369)).

**Suggested fix.** Her definition of "modified" maps cleanly to existing timestamps —
`placement_decision.created_at` for a shelving/reshelving into the collection's binders, and
`wishlist_item.created_at` for a placeholder (`line_slot` itself has no `created_at`, so the wishlist
row's timestamp is the clean proxy). But deriving it live means a three-table join per collection on
every load; the cheaper correct fix is to add `updated_at` to `collection` and bump it in the code paths
that shelve into its binders or add a placeholder against them.

**Priority rationale.** Low: pure ordering convenience, no data at risk, nothing broken — it's fine to
address post go-live. Flagged Low honestly, not "Low because busy."

## UIL-053 — A card can be shelved without appearing in the collection it should belong to

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** Open — **on watch, by Karvi's ruling 2026-09-19: keep it open, do not close.** Not
  reproducible on current data: her example (Magneton, moved to the Saboteur collection, not shown there
  at the time) now shows correctly, and the Tech Lead's Testing read found every shelved copy in the
  specialty binder her collections list on exactly one collection's list (27 of 27; 0 on none, 0 on two).
  She does not remember what she did in between, so stale view vs a write-path gap cannot be told apart
  from her account. **What re-opens active work:** a fresh example caught while it is still wrong, with the
  collection's target list and the copy's binder read at that moment (Tech Lead, on request).
- **Priority:** High (Karvi's own ruling, 2026-09-18, via Junior BA - 2) — mechanism narrowed by
  measurement, not identified; see the body's 2026-09-19 update
- **Area:** Collections
- **Env:** Testing

In her words: "Card was shelved but does not reflect in collection."

**Membership requires two facts:** a shelved `copy` in one of the collection's `current_binder_ids`
**and** its id on `target_catalog_card_ids` ([`actions.ts:102-124`](<../app/(ui)/coll/actions.ts>:102)).

**First round of candidates, and her answer to which one applied.** She clarified she shelved the card
**directly into the collection**, not via rebinding an existing one — which rules out candidate 1
(UIL-040's rebind orphan) and candidate 2 (a general-binder shelve with no collection tag, where
non-membership would be correct-by-design). That pointed at candidate 3: a
`{kind:"collection"}` placement-override write that moves the copy but fails to union the target id.

**Candidate 3 checked directly against source and refuted — this is not a new bug.**
`writeOverriddenCard` ([`lib/plan/commit.ts:385-412`](../lib/plan/commit.ts:385)) calls
`placementForMove(dest)` for the copy's placement **and separately** calls
`collectionTargetJoinOp(dest, p.tcgdexId)` ([`:409-410`](../lib/plan/commit.ts:409)), pushing a
`union_collection_targets` op whenever the destination is a collection. This is exactly the fix UIL-022
shipped (PR #82) — its own commit message states "TWO SITES, not one... the Plan screen's placement
override does NOT [union]... Both were missing the membership write; both are fixed," and
[`tests/line/move-into-collection.test.ts:170`](../tests/line/move-into-collection.test.ts:170) pins a
control case reproducing this exact pre-fix orphan before asserting the union happens. On current
`origin/develop`, a Plan-screen collection override does union correctly.

**So the report's mechanism is still open, not closed.** Ruling out three specific hypotheses doesn't
mean the symptom is imaginary — she saw it happen. Other paths that shelve "directly into a collection"
exist and haven't all been checked against this specific symptom: the Collections screen's own "Log a
card" flow (`logCardIntoCollection`, already flagged in UIL-048 for a different symptom — duplicate
copies — but its own JS-computed union step hasn't been checked for a staleness or ordering bug), and
Backfill's specialty commit path.

**What's actually needed now: the exact screen and button, not just "directly into the collection."**
"Directly into the collection" describes at least three different UI flows (Plan-screen override, Line
screen move-into-collection, Collections' "Log a card"), and only one of the three has been ruled out by
code. Recommend asking her which specific action she took, rather than continuing to guess from a
description that fits more than one flow.

**Update 2026-09-18: a Testing count, narrowed but not conclusive.** Membership is derived exactly as
this entry already states — a shelved copy whose `binder_id` is in the collection's
`current_binder_ids` and whose `catalog_card_id` is on `target_catalog_card_ids`
([`lib/coll/remove.ts`](../lib/coll/remove.ts)). Testing has 3 binders (1 specialty, 2 general); **all
11 of her collections list the same single specialty binder.** Of 105 shelved copies, 27 sit in that
shared specialty binder and 78 in the two general binders. Of the 27: every one is on **exactly one**
listing collection's target list — 0 on none, 0 on two or more, which refutes "in the binder but off
its list" for this population **on current data**. The 78 general-binder shelved copies are the only
population where "shelved but in no collection" is structurally true — no collection lists a general
binder at all — legitimate state or mis-set `role`, not yet answered. Adjacent counts: shelved-no-binder
0, bulk 601 (8 carry a `binder_id`, unexplained, not investigated), block 0. The per-collection
off-target figures seen earlier (22–27) are an artifact of the shared binder, not evidence of a defect
on their own.

**Her concrete report, verbatim (via Junior BA - 2, 2026-09-18): "I attempted to move Magneton to the
Saboteri collection. I now see that card in the proper collection. Maybe a different issue resolution
fixed it."** The trigger was a **Move to a collection destination**. Candidate explanation, recorded as
a hypothesis, not a finding: at the time of her report Magneton was in the shared binder but not yet on
Saboteur's target list, and later was — the current-data read above cannot distinguish that timing from
a fix landing in the interim, because it only sees the present state, not the history.

**Her follow-up, 2026-09-19: see the status line above** — keep Open, on watch, not Closed, and what
would reactivate it. Not repeating it here; recorded once to avoid the two copies drifting apart later.

**Priority rationale.** High (Karvi's own ruling, 2026-09-18) — the mechanism is still unidentified, not
just unrated; recorded here so the two fields agree with each other now that a priority has been set.

## UIL-054 — Team Rocket's Wobbuffet (SVP full-art promo) has no image because TCGdex serves none

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Closed** — Karvi 2026-09-20: "that is fine". An upstream data gap (TCGdex serves no image
  for `svp-203`) with nothing to fix in the app; a later re-sync picks the image up if TCGdex ever adds
  one. Her follow-on in the same breath, a pixelated placeholder image for any card without art in place
  of the initials fallback, is its own entry: UIL-081.
- **Priority:** Low (Karvi confirmed 2026-09-20)
- **Area:** Catalog
- **Env:** Testing

In her words: "Team Rocket's Wobbuffet does not have an image. It is a full art promo card from Scarlett
and Violet."

**Confirmed: an upstream data gap, not a mirror or display bug.** The card is `svp-203` (SVP Black Star
Promos). Its `/v2/en/cards/svp-203` payload has **no `image` field at all** (verified live; every other
key present). `toCatalogRow` ([`lib/catalog/mirror.ts`](../lib/catalog/mirror.ts)) sets
`image_url: card.image ?? null` verbatim, so the row stores `null` and `CardFace` correctly falls back
to initials — the same fallback UIL-016 describes. The set is not one of UIL-004's six empty sets; `svp`
serves 225 cards, this specific row is just imageless upstream.

**Suggested fix.** Nothing in our code is wrong. Options: a re-sync may pick up an image if TCGdex adds
one later (idempotent, cheap), or add a per-row fallback image source for known-imageless promos. Neither
is urgent.

**Priority rationale.** Low: one card's thumbnail falls back to text, the card is otherwise fully
functional, and the cause is external data rather than a defect in the app. Fine post go-live.

## UIL-055 — There is no way to browse a binder's actual cards, and the binder card's capacity stats read awkwardly

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Fixed** — PR [#159](https://github.com/viantihu/pokemon-tcg-tracker/pull/159) MERGED to
  `develop` 2026-09-18 (squash `5f0715e`), QA-gated on the merged tree (QA's hold on the unpaged
  whole-collection read was resolved before merge), confirmed **deployed** to Testing (Deploy green on
  `04dea51`, which contains it). Capacity now renders **one card per binder** with front and back as
  labelled sections inside it, not a card per half; clicking a binder expands an **image-first grid of every
  card shelved there** (collapsed by default, mounts nothing until opened — UIL-034's fold discipline, and
  the visual-search principle from card lookup); the capacity stats read as horizontal `label … value` rows.
  Two things for her pass specifically: the stat orientation is the dev's reading of "fix the orientation",
  not a layout she specified, and the UI was verified by reading the component, not in a browser — so her
  look is the visual check. Awaiting Karvi's confirmation when UAT resumes.
- **Priority:** Medium (Claude's read — needs Karvi's confirmation)
- **Area:** Binders
- **Env:** Testing

In her words: "I should be able to see a list with icons (in a grid format) [of] all the cards in a
binder when I click on it. Additionally, front and back halves need not be treated like separate binders
in this view. Lastly, fix the orientation of the capacity details in each binder's box."

**Three sub-asks, all confirmed against current state:**

1. **No binder-browse view exists.** [`app/(ui)/binders/CapacityScreen.tsx`](<../app/(ui)/binders/CapacityScreen.tsx>)
   is a numeric capacity review only — five stats per section, no card thumbnails, nothing clickable to
   drill in. This is a new screen. The data exists (`copyRepo.listShelved` filtered to one binder) and
   the `CardFace` grid primitive (`cgrid`/`ccard`, already used by CollHub's finite-set grid) drops
   straight in — aligns with the visual-search design principle already on record.
2. **Front/back are split in this view today** — the `binder_section` view emits `half='front'`/`'back'`
   as separate rows and `CapacityScreen` renders each as its own card. A browse view should union them
   and present the binder as one thing (the `binder_half` field stays for pocket classification under the
   hood; the browse UI just shouldn't expose it as two binders).
3. **Capacity-stat orientation:** the stats render value-above-label at 17px/8px in a cramped 5-column
   grid ([`CapacityScreen.tsx:120-127`](<../app/(ui)/binders/CapacityScreen.tsx>:120),
   [`globals.css:2237-2259`](../app/globals.css:2237)). Likely fix is a standard label-then-value KPI
   orientation or a horizontal `Label: value` row.

**Priority rationale.** Medium: the browse view is a real feature gap on a core surface and directly
serves the visual-hobby principle, but nothing is broken — she can see counts today, just not the cards.
The orientation fix is cosmetic and could ship separately as Low.

## UIL-056 — Evolution lines can't be created manually, so Basics and non-viable lines strand with no recovery

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet — two reports, one root cause)
- **Status:** **Fixed** — PR [#120](https://github.com/viantihu/pokemon-tcg-tracker/pull/120) MERGED to
  `develop` 2026-09-16 (squash `79eb187`), QA-gated on the merged tree, confirmed **deployed** to Testing
  (all four conditions green). Shipped: a back-half move now resolves a line — join an existing line's open
  slot (candidates listed with band and filled/total so two lines for one species are distinguishable) or
  **start a new line**, which builds the family's slots from the chain walk; a "NOT IN A LINE YET" section
  on the Lines page lists shelved line-less cards, **without which the fix would have been correct but
  unreachable** for an already-stranded Basic. Done as an additive optional `lineJoin` on the `shelf`
  destination rather than a new `MoveDestination` variant, so the Plan and Collections paths are untouched.
  Two real defects were found while building it and are fixed here: the existing-line check compared the
  moved card's own dexId instead of the chain's root (which could have created a second colliding line —
  the `(root_dex_id, color_band)` pair has an index, not a unique constraint, so nothing downstream would
  have caught it), and "start a new line" ignored the band she picked in favour of the card's natural type
  band. A third, found by QA and fixed on the same head: the back-half-needs-a-line rule was enforced only
  in the panel's Confirm button, so `applyMove` itself now checks it — an existing test was silently
  reproducing the very strand this entry describes. On the Plan spotlight and Collections, where the line
  picker is not offered, the panel now defaults to the front half and says "Back-half moves choose a line.
  Do this from the Lines page" rather than presenting a destination it can never confirm. **Not fixed here,
  by decision:** line-join from the Plan spotlight (owed with UIL-061), pulling other owned family members
  into a newly started line, and the picker on an already-lined card's move. **Test debt recorded rather
  than logged as entries:** the destination-band override inside slot generation IS pinned (`tests/line/manual-line-join.test.ts`, PR #146) and the unlined-cards filter is now pinned too (PR #287, 2026-09-20, which found and closed two real gaps: the shelved-role check and the Trainer/Energy guard each survived the suite until then), and "start a new line" reads the catalog uncached
  (~24 pages) where the plan path uses the cache — a rare manual action, not a blocker. Awaiting Karvi's
  confirmation.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Plan, Lines
- **Env:** Testing

Two of her reports are the same underlying gap:

- "None of the cards were ever placed in a line. The Magnemite was not shelved in the back half of the
  binder — and I cannot move it now. The Magnezone was added to a collection in a Specialty binder, so it
  should not be in a line at all."
- "There are lines that are missing. I tried creating one with Ponyta and Rapidash but they cannot be
  found on the 'lines' page. A UX tip: if a basic card is being moved to the back half of the binder, the
  user must pick which card it is entering a line with."

**Root cause: a line is only ever created as a side effect of the cascade, and there is no manual path.**
A line row is inserted only when an incoming Stage 1/2 card fires the cascade's "line-new" step
([`cascade.ts:249-303`](../lib/engine/cascade.ts:249)) and passes viability (`>= 2` same-colour chain
members, [`lib/engine/line.ts:114-133`](../lib/engine/line.ts:114)). A Basic never triggers line
creation itself. So:

- **Magnemite** (Basic) can't create a line, and **Magnezone** was collection-claimed (STEP 1 beats the
  line steps), so no Stage 1/2 ever fired line-new — no `evolution_line` row exists. Magnezone going to
  the specialty binder and *not* a line is actually correct (collection claim wins); her "should not be
  in a line" instinct matches what the code does, so that part may be a display confusion worth checking.
- **Ponyta/Rapidash**: only Rapidash (Stage 1) could trigger line-new, and only if viability was `>= 2`
  at commit time (both owned, same band). If not, it took the "line-nonviable" fallthrough to the front
  half and no line was created. `/lines` ([`lib/line/load.ts:76`](../lib/line/load.ts:76)) lists
  `evolution_line` rows; no row, no tab.
- **"Cannot move it now"**: the Line screen only exposes Move on cards already in a filled slot
  ([`lib/line/view.ts:67`](../lib/line/view.ts:67)), and `placementForMove.shelf`
  ([`lib/line/move.ts:53-60`](../lib/line/move.ts:53)) always sets `line_slot_id: null` — so a Basic in
  the front half is invisible on `/lines` and the move path can't attach it to a line even in principle.

**Her UX suggestion is diagnosing the real fix.** There is no surface anywhere to create a line manually
(`insert_line` appears only in the cascade and one-shot backfill), and moving a Basic to the back half
silently strands it. A "start a line / pick which line this card joins" flow is the missing capability.

**Priority rationale.** High: evolution lines are a core organizing feature, cards are stranding in the
front half with no way to place them into a line and no way to move them afterward, and she hit it on two
separate species. Not a cosmetic gap — a reachable dead end on core functionality.

**Cross-reference UIL-061.** #120's own "Deliberately left out" section names two gaps this fix doesn't
close: Plan-spotlight/Collections override support for the line-join it adds, and pulling other owned
copies of the same family into a newly-started line as a side effect. UIL-061 is the second of those,
found independently from Karvi's own report rather than from this list — the two should be read together
so a future session doesn't log the same gap a third time.

## UIL-057 — The line-decision screen shows wishlist alternatives but won't let her pick one

- **Reported:** 2026-09-14 (Karvi, UAT spreadsheet)
- **Status:** **Fixed** — PR [#146](https://github.com/viantihu/pokemon-tcg-tracker/pull/146) MERGED to
  `develop` 2026-09-16 (squash `a108854`), QA-gated on the merged tree with four mutations verified,
  confirmed **deployed** to Testing (all four conditions green on that SHA). The wishlist alternates are
  now selectable and the chosen catalog id is threaded through `DecisionCard` → `onChoose` →
  `resolveDecisionAction` → `applyDecision` → `resolveDecisionWrites` → `wishlistUpsertFor`, replacing the
  always-cheapest server pick. The id is **validated against the decision's own freshly-derived option
  set** before it is trusted, so a stale id from the browser falls back to the default rather than being
  written. Known test gap, recorded rather than logged: `applyDecision`'s pass-through of the pick has no
  test of its own (dropping it leaves 606/606 green), so a broken wire there would silently revert to
  always-cheapest; correct by reading, handed to the dev to pin. No browser verification — the Line screen
  is behind auth and that session had no Supabase credentials. Awaiting Karvi's confirmation.
- **Priority:** Medium (Claude's read — needs Karvi's confirmation)
- **Area:** Lines
- **Env:** Testing

In her words: "I'm not able to make an alternative wishlist choice when trying to make a decision for a
line."

**Confirmed: the alternative-picking UI is missing entirely, not broken.** The line-decision card renders
`d.wishlist.map(...)` as `wcard` elements with the first marked `on`, but **none has an `onClick`** —
they're decorative evidence, not selectable. The `onChoose` callback accepts only a fixed
`DecisionChoiceId` union (`"confirm-cap" | "cap-no-wishlist" | …`), none of which carries a chosen
catalog id, and `resolveDecisionWrites` reuses the server-computed cheapest option
(`res.chosenCatalogCardId`) regardless. So she can accept the default wishlist choice but cannot pick a
different one.

**Suggested fix.** Make the `wcard` alternatives selectable and thread the chosen catalog id through
`onChoose` → `resolveDecisionWrites` → `wishlistUpsertFor`, rather than always using the first
`altOptions` entry.

**Priority rationale.** Medium: a genuine gap in the decision UI on a core screen, but she can still
resolve the decision with the default rather than being fully blocked — so it's a real limitation, not a
dead end.

## UIL-058 — The pinned progress bar (UIL-019's fix) now overlaps the spotlight panel on desktop

- **Reported:** 2026-09-14 (Karvi, retesting UIL-019's fix, PR #109)
- **Status:** **Closed** — PR [#134](https://github.com/viantihu/pokemon-tcg-tracker/pull/134) MERGED to
  `develop` 2026-09-15 (squash `6776da3`), QA-gated, confirmed **deployed** to Testing (all four
  conditions green). One rule: `.spot` now offsets by the haul bar's published height
  (`top: calc(var(--haulbar-h, 0px) + 14px)`, `z-index: 4`, between `.bandhead` and `.haulbar`).
  Verified by browser measurement at 1440 / 1000 / 375 px with a revert check — 52 px of the spotlight
  cap hidden before, 0 after; inert in the two narrower layouts. No unit test is possible for a computed
  offset. **Confirmed resolved by Karvi on Testing 2026-09-16.** Related product question still open with
  her, deliberately not changed here: at ≤720 px the spotlight stacks **above** the pinned bar, so the
  progress counter is hidden on a phone — it becomes its own entry only if she wants the counter there.
- **Priority:** Medium (Claude's read — needs Karvi's confirmation)
- **Area:** Plan
- **Env:** Testing

In her words (via the second Junior BA): the progress bar now sticks as intended, but it covers the
top of the suggestion/spotlight box. The pin itself works — this is a new, distinct problem, not
UIL-019's original bug recurring.

**Root cause: two sticky elements sharing one scroll container, only one of which was taught about the
other's height.** `.haulbar` ([`globals.css:2733-2739`](../app/globals.css:2733), UIL-019's fix) is
`position: sticky; top: 0; z-index: 6`, and `PlanScreen.tsx` publishes its real rendered height as
`--haulbar-h` onto `document.documentElement` via a `ResizeObserver`
([`PlanScreen.tsx:772-799`](<../app/(ui)/plan/PlanScreen.tsx>:772)) specifically so other sticky elements
can offset around it. But that variable has exactly **one** consumer today —
[`.bandgroup .bandhead`](../app/globals.css:2740) (`top: var(--haulbar-h, 0px)`), the worklist column's
fold headers. `.spot` (the "NOW HANDLING" panel, [`globals.css:498-503`](../app/globals.css:498)) is
separately `position: sticky; top: 14px` — a **hardcoded** value, no `z-index` at all (defaults to
`auto`), and no reference to `--haulbar-h`. Both are siblings inside the same scroll container
(confirmed: `PlanScreen.tsx`'s own comment states "the document body is the scroll container on this
screen"), so on scroll `.haulbar` pins at `top: 0` and extends well past 14px (its real height, from
padding and wrapped flex content), while `.spot` pins at `top: 14px` — landing inside the vertical space
`.haulbar` occupies. `.haulbar`'s explicit `z-index: 6` beats `.spot`'s default `auto`, so `.haulbar`
paints over it.

**Confirmed specific to the desktop two-column layout.** At `≤1080px`
([`globals.css:1553-1555`](../app/globals.css:1553)) `.spot` becomes `position: static` — the bug can't
occur there. At `≤720px` ([`globals.css:1578-1585`](../app/globals.css:1578)) `.spot` gets its own
sticky context and is reordered first — a different stacking arrangement, not this bug. The overlap she
saw is specific to `>1080px`, the same layout UIL-019's own original bug was invisible at (that one was
mobile-only; this one is desktop-only — mirror images of the same class of "only checked one breakpoint"
gap).

**Suggested fix.** Give `.spot` `top: var(--haulbar-h, 14px)`, the same pattern already used for
`.bandhead` — the missing piece is the offset, not the z-index. `.haulbar`'s `z-index: 6` doesn't need
to change once `.spot` no longer sits inside its footprint.

**Note for whoever tracks UIL-019's status:** the original defect (the bar not staying pinned) is fixed
— this is a new, distinct symptom introduced by that fix touching only `.haulbar`/`.bandhead` and never
`.spot`. Whether that means UIL-019 stays Closed with this as its own entry, or gets reopened, is a
status call; logging this as its own entry either way so the report isn't lost in the meantime.

**Priority rationale.** Medium: nothing is broken functionally — she can still read the spotlight card's
information, just with the top of it visually covered — but it's a real regression-shaped issue on the
core daily screen, on desktop, right after a fix that was supposed to make that screen better.

## UIL-059 — Collections always reopen fully folded, even right after she expanded one

- **Reported:** 2026-09-14 (Karvi, retesting UIL-034's fix, PR #106)
- **Status:** **Fixed** — PR [#172](https://github.com/viantihu/pokemon-tcg-tracker/pull/172) MERGED to
  `develop` 2026-09-18 (squash `4f033e1`), QA-gated on the merged tree, confirmed **deployed** to Testing
  (Deploy and Vercel both green on `f1b788f`, which contains it). UIL-034's fold state was a plain
  `useState`, so every fresh load of Collections re-folded everything, including the one she had just
  opened. The collapsed set is now restored from **`localStorage`** on mount and written back on every
  change (same key convention and storage try/catch as the Haul Plan's resume) — `localStorage`, not
  `sessionStorage`, per the Senior BA's ruling and confirmed in the merged code by QA, so the state survives
  closing the tab, not just navigating away. Persisting the **collapsed** set rather than the expanded one
  keeps "a brand-new collection opens expanded" for free. Two files, exercised through the real
  `CollectionsView` against stubbed storage; removing the restore call fails the two "not everything folds"
  tests; 750 tests on the merged tree. Awaiting Karvi's confirmation when UAT resumes: expand a collection,
  leave and come back (or close and reopen the tab), it should still be open.
- **Priority:** Low (Claude's read — needs Karvi's confirmation)
- **Area:** Collections
- **Env:** Testing

In her words: "If the user left the collections page expanded, it must stay expanded. It shouldn't
default to collapsed."

**Confirmed: this is documented, deliberate behavior, not a bug in UIL-034's fix — it's a gap the fix
itself named and left for later.** `CollHub.tsx`'s own comment
([`:314-317`](<../app/(ui)/coll/CollHub.tsx>:314)) states it plainly: "Not persisted across visits —
this page has no resume concept to persist into." Every collection defaults to folded on mount
(`() => new Set(data.collections.map((c) => c.id))`), unconditionally, on every visit — expanding one
and navigating away and back re-collapses it.

**Why the Haul Plan's equivalent (UIL-018) doesn't have this problem, and why Collections can't just
copy it wholesale.** `PlanScreen.tsx`'s `collapsed` set rides inside the sessionStorage-backed resume
payload UIL-006 built (`resumed?.collapsed`, [`:187`](<../app/(ui)/plan/PlanScreen.tsx>:187), saved
alongside the draft/plan/cursor at [`:217`](<../app/(ui)/plan/PlanScreen.tsx>:217)) — it persists because
it's one field in a mechanism that already existed for a different reason (resuming an in-progress
haul). Collections has no such mechanism at all; there's nothing existing to piggyback on.

**Suggested fix.** A small, Collections-specific persistence — a single sessionStorage key storing the
set of collapsed collection ids, read on mount and written on toggle. Doesn't need UIL-006's full
resume-and-invalidate machinery (there's no computed plan to go stale here, just a UI preference), so
this is simpler than what Plan has, not a port of it.

**Priority rationale.** Low: nothing is broken and no data is at risk — the all-folded default is a
reasonable choice for a 200-300-card browse surface, just not sticky the way she wants. A UI-state
convenience, not a defect.

## UIL-060 — Let her create a stand-in catalog record for a card the external database doesn't have yet, and swap it for the real one once it arrives

- **Reported:** 2026-09-14 (Karvi, retesting Sync)
- **Status:** **Fixed** — Half 1 complete, both parts deployed; Karvi's go-live blocker is closed as she
  defined it ("a manual override is necessary"). **Part 2, the form:** PR
  [#275](https://github.com/viantihu/pokemon-tcg-tracker/pull/275) MERGED to `develop` 2026-09-20 (squash
  `601cc7a`), QA-gated on the merged tree (1014 tests, build; 5 DOM click-path cases and 4 PGlite action
  cases), confirmed **deployed** to Testing (Deploy, migrate, smoke, acceptance and Vercel green on
  `601cc7a`). Under the Sync match overlay's search grid, "Not in the catalog? Create a stand-in and match
  to it", prefilled from the entry (name, set name, number; set id derived server-side and kept only when
  the mirror holds that set), one required choice of kind (Pokémon with type, stage and optional Pokédex
  number, Trainer, Energy), one RPC via `manualMatchStandIn`, a twin refused in place with "Match to the
  existing stand-in instead", success toast "Created a stand-in and matched — ready to place." **Step for
  Karvi when UAT resumes:** Sync, a "Needs your match" or "Waiting on catalog" row, Match manually, open the
  disclosure, pick a kind, Create; the row leaves the queue and the card appears in the Haul Plan as bulk.
  The Tech Lead's next read should then show `source = user` 1 and catalog_card 23,549. **Half 2** (detect
  the real record and swap the stand-in for it, repointing the seven referencing sites in one transaction)
  remains the named follow-on; nothing in Half 1 forecloses it. **Part 1**, migration `0015` and the
  write path: PR [#272](https://github.com/viantihu/pokemon-tcg-tracker/pull/272) MERGED to `develop`
  2026-09-20 (squash `ecf34b6`), QA-gated (1005 tests; 0015's function is 0014's text plus the 31-line
  `insert_catalog_stand_in` branch; stamping a stand-in 'tcgdex' fails 4 tests on the check constraint;
  dropping the stand-in op from the payload fails 4), **deployed** (migrate applied 15 of 15; Tech Lead's
  before/after read, runs 35478490060 → 35478598086: `catalog_card.source` absent → present
  23,548/23,548, all 'tcgdex', zero 'user', every other count identical). Design as approved: stand-in ids
  are `user:<uuid>` and a check ties that shape to `source = 'user'` both ways; insert/update RLS scoped to
  `source = 'user'`, no delete; `manualMatchStandIn` emits the stand-in as the first op of the same RPC as
  the match, so create-and-match is one transaction; a twin (same name, set name and number) is refused
  with the existing stand-in offered; the required card kind (Pokémon with type and stage, Trainer,
  Energy) exists because a bare row bands White. The mirror's resume count now filters `source=eq.tcgdex`
  so a stand-in never makes a set look complete early. The check constraint becomes observable on
  Karvi's first stand-in (expect `source = user` 1, catalog_card 23,549). **Part 2**, the form under the
  Sync MatchOverlay's search grid, is on `feat/uil-060-stand-in-form`. Half 2 (swap for the real record
  when it arrives) remains a follow-on.
- **Priority:** High (Karvi's own ruling, 2026-09-20: a go-live blocker — "the catalog and the match are
  not always correct, so a manual override is necessary for users to accurately maintain their
  collection"). Was Medium, Claude's read.
- **Area:** Sync, Catalog
- **Env:** Testing

In her words: "I realized when this happens, it is most likely happening because the catalog being
pulled externally does not have a record. In this situation, I want to introduce the ability to create
a record for that card in the catalog... When the external database receives a record upon sync, I want
the user generated card to be replaced by the matching one from the external."

**Her diagnosis is right, and the screenshot's own examples confirm it.** Two of the six
"waiting on catalog" rows — Floragato (Starter Set ex Deck Sprigatito & Meowscarada ex) and Purrloin
(Starter Set ex Deck Zorua & Zoroark ex) — are Japan's "MEGA Starter Set ex" decks, released
2026-07-31 (~6 weeks old). Checked live against TCGdex's `ja` set list: no matching set exists there
yet, though TCGdex does carry other, older JP starter decks — a coverage/timing lag on a recent release,
not a categorical gap. Likely the same underlying cause as UIL-047 (the mirror's English-only scope),
made visible here as a second, distinct symptom: a card TCGdex simply hasn't caught up to yet, regardless
of locale.

**Two genuinely separate halves, and the second is substantially larger than the first.**

**Half 1 — create a stand-in record.** Confirmed there is no write path to `catalog_card` outside the
mirror today: `catalogCardRepo` exposes `upsert`/`upsertMany` (used only by
[`lib/catalog/mirror.ts`](../lib/catalog/mirror.ts)) and read-only finders;
`manualMatch` ([`lib/sync/exec.ts:423-430`](../lib/sync/exec.ts:423)) only looks up an **existing** row
and throws if there isn't one. A generic `insert` exists on the base repo but is never called for this
table. Buildable: a form that writes a minimal `catalog_card` row from what the Dex export already
carries (name, set name, collector number), keyed on some non-TCGdex id scheme (`tcgdex_id` is
documented as "stored EXACTLY as TCGdex returns," so a stand-in needs its own distinguishable id shape).

**Half 2 — detect the real record and swap it in.** This is the expensive part, on two counts:

1. **No provenance flag exists.** `catalog_card` has no `source`/`is_user_generated` column — every row
   is currently assumed TCGdex-sourced. Needs a new column (migration) just to know which rows are
   stand-ins.
2. **Seven reference sites would need atomic repointing on a swap**, none of them `ON UPDATE CASCADE`:
   `presence_group.catalog_card_id`, `copy.catalog_card_id`, `line_slot.target_catalog_card_id`,
   `wishlist_item.chosen_catalog_card_id`, `unresolved_entry.manual_match_id` (all real FKs, verified in
   [`0002_domain.sql`](../supabase/migrations/0002_domain.sql)), plus two **unconstrained** array
   columns that also carry the id with no FK at all — `collection.target_catalog_card_ids` and
   `wishlist_item.alternate_catalog_card_ids`. A swap has to update every one of these in one
   transaction or a card can end up owned under one id and wishlisted under another.
3. **No existing signal to hook the detection into.** The mirror workflow only reports aggregate
   fetched/upserted counts per set, not per-card "this id is new." Matching a stand-in to its eventual
   real record would need to be built from scratch — plausibly a name/set/collector-number heuristic,
   since the stand-in has no real `tcgdex_id` to match against directly.

**Suggested scope, not a full design:** ship Half 1 alone first — a stand-in record with a `source`
column lets her place the card immediately, which is most of the value — and treat Half 2 (automatic
detection-and-swap) as its own follow-on, since it's a genuinely different-sized piece of work with a
schema change and a new matching heuristic, not an extension of Half 1's plumbing.

**Priority rationale.** Medium: a real, recurring friction point (any card the mirror hasn't caught up
to is currently a dead end beyond Dismiss), but `Match Manually`/`Dismiss` already exist as a working,
if less smooth, path — nothing is blocked, and the more valuable half of the fix (Half 1) is
comparatively cheap while the complete feature (both halves) is not.

**Cross-reference UIL-047.** Confirmed live on Testing (run `34977540936`): two of UIL-047's WAITING
entries resolve to a real set (via a learned alias) but still miss at the card level — TCGdex simply
doesn't carry that card. That's this entry's exact case, not a separate mechanism; a fix here would also
give those two rows a path forward.

## UIL-061 — Creating a new line can silently relocate other already-owned cards, with no confirmation and no audit trail, and there is no way to choose the line yourself

- **Reported:** 2026-09-14
- **Status:** **Fixed** — PR [#145](https://github.com/viantihu/pokemon-tcg-tracker/pull/145) MERGED to
  `develop` 2026-09-16 (squash `77fb23f`), QA-gated on the merged tree with independent revert checks
  (consent gate dropped → 4 tests fail; slot release deleted → exactly 1 fails, no overlap), confirmed
  **deployed** to Testing (all four conditions green on that SHA). Starting a new line now moves **nothing
  she has not ticked**: each owned copy the line could pull is disclosed with its current location and
  defaults to unticked, every confirmed pull gets its own `placement_decision` so "why did this card move"
  is answerable, and a confirmed pull out of another line's slot releases that slot in the same
  transaction. An unticked stage stays a placeholder and deliberately gets **no wishlist row** — she owns
  that card, so listing it as something to acquire would be wrong. The trace widened this entry's own
  claim: `ownedAt` matched species + band with **no role filter** and the writer never read `pullFrom`, so
  bulk, binder blocks, specialty binders and other lines' slots were all in scope, not only front-half
  shelved copies. The consent block sits under the destination block it qualifies rather than below the
  reason, because at 375×812 the first version put it 55% down an 808px scroll area — she would have had to
  scroll past the consent gate to reach Done. **This does NOT fix the five stale slots measured on
  Testing** (that is UIL-062's `writeOverriddenCard` gap); the dev rewrote its own commit message to drop
  that claim when the measurement landed mid-build. Awaiting Karvi's confirmation.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Plan, Lines
- **Env:** Testing

In her words: "When I 'create a new line' in the haul plan, it automatically take the cards from that
haul into that line without confirming. You cannot infer that a card will go somewhere and just put it
there. In a haul, the user must validate each and every single line. Additionally, there must be an
option to add to the back of the binder and either start a new line or add to an existing. If add to
existing is selected, the user must choose a compatible line from a list."

**Confirmed, and worse than described: it isn't only that the pull is unconfirmed — it's untracked.**

**Mechanism.** `generateSlots` ([`lib/engine/line.ts`](../lib/engine/line.ts)) fills every stage of a
new line from `ctx.owned` — every copy in her whole collection, not scoped to the haul
([`lib/plan/context.ts:104-107`](../lib/plan/context.ts:104), `copyRepo.listAll(db)`), matching by
species and colour band (`ownedAt`, [`line.ts:116`](../lib/engine/line.ts:116)). If a matching chain
member is already shelved in a general binder's front half, it's flagged to be **pulled** into the new
line's back-half slot. `writeNewLine` ([`lib/plan/commit.ts:556-566`](../lib/plan/commit.ts:556)) writes
that pulled copy's placement change into the **same** op set as the card she clicked Done on — one
transaction, one "Done" click, and an unbounded number of already-shelved cards can move as a side
effect.

**No audit row for the pulled cards — this is the sharper problem.** `buildHaulCommitPayload`'s loop
writes exactly one `insert_decision` per incoming draft card. The pulled copies get no
`placement_decision` row at all. So not only is there no confirmation before the move — there is no
record afterward that it happened. If she later asks "why is this Charmander in the back half, I didn't
put it there," nothing in the app can answer that.

**No choice between "start a new line" and "add to an existing line" exists anywhere.**
`existingLineSlot` ([`cascade.ts:168`](../lib/engine/cascade.ts:168)) checks for exactly one candidate
line; if found, "line-existing" fires, otherwise "line-new" — the engine decides unilaterally, considers
only the first match, and there is no concept of multiple "compatible lines" to select among. The
generic "↔ Change position" button opens a free-form destination picker (`MoveOverlay`) — any
binder/half/band/bulk/specialty — not a line-specific chooser, and it's identical for every card type,
not a targeted "pick which line" flow.

**"Done" discloses only the incoming card, never the pull.** The spotlight text for a new line
([`lib/plan/assemble.ts:91-95`](../lib/plan/assemble.ts:91)) — `"Starts a new {band} line for
{name} ({N} same-colour cards so far) — goes to the back half"` — names a count, never the specific
already-shelved cards about to be relocated. She confirms one card's destination and the write silently
does more than that sentence describes.

**Cross-reference UIL-056.** #120 (UIL-056's fix) explicitly lists "pulling other owned copies of the
same family into a newly-started line" among what it deliberately leaves out — this entry is that exact
gap, confirmed independently from Karvi's own report. Its fix should land alongside #120's line-join
work (same `MovePanel` line picker, same author), not as a separate effort.

**Suggested fix, in order of how directly each maps to her ask:**

1. Surface the pull explicitly before commit — name which other card(s) are about to move and require
   confirming that too, not just the incoming card. This is the "validate each and every line" half of
   her request.
2. Write a `placement_decision` for a pulled copy the same way the incoming card gets one, so a move
   like this is traceable after the fact regardless of whether #1 ships first.
3. When a card could go to the back half, offer an explicit choice — start a new line, or add to an
   existing one from a list of compatible lines — rather than the cascade deciding silently. This is a
   real UI addition, not a wiring job: no "list compatible lines" concept exists anywhere today.

**Priority rationale.** High: this is the silent-wrong-data class the log has repeatedly treated as High
(UIL-014, UIL-022, UIL-040, UIL-048) — a normal action relocates inventory she didn't ask to move, with
zero confirmation and, unlike those other entries, zero audit trail to even discover it happened.
Flagging for her confirmation since severity calls are hers.

**Correction 2026-09-15 (verified against `6776da3`): the blast radius is wider than "shelved,
general-binder, front-half copies."** `ownedAt` ([`lib/engine/line.ts:116`](../lib/engine/line.ts:116))
matches a candidate on species and colour band only —
`o.card.dexId.includes(node.dexId) && band(o.card, map) === b` — with no filter on `role` or on
whether the copy is already sitting in a line. `ctx.owned` itself is the full unfiltered collection
([`lib/plan/context.ts:104`](../lib/plan/context.ts:104) → `cascade.ts:321-323` pass it straight into
`testViability`/`generateSlots`). So the pull candidate can be a `bulk`-role copy, a `block`-role copy,
a copy shelved in a *specialty* binder (specialty placements carry `binder_half: null`, not `"front"`,
per [`commit.ts:196`](../lib/plan/commit.ts:196)), or a copy currently filling **another line's own
slot** — not only a general-binder front-half shelved copy.

`generateSlots` tags a `pullFrom` ([`line.ts:293`](../lib/engine/line.ts:293)) only when
`binderHalf === "front" && role === "shelved"` — true for the general-binder case this entry
describes, false for all four cases above. That tag turns out to be cosmetic either way: `writeNewLine`
([`lib/plan/commit.ts:557-568`](../lib/plan/commit.ts:557)) fires its relocation on the bare truthiness
of the slot's `copyId` and never reads `pullFrom` — the field has no reference anywhere in `commit.ts`.
Every one of the four wider-blast-radius cases gets relocated exactly like the front-half-shelved case
the entry already flags.

**New consequence specific to the "another line's own slot" case:** the `update_copy` op
(`commit.ts:558-568`) overwrites the copy's `line_slot_id` to point at the new line's slot, but nothing
in `writeNewLine` patches the *old* slot it vacated. That old slot's row is left `state: "filled"`,
`copy_id` still pointing at a copy that has since moved — an orphaned slot, invisible in the UI. A
count of any such orphans already on Testing is being pulled separately; a nonzero count gets its own
entry rather than folding into this one.

**Approved fix direction, layered onto the "Suggested fix" list above:** confirmation at the write
layer via a `PlannedCard.confirmedPulls` set that defaults to moving nothing; one `placement_decision`
per confirmed pull (closes suggestion #2 regardless of source); and a confirmed pull sourced from
another line's slot must release that slot (an `update_slot` back to open) in the same apply, so the
orphan case above can't recur once this ships. Historical orphan repair stays out of this entry's
scope.

## UIL-062 — Existing evolution-line slots on Testing are marked filled while the copy they point to has already moved elsewhere

- **Reported:** 2026-09-15 (not from Karvi — measured on Testing by the tech lead via the
  `ops/read-band-config` diagnostic branch, relayed by the Senior BA)
- **Status:** **Fixed** — PR [#151](https://github.com/viantihu/pokemon-tcg-tracker/pull/151) MERGED to
  `develop` 2026-09-16 (squash `26b6971`), QA-gated with every mutation reproduced, confirmed **deployed**
  to Testing, and — the part that matters — **verified by row count rather than by a green run**
  (diagnostic run `35175445323`): filled slots whose copy no longer points back went **5 → 0**, `copy`
  stayed byte-identical at 706 and `presence_group` at 681, and the slot arithmetic reconciles exactly
  (22 − 5 released + 2 newly filled = 19 filled; 6 + 5 + 1 = 12 placeholder), so precisely **5** slots were
  released and the migration's effect is separable from her ongoing placing. Prevention: `writeOverriddenCard`
  now releases the slot it leaves through a shared `releaseSlotOps`, and `filledExistingSlot`'s unresolvable
  case throws instead of committing a placement with neither pointer set — one transaction, so zero rows and
  a clean retry beat a silent half-write. Repair migration `0010` clears only a filled slot whose copy no
  longer points back, never writes a pointer onto a copy, and is idempotent because its predicate excludes
  its own output. **The 8 shelved back-half copies with a null pointer were deliberately left untouched**
  and measured still 8 — a test pins that, because none had an intended placeholder at the time and a
  migration guessing a slot would be inventing her placement decisions. Note for anyone reading the
  numbers: `placement_decision` 71 → 105 across this window is **entirely her own placement work**;
  `0010` writes no decisions. Follow-ups tracked, not folded in: a fourth release path routed through the
  shared emitter (PR #158), and a possible relink of 5 of the 8 now that releasing their slots re-exposed
  each slot's original target — held pending a pairing-cardinality measurement, since "a slot wants this
  card" is an existence claim and a safe relink needs a **uniqueness** claim. Awaiting Karvi's confirmation.
- **Priority:** High (Senior BA's read — the record disagreeing with the physical shelf is the app's
  core failure class; Karvi to confirm)
- **Area:** Lines, Plan
- **Env:** Testing

**Measured on Testing, 2026-09-15 ~03:50, against all rows created since the last Testing clear (so
this is live-path drift, not leftover residue):**

```
evolution_line:              9
line_slot:                   24  (filled 18 · placeholder 5 · block 1)
copies currently claiming a slot (copy.line_slot_id set): 13
filled slots whose copy has moved away (slot.copy_id set,
  but that copy's line_slot_id no longer points back at it): 5
filled slots with null copy_id:                             0
copies pointing at a slot that isn't holding them:          0
```

Five filled slots are stale. Two sub-shapes aren't separated yet — copy left the slot for no line at
all (`line_slot_id` now `NULL`) versus copy moved to a different line's slot — the tech lead is running
that split next.

**What she'd see:** on the Lines page, a slot looks occupied — card art, "filled" — while the actual
card is shelved somewhere else or built into a different line. The record and the shelf disagree, and
nothing on screen says so.

**One confirmed cause, one path checked and cleared, one path still open.** *(Superseded — see the
2026-09-17 updates below. Item 1's "confirmed cause" label does not survive the later measurement:
UIL-061's pull is CLEARED, not a cause, for all 5 rows. Left as-is for the record of what was believed
at the time.)*

1. **Confirmed cause: UIL-061's new-line pull.** `writeNewLine`
   ([`lib/plan/commit.ts:557-568`](../lib/plan/commit.ts:557)) overwrites a pulled copy's
   `line_slot_id` to point at the new line's slot without ever patching the slot it vacated — see
   UIL-061's 2026-09-15 correction for the full mechanism. This alone explains any stale slot whose
   copy moved because a new line was started that happened to claim it.
2. **Checked and cleared: `buildMoveOps`'s own release logic is symmetric.** The "move a card off a
   line" write path ([`lib/line/move.ts:190-213`](../lib/line/move.ts:190)) does reopen the slot it
   vacates — `if (plan.reopenSlotId)` pushes an `update_slot` back to `placeholder`/`copy_id: null` in
   the same op set, exactly matching its own doc comment ("removal symmetry, sync-arch §1.6"). This is
   not the second leak.
3. **Still open: how `reopenSlotId` itself gets resolved before a move is built.** Both call sites that
   populate a `MovePlan`/collection-removal plan derive `reopenSlotId` from a slot lookup done ahead of
   the actual write ([`lib/line/write.ts:73-92`](../lib/line/write.ts:73),
   [`lib/coll/remove.ts:250-262`](../lib/coll/remove.ts:250)) — if that lookup runs against state that's
   already stale by the time the op set applies, the move would clear the copy's own `line_slot_id`
   correctly but skip reopening a slot it no longer believes it's leaving. Unverified; FSD-2 is checking
   this against #120.

**Repair rule (verbatim from the tech lead, to record exactly as given):** `copy.line_slot_id` is the
side the write path treats as authoritative, so reconciliation must clear the stale slot to
`placeholder`/`copy_id: null` — never re-attach the copy to the slot it no longer occupies.

**Scope split with UIL-061:** UIL-061 covers *preventing new orphans* (its confirmed-pull design
closes the exact gap in #1 above). This entry, UIL-062, covers *repairing the ones already on Testing*
plus resolving whether #3 is a real second leak. Cross-reference both ways.

**Update 2026-09-16: the sub-shape split is in, and it rules out cause #1 above for these five.** A
second measurement (tech lead, same diagnostic branch, 2026-09-15 ~04:05) resolves all five stale
copies to the same shape: `line_slot_id = NULL`, `role = 'shelved'`, `binder_id` set — none of the five
now point at a different slot. UIL-061's new-line pull (cause #1) always re-points a pulled copy's
`line_slot_id` at the NEW slot; it never leaves a copy with `line_slot_id = NULL`. So cause #1 does not
explain these five — the leak is a **move-out of a line into a plain shelf/bulk placement that clears
the copy's own link but never releases the slot it vacated.**

**Re-checked cause #3 directly against `e8b1499` — does not hold up as stated.** The relayed inference
was that `buildMoveOps`/`placementForMove`'s `"shelf"` branch emits the `update_copy` without a paired
`update_slot`. Read in full again, straight from `origin/develop` (not the shared local worktree, which
had drifted 20 commits behind and would have been the wrong thing to trust here): `buildMoveOps`
([`lib/line/move.ts:190-213`](../lib/line/move.ts:190)) pairs the release unconditionally on
`plan.reopenSlotId` truthiness — not conditioned on destination kind, so `"shelf"` gets no different
treatment than any other destination. Its caller, `applyMove`
([`lib/line/write.ts:73-84`](../lib/line/write.ts:73)), re-derives `reopenSlotId` from a fresh
`getByPk` read of the copy's current `line_slot_id`, confirmed against `slot.copy_id === req.copyId`,
immediately before building the op set — the same pattern `applyCollectionRemoval`
([`lib/coll/remove.ts:247-262`](../lib/coll/remove.ts:247)) uses for its own removal path. Both read as
symmetric. Also checked and cleared: sync's retire path
([`lib/sync/exec.ts:251-260`](../lib/sync/exec.ts:251)) releases a slot the same way when a card is
retired, and decision resolution ([`lib/line/decisions.ts`](../lib/line/decisions.ts)) never rewrites
an already-placed copy's binder/role columns at all. None of the four move-out paths in the codebase as
it stands at `e8b1499` reproduce this shape. The cause of these five specific orphans is still open —
either a mechanism not yet found, or residue from a version of one of these paths that predates the
current symmetric form. Flagging back to the Senior BA/FSD-2 rather than closing this line of inquiry
myself.

**Update 2026-09-17: cause found and verified — none of the four move-out paths above, a fifth path
none of us had checked yet.** A further measurement (tech lead) splits the five differently than
"which path moved them": **4 of 5 never left their slot at all** — same binder, same back half, same
colour band as their own slot's line, and `evolution_line.half` is CHECK-constrained to `'back'`, so
that is exactly where the slot would have placed them; each line was created only 1–2 minutes before
that copy's `placement_decision`. **1 of 5 is genuinely in the front half** of the same binder — it did
leave. All post-date the 02:30 clear, so still live-path, not residue.

**The real mechanism is in the haul-commit path, not a move at all.** `copyPlacementFromTarget`
([`lib/plan/placement.ts:20-40`](../lib/plan/placement.ts:20)) returns a `CopyPlacement` with exactly
four fields — `role`, `binderId`, `binderHalf`, `colorBand` — **there is no `lineSlotId` field on that
type**, for any target kind including `back-half-line`. `emitIncomingCopy`
([`lib/plan/commit.ts:494-505`](../lib/plan/commit.ts:494)) takes that placement and, for a **routed**
card (`p.existingCopyId` set — the UIL-003 sync-copy path, which is how her ~705 existing cards reach
the cascade), writes `line_slot_id: placement.lineSlotId ?? null` — since the field is never present,
this is unconditionally `null`. On a normal, first-time commit this is harmless: `writeCard`
([`lib/plan/commit.ts:330-412`](../lib/plan/commit.ts:330)) calls `emitIncomingCopy` first and then, in
the SAME op set, immediately re-sets the correct slot id — either via `filledExistingSlot`'s own
`update_copy` ([`commit.ts:411`](../lib/plan/commit.ts:411)) or `writeNewLine`'s `if (isIncoming)`
branch ([`commit.ts:607`](../lib/plan/commit.ts:607)). Net effect on a fresh commit: correct.

**The leak is committing the SAME already-slotted copy a second time.** `commitCardPlacement`
(lib/plan/commit.ts) has no guard against re-committing a copy that already has a `line_slot_id` — and
UIL-006's resumed sessionStorage draft can still list a card she already pressed Done on. Re-run it:
`emitIncomingCopy` nulls the copy's *existing* slot pointer first, exactly as before — but this second
time, if the cascade re-derives a DIFFERENT step for it (four of the five: re-derives the *same*
back-half-line placement but for some reason without taking the `filledExistingSlot`/`writeNewLine`
branch that would re-set the pointer; one of the five: re-derives to "line already holds this stage,
extra copy to the front half" per the STEP 4 duplicate-tracking branch, which explains the lone
front-half outlier exactly) — the null-write is never followed by a correcting one. The copy loses its
link; the slot it vacated is never touched and stays `filled`, naming a copy that no longer points back.

**Cleared, not this:** `buildMoveOps`/`applyMove`, `applyCollectionRemoval`, sync's retire path,
decision resolution, and UIL-061's owned-pull op (which does set the pointer) — all confirmed
unaffected in the earlier passes above. This fifth path is the one none of those checks covered.
Verified independently against `origin/develop`, matching FSD-1's read on the fix in progress.

**Update 2026-09-17 (later the same day): the "second Done" paragraph above is retracted — it
required two write events per copy, and the data has exactly one.** A further measurement (tech lead)
gives each of the 5 drifted copies exactly one `placement_decision` row, by type: **4 ×
`placement-override` / `resolved_by: 'user'`**, **1 × `line-existing` / `resolved_by: 'auto'`**. One
decision means one commit event touched that copy's placement columns — the double-commit story above
needed two (a correct placement, then a later leaking one) and doesn't fit. Withdrawing it.

**Verified cause for the 4: `writeOverriddenCard` has no slot-release step, and never did.**
`MoveDestination` ([`lib/line/types.ts:214-223`](../lib/line/types.ts:214)) grew a `lineJoin` field on
its `"shelf"` kind under #120/UIL-056 (`buildNewLineJoinOps`/`buildExistingLineJoinOps`,
[`lib/line/move.ts:308-337`](../lib/line/move.ts:308)) — but that machinery is wired into
`buildMoveOps`, the **Lines-page move path**, only. `placementForMove`
([`lib/line/move.ts:40-66`](../lib/line/move.ts:40)) itself is unchanged by that PR and still returns
`line_slot_id: null` for every destination kind, every time — by itself that's fine, because
`buildMoveOps` overwrites it with a resolved slot id when `lineJoin` applies. `writeOverriddenCard`
(the **haul-plan override path**, [`lib/plan/commit.ts:439-467`](../lib/plan/commit.ts:439)) was never
touched by #120: it calls `placementForMove(dest)` and feeds the raw result straight to
`emitIncomingCopy`, with only a collection-membership join alongside it — no slot lookup, no release,
no `lineJoin` resolution at all. So overriding a copy that currently has a real `line_slot_id` clears
that copy's own pointer and never touches the slot it vacates. The commit that fired this on 4 of the 5
is the `insert_decision` with `decision: "placement-override"`
([`lib/plan/commit.ts:314-323`](../lib/plan/commit.ts:314)), which matches the measured type exactly.

**How an override ever reaches an already-slotted copy without a second commit: the slot fill and the
leak are two different copies' events.** `writeNewLine`'s pull ([`commit.ts:607`](../lib/plan/commit.ts:607)
region) sets a pulled copy's `line_slot_id` as a side effect of the INCOMING card's own decision and
writes no `placement_decision` of its own (UIL-061). So a copy can start occupying a slot with zero
decision history, then be overridden later — its first-ever `placement_decision` is the leaking one,
and "exactly one row" holds without needing two events on the same copy.

**Respectful disagreement with the relay on the 5th row — same mechanism, not a distinct second
flavour.** The relay reads `line-existing`/`auto` landing in the front half as "wrong in two ways in
one write." But `step: "line-existing"` in `placeCard` is shared by TWO different branches
([`lib/engine/cascade.ts:292-315`](../lib/engine/cascade.ts:292)): filling an open placeholder slot
(pairs with `filledExistingSlot`, sets the pointer correctly — not this), and "the line already holds
this stage; the extra copy goes to the front half (lines tracked once)" — which is a real, intentional,
documented outcome with **no** `filledExistingSlot` and no bug in that branch itself. If the
already-slotted copy from a prior silent pull is the one that gets re-cascaded — reachable the same
way as the 4 overrides, just auto instead of manual — `existingLineSlot` finds its OWN slot already
`state: "filled"` (since it's sitting there) and this branch fires: front half, `line-existing`,
`auto`, no slot-release anywhere in the chain, matching all three measured facts without a second gap.
Recording this as the more likely reading, not asserting it over the relay — the two theories aren't
distinguishable from the fields measured so far (both predict identical output), so treat this as a
noted disagreement rather than a settled correction to the relay's fifth-row account.

**Unifying root cause, either way:** no commit-time write path outside the Lines-page move
(`applyMove`/`buildMoveOps`, and now its `lineJoin` extension) ever checks whether the copy it's about
to write new placement columns for currently holds a real `line_slot_id` that needs releasing. Both
`writeOverriddenCard` and STEP 4's "lines tracked once" branch assume they're placing a copy that has
nowhere else to leave from — true for a first-time commit, false whenever a silently-pulled copy is
reprocessed. Repair direction holds regardless of which of the two produced row 5: since no
`MoveDestination` can express "leave it in the line slot" outside `lineJoin`, and `resolved_by` marks
her override/the auto-decision as authoritative in all five cases, the copy side is correct as written
in every row — repair vacates the stale slot, never writes a pointer back.

**Update 2026-09-17 (further measurement): blast radius is 8 orphaned copies, not 5 — the 5 stale
slots are a subset, not the whole picture.** The tech lead separately counted shelved, back-half
copies with a NULL `line_slot_id` pointer at 8, of which the 5 stale-slot rows above are one part.
**None of the 8 have an intended placeholder slot to reattach to**, so the repair migration clears the
5 stale slots to `placeholder` and stops there — it must not try to relink any of the 8 copies to a
slot. She can reattach those herself via UIL-056's "Not in a line yet" list once the fix ships.

**Flagging an internal contradiction rather than silently picking a side.** The relay that supplied the
8-count also read "about 4 of which render HUNTING" as an explanation for her UIL-063 Dragonair report.
The Senior BA's own later, more carefully measured message on UIL-063 (dex-scoped read, exact
timestamp) says she owns **zero** Dragonair copies across all 32 printings — so no orphaned Dragonair
copy can exist to render anything. These two claims from the same investigation don't reconcile; the
later, more specific measurement (exact dex-scoped counts, not an approximate "about 4") is the one
this entry treats as correct, so it does **not** claim any connection to UIL-063. If that turns out
wrong, it's a data question for the tech lead, not a code question this entry can settle.

**Update 2026-09-17: fixed and repaired — PR [#151](https://github.com/viantihu/pokemon-tcg-tracker/pull/151)
(squash `26b6971`), prevention and a data migration, both verified against `origin/develop`.** This also
corrects my own earlier guess at row 5's exact mechanism — it was neither UIL-061's pull nor the
"lines tracked once" front-half branch I'd floated as a possibility; see below.

**Row 5's real mechanism: the `filledExistingSlot` branch wrote both pointers only inside `if (slot)`,
with no `else`.** ([`lib/plan/commit.ts:410-434`](../lib/plan/commit.ts:410).) When the cascade names a
stage/line to fill but that slot can't be resolved against the loaded context, `emitIncomingCopy` had
already run and written the back-half placement columns with `line_slot_id: null` — neither pointer op
then fires, and the commit still succeeds: card physically shelved, its line still showing that stage
as unfilled. **This is a distinct code path from the 4 override rows** (which come from
`writeOverriddenCard` never emitting a slot op at all, confirmed in the retraction/override-cause
updates above) — same *symptom* (a stale pointer pair), two different missing pieces of code. The fix
now throws instead of half-writing: one `apply_write_ops` transaction, so throwing leaves zero rows and
she retries against fresh state, rather than a silent half-write nothing on screen contradicts.

**Prevention for the override path: a new shared `releaseSlotOps`
([`lib/line/move.ts`](../lib/line/move.ts)), opt-in on a positive match.** Three callers now emit it
(the Line-screen move, collection removal, and — the one that was missing it — the Haul Plan override).
Release fires only when the copy's OWN current slot still names that same copy, not merely whenever the
copy has a pointer at all — an earlier version of the fix released on pointer-presence alone, which
would evict a card that never moved if the pointer was already stale; a test pins this.

**Repair: migration 0010** (`supabase/migrations/0010_release_stale_line_slots.sql`) clears the 5 stale
slots to `placeholder`/`copy_id: null`, predicate `state = 'filled' AND copy_id IS NOT NULL AND NOT
EXISTS (copy row whose own line_slot_id points back)`. Idempotent, no-op against Production's empty
table. **The 8 unlinked back-half copies are deliberately untouched, and the breakdown is sharper than
my earlier note:** of the 8, 5 have a placeholder in the right binder+band but wanting a *different*
card, and 3 have no placeholder there at all — zero have one that's rightfully theirs to reattach to.
A migration that picked a slot for any of them would be inventing a placement decision on her behalf;
she can attach them herself from the Lines page's "not in a line yet" list (UIL-056/#120). A test pins
that they stay untouched.

**Priority rationale.** High, per the Senior BA: this is the same silent-disagreement-with-reality
class the log has repeatedly treated as High, on the screen whose whole job is showing her what she
physically owns and where. Flagging for Karvi's confirmation since severity calls are hers.

**Update 2026-09-18: final verification, run `35347026092` from the tech lead — measured, not
inferred, and reconciled against the migration's own pre-flight comment rather than taken at face
value.** Final state: unattached back-half copies **3**, `line_slot` filled **34**, placeholder **12**,
`copy` **706**, `presence_group` **681**, and all three drift checks **0** (filled slot whose copy
doesn't point back; filled with a null `copy_id`; copy claiming a slot that doesn't hold it).

**Why the 3 is not a failed guard, stated in the terms that prove it rather than the bare number.**
Migration `0011`'s own pre-flight comment
([`supabase/migrations/0011_relink_unambiguous_line_slots.sql`](../supabase/migrations/0011_relink_unambiguous_line_slots.sql)) —
verified directly — measured, against 8 unattached copies at the time it was written, 3 strictly-1:1
pairs (safe to relink), 2 one-slot/several-copies pairs (ambiguous, deliberately skipped, no
tie-break), and 3 with no candidate slot at all. Its own predicate requires the pairing to be
unambiguous **in both directions** — `having count(*) = 1` on both the slot side and the copy side —
and explicitly does not tie-break on `created_at`, because `target_catalog_card_id` says nothing about
`variant`, and guessing which of two owned printings belongs in the line would invent a decision that
is hers to make. **But by the time `0011` actually ran, she had already attached 4 of the 8 herself**
from the Lines page's "not in a line yet" list — the true baseline at run time was 4 unattached, not 8
— and the measured delta (`line_slot` filled 33 → 34, placeholder 13 → 12, unattached 4 → 3) shows
**exactly one relink**, the one strictly-1:1 pair that still existed at that point. A three-relink
tie-break would have produced filled 36 and placeholder 10; it didn't. The guard held, on real data,
under real concurrent activity, not just at pre-flight measurement time.

**Three things closed, not deferred.** Prevention held at scale: the drift count stayed at 0 across 15
additional filled slots since the earlier post-repair read (filled 19 → 34), not just immediately after
the fix. The variant question the migration's own comment raised is moot — zero one-slot/many-copies
groups remain, so there is nothing left to tie-break and no decision outstanding from her. And the
remaining 3 have no candidate slot at all, so no future migration can help them — they are permanently
hers to attach via the same "not in a line yet" list, and she has been told that directly, so this
should read as settled rather than as an open repair.

**`copy` (706) and `presence_group` (681) are unchanged from every read since 2026-09-15** — `0011`
created and deleted no rows; the only copy-side change it makes is the `line_slot_id` pointer, by
design, matching its own migration comment's "both sides, one statement set" framing.

**Two corrections to earlier commentary, both caught by `0011`'s own header comment and worth
repeating here so they don't resurface:** (1) 0010's line naming "the Dragonair report, UIL-063" as
roughly 4 of the 8 was already retracted in this entry's own 2026-09-17 update, and 0011's comment
independently reaches the same correction from the DB side — two routes to the same fix, consistent.
(2) The "about 4 render as HUNTING" phrasing in 0010 described a state that couldn't have existed when
0010 was written — none of the 8 had a placeholder naming their card yet, since 0010 hadn't run;
"about 4" was an estimate of 0010's own downstream effect, written as though it were a pre-existing
measurement. Trust the zero 0010 also stated, not the "about 4."

## UIL-063 — A Basic card's spotlight says "no line yet" even when a line for that exact species already exists on the Lines page, and a Dragonair she says she committed still shows as un-owned

- **Reported:** 2026-09-16 (Karvi, relayed precisely by Junior BA - 2 — not her diagnosis, a careful
  transcript of a contradiction she flagged)
- **Status:** **Fixed** — PR [#149](https://github.com/viantihu/pokemon-tcg-tracker/pull/149) MERGED to
  `develop` 2026-09-16 (squash `fab3245`), QA-gated, confirmed **deployed** to Testing (all four conditions
  green on that SHA). A Basic now enters the **same** existing-slot-fill path Stage1/Stage2 already used —
  one changed condition, not a parallel branch — so it fills an open slot in a line that already exists for
  its species, and the stage-agnostic line-existing reason string names that line instead of asserting
  "Basic with no line yet." That sentence was the actual defect: every Basic got it regardless of reality,
  which is what she hit. A Basic still **cannot create** a line — the fallback for a genuinely line-less
  Basic is byte-for-byte unchanged and never reaches `testViability`/`generateSlots` — and that is pinned
  by a test, because line creation is her decision (UIL-056). Fixtures are key-form bands
  (`Dragon: "olive"`) per UIL-012's lesson, reproducing her exact species and band. **Known limit, tracked
  as UIL-065:** the lookup still keys on the card's *natural* band, so a line she created manually in a
  different band remains invisible for every stage — the same symptom by a second route, so this being
  Fixed does not mean the symptom is gone in that case. Awaiting Karvi's confirmation.
- **Priority:** High (Claude's read — needs Karvi's confirmation)
- **Area:** Plan, Lines
- **Env:** Testing

**The sequence, in order:**

1. In the Haul Plan, card 101 of 614 — a Dratini — showed the spotlight text "Basic Pokémon with no
   line yet — goes to the front half, Olive band," proposing a brand-new placement.
2. Asked whether she'd already clicked Done on a Dragonair earlier in this same session, she said yes.
3. She then showed a screenshot of the Lines page's existing "DRATINI LINE": Basic (Dratini, #147)
   **OWNED/FILLED**; Stage1 (Dragonair, #151, Ascended Heroes) **OPEN/HUNTING** with priced wishlist
   alternates ($0.15/$0.20/$0.21), labeled "DRAGONAIR is a hunt, not owned yet"; Stage2 (Dragonite,
   #149) **OWNED/FILLED**.

In her words (via Junior BA - 2): "I want to note, this line does not look right either. The Dratini
card should not be visible in the line until I've approved it. It can be suggested but the UI does not
seem to be suggesting."

**Confirmed: the "no line yet" text is not about whether a line exists — a Basic card never checks.**
`placeCard`'s STEP 4 ([`lib/engine/cascade.ts:288`](../lib/engine/cascade.ts:288)) gates ALL
line-lookup and line-creation logic — `existingLineSlot`, `testViability`, `generateSlots`, the whole
new-line/join-line branch — behind `isLineStage = incoming.card.stage === "Stage1" ||
incoming.card.stage === "Stage2"`. A Basic never satisfies that condition, so it falls straight through
to STEP 5 ([`cascade.ts:389`](../lib/engine/cascade.ts:389)), which unconditionally returns "Basic with
no line; to the front half" — **it does not look at `ctx.lines` at all.** So this spotlight text would
read exactly the same whether zero lines exist for that species or, as here, one already does with two
of its three stages filled. The sentence isn't wrong about THIS Dratini specifically failing some
check; it's a sentence a Basic always gets, regardless of reality. Only Stage1/Stage2 incoming cards
ever look up or start a line — a fresh Basic pull can never join one, even a viable, mostly-filled one
for its own species.

**Her stated hypothesis (forecast leaking onto the committed Lines page) does not hold up against the
read code, though the confusion is understandable.** `buildScreenModel`
([`lib/line/load.ts:2`](../lib/line/load.ts:2), "Load persisted line state") reads `line_slot.state`
and `copy_id` directly — there is no forecast overlay on that screen, so a slot showing FILLED reflects
a real, previously-committed `copy` row, not an in-progress or unapproved haul decision. The Dratini and
Dragonite filling this line almost certainly came from an EARLIER commit, not this haul's card 101 —
most plausibly a prior Dragonite (Stage2) Done, which — per STEP 4 — runs `testViability` and
`generateSlots`, finds her Dratini already owned and pulls it into the Basic slot (system-design §6),
and finds Dragonair not owned but catalog-confirmed, wishlisting it with priced alternates. That would
produce exactly this screenshot without any bug. **This is inference from how the engine is supposed to
behave, not a confirmed reconstruction of her specific history** — I have no way to see which card
actually created this line without a DB read.

**Unresolved: why a Dragonair she says she committed still shows as a hunt.** Three ways this could
happen, none confirmed:
1. Her Dragonair Done landed somewhere other than this line's Stage1 slot — e.g. routed as a duplicate
   (STEP 3) if she already held a shelved Dragonair, or into a differently-banded line if this
   printing's colour doesn't match "Olive." `existingLineSlot` matches on `colorBand` and `dexId`
   together ([`cascade.ts:168-179`](../lib/engine/cascade.ts:168)) — a mismatch on either sends it
   elsewhere silently.
2. Her Dragonair Done predated the line's existence (e.g. it committed before whatever created the
   DRATINI LINE), so at that moment `existingLineSlot` found nothing and it was never a "fill this
   slot" write to begin with.
3. `commitCardPlacement`'s re-derivation guard ([`lib/plan/commit.ts:165-201`](../lib/plan/commit.ts:165))
   only refuses a stale write when the caller supplies `expectedDigest` — it's explicitly optional, "do
   not check" when absent. If that write's request omitted it, or the check passed against a
   digest that itself no longer matches current reality, the copy could have committed to a
   destination other than the one she read off the screen with nothing on screen ever contradicting it
   (the exact risk that comment names, UIL-045).

None of these is confirmed. This needs a fresh Testing-DB check for where her Dragonair copy currently
sits — bulk, a different binder, or genuinely nowhere (never committed) — before a cause can be named.

**Cross-reference.** UIL-045 (the digest-guard mechanism cited in #3) and UIL-062 (concurrently under
investigation for a different placement-drift shape) are both about forecast/commit or record/reality
divergence; if the DB check resolves this to the same family, fold the finding in rather than treating
it as a fourth unrelated cause. The STEP-4 gate finding above stands on its own regardless of how the
Dragonair question resolves.

**Update 2026-09-17: the Dragonair half is resolved — no data defect, and it does not connect to
UIL-062.** A dex-scoped measurement (tech lead) on the DRATINI line itself (`root_dex_id` 147, Olive,
created `2026-09-16T03:32:35Z`) reads stage 0 (Basic) **filled**, stage 1 (Stage1) **placeholder**
wanting `me02.5-151`, stage 2 (Stage2) **filled** — and **she owns zero Dragonair copies across all 32
printings.** All three candidate explanations above required a Dragonair copy row to exist somewhere;
there isn't one, so none of them apply. `state: placeholder` with a wishlist target is the correct
representation of "not owned yet," and "HUNTING" is its correct rendering — the Lines page told her the
truth, and the line is internally consistent: two stages owned, one wanted.

**Correcting a detail in the original report:** "#151" was the printed collector number in Ascended
Heroes (`151/xxx`), not a dex id — that read as a contradiction because dex 151 is Mew, not Dragonair.
Dragonair is dex **148**. The line's own three dex ids (147 Dratini, 148 Dragonair, 149 Dragonite) are
consecutive and consistent throughout; only the collector-number label was ambiguous in how it reached
the log.

**What's still open is upstream of the app and only Karvi can settle it:** whether the Haul Plan row she
pressed Done on actually said Dragonair, or whether Dragonair is a card she physically holds that the
app never learned about (missing from a Dex import). Those point at different things — a Done that
didn't do what the screen said, versus a card absent from her catalog sync — and only she can say which.
Awaiting one clarification from her; recording as no data defect found on this line pending that answer.

**The STEP 4 finding stands on its own, unweakened by this resolution.** A Basic card never checking
`ctx.lines` at all is confirmed independent of what happened to any specific Dragonair — assigned to
FSD-2.

**Priority rationale.** High, provisionally: misleading spotlight text on the app's core placement flow
is the same class the log has repeatedly flagged High. The Dragonair half is now resolved as "no
defect, pending one clarification from Karvi" rather than an open cause; the STEP 4 gate is the entry's
standing confirmed defect. Flagging for Karvi's confirmation since severity calls are hers.

## UIL-064 — The line-join UX #120 shipped doesn't work for her: too many manual picks, gets her kicked off the Haul Plan, and the "not in a line" list is unusable

- **Reported:** 2026-09-17 (Karvi, via Junior BA - 2). Initial report, verbatim: "we need to review 056
  because the new UX makes no sense." Followed by her ruling on four candidate problems the Senior BA
  put to her, all four selected verbatim: "It's somewhat buggy and the icons are not aligned" / "Too
  many picks; it should ask for the line" / "Being sent away from the Haul Plan" / "The list of cards
  not in a line is unusable."
- **Status:** **Closed on Karvi's explicit instruction** — she was told plainly that two of the four
  parts were **not** fixed and chose to close the entry anyway, so this is an informed acceptance of parts
  1 and 3 as sufficient rather than a confirmation that all four are done. The two remaining parts are
  carried in their own entry (see the end of this entry) so they are not lost with the closure, per her
  standing rule that a report keeps its own number. **Fixed (parts 1 and 3 of 4)** — PR [#154](https://github.com/viantihu/pokemon-tcg-tracker/pull/154)
  MERGED to `develop` 2026-09-16 (squash `218ac0a`), QA-gated on the merged tree, confirmed **deployed** to
  Testing (all four conditions green on that SHA). **Part 1, too many picks:** the panel now leads with
  "join a line" — candidates flat and sorted nearest-complete, each showing its own band — and picking one
  **derives** binder, half and band from the line instead of demanding them first; "start a new line"
  pre-selects the card's natural band from `type_color_map` rather than offering ten empty chips; the old
  binder → half → band flow survives behind "place it manually" for a genuine forced override. The
  band-keyed wrapper that forced a band choice was a Senior BA design error, now removed. **Part 3, the
  unusable list:** the Lines page splits by current half — "stranded in the back half · N" prominent, the
  hundreds of front-half shelved cards collapsed below — because a front-half card with join candidates is
  ordinary collection state, not an anomaly. **Still open, and this entry is NOT closed by the above:**
  **part 2**, a line choice on the Haul Plan itself, is only half-possible today — the read half was
  deliberately **dropped** from this PR rather than shipped as a second implementation of a derivation
  `buildScreenModel` already performs (two implementations drift, and a drifted one would offer a line the
  write path won't honour, the UIL-045 shape), and the write half needs `writeOverriddenCard` to gain line
  side effects it does not have; and **part 4**, the bugginess and misaligned icons she reported, is
  unaddressed pending a layout measurement pass, since no session could open an authed screen to look.
  Reversing the "do this from the Lines page" redirect was a Senior BA decision, recorded as such.
- **Priority:** High (Senior BA's read — she rejected shipped work on a core flow; hers pending)
- **Area:** Lines, Plan, Collections
- **Env:** Testing

This is a UX rejection of what #120 (UIL-056) shipped, not a named defect — logged under its own number
rather than reopening UIL-056, per the standing rule that her report gets its own entry regardless of
where the cause traces. **UIL-056 stays Fixed, not reopened: the strand it closed (a shelved card had
no way off the front half into a line) is genuinely closed. This entry carries the rework.**

**Problem 1 — too many manual picks; confirmed in code.** To put a stranded card into a line, `MovePanel`
([`app/(ui)/_components/MovePanel.tsx`](../app/(ui)/_components/MovePanel.tsx)) walks her through
**BINDER** (:115) → **HALF** (:182) → **COLOR BAND · RAINBOW ORDER** (:201) → **JOIN A LINE** (:239) →
Confirm — four sequential picks before she can say which line. Two of those, half and band, are values
the app derives everywhere else in the app (the cascade computes the band from the card's type via
`type_color_map`). Her own read matches exactly: "too many picks; it should ask for the line." **Fix
direction (Senior BA): show candidate lines for this specific card first; derive binder/half/band from
whichever line she picks; keep manual picks available but not required.**

**Problem 2 — sent away from the Haul Plan; confirmed in code, and this was a deliberate call, not a
bug.** `MovePanel`'s own doc comment: `allowLineJoin` (UIL-056) is "opt-in, default off, so the plan
spotlight and Collections' existing usage are untouched; only the Line screen turns it on." Where it's
off, the panel shows "Back-half moves choose a line. Do this from the Lines page."
([`MovePanel.tsx:232`](../app/(ui)/_components/MovePanel.tsx:232)) instead of the line-join picker — so
a back-half placement decision from the Haul Plan or Collections always bounces her to a different
screen. **This was the Senior BA's own instruction to the dev, recorded here at their request rather
than attributed to the implementation** — and it's reversed: the fix direction is to move the line
step onto the Plan spotlight itself so a haul can be placed without leaving the screen.

**Problem 3 — the "not in a line" list is unusable; confirmed in code.** `UnlinedCardsPanel`'s own doc
comment claims "nothing to show is the common case (most shelved cards are already lined or have no
line concept)," but the list backing it (`lib/line/load.ts`, the `unlinedCards` loop) filters only on
`c.role !== "shelved" || c.line_slot_id` — **it never checks `binder_half`.** Every front-half shelved
card (which has no line concept at all, by design — lines only ever live in the back half) qualifies
for this list exactly as much as a genuinely stranded back-half card does. With most of her shelved
collection sitting in the front half, this floods the panel with hundreds of irrelevant entries instead
of surfacing the handful that are actually actionable. **Fix direction: filter to `binder_half ===
"back"`, or split/order the list so the actionable set surfaces first.**

**Problem 4 — "somewhat buggy and the icons are not aligned."** No specifics requested from her by
design — FSD-2 is running a browser pass at desktop and 375px widths to find what she's seeing rather
than asking her to itemize it. Recording as under investigation, no further detail available yet.

**Cross-reference.** UIL-056 (the strand this rework replaces, left Fixed), UIL-061 (its Plan-side
`lineJoin` design work carries forward into this entry's Problem 2 fix), UIL-063 (a Basic card still
can't join an existing line automatically at all — separate from this entry's manual-join UX, but part
of why she needs the manual path in the first place).

**Priority rationale.** High, per the Senior BA: rejecting shipped work on a core, everyday flow — not
holding the assignment on Karvi's priority read given that. Flagging for her confirmation since
severity calls are hers.

## UIL-065 — A line she deliberately created in a non-natural colour band is invisible to the cascade forever, silently defeating UIL-063's fix for exactly the lines she built herself

- **Reported:** 2026-09-17 (not from Karvi — found by QA while gating #149, verified in the cascade's
  own lookup, relayed by the Senior BA)
- **Status:** **Fixed** — PR [#154](https://github.com/viantihu/pokemon-tcg-tracker/pull/154) MERGED to
  `develop` 2026-09-16 (squash `218ac0a`), QA-gated, confirmed **deployed** to Testing. The band filter is
  dropped from `existingLineSlot` at **both** sites the gap reached — STEP 1's collection-claim check and
  STEP 4's line participation — and a card joining a line now takes **the line's** `colorBand` rather than
  its own natural one, which is the same "pick the line, derive the placement" inversion Karvi's UIL-064
  ruling established, so the engine now agrees with the panel instead of contradicting it. Verified that
  nothing downstream re-derives the band independently: `copyPlacementFromTarget` and `describeReason` both
  pass `target.band` through verbatim. One subtlety pinned by a test because it is easy to get wrong later:
  a card that falls back to the **front half** keeps its **own** natural band, not the line's — the front
  half is not part of the line. The mutation split is what establishes both sites were needed: restoring
  the filter at STEP 4 alone fails the cross-band tests while the STEP 1 test still passes, and vice versa.
  Awaiting Karvi's confirmation: a line she created in a non-natural band should now be found by the next
  card of that species, and that card should land in the line's band.
- **Priority:** High (Senior BA's read; Karvi to confirm)
- **Area:** Lines, Plan
- **Env:** Testing

**Confirmed against `fab3245` (the UIL-063 fix, #149, already on develop): `existingLineSlot` matches
on the incoming card's own natural band, and a manually-created line's band is her free choice —
those two facts don't agree with each other.** `existingLineSlot`
([`lib/engine/cascade.ts:168-179`](../lib/engine/cascade.ts:168)) filters `ctx.lines` on
`line.colorBand !== b`, where `b = band(incoming.card, map)` — the band the cascade derives from the
card's own type via `type_color_map`, computed identically for a Basic, Stage1, or Stage2 incoming
card. `#149` (fab3245) made a Basic run this same lookup, but did not touch how `b` is computed.
Meanwhile `buildNewLineJoinOps` ([`lib/line/move.ts:219-248`](../lib/line/move.ts:219)) — the write
path behind UIL-056's manual "start a new line" — writes the new `evolution_line.color_band` as
`ctx.destinationBand`, her own MovePanel pick, with a comment stating the override is deliberate:
"`band` is overridden to HER destination band here... rather than trusting `testViability`'s own band
guess from the card's type." `MoveDestination`'s `shelf.band` field is exactly that free pick — nothing
forces it to match the card's natural type-derived band.

**Consequence: if she ever puts a manually-created line in a band that isn't the species' natural one,
no card of that species — Basic, Stage1, or Stage2, present or future — will ever find that line
again.** `existingLineSlot` checks `dexId` and band together; the species matches, the band never will,
so every future card for that line falls through exactly as if the line didn't exist. Two things worth
stating plainly because they're easy to miss:

1. **This silently defeats `fab3245` for exactly the lines she built herself.** The fix's whole point
   was "a Basic's spotlight should say the truth about whether a line exists for it" — but for a
   manually-banded line, it still won't, because the lookup that fix now runs was never the part that
   was broken for this case.
2. **It reproduces her original UIL-063 symptom by a second, independent route.** A reader who sees
   UIL-063 marked Fixed would reasonably conclude "no line yet" can no longer be shown to her
   incorrectly. It still can, whenever the line in question is one she banded herself.

**Pre-existing, not caused by #120.** The band-keyed lookup in `existingLineSlot` predates UIL-056's
manual-creation UI entirely — it's the same lookup the auto-cascade always used. #120 made this
reachable by giving her a free band choice for the first time; before that, every line's band was always
cascade-derived and therefore always matched a future card's natural band by construction.

**Fix direction (Senior BA, following the same principle her UIL-064 ruling already established for
this file): match on species alone, and let a card joining a line take the LINE's band, not its own
natural one — she chose where the line physically lives, so the line's band should win.** Folded into
the UIL-064 work rather than shipped separately: same file, same "pick the line, derive the placement"
inversion, and shipping them apart would have her retest the same flow twice.

**Cross-reference.** UIL-056 (the manual-creation UI that made this reachable), UIL-063 (the symptom
this reproduces by a second route, despite being marked Fixed), UIL-064 (the line-join rework this is
folded into).

**Update 2026-09-17: fix built, open as PR [#154](https://github.com/viantihu/pokemon-tcg-tracker/pull/154),
verified against its actual diff (not yet merged as of this writing).** Goes further than first
described: the band filter is dropped from **both** call sites — STEP 1's collection-claim check and
STEP 4's line-participation check — since the same gap hit both, not only the one this entry named.
`existingLineSlot` now matches on `dexId` alone; the caller takes `existing.line.colorBand` for
placement instead of the card's own derived band, in both branches. **One exception worth recording
precisely because it's easy to get backwards later: a card that falls to the front half because its
line's stage is already filled (the "lines tracked once" branch) keeps its OWN natural band there, not
the line's** — the front half isn't the line, so her band choice for the line doesn't follow a spare
copy that never joins it. Verified nothing downstream re-derives band independently:
`copyPlacementFromTarget` ([`lib/plan/placement.ts:36-40`](../lib/plan/placement.ts:36)) and
`assemble.ts`'s `describeReason` ([`lib/plan/assemble.ts:43-45`](../lib/plan/assemble.ts:43)) both pass
`target.band` through verbatim, so the line's band propagates correctly end to end.

**Priority rationale.** High, per the Senior BA: reproduces an already-Fixed defect's exact symptom
through a path the fix didn't cover, on the same core flow the log has repeatedly treated as High.
Flagging for Karvi's confirmation since severity calls are hers.

## UIL-066 — GitHub Actions billing lockout renders every check red, indistinguishable from a real test failure, for as long as it lasts

- **Reported:** 2026-09-17 (not from Karvi — found by the tech lead during tonight's outage)
- **Status:** **Closed** — **confirmed resolved by Karvi 2026-09-19** (via Junior BA - 2). The cause and
  fix are in the body's 2026-09-18 updates: Free-plan minutes exhausted on a private repo, resolved by
  making the repository public at 2026-09-17 23:52Z (unlimited standard-runner minutes, no payment or
  spending-limit change), and every CI, Deploy and diagnostic run since has started normally — including
  the ~40 PR merges of 2026-09-18. Lasting consequences recorded in the body and carried into standing
  practice: Actions logs are world-readable so diagnostics print counts and shape only; branch protection
  is now ON for `develop` (2026-09-18) and `main` (2026-09-19) with verify, migration-order and Vercel
  required. The "is this red real" tell (a run with `steps = 0` never started) stays in the memory
  notes.
- **Priority:** Medium (Senior BA's read — an ops/CI incident, not a product defect Karvi will see)
- **Area:** Deploy
- **Env:** CI (GitHub Actions)

**Confirmed, independently, against the live account: this is real and ongoing as of this writing.**
Since **02:57Z on 2026-09-17**, GitHub Actions has refused to start jobs on this account. Every run on
`CI`, `Deploy`, and the `ops/read-band-config` diagnostic workflow since then shows `completed`/red —
identical to a genuine test or migration failure in the Actions tab, with nothing there to tell the two
apart. The actual reason is visible only through the check-run **annotations API**, verified verbatim
just now:

> "The job was not started because recent account payments have failed or your spending limit needs to
> be increased. Please check the 'Billing & plans' section in your settings"

**The cheap tell, worth recording as the standing diagnostic:** a run whose jobs report `steps: 0`
never executed anything — it isn't a code or migration failure, it's the runner never starting.
```bash
gh api repos/viantihu/pokemon-tcg-tracker/actions/runs/<id>/jobs --jq '.jobs[].steps | length'
```
Confirmed on the latest run at time of writing: both `verify` and `migration-order` jobs report `0`
steps, `started_at`/`completed_at` three seconds apart. Anyone triaging a red check from the Actions tab
alone would reasonably read this as a broken build and re-run it — which cannot help, since nothing
ever ran.

**Why this earns its own entry rather than folding into a billing fix-and-move-on: app code kept
shipping to Testing while migrations could not apply.** Vercel bills separately from GitHub Actions and
kept deploying through the block, so the ordinary safeguard — CI's `migration-order` check gating a
merge — was itself one of the blocked jobs. This is UIL-005's "deploy outruns the DB" condition
returning by a different route, and worse this time: the schema read-back check added specifically to
catch that class of drift is, itself, a GitHub Actions job, and therefore also blocked.

**The luck, recorded plainly rather than assumed:** nothing that merged during the block touches a
migration. Two commits landed after 02:57Z — `5d249f8` (`ci: run migration-order on push, not only on
pull_request`, workflow config only) and `cce1bbe` (`docs(issue-log): ...`, status lines only, verified
65 entries before and after). Neither is a migration or a product change, so Testing's schema is
current at all 10 migrations and **no damage occurred this time.** This should not be trusted to hold
if the block runs long — it is a fact about what happened to merge, not a property of the lockout
itself.

**Recovery order on record, since a future reader will need it more than the billing fix itself:**

1. Re-run CI on **develop's tip**, not the sum of each PR's own (pre-merge) run — two commits merged
   with zero validation during the block, and this repo has independently produced a clean-merge that
   doesn't build four times in one day even under normal conditions.
2. Confirm `migrate` reports all 10 migrations applied on that tip. This closes the "is code ahead of
   schema" question with evidence, not reasoning from what's believed to have merged.
3. Then the held migration `0011`, then Testing's re-counts, then the variant check — in that order.

**Merge policy for the duration:** anything with a migration or a product change is frozen. Docs-only
issue-log PRs remain safe to merge, since they touch nothing CI validates — this entry itself was
written and merged under that exception.

**Priority rationale.** Medium, per the Senior BA: an infrastructure incident invisible to Karvi and
already self-limiting once billing is resolved, not a product defect — but High-adjacent in effect
while it lasts, since it silently removed the one automated check standing between a merge and a
schema mismatch.

**Update 2026-09-18: resolved, and the two cause descriptions reconcile into one event, not two.**
Karvi confirmed the root cause: the account's Free-plan monthly Actions minutes were exhausted — a
private repo on Free gets 2,000 minutes/month, and measurement over 200 runs (Sep 14–17) put usage
around 990 billed minutes across 397 runs, roughly 5 minutes each, with `verify` alone accounting for
about three quarters of it. Three days of UAT activity used a month's allotment. **Precisely why that
produced the payment/spending-limit annotation rather than an "included minutes exhausted" one:**
GitHub Actions on a Free plan carries a spending limit that **defaults to $0**. Once the included
2,000 minutes run out, every further job is billable usage, and a $0 limit is exactly what refuses to
start a billable job — the annotation's wording ("payments have failed or your spending limit needs to
be increased") describes that refusal accurately; it was never describing a card-on-file failure.
Raising the spending limit with a card on file would have cleared it the same way making the repo
public did.

**Fix: the repository was made public**, 2026-09-17 23:52Z — confirmed directly
(`GET /repos/viantihu/pokemon-tcg-tracker` reports `private: false`) — which moves the account onto
unlimited standard-runner minutes for public repos, no payment or spending-limit change needed. A
full-history secret scan run beforehand as a precaution found only placeholder values, no real keys or
personal emails (taken as reported; not independently re-run).

**Recovery verified directly on develop's tip `1a86505`**, all conditions green:
`Vercel: success`, `verify: success`, `migrate: success` (all 10 migrations, 0001–0010, applied on
Testing), `smoke: success`, `acceptance: success`. No migration merged during the lockout (confirmed
earlier in this entry), so Testing's schema never diverged — the freeze held. **Re-confirmed on the
current tip `8028771`**, all six checks green again — the recovery held through further merges, not
just the first post-fix commit.

**The scale-sanity flake discovered during recovery is recorded under UIL-021, not here — moved on
review.** It's the same test UIL-021 already covers (`tests/catalog/artwork.test.ts`'s wall-clock
assertion), a second failure mode on that one test rather than a new, independent CI-billing
consequence, so it belongs with the existing entry. See UIL-021 for the detail; PR
[#175](https://github.com/viantihu/pokemon-tcg-tracker/pull/175) (merged) is its fix.

**Update 2026-09-18: a lasting consequence of making the repo public — branch protection on `develop`,
Karvi-approved, confirmed live directly against the API.** `GET
/repos/viantihu/pokemon-tcg-tracker/branches/develop/protection` reports required status checks
`verify`, `migration-order`, and `Vercel` (strict mode off) — this option simply wasn't available on
the private Free-plan repo before the visibility change this entry made. Effective immediately for
every PR into `develop`, docs-only issue-log PRs included: GitHub now blocks the merge
(`mergeStateStatus: BLOCKED`) until all three report `SUCCESS` on the PR's head commit, typically a
few minutes after the last push, and direct pushes to `develop` are refused outright. Confirmed
directly on this session's own PR #189: sat `BLOCKED` on `verify` for roughly two minutes, then merged
cleanly once it passed. If a PR shows only the artwork "scale sanity" test failing, that is the UIL-021
flake (previous update, PR #175) — re-run it; anything else red is real.

## UIL-067 — The decision card is too crowded and shows information that isn't helpful for making the actual call

- **Reported:** 2026-09-17 (Karvi, screenshot of a live "COLLECTION CLAIM VS LINE SLOT" decision for
  Charizard). In her words: "This UX is too crowded, and a lot of the information here is not helpful.
  I need something simpler."
- **Status:** **Fixed** — PR [#278](https://github.com/viantihu/pokemon-tcg-tracker/pull/278) MERGED to
  `develop` 2026-09-20 (squash `81d1986`), QA-gated on the merged tree (1040 tests, build; removing the
  Details disclosure fails 5 shape cases, deleting the outcome line fails its text case), confirmed
  **deployed** to Testing (Deploy, migrate, smoke, acceptance and Vercel green on `81d1986`). The shape
  Karvi approved 2026-09-20: the proposal; one line "WHAT HAPPENS TO THIS COPY" that says which of the
  collection or the line physically ends up with it (and, for cap, block and termination, where the copy
  lands or that nothing is placed), the one fact the old card never surfaced; one sentence of why; the
  choice buttons. CATALOG, YOU OWN, the rest of the why and the priced alternates grid sit behind a closed
  Details row, still one tap away and still pickable there; the wishlisting pick stays as one line under
  PROPOSED. Measured on the merged tree with the harness at 375: the sheet 1,608.7 → 950.2 px and the first
  choice button 1,391.4 → 677.9 px down, so on a phone the buttons sit at the fold instead of two screens
  down (at 1440: 1,185.2 → 863 and 983.2 → 620.5). Step for Karvi when UAT resumes: Lines, Work the
  decisions; the card should read proposal, what happens, why, buttons, and Details should open the rest.
- **Priority:** Medium (Karvi's own ruling, 2026-09-18, via Junior BA - 2)
- **Area:** Lines
- **Env:** Testing

**Confirmed structure, read directly from the component she's describing.** `DecisionCard`
([`app/(ui)/_components/DecisionCard.tsx:106-134`](../app/(ui)/_components/DecisionCard.tsx:106))
renders three evidence columns — CATALOG, YOU OWN, WHY — above the proposal, then (when the decision
carries one) a full grid of wishlist alternates with card art and price, then the choice buttons. For
the collection-claim case she screenshotted specifically
([`lib/line/decisions.ts:254-289`](../lib/line/decisions.ts:254)):

- **CATALOG** is built by `catalogEvidence` ([`decisions.ts:107-121`](../lib/line/decisions.ts:107)):
  total printings for the species, a standard-band count, a specialty-band count, an "other band"
  example, and the cheapest same-band printing — five data points, all catalog statistics rather than
  anything about the specific card in front of her.
- **YOU OWN** lists every stage in the line (owned/open/blocked) plus a line stating the claimed copy
  lives in a running collection.
- **WHY** is two full sentences of prose explaining the cascade's rule ordering.
- Below that, the full wishlist grid repeats card art, set/number, and price for every ranked
  alternate, not just the one or two she'd actually consider.

**Not diagnosing which specific pieces to cut — that's a design call, not a code-correctness one — but
recording what's on screen precisely so whoever picks this up isn't starting from a description alone.**
The one data point the current card does NOT surface plainly is the thing her question ("collection
still wins?") is actually about: which of the two — the collection or the line — physically ends up
with this exact copy. That's implied by the proposal string but not called out as its own line the way
the five catalog stats are.

**Cross-reference UIL-064.** Same underlying pattern as her line-join complaint: a screen that surfaces
every fact the engine used to reach its recommendation, rather than the smaller set she needs to
confirm or override it.

**Priority rationale.** Flagging for Claude's read and Karvi's confirmation — this is a design
complaint on a screen she uses often, but not a data-correctness defect, so it doesn't automatically
inherit the "silent wrong data" High bucket the way UIL-062/063/065 did.

## UIL-068 — Moving a shelved card anywhere manual isn't a direct option — it's collapsed behind "place it manually," one extra step past the line-join flow

- **Reported:** 2026-09-17 (Karvi, screenshot of the "MOVE A SHELVED CARD" panel for a Pikachu with no
  existing line candidates). In her words: "I should have the option to move the card anywhere."
- **Status:** **Fixed** — PR [#176](https://github.com/viantihu/pokemon-tcg-tracker/pull/176) MERGED to
  `develop` 2026-09-18 (squash `4655145`, commit 2 of its three), QA-gated on the merged tree (699 tests,
  build), confirmed **deployed** to Testing (Deploy and Vercel both green on `c6ef4c4`, which contains it).
  Manual placement (binder / half / band / collection / bulk) is no longer collapsed behind a "place it
  manually" disclosure in the MOVE A SHELVED CARD panel; it is a direct option at the same level as joining
  a line, so a card with no line candidates has somewhere to go without the extra step. `lib/line` is
  untouched, so UIL-056's named back-half refusal still stands per her ruling; greying that option with its
  reason is tracked separately (UIL-072). **Not rendered in a browser before merge** — the dev had no
  credentials for an authed screen — so her pass is the visual check. Awaiting Karvi's confirmation when
  UAT resumes.
- **Priority:** High (Karvi's own ruling, 2026-09-18, via Junior BA - 2)
- **Area:** Lines
- **Env:** Testing

**Confirmed in the shipped UIL-064 rework (#154).** `MovePanel`
([`app/(ui)/_components/MovePanel.tsx:354-359`](../app/(ui)/_components/MovePanel.tsx:354)) puts every
manual destination — any binder, front or back half, band, the collection binders, the bulk box —
inside a collapsed `<details>` labeled "Not this — place it manually," reachable only after the
line-join options above it. When a card has no existing line to join, as in her screenshot, that
section's only visible content is "+ Start a new line"; manual placement requires opening the
collapsed toggle first, and the confirm button reads "PLACING · KB-001 · BACK HALF · YELLOW · PICK A
LINE" — disabled — until a line choice is made, even for someone who wants to skip the line question
entirely.

**This is the flip side of UIL-064's own complaint, not a contradiction of it.** UIL-064 was "too many
picks; it should ask for the line" — #154 fixed that by making the line question first and collapsing
everything else. Her new report is that the collapse went further than she wanted: manual placement
should be a direct option alongside joining a line, not one step behind it.

**Cross-reference UIL-064 (the rework this is direct feedback on) and UIL-070 (its item 1, "being sent
away from the Haul Plan," is largely this same complaint from a different screen).** Once this fix
ships — dropping the `<details>` wrapper so front half, collection, and bulk sit directly alongside the
line-join options rather than behind a toggle — that resolves the front-half/bulk/collection part of the
"sent away" complaint everywhere the panel mounts, including the Haul Plan. It does **not** resolve the
back-half-specific case there: UIL-056's server-side invariant still requires a line pick for any
back-half placement, correctly, and the Haul Plan has no line picker at all today — that residual is
UIL-070's item 1, not this entry's.

**Priority rationale.** Flagging for Claude's read and Karvi's confirmation — feedback on a screen that
shipped days ago, not a data-correctness defect.

## UIL-069 — The Haul Plan proposes putting a Purple-natured card into an Orange line, and she reads that as wrong regardless of the reason given

- **Reported:** 2026-09-17 (Karvi, screenshot of the Haul Plan spotlight for Annihilape, card 441/600).
  In her words: "This is an incorrect suggestion. This is a purple card but is being asked to fill an
  orange line."
- **Status:** **Fixed** — PR [#176](https://github.com/viantihu/pokemon-tcg-tracker/pull/176) MERGED to
  `develop` 2026-09-18 (squash `4655145`, commit 1 of its three), QA-gated on the merged tree (699 tests,
  build; mutations bite: mismatch detection off → 8 tests fail, commit refusal off → 3 fail, `bandChoice`
  accepted without a digest → 1 fails), confirmed **deployed** to Testing (Deploy and Vercel both green on
  `c6ef4c4`, which contains it). Per her ruling the app now **asks, never decides**: when a card's own
  colour differs from the open line slot it would fill, the Haul Plan spotlight shows both options as
  radios — join the line, or go to the card's own-colour destination — with **neither pre-selected**, and
  Done stays disabled until she picks. The write path refuses an unresolved mismatch (no override,
  digest-alone and `bandChoice`-alone are all refused), so the choice cannot be skipped by a stale client.
  The cross-band lookup itself (UIL-065) is unchanged. The same PR's third commit deleted the whole-haul
  bulk-commit path on her instruction (UIL-027 follow-up). **Not rendered in a browser before merge** — so
  her pass on the Annihilape-style case is the visual check. Awaiting Karvi's confirmation when UAT resumes.
- **Priority:** High (Senior BA's read; Karvi to confirm) — she's ruled on the shape of the fix, not yet
  explicitly on severity
- **Area:** Plan, Lines
- **Env:** Testing

**Not a matching bug — this is UIL-064/065's "the line's band wins" ruling, working exactly as
shipped, seen for the first time in a concrete case.** The spotlight card identity shows Annihilape's
own natural band — Purple — computed by `band(incoming.card, pc.ctx.typeColorMap)`
([`lib/plan/context.ts:209`](../lib/plan/context.ts:209) /
[`lib/plan/spotlight.ts:146`](../lib/plan/spotlight.ts:146), both feeding
`toPlanItem`'s `bandKey`). The destination and reason text ("Fills the open Stage2 slot on the
existing Orange line, in the back half") come from a **different** value —
`existing.line.colorBand` — set in the STEP 4 branch of `placeCard`
([`lib/engine/cascade.ts`](../lib/engine/cascade.ts), the #154/UIL-065 fix). Those two bands are
deliberately allowed to differ: #154 shipped "match an existing line by species alone, and a card
joining one takes the LINE's band, not its own" specifically because she ruled, on UIL-064, that she
chose where a line physically lives and the line should win. This screen is doing precisely that — the
Orange line is presumably one she built herself (UIL-056 manual creation, most likely in a non-natural
band, UIL-065's exact scenario) — and Annihilape, a Mankey/Primeape/Annihilape-chain Stage2 she's
never placed before, is the first card that's tried to join it since.

**What's actually being asked of her, not diagnosed further here: does the ruling itself need
revisiting, or is this a display problem?** Two different things could be true and would call for
different fixes:
1. She's fine with "the line's band wins" in principle but seeing "Purple card → Orange line" stated
   flatly, with no acknowledgment that they differ, reads as an error rather than a deliberate outcome
   — a wording/display fix (e.g. naming the mismatch explicitly: "this card is naturally Purple; the
   line it's joining lives in Orange").
2. She actually doesn't want a card placed into a line whose band doesn't match its own, full stop —
   which would mean reversing the UIL-064/065 precedent this shipped from, not just wording it better.

This entry doesn't guess which; that's hers to rule on, the same way UIL-064's four problems were.

**Update 2026-09-17: her ruling is in, and it's option 3 of the two this entry raised — reversal.**
Asked directly with three shapes to choose from, verbatim: **when a card's own band differs from the
band of the line it would join, the app must ASK rather than decide.** Her chosen screen, verbatim:

```
NOW HANDLING  Annihilape
  COLOUR MISMATCH - choose:
  ( ) Join PRIMEAPE line      Binder 1 - Back - Orange
  ( ) File by its own colour  Binder 1 - Front - Purple
            [ Done ]
```

**Rejected, recorded so neither gets re-proposed:** keeping the line's band and only wording the
mismatch better (this entry's option 1 above); making the card's own band win outright and no longer
offering a mismatched line at all (a stronger version of option 2). Neither of her two surviving
choices may be pre-selected as a default — she's rejecting a silent default, not picking a better one.

**What this does to UIL-065, precisely.** The cross-band **lookup** stands and UIL-065 stays Fixed for
it — a line living in another band still has to be found, and that was the real defect UIL-065 named.
What's reversed is the automatic **consequence** that followed the lookup: "a joining card takes the
line's band" was the Senior BA's own ruling under UIL-064's derive-from-the-line principle, made before
anyone had seen it play out on a real card. Seeing it concretely, she's rejected the silent part of
it. **This entry supersedes that placement-precedence half of UIL-065; UIL-065 itself is not being
reopened or corrected — the two entries now divide the behavior between them.**

**Cross-reference UIL-064 (where "the line's band wins" was originally ruled), UIL-065 (the fix that
shipped it, #154, merged `218ac0a`, and whose lookup half still stands), and UIL-061 (the same
offer-don't-decide shape: surface the choice, never silently pick for her).**

**Priority rationale.** High, per the Senior BA: it produces a suggestion she's called incorrect on the
flow she uses constantly, and the current behavior is live in her app now.

**Update 2026-09-18: built, verified against the merged diff.** PR
[#176](https://github.com/viantihu/pokemon-tcg-tracker/pull/176) (squash `4655145`, deployed on
`c6ef4c4`) ships exactly the screen quoted above: `placeCard`'s STEP 4 gains a `bandMismatch` result,
set only when an open slot's line band disagrees with the card's own natural band (the already-filled
and collection-claim paths have no destination choice to offer, so neither sets it); the Haul Plan
spotlight renders both options as radio choices with **neither pre-selected**, Done disabled until she
picks one — matching her rejection of a default exactly. Status line lands separately.

## UIL-070 — UIL-064's two unfixed parts, carried forward per her own "every report gets a number" rule after she chose to close the parent

- **Reported:** 2026-09-17 (not from Karvi directly — she ruled to close UIL-064 after being told
  plainly that two of its four selected problems were still unfixed; relayed by the Senior BA, who is
  recording that closure on her explicit instruction)
- **Status:** **Fixed** — both parts. **Part 1 (back-half placement from the Haul Plan joins a line):** PR
  [#222](https://github.com/viantihu/pokemon-tcg-tracker/pull/222) MERGED to `develop` 2026-09-19 (squash
  `ad528b8`), QA-gated on the merged tree (873 tests; removing the completeness check fails the
  pre-fix-failing case "REFUSES a bare back-half shelf (no line picked) instead of writing UIL-056's
  strand", neutralising the line join fails 7 more), confirmed **deployed** to Testing (Deploy, migrate,
  smoke, acceptance and Vercel green on `a910d83`). A back-half destination now means a picked line slot:
  the BACK HALF chip stays greyed with its reason until a line is picked, the pick travels to the server,
  and the write refuses an incomplete destination before any I/O with the reason and the remedy on
  screen ("reload the screen and pick again"). Step for Karvi when UAT resumes: on the Plan, Move a card
  to BACK HALF, pick a line slot, Done; the card should land in that slot, not as a bare strand. One test
  debt, not a hold: the Plan's own wiring of the picker prop is unpinned (QA's gate); a render assertion
  follows in the dev's next PR. **Part 2 of 2** ("it's somewhat buggy and the icons are not aligned"): PR
  [#211](https://github.com/viantihu/pokemon-tcg-tracker/pull/211) MERGED to `develop` 2026-09-19 (squash
  `17d334b`), QA-gated on the merged tree (807 tests, build; dropping the scoping class fails the new
  test), confirmed **deployed** to Testing (Deploy and Vercel green on `07b0c88`). **Found by
  measurement, not by a screenshot** — the static harness rendered the real MoveOverlay/MovePanel for six
  states against the compiled `globals.css` at 375 / 1000 / 1440: desktop had zero deviations; at phone
  width a JOIN A LINE candidate chip whose label wraps rendered its second line centred (a `<button>`'s
  default `text-align`), so the swatch on the left did not line up with the text block — line-2 start
  154.6px vs line-1 86.1px — and the sheet header dropped Close under the card name (82.8px tall). Two
  one-rule CSS fixes, each revertable alone: `.ochip { text-align: left }` (both lines now start at 81px,
  swatch at 74) and a narrow-only `.cap.movecap` reflow keeping Close on the title row (header 77px;
  control run without the class snapped back; CollHub / DecisionCard / Sync headers untouched). Only
  chips with long labels wrap, which is why it read as "somewhat" buggy. Awaiting Karvi's confirmation on
  her phone when UAT resumes: open Move on a card with a long line-candidate label; swatch and both text
  lines should align, Close should sit top-right.
- **Priority:** High (Karvi's own ruling, 2026-09-18, via Junior BA - 2 — she asked what this entry was,
  was reminded it is UIL-064's two carried-forward parts, and rated it High; the rationale below predates
  that ruling)
- **Area:** Plan, Lines
- **Env:** Testing

Two of UIL-064's four originally-selected problems (both in her own words, from that entry's ruling)
remain open. UIL-064 itself is being marked Closed on her explicit instruction, having been told what
remained — this entry exists only because her standing rule is that every report gets its own number,
not to quietly drop the two leftovers with the parent.

**1. "Being sent away from the Haul Plan" — narrowed to what survives UIL-068's fix: back-half
placement specifically, from the Haul Plan.** UIL-068 (once shipped) resolves the front-half, bulk, and
collection part of this everywhere the panel mounts, including here — see the cross-reference added to
that entry. What UIL-068 does **not** touch is the back half: UIL-056's server-side invariant correctly
still requires a line pick for any back-half placement, and the Haul Plan has no line picker at all.
Confirmed in two layers. `PlanScreen.openMove`
([`app/(ui)/plan/PlanScreen.tsx:296-318`](../app/(ui)/plan/PlanScreen.tsx:296)) builds its
`MoveTargetCard` with no `joinCandidates`, `existingLineByBand`, or `naturalBandKey`, and its
`<MoveOverlay>` call site ([`PlanScreen.tsx:597-602`](../app/(ui)/plan/PlanScreen.tsx:597)) passes no
`allowLineJoin` — so choosing the back half from the Plan spotlight still shows `MovePanel`'s
plain-move fallback text, "Back-half moves choose a line. Do this from the Lines page." Even if that
read half were wired up, the write half would silently drop the choice: `writeOverriddenCard`
([`lib/plan/commit.ts`](../lib/plan/commit.ts), confirmed repeatedly elsewhere in this log this week)
has no line side effects at all — the UIL-045 shape, a screen showing one thing and the write doing
another. This is a two-layer job, not a UX tweak. Fix direction on record: this should land as an
**extraction** of the one derivation `lib/line/load.ts`'s `buildScreenModel` already performs for the
Line screen, not a second implementation, and it should land together with whatever consumes it.

**2. "It's somewhat buggy and the icons are not aligned."** Still unaddressed — no specifics from her
by design, and no session has been able to open an authed screen to look. A layout-measurement pass on
the Move panel (static render against `globals.css`, no server/auth needed) is owed and is the only
verification available without one.

**Cross-reference.** UIL-064 (the closed parent), UIL-045 (the display/write divergence shape #1
repeats), UIL-056 (the manual line-creation UI all of this sits on top of), UIL-068 (resolves the
front-half/bulk/collection part of #1; back-half is what's left here).

**Update 2026-09-19: the picker-wiring debt named above (Part 1) is closed.** PR
[#230](https://github.com/viantihu/pokemon-tcg-tracker/pull/230) (merged `58008f9`) moves the signal to
where a static render can reach it: `MoveOverlay` now derives `allowLineJoin` from
`Boolean(card.joinCandidates)` whenever the prop is omitted, so a call site cannot silently drop what it
never had to pass, and `PlanScreen`'s card-mapping is extracted as the pure, exported `moveTargetFor` for
exactly that purpose. Mutation-tested: forcing the default to `false` fails 2 of 4 new `MoveOverlay`
cases; dropping `joinCandidates` from the mapping fails 1 of 3.

**Priority rationale.** Deliberately left unrated rather than guessed. She chose to close the parent
knowing #1 was open, which may mean she doesn't want it at all — rating it myself would assert an
intent she hasn't stated. #2 is a defect she personally observed and should not sit unrated forever,
but needs something to show her first.

## UIL-071 — She wants the grid-style search UIL-039 built for Collections used everywhere the app searches the catalog

- **Reported:** 2026-09-17 (Karvi, relayed by Junior BA - 2 — a generalization of UIL-039, not a
  separate defect). In her words: "The search throughout the app should be uniform."
- **Status:** **Fixed** — all nine call sites use the image-first grid and the text-list component is gone.
  Step 1, Collections' Log-a-card: PR [#212](https://github.com/viantihu/pokemon-tcg-tracker/pull/212)
  (squash `5e03a80`). The rest landed 2026-09-20, one PR per screen, each a one-tag swap because
  `CardResultsGrid` keeps the old component's exact `{ search, onPick, placeholder }` contract: Haul Plan
  intake [#248](https://github.com/viantihu/pokemon-tcg-tracker/pull/248) (`4de827c`); Backfill, all FIVE
  sites on that screen (the footprint was undercounted at two)
  [#249](https://github.com/viantihu/pokemon-tcg-tracker/pull/249) (`7155c8c`); Sync's unresolved-entry
  pin [#250](https://github.com/viantihu/pokemon-tcg-tracker/pull/250) (`329508d`); the Lookup tab
  [#251](https://github.com/viantihu/pokemon-tcg-tracker/pull/251) (`a4cf8e3`); then `CardLookup.tsx`
  deleted with zero references left in `lib/`, `app/` or `tests/`
  [#257](https://github.com/viantihu/pokemon-tcg-tracker/pull/257) (`4a0aab8`; typecheck and build clean
  with the module gone, 972 tests). Each swap QA-gated with a source-pinning test (at rest both components
  rendered byte-identical markup, so the tests assert the grid is the component mounted, with exactly the
  contract props) and revert-checked by swapping the tag back. All confirmed **deployed** to Testing
  (Deploy, migrate, smoke, acceptance and Vercel green on `d40159b`). Step for Karvi when UAT resumes:
  search for a card anywhere in the app (Plan intake, Lookup, any Backfill picker, Sync pin, Log a card);
  results should be image tiles, never a text list.
- **Priority:** High (Karvi's own ruling, 2026-09-18, via Junior BA - 2)
- **Area:** Plan, Lookup, Backfill, Sync, Collections
- **Env:** Testing

**Confirmed footprint, found by searching the whole app rather than trusting a partial list.** One
shared component, `CardLookup` ([`app/(ui)/_components/CardLookup.tsx`](../app/(ui)/_components/CardLookup.tsx))
— a single debounced text field against the local catalog mirror, one result list, one `onPick` — is
used at **nine call sites across five screens** (corrected 2026-09-20, see below), unchanged since
UIL-039 confirmed the same pattern there:

1. **Lookup** ([`app/(ui)/look/LookupScreen.tsx:43`](../app/(ui)/look/LookupScreen.tsx:43)) —
   "Where is my…", the standalone Lookup tab.
2. **Backfill**, front-half intake
   ([`app/(ui)/backfill/BackfillScreen.tsx:271`](<../app/(ui)/backfill/BackfillScreen.tsx>:271)) —
   "Set + number or name…".
3. **Backfill**, back-half species picker
   ([`BackfillScreen.tsx:501`](<../app/(ui)/backfill/BackfillScreen.tsx>:501)) — "Pick a species in
   this line (any stage)…".
4. **Backfill**, the StageRow's "Which printing?" picker
   ([`BackfillScreen.tsx:655`](<../app/(ui)/backfill/BackfillScreen.tsx>:655)).
5. **Backfill**, the StageRow's "Which duplicate was repurposed?" picker
   ([`BackfillScreen.tsx:686`](<../app/(ui)/backfill/BackfillScreen.tsx>:686)).
6. **Backfill**, the Specialty flat-list intake
   ([`BackfillScreen.tsx:834`](<../app/(ui)/backfill/BackfillScreen.tsx>:834)) — "Set + number or
   name…".
7. **Sync**, pinning an unresolved entry to a real catalog card
   ([`app/(ui)/sync/SyncScreen.tsx:631`](../app/(ui)/sync/SyncScreen.tsx:631)).
8. **Collections' "Log a card" modal** ([`app/(ui)/coll/CollHub.tsx:1075`](../app/(ui)/coll/CollHub.tsx:1075))
   — "Search the catalog…". This is the ONE case UIL-039 didn't touch: that fix replaced the
   collection-*builder* grid search entirely, but this separate, still-inline "log a single card into
   this collection" modal is a distinct `CardLookup` call site UIL-039 left alone.
9. **Haul Plan's own add-card intake**
   ([`app/(ui)/plan/PlanScreen.tsx:727`](../app/(ui)/plan/PlanScreen.tsx:727)) — not named in the
   relay, but the same component, found by grepping every usage rather than working from the
   relayed list alone.

**Corrected 2026-09-20: Backfill alone carries five sites, not two — found by b0 while building #249,
confirmed directly against `BackfillScreen.tsx` on develop today.** The original count (items 2 and 3
above, before this correction) missed the back-half species picker, both StageRow pickers, and the
Specialty intake — five `<CardLookup>` call sites in that one file, not two. Total footprint: **nine**,
not six.

**Not scoping a fix here — just the footprint, so whoever does isn't guessing at it.** Nine call sites,
five screens, each with a different `placeholder` and a different downstream action after `onPick`
(add to a haul draft, log into a collection, pin a sync entry, fill a backfill slot) — a uniform
front end would need to keep those nine different "what happens next" behaviors distinct even if the
search-and-pick experience itself becomes one shared grid component, the way UIL-039 built it for
Collections' builder.

**Progress, tracked here since it spans several owners' PRs; the status line above is the Senior BA's
count to keep current.** Site 1 (Collections' Log-a-card): PR
[#212](https://github.com/viantihu/pokemon-tcg-tracker/pull/212) (squash `5e03a80`, deployed). Haul Plan
intake: PR [#248](https://github.com/viantihu/pokemon-tcg-tracker/pull/248) (merged `4de827c`). Backfill,
all five sites: PR [#249](https://github.com/viantihu/pokemon-tcg-tracker/pull/249) (dev session b0,
open). Sync: PR [#250](https://github.com/viantihu/pokemon-tcg-tracker/pull/250) (dev session b0,
open). Lookup tab: branch `fix/uil-071-lookup-grid` (Full Stack Dev - 2, no PR yet). Once all nine land,
`CardLookup` has no remaining consumers and is deleted in a final PR.

**Cross-reference UIL-039** (the grid-search page this generalizes from, `/coll/search`, PR #155).

**Priority rationale.** Flagging for Claude's read and Karvi's confirmation — this is a consistency
request across five screens that already work, not a defect, so it doesn't inherit UIL-039's own
Medium by default; the scope (six call sites, not one) is worth her seeing before a priority is set.

## UIL-072 — Cards stranded in the back half by the new automatic line flow should always be movable, and she wants this stated as a standing product principle, not just fixed case by case

- **Reported:** 2026-09-17 (Karvi, screenshot of the Lines screen's "STRANDED IN THE BACK HALF · 4"
  list — Blaziken, Torchic, Ponyta, Pikachu). In her words: "I should be able to move these two cards.
  These came in from the new automatic line flow from the Haul Plan." Separately, as a standing
  instruction rather than part of the report itself: "The user should ALWAYS have the ability to move
  cards. The whole point of this app is for users to have the ability to easily view their collections.
  Convey this to the Senior BA and ensure the team is aware of this product ethos so that we can
  proactively avoid more issues."

- **Status:** **Fixed** — PR [#203](https://github.com/viantihu/pokemon-tcg-tracker/pull/203) MERGED to
  `develop` 2026-09-19 (squash `53d75f8`), QA-gated on the merged tree (794 tests, build, `globals.css`
  481/481, `lib/line` untouched; forcing `backHalfNeedsLine = false` fails 3 of 7 new tests), confirmed
  **deployed** to Testing (Vercel, migrate, smoke and acceptance all green on `32f707d`, which contains
  it). This is her 2026-09-18 ruling applied, not the ethos read literally: the back-half refusal
  (UIL-056's invariant) **stays**, but the BACK HALF chip is now natively disabled whenever no line is
  picked, with the reason in her terms on the chip — "The back half holds lines. Pick a line above to
  enable." ("below" where UIL-068 put the picker under the manual controls; "Move it from the Lines page
  to pick one." where the panel has no picker: Plan spotlight, Collections, Lookup) — and the remedy
  named: front half, collection and bulk all stay live. The disabled state is derived from the same
  predicate the server throw checks (`isMoveDestinationComplete`, probed with stand-in ids), so if the
  invariant is ever relaxed in `lib/line` the chip follows with no change here. The two old free-floating
  "needs a line" hints are gone. **Not rendered in a browser before merge**; UIL-070's measurement pass
  ran on this markup afterwards and found the chips correctly sized and centred at 375 / 1000 / 1440. The
  stranded-cards half of her report was UIL-068's mechanism and shipped in #176. Awaiting Karvi's
  confirmation when UAT resumes: open Move on a stranded card, see BACK HALF greyed with its reason,
  pick a line, see it enable.
- **Priority:** High (Karvi's own ruling, 2026-09-18, via Junior BA - 2)
- **Area:** Lines, Plan
- **Env:** Testing

**Confirmed mechanism, but which two of the four isn't resolvable from the screenshot alone — flagging
the ambiguity rather than guessing.** All four stranded cards in the list get a MOVE button
([`app/(ui)/line/LineScreen.tsx:445`](<../app/(ui)/line/LineScreen.tsx>:445)), and every one of them
opens `MovePanel` through `openMoveForUnlined`
([`LineScreen.tsx:142-154`](<../app/(ui)/line/LineScreen.tsx>:142)) with `joinCandidates` set —
`allowLineJoin={Boolean(move.joinCandidates)}` ([`LineScreen.tsx:195`](<../app/(ui)/line/LineScreen.tsx>:195))
is `true` for all of them, since `joinCandidates` is always an array (possibly empty), never
`undefined`, off `lib/line/load.ts`'s `unlinedCards` construction. So for **all four**, not just two,
moving to anywhere other than a line requires opening the collapsed "Not this — place it manually"
toggle — **this is UIL-068's exact, already-logged mechanism**, not a new one. What isn't confirmable
from here is whether she means that friction specifically, or something stronger for two particular
cards (a move that outright fails, rather than one extra click to reach). Torchic and Blaziken are the
same evolutionary chain (Torchic → Combusken → Blaziken) and both stranded together, which may be what
"these two" refers to, but that's a guess, not a finding — needs her word on which two and what
actually happens when she tries.

**Cross-reference UIL-068** (manual placement collapsed behind a toggle — the confirmed mechanism
above) **and UIL-070** (the same flow's back-half-from-Haul-Plan gap). If her experience turns out to
be stronger than UIL-068's friction — an actual failure, not extra clicks — that would be a new,
distinct defect this entry should be corrected to describe once she confirms.

**The product ethos statement, relayed to the Senior BA directly and recorded here as her own words
verbatim (see above), not paraphrased:** she wants "the user should always be able to move a card" held
as a standing principle the team designs against — not something re-litigated fix by fix. This bears
directly on UIL-064/065/068/069's whole thread: every one of those entries is, in some form, about a
line-first flow narrowing or gating her access to a plain, unconditional move. Worth reading as the one
principle underneath four separate reports rather than four unrelated complaints.

**Priority rationale.** Flagging for Claude's read and Karvi's confirmation on the specific report; the
product-ethos statement itself isn't a priority-rated bug, it's a standing constraint the team should
carry into every future design in this area.

**Update 2026-09-18: her ruling bounds the ethos, and it's narrower than "always allow the move"
alone.** Once UIL-068 ships, back half sits directly alongside front half, collection and bulk as a
peer choice — except back half is the one of the four that refuses unless a line is picked first,
because UIL-056's `applyMove` invariant throws otherwise. Put to her as three options — allow the move
and warn instead of refusing; keep refusing but stop presenting back half as if it were an enabled
peer; leave it as-is — **she chose to keep the refusal and remove the false affordance**: the back-half
chip greys out while no line is selected, with the reason stated inline, her words: "The back half
holds lines. Pick a line above to enable."

**What this means for applying the ethos going forward, stated precisely so it isn't over-read as
"never refuse a move":** her objection is to a **dead end that looks alive** — a control that appears
enabled but silently does nothing or drops the choice — not to the app declining something it
genuinely cannot honour. "Make the impossible visibly impossible, and name the enabling action" is a
legitimate answer to a movability complaint, not a violation of it. This reads consistently with her
earlier endorsement of **UIL-040**'s rebind refusal (a rebind that would orphan shelved cards is
refused, with a message naming what would be orphaned — the same shape: refuse, name the condition, no
silent drop). The principle going forward: **never gate a move behind a hidden or unexplained
condition; refusing with the condition named and the remedy visible in the same control is fine.**

**Consequences for two entries already carrying this thread, recorded here rather than editing their
own status:** **UIL-056's invariant stands** — no relaxation, confirmed not needed. **UIL-070's
back-half-from-the-Haul-Plan residual (its item 1) is unchanged by this** — that entry already framed
the gap as "the Haul Plan has no line picker at all," never as "the gate should be removed," so this
ruling confirms rather than corrects it; the fix there is still to offer the line picker, not to bypass
the invariant. The back-half-chip affordance fix itself (grey + inline reason) is assigned as a
follow-up after UIL-078.

**Cross-reference UIL-056, UIL-068, UIL-070, and UIL-040** (the precedent this ruling reads
consistently with).

## UIL-073 — There is no component-render test harness, so every UI failure state in this repo is verified by reading code, not by a test that can fail

- **Reported:** 2026-09-17 (not from Karvi — a recurring gap independently re-flagged by multiple dev
  sessions across four separate PRs; relayed by the Senior BA as worth tracking once rather than
  rediscovering repeatedly)
- **Status:** **Fixed** — PR [#261](https://github.com/viantihu/pokemon-tcg-tracker/pull/261) MERGED to
  `develop` 2026-09-20 (squash `9ae0587`), QA-gated (clean frozen-lockfile install, 994 tests, build).
  The harness now exists and is opt-in per file, so nothing global changed: `jsdom`, `@testing-library/react`,
  `@testing-library/dom` and `@testing-library/user-event` as devDependencies; a file opts in with the
  `// @vitest-environment jsdom` pragma and the `*.dom.test.ts` name; `vitest.config.mts` untouched, the
  other 129 files stay on node. Proven on two click paths that were pinned only by reading or by pure
  extraction: `CardLightbox` (image, caption, backdrop and hint clicks each close once; Escape closes;
  other keys do not; the listener is gone after unmount) and `MovePanel` through the real component
  (candidate click presses the chip, flips the reason, enables BACK HALF, Confirm hands the host the
  lineJoin; new-line path; binder change clears it). The point, in QA's mutation table: swapping the
  lightbox's dismiss for the careful guard fails 3 of 7 DOM cases while every pure and static test stays
  green; dropping `setLineJoin` from the chip fails 2 of 6 the same way. Suite time +0.65 s. QA's standing
  rule from here: an unpinned interaction claim is a gap to close with a `*.dom.test.ts` case. Nothing for
  Karvi to test; closes on evidence.
- **Priority:** Low (Senior BA's read) — nothing is known broken by this gap, and the fix touches
  shared config that would conflict with every open PR during the current freeze
- **Area:** all (test infrastructure)
- **Env:** n/a — in the repo, not a running environment

**Confirmed directly.** `vitest.config.mts` runs with `environment: "node"` and globs only
`tests/**/*.test.ts` — no `.tsx`, so a component test file wouldn't even be collected unless misnamed
into the `.ts` glob. `package.json` has no `jsdom`, `happy-dom`, or `@testing-library/*` dependency.
What component-adjacent tests exist use `renderToStaticMarkup` (confirmed across six files —
[`tests/coll/collection-fold.test.ts`](../tests/coll/collection-fold.test.ts),
[`tests/plan/band-collapse.test.ts`](../tests/plan/band-collapse.test.ts),
[`tests/plan/override-display.test.ts`](../tests/plan/override-display.test.ts),
[`tests/plan/plan-artwork.test.ts`](../tests/plan/plan-artwork.test.ts),
[`tests/plan/plan-resume-collapse.test.ts`](../tests/plan/plan-resume-collapse.test.ts),
[`tests/plan/pull-disclosure.test.ts`](../tests/plan/pull-disclosure.test.ts)) — which produces a
static HTML string and cannot dispatch a click or keypress, run an effect, or drive an async
rejection. Every failure state, hover behavior, or event handler in this app's UI is therefore
**verified by reading the component**, not by a test that can go red.

**Concrete instances, per the Senior BA, from mutation testing rather than assertion — worth recording
even though I haven't re-run the mutations myself:**

- **PR #168 (UIL-035)** — confirmed to exist and on-topic (a failed catalog search should say so). Per
  the relay: removing the `catch` that sets `CardLookup`'s `failed` state still passes its suite 5/5 —
  the failure message she'd actually see is untested.
- **PR #154 (UIL-064)** — every manual control that clears a stale `lineJoin` is verified by reading;
  QA said so explicitly in review.
- **PR #126 (UIL-038)** — the click/type/close wiring is covered only at the server and scheduler
  layers; the dev flagged this gap themselves in the PR.
- **#161** — the ordering is pinned only because the scheduler was extracted into a plain, testable
  module; the button that triggers it is never exercised.

**Distinct from UIL-029, on purpose.** UIL-029 is about a hand-written `DbClient` test double
*actively certifying wrong behaviour* — a test that passes and shouldn't. This entry is about the
*absence* of any DOM at all — there's no test to write in the first place for anything that requires a
real render, an event, or a browser API, regardless of how carefully a double is written.

**Why this is worth logging at Low rather than fixing now.** Nothing is known broken by the gap itself
— it's a blind spot, not a bug. Adding a harness touches `package.json` and the vitest config, which
would conflict with every currently-open PR (seven queued during the CI freeze) and can't sensibly land
until that clears. The devs have consistently compensated the better way already: extracting logic into
plain, `environment: "node"`-testable modules (the scheduler extraction behind #161's ordering test is
the pattern) rather than reaching for a DOM they don't have. **Why log it at all:** it's the reason
several of Karvi's UI fixes this week carry a "not visually verified" caveat, and the alternative this
repo already has — the static-layout measurement technique (render the real component to static markup
against `globals.css`, measure in a browser) — proves layout, not behaviour. Recording both options so
whoever eventually picks this up chooses with the tradeoff stated, not rediscovers it.

**Cross-reference UIL-029** (wrong-behaviour-certified, the opposite failure mode) **and UIL-021** (the
other standing Low in test infrastructure, with its own recorded counter-argument).

**Update 2026-09-19: a durable-answer pointer, from**
[`docs/root-cause-analysis.md`](../docs/root-cause-analysis.md) **RC-5, verified directly.** Confirms
this entry's own finding precisely — "No playwright, jsdom, happy-dom, testing-library or puppeteer in
`package.json`... No click, focus, layout or hydration behaviour is tested anywhere" — and recommends
adding Playwright "over the three flows where a wrong pixel becomes a misplaced physical card: haul
commit, move/override, sync preview" as the fix, rather than continuing to rely solely on the
static-layout-markup technique this entry already records.
Not built; recorded as a forward pointer alongside UIL-029's own RC-5 note (a DbClient contract suite).

**Priority rationale.** Low, per the Senior BA: no known live defect traces to this gap specifically,
and the cost of fixing it now (touching shared config mid-freeze, against seven open PRs) outweighs
the benefit of fixing it immediately rather than logging it for later.

## UIL-074 — Lines have no sort or grouping options; they render in whatever order the database happens to return

- **Reported:** 2026-09-17 (Karvi). In her words: "Lines must be sorted by binder. I want a UX where I
  can either view lines grouped by binder or in color + alphabetical order" — her stated priority,
  Medium.
- **Status:** **Fixed** — both parts. **Part 2** (Karvi 2026-09-20: "when switching to Binder, the text for
  the binder sort is not super visible"): PR [#267](https://github.com/viantihu/pokemon-tcg-tracker/pull/267)
  MERGED to `develop` 2026-09-20 (squash `ad93e81`), confirmed **deployed** (all gates and Vercel green on
  `ad93e81`). Measured cause, not the guessed one: the Lines screen renders into a shell with no
  background, so the BY BINDER heading sat as 9 px brown text on the body's olive at a 1.69:1 contrast
  ratio. It is now an inverted ink-on-panel plate, 10 px bold, spanning the row and meeting the tabs'
  top border so each binder's tabs hang from a labelled bar; harness at 375 and 1440, re-measured by QA
  on the merged tree: contrast 1.69:1 → 9.91:1 (equal to the active tab), heading box 17 → 26.5 px, no
  overflow, the COLOUR + A–Z view unchanged. CSS only; no markup change. Step for Karvi when UAT resumes:
  switch Lines to BY BINDER; each binder's name should read as a labelled bar above its tabs. She
  confirmed the COLOUR + A–Z default. **Part 1:** PR [#239](https://github.com/viantihu/pokemon-tcg-tracker/pull/239) MERGED to
  `develop` 2026-09-20 (squash `bd6156c`), QA-gated on the merged tree (924 tests, `/line` builds under
  its new Suspense boundary; loader sort removed → 2 fail, binder key dropped → 4 fail, headings
  suppressed → 1 fails; pre-fix-failing PGlite case "default: colour (seeded rainbow order) then species
  A to Z — NOT insertion order"), confirmed **deployed** to Testing (Deploy, migrate, smoke, acceptance
  and Vercel green on `678a55f`). Two views, both hers: **COLOUR + A–Z** (default; band order from
  `color_band`, then species name, case- and accent-insensitive) and **BY BINDER** (binders in creation
  order, matching the Move panel's existing order; colour + A–Z inside each; lines with no binder last
  under NO BINDER). The toggle is the app's existing two-way control at the top of the Lines screen; the
  choice lives in `?view=binder` so a reload, a move or a decision keeps it. Sorting happens in
  `buildScreenModel` via the pure `lib/line/order.ts`, not in the component. **Structural call by the
  Senior BA, flagged for Karvi:** colour + A–Z is the default; if she wants BY BINDER first, that is a
  one-line switch. Step for Karvi when UAT resumes: open Lines; lines should read in colour order then
  A to Z, and BY BINDER should group them by binder in the order the binders were created.
- **Priority:** Medium (Karvi's own read)
- **Area:** Lines
- **Env:** Testing

**Confirmed: no sort or grouping exists at all today.** `buildScreenModel`'s line-building loop
([`lib/line/load.ts:251`](../lib/line/load.ts:251)) is `for (const line of lineRows)`, where `lineRows`
comes straight from [`evolutionLineRepo.listAll(db)`](../lib/line/load.ts:113) — an unordered `listAll`,
unlike `colorBandRepo.listOrdered` two lines below it in the same call, whose name itself signals the
difference. Lines render in whatever order Postgres happens to return an unordered `SELECT`, which in
practice tracks creation order — not alphabetical, not by binder, not by colour. The screenshot she sent
shows exactly this: Cubone, Charcadet, Pawmi, Mankey, Ponyta, Timburr… no visible pattern.

**Not scoping the fix here — two view modes, both named by her, need a decision on where the toggle
lives and whether "grouped by binder" also needs a within-binder secondary sort (color + alphabetical,
presumably, mirroring the other mode) rather than being a separate, unrelated axis.**

**Distinct from UIL-073, kept separate rather than folded in.** UIL-073 is about the Haul Plan's
row order within a haul session; this is about the Lines screen's own standing organization. Different
screens, different functional requirements — the Haul Plan's order is about working through a sitting
in a physical rhythm, this is about browsing/finding a line she already built.

**Priority rationale.** Medium, Karvi's own call.

## UIL-075 — The Haul Plan's "BASICS" / "STAGE 1 · 2" subheadings inside each band have no collapse control

- **Reported:** 2026-09-17 (Karvi). In her words: "In the haul plans, the stages should also be
  collapsable" — her stated priority, Medium.
- **Status:** **Fixed** — PR [#196](https://github.com/viantihu/pokemon-tcg-tracker/pull/196) MERGED to
  `develop` 2026-09-18 (squash `517336b`), QA-gated on the merged tree (744 tests, build, `globals.css`
  478/478, fold mutations bite), confirmed **deployed** to Testing on `7381d3c`, which contains it (Deploy
  migrate/smoke/acceptance green on both; `517336b`'s own Vercel build reads "Canceled from the Vercel
  Dashboard" because the next commit's build superseded it, and `7381d3c`'s Vercel status is success).
  Each BASICS / STAGE sub-heading inside a band is now a fold button using UIL-018's exact discipline:
  folded rows are absent from the tree, not hidden; the fold state rides in the resume payload as an
  optional field so a plan parked before this reads as nothing folded; per-band-and-kind key. Dev's
  mutation check: forcing sub-groups unfolded fails 6 of 10 new tests. **Not rendered in a browser before
  merge**, so her pass is the visual check. Awaiting Karvi's confirmation when UAT resumes.
- **Priority:** Medium (Karvi's own read)
- **Area:** Plan
- **Env:** Testing

**Confirmed: UIL-018 shipped band-level fold only; this finer level was never built.**
`groupPlan` ([`lib/plan/group.ts:19-38`](../lib/plan/group.ts:19)) splits every band into up to two
subgroups labeled "BASICS" and "STAGE 1 · 2" (or "TRAINERS · ITEMS" in White) — these are the "stages"
she means. `BandSection`'s render ([`app/(ui)/plan/PlanScreen.tsx:1156-1246`](<../app/(ui)/plan/PlanScreen.tsx>:1156))
has one `collapsed` boolean per **band**, toggled by `onToggleCollapse`; once a band is expanded, its
`group.subgroups.map(...)` always renders every row in every subgroup with no per-subgroup toggle at
all — the same "always renders everything" shape UIL-018 fixed at the band level, one level down.

**Cross-reference UIL-018** (the band-level version of this same request, already shipped) **and
UIL-073** (a different axis on the same screen — this is progressive disclosure, UIL-073 is ordering).

**Priority rationale.** Medium, Karvi's own call.

## UIL-076 — The Haul Plan's worklist is not sorted alphabetically, and it needs to be

- **Reported:** 2026-09-17 (Karvi). In her words: "In the haul plan, the cards must be in alphabetical
  order" — her stated priority, High.
- **Status:** **Fixed** — PR [#200](https://github.com/viantihu/pokemon-tcg-tracker/pull/200) MERGED to
  `develop` 2026-09-18 (squash `f1b788f`), QA-gated on the merged tree, confirmed **deployed** to Testing
  (Deploy and Vercel both green on `f1b788f`). **Interpretation chosen by the Senior BA, not confirmed by
  her, and she can overrule it in one line:** the outer grouping (band → basics / non-basics) is kept,
  because the design docs call it functional and it mirrors her shelf; inside each sub-group rows now sort
  by **name alone** (Intl.Collator, numeric, so "9" sorts before "10"; ties by collector number, then input
  order), and the cascade action is dropped as an inner sort key but stays visible as the row chip. The
  alternative — action first, then name — was rejected because it would show her alphabetical runs broken
  by action label and read as "still not sorted". Footer now reads "BAND → BASIC / NON-BASIC → A–Z". If
  she wants action-first back it is a one-line comparator change. Dev's mutation check: swapping in the
  pre-fix comparator fails 5 of 16 tests including a real-cascade "Charizard ex before Charmeleon" run;
  747 tests on the rebased head. Only visual change is the footer string, not rendered in a browser. The
  three design-doc passages that still say "then action" are routed to intake. Awaiting Karvi's
  confirmation when UAT resumes.
- **Priority:** High (Karvi's own read)
- **Area:** Plan
- **Env:** Testing

**Confirmed: rows are ordered by cascade action, not name.** Inside each subgroup,
`subgroupsFor` ([`lib/plan/group.ts:28-38`](../lib/plan/group.ts:28)) sorts on
`actionOrder(a.it.action) - actionOrder(b.it.action)`, falling back only to original input order (`i`)
as a tiebreak — never on `it.name`. So two cards with the same action land in whatever order they were
typed or synced in, and cards with different actions never sort by name against each other at all.

**Update 2026-09-18: the open question above is answered — name alone, not name-within-action.** See
the status line for the shipped mechanism and the Senior BA's rationale for that choice; verified
directly against PR #200's merged diff before this was recorded there.

**Action item flagged in the status line as "routed to intake" — the specifics.** Three design docs
still describe the pre-fix inner sort and need to agree with shipped code: `docs/system-design.md:384-386`,
`docs/dev-spec.md:299-301`, and `docs/designer-brief.md:80-81` all read "...then action" / "then by
action," confirmed directly against `origin/develop`. Not edited here — those files are outside
`docs/issue-log.md`, the only file this role touches — recording the exact locations so whoever picks
this up doesn't have to re-find them.

**Priority rationale.** High, Karvi's own call.

## UIL-077 — The full printed collector number (the /denominator) is captured from TCGdex and used for search, but never shown anywhere in the app

- **Reported:** 2026-09-17 (Karvi, two reports folded into one — same functional requirement). First:
  "I need to see the FULL collectors number EVERYWHERE a specific card is referenced. There are either
  no collector numbers or it is just the digits before the /." Second, from the same session: "When
  choosing to place a stage card into the back half alongside other compatible cards in the haul, the
  full collectors number of the card must be specified" — the wishlist-alternates grid she screenshotted
  earlier (UIL-067) showing bare numbers like "1", "010", "25", "3", "14", "RC5" is exactly this case.
  Her stated priority for the first report: High.
- **Status:** **Fixed** — for the Plan, Backfill and shared type-ahead sites; PR
  [#187](https://github.com/viantihu/pokemon-tcg-tracker/pull/187) MERGED to `develop` 2026-09-18 (squash
  `d1bfce3`), QA-gated on the merged tree (731 tests, build, `formatCollectorNumber` pinned by its tests),
  confirmed **deployed** to Testing (Deploy and Vercel both green on `d1bfce3`). Root cause was one missing
  line: `set_card_count_official` is populated on all 23,548 catalog rows and already drove search ranking,
  but `toCatalogCard` never mapped it, so no screen could render it. Now mapped through and shown as
  "099/182" by one shared formatter at seven sites — Plan (draft row, worklist row, spotlight), Backfill
  (three sites) and the shared `CardLookup` type-ahead, which Collections' search inherits. A card whose set
  genuinely has no printed total (some promos and subsets; TCGdex reports null) shows the bare number by
  design, not by defect. Revert-checked: removing the adapter line fails 4 tests including her named
  `099/182` case. **Collections half landed 2026-09-19:** PR
  [#212](https://github.com/viantihu/pokemon-tcg-tracker/pull/212) (squash `5e03a80`, QA-gated, Deploy and
  Vercel green on `5e03a80`) threads `setCardCountOfficial` onto `CollectionCardView`, `BrowseCard` and
  `WishlistCard` and calls the shared formatter at every Collections site — tiles, editor target list,
  wishlist rows and ALT lists, the removal move sheet, the Log-a-card picked row, builder tiles;
  revert-checked (bare numbers restored → 2 render tests fail). **Move sheet landed
  2026-09-19:** PR [#222](https://github.com/viantihu/pokemon-tcg-tracker/pull/222) (squash `ad528b8`,
  deployed, all gates green on `a910d83`) renders the formatter in `MoveOverlay.tsx` for the Plan's Move
  sheet (render-tested for "099/182" and for a card with no total). **Every remaining site landed
  2026-09-20:** PR [#234](https://github.com/viantihu/pokemon-tcg-tracker/pull/234) (squash `4516139`;
  `CardIdentity`, `AlternateView` and `WishlistOption` now carry the set total, rendered at the Line slot
  strip, the placeholder alternates, both Line Move sheets, the Lookup header and Move sheet, and the
  decision card's header, WISHLISTING line and alternate tiles) and PR
  [#235](https://github.com/viantihu/pokemon-tcg-tracker/pull/235) (squash `f38900c`; the Sync preview's
  three candidate rows), both **deployed** (all gates green on `88c6de8`). Finding while closing the
  Move sheet: it was not the last bare site; five more were found by grep and fixed in the same pass. No
  bare collector-number render remains in `app/`. Test debt, not a hold: the Line (3) and Lookup (2)
  on-screen labels are pinned through the card handed to the Move sheet, not the label itself; Full
  Stack Dev - 2's tiny follow-up. **Closed candidate** on Karvi's confirmation when UAT resumes: any
  card, on any screen, reads "099/182" when its set has a printed total.
- **Priority:** High (Karvi's own read)
- **Area:** Lines, Plan, Lookup, Backfill, Collections
- **Env:** Testing

**Confirmed: the denominator is captured and even used for search ranking, but one mapping function
silently drops it before it reaches any screen.** `catalog_card.set_card_count_official`
([`supabase/migrations/0009_set_metadata.sql:39`](../supabase/migrations/0009_set_metadata.sql:39))
is populated correctly from TCGdex's `cardCount.official`
([`lib/catalog/mirror.ts:183`](../lib/catalog/mirror.ts:183)) and used to rank collector-number search
matches ([`lib/catalog/collector-number.ts`](../lib/catalog/collector-number.ts), UIL-026). But
`toCatalogCard` ([`lib/plan/adapt.ts:60-83`](../lib/plan/adapt.ts:60)) — the ONE function that turns a
DB row into the engine's `CatalogCard`, which every display component reads from — maps every other
column and never touches `set_card_count_official`. `CatalogCard`
([`lib/engine/types.ts`](../lib/engine/types.ts)) has no field for it at all. So the data exists,
correctly, in the database, and is provably usable (search already proves it), but no UI surface —
`CardFace`, the Haul Plan worklist, the decision card's wishlist grid, the Lines screen, Lookup — can
show it, because the one function standing between the row and every screen never carries it forward.

**One fix point, many consumers.** Adding `setTotal` (or similar) to `CatalogCard` and to
`toCatalogCard`'s return makes the data available everywhere at once; formatting it as "NNN/TTT" is
then a display-layer choice at each of the several call sites, not a data problem to solve per screen.

**Cross-reference UIL-026** (the search-side use of this same column) **and UIL-067** (her earlier
screenshot of the wishlist grid, which shows the exact symptom of this gap).

**Update 2026-09-19: the "two entry points still show the bare number" count above was itself
incomplete — checked against develop today, not just relayed.** Beyond the Line and Lookup Move sheets,
four more surfaces build from `CardIdentity` and also render the bare number, confirmed directly in each
file: the Lookup answer header
([`app/(ui)/look/LookupScreen.tsx:209-211`](<../app/(ui)/look/LookupScreen.tsx>:209)), the Line slot strip
([`app/(ui)/line/LineScreen.tsx:489-491`](<../app/(ui)/line/LineScreen.tsx>:489)), and two spots in
`DecisionCard` — the resolved card
([`app/(ui)/_components/DecisionCard.tsx:88-90`](<../app/(ui)/_components/DecisionCard.tsx>:88)) and the
wishlist alternate row (`:178`). Reported by Full Stack Dev - 2 while closing the Move-sheet site; all
four go into the same assigned `CardIdentity` follow-on rather than a new report — the fix point named
above is unchanged, just wider than first counted.

**Update 2026-09-20: the render-pin debt named in the status line above is closed.** Reverting the
LineScreen (three sites) and LookupScreen (two sites) render calls back to the bare number had left every
test green, because the Move-sheet tests pinned the card data handed to `MoveOverlay`, not the on-screen
label actually rendered. PR [#243](https://github.com/viantihu/pokemon-tcg-tracker/pull/243) (merged
`678a55f`, test-only) pins the on-screen labels themselves at both screens.

**Priority rationale.** High, Karvi's own call — this touches how she identifies which physical card is
which, everywhere the app shows one.

## UIL-078 — A Lines-screen decision she resolves does not stay resolved; the same decision resurfaces

- **Reported:** 2026-09-17 (Karvi). In her words: "Line decisions do not stick" — her stated priority,
  High.
- **Status:** **Fixed** — PR [#188](https://github.com/viantihu/pokemon-tcg-tracker/pull/188) MERGED to
  `develop` 2026-09-19 (squash `0795a29`, head `05cdcd5`), QA-gated on the merged tree (806 tests, build,
  migration-order "0013 above 12"), confirmed **deployed** to Testing (Deploy migrate/smoke/acceptance
  and Vercel all green on `0795a29`). A resolved decision now lives **on the slot**:
  `line_slot.resolved_decision_kind` / `_choice` / `_collection_id`, written when she resolves and read by
  the Lines loader, so the same question does not resurface; `placement_decision` gains `line_id` /
  `line_slot_id` as audit only and nothing reads it to decide (the load-bearing-queue concern from
  UIL-042 is respected). Its original author's session was lost mid-review; QA HELD the PR on two gaps
  found by reading the code and b0 fixed both with pre-fix-failing tests: (a) collection-vs-line
  suppression was kind-only, so a **different** collection later claiming the same card would have been
  silenced — the claiming collection id is now stored and compared; (b) nothing cleared the marker when a
  slot left filled, so a released-and-refilled slot would never ask again — `releaseSlotOps` now nulls all
  three marker columns, covering the move path, #145's pull path, #151's override path and (folded in on
  the Senior BA's call) the sync-retire path in `lib/sync/exec.ts`, which had reopened slots with its own
  inline write. Hand-offs and leave-it are not suppressed. QA's mutations: claimant compare forced true
  fails 2, marker nulls removed fails 3, sync retire reverted fails 1, and removing the patch keys from
  0013's RPC fails the two PGlite release tests — so the composed `apply_write_ops` (0013 replaces 0008's
  body plus exactly three `update_slot` patch keys) is what is under test. Migration `0013` adds columns
  only, and the Tech Lead's before/after pair says exactly that (runs `35410225042` 00:42Z →
  `35410859376` 00:53Z): all five columns ABSENT → PRESENT with **not-null 0 on every row** (56 slots,
  137 decisions), so nothing was backfilled and no decision she has never seen is suppressed; `collection`
  11 and `copy` 706 unchanged, 0 collection triggers fired. `line_slot` 50 → 56, `placement_decision`
  135 → 137, `evolution_line` 19 → 21 and `wishlist_item` 8 → 12 moved in those eleven minutes — a
  schema-only migration cannot create lines or wishlist rows, so that is her building lines in Testing,
  not the migration. Awaiting Karvi's confirmation when UAT resumes: resolve a line decision, leave the
  screen, come back, it should not ask again.
- **Priority:** High (Karvi's own read)
- **Area:** Lines
- **Env:** Testing

**Confirmed mechanism for at least one decision kind — "Collection wins," the RECOMMENDED default
choice on the collection-claim-vs-line decision card (UIL-067's screenshot).** Resolving a decision is
genuinely a server round-trip: `resolveDecisionAction` → `applyDecision` → a real write, then a fresh
`loadLineScreen` reload ([`app/(ui)/line/actions.ts:60-73`](<../app/(ui)/line/actions.ts>:60)) — so this
isn't a client-only illusion of saving. The problem is **what** gets written for this specific choice.
`resolveDecisionWrites`'s `"collection-wins"` branch
([`lib/line/decisions.ts:516-524`](../lib/line/decisions.ts:516)) writes a `wishlistUpserts` entry and
an audit `decision` row — and nothing else. **No `slotPatches` at all.** The slot's `state` stays
`"placeholder"`, unchanged, by design (the card legitimately stays a hunt).

**Why that makes the decision reappear.** `deriveAllDecisions`'s trigger for this exact decision kind
([`lib/line/decisions.ts:254`](../lib/line/decisions.ts:254)) is `slot.state === "placeholder" &&
claimed` — a running collection still claims this species, and the slot is still a placeholder, both
true again on the very next load, for the identical reason they were true the first time. Decision
`id`s are deterministic, derived from `${lineId}:${kind}:${stageIndex}`
([`decisions.ts:259`](../lib/line/decisions.ts:259)) — not a persisted row with its own "resolved" flag
— so the ONLY thing suppressing a re-shown decision is client-local React state
([`app/(ui)/line/LineScreen.tsx:50`](<../app/(ui)/line/LineScreen.tsx>:50), `resolved`, never
persisted). A fresh page load starts that map empty, and the identical trigger condition fires again:
the same decision, indistinguishable from a new one.

**Not yet checked against the other decision kinds** (`ex-only-cap`, `root-block`, `line-existing`
terminations) — this entry confirms the mechanism for one, the most common one on her screenshot; the
same "nothing changes the trigger condition" shape may or may not repeat for the others and would need
its own check before assuming it does.

**Priority rationale.** High, Karvi's own call — a decision she's already made keeps asking her again,
which both wastes her time and risks her picking a different answer the second time without noticing
it's the same question.

## UIL-079 — Two source files carry raw embedded NUL bytes, and a schema-types header comment is nine migrations stale

- **Reported:** 2026-09-19 (not from Karvi — found in a broader root-cause pass, relayed by the Senior
  BA; zero-risk repo hygiene, batched into one entry rather than three)
- **Status:** **Fixed** — PR [#218](https://github.com/viantihu/pokemon-tcg-tracker/pull/218) MERGED to
  `develop` 2026-09-19 (squash `2e0a98c`), QA-gated on the merged tree (848 tests; the new
  `harness-applies-every-migration` test fails 7 cases when the harness skips 0014), confirmed **deployed**
  to Testing (Deploy green on `2e0a98c`). Both raw `0x00` bytes are now the two-character `\0` escape
  (QA's read: zero NUL bytes remain under `lib/` on `develop`) and the `database.types.ts` header now
  says what the file is — a mirror of every migration under `supabase/migrations/`. Nothing here is
  visible in the app, so there is no UAT step for Karvi; this entry closes on evidence, not on her
  confirmation.
- **Priority:** Low (Senior BA's read) — no behavior is wrong, both fixes are text-only and mechanical
- **Area:** all (repo hygiene)
- **Env:** n/a — in the repo, not a running environment

**Confirmed directly, byte-for-byte — `grep` alone would have missed this, which is the point of
recording it.** `git cat-file blob` on both files, checked with `od -c` rather than trusting a text
tool: [`lib/sync/diff.ts:29`](../lib/sync/diff.ts:29) and
[`lib/sync/pipeline.ts:66`](../lib/sync/pipeline.ts:66) each contain one **raw, literal `0x00` byte**
embedded directly in a template literal — not the two-character escape sequence `\0`, an actual NUL byte
typed (or pasted) into the source. Both are the presence-key separator the comment right above
`diff.ts`'s occurrence names explicitly: "NUL separator can't appear in a tcgdex id or variant." The
code is very likely correct at runtime — a raw NUL byte inside a template literal and the `\0` escape
produce the identical character in the resulting string — but the raw byte makes `file` report these as
`data`, not text, which is why a plain `grep` (no `-a`) on either file silently reports nothing rather
than a match: exactly the "grep lies" symptom that makes this worth fixing rather than shrugging at.
**Fix:** replace the raw byte with the literal escape sequence `\0` (two ASCII characters) at each site
— zero behavior change, restores the files to plain text for every tool that assumes it.

**Separately, `lib/repo/database.types.ts`'s own header comment is badly stale.** It reads "Supabase
schema types for the `public` schema (migrations 0001 + 0002 + 0004 + 0005)" — confirmed against
`origin/develop`, where migrations run through at least `0013` (0014 landed the same day this was
found). The file's own instruction — regenerate via `supabase gen types typescript --local` and commit
the result verbatim — still applies; the header just never got updated to say which migrations are
actually reflected. Not touching the generated types themselves here (that needs a live database
connection this session doesn't have); recording the stale claim so it isn't read as current.

**Priority rationale.** Low, Senior BA's read — no behavior defect in either case, both fixes are
mechanical and low-risk, batched as one entry since grouping by "found in the same zero-risk audit
pass" is Karvi's own convention for entries like this, applied consistently with how UIL-029 already
absorbs multiple instances of one theme.

## UIL-080 — Backfill re-implements colour-band derivation client-side, and it can genuinely disagree with the canonical engine function

- **Reported:** 2026-09-19 (not from Karvi — found in a broader root-cause pass, relayed by the Senior
  BA)
- **Status:** **Fixed** — PR [#229](https://github.com/viantihu/pokemon-tcg-tracker/pull/229) MERGED to
  `develop` 2026-09-19 (squash `bfbda03`), QA-gated on the merged tree (881 tests; restoring the inline
  `types[0]` / literal-white derivation fails exactly the three named cases: "a Trainer with no types
  gets the TRAINER band, not Colorless's", "a Trainer with a trainerType gets that type's band", "an
  unmapped type falls back to the map's own white key, not a literal"), confirmed **deployed** to Testing
  (Deploy, migrate, smoke, acceptance and Vercel green on `bfbda03`). Backfill's front row now calls the
  engine's own `band()` on a `LookupCard` that carries the engine's derived `category` / `trainerType`
  (threaded through `toCatalogCard`, not re-spelled), and the hard-coded `"white"` fallback is the map's
  own white key (the UIL-012 lesson). **Follow-on, not done here:** Backfill and the Plan each keep their
  own `toLookupCard` producer; both gained the two fields, neither was consolidated (that needs a new
  non-server module under `app/(ui)/plan`). Step for Karvi when UAT resumes: in Backfill, a Trainer or
  Supporter row should show the Trainer band, not Colorless's.
- **Priority:** Medium (Senior BA's read)
- **Area:** Backfill
- **Env:** Testing

**Confirmed: two independent implementations of the same decision, and they can produce different
answers for the same card class, not just theoretically.** The canonical band derivation is
[`band()`](../lib/engine/bands.ts:107) in `lib/engine/bands.ts` — it calls `effectiveType(card)` first,
which special-cases `category === "Trainer"` (resolves to `card.trainerType ?? "Trainer"`, e.g.
"Supporter"/"Item"/"Stadium"/"Tool") and Energy/unknown (resolves to `"Colorless"`), **before** ever
consulting the `TypeColorMap`.
[`BackfillScreen.tsx`'s own `bandKeyForCard`](<../app/(ui)/backfill/BackfillScreen.tsx>:46) has neither
of those branches — it only receives `types: string[]` (no `category`, no `trainerType`), so it
literally cannot replicate `effectiveType`'s logic even if it tried: it just takes `types[0]` (or
`"Colorless"` if empty) and looks that up directly. For a Pokémon card the two usually agree, since
`types[0]` and `effectiveType`'s Pokémon branch resolve the same way. **For a Trainer or Energy card
they structurally cannot agree** unless `map["Colorless"]` happens to equal whatever `map[card.trainerType]`
or the engine's own resolution would have produced — which is not guaranteed and isn't checked anywhere.

**Why this matters beyond tidiness: it's the same shape UIL-012 already named.** UIL-012's white-key
problem was two places spelling one piece of domain logic differently, and one silently drifting. This
is that shape again, at the same two-owners scale UIL-012 warned would keep recurring once one canonical
function exists and a second one gets written anyway — see also UIL-013 (fixture-vs-production drift)
and UIL-033 (four independent "joining a collection" implementations), the same category of defect
appearing across this codebase's different subsystems.

**Suggested fix.** Delete `bandKeyForCard` and call the canonical `band()` from `lib/engine/bands.ts`
instead — it needs the full card (`category`, `trainerType`) threaded through rather than just
`types`, which is the actual fix, not a cosmetic rename.

**Cross-reference UIL-012, UIL-013, and UIL-033** (the same "one decision, two+ implementations" shape,
different subsystems each time).

**Update 2026-09-19: the divergence above is fixed; the producer duplication that caused it is not yet
consolidated.** PR [#229](https://github.com/viantihu/pokemon-tcg-tracker/pull/229) (merged `bfbda03`)
makes both `LookupCard` producers — `lib/plan/actions.ts`'s named `toLookupCard` and
`backfill/actions.ts`'s inline mapping — thread `category`/`trainerType` from the engine's own
`toCatalogCard` rather than re-deriving them, and the front-half row now calls `band()` directly; the
local `bandKeyForCard` this entry named is deleted. Pre-fix-failing, verified on the preparation commit
before the derivation swap: 3 of 5 new cases failed ("a Trainer with no types gets the TRAINER band, not
Colorless's", "a Trainer with a trainerType gets that type's band", "an unmapped type falls back to the
map's own white key, not a literal"). **Noted in the PR itself as a named follow-on, not done there:**
Backfill's producer remains its own inline copy of Plan's `toLookupCard`, not a call to it — the same
duplication shape, one level up the call stack.

**Priority rationale.** Medium, Senior BA's read: a confirmed, reachable divergence on real card
classes (Trainer/Energy), not a hypothetical — but Backfill is a lower-traffic screen than the Haul
Plan or Lines, and no report of a wrong band has surfaced from it yet.

## UIL-081 — Cards with no art show initials; Karvi wants a pixelated placeholder image that fits the brand

- **Reported:** 2026-09-20 (Karvi, while closing UIL-054; body written by the Senior BA because no intake
  session was on the roster)
- **Status:** **Fixed** — PR [#283](https://github.com/viantihu/pokemon-tcg-tracker/pull/283) MERGED to
  `develop` 2026-09-20 (squash `82c5988`), QA-gated on the merged tree (1064 tests, build; dropping the
  mirrored push fails 2, seeding from a constant instead of the name fails the 50-distinct case; a face with
  a sigil and no art has no button role, so UIL-036's guard holds), confirmed **deployed** to Testing
  (Deploy, migrate, smoke, acceptance and Vercel green on `82c5988`). The prototype's pixel sigil, ported:
  `lib/catalog/sigil.ts` draws a 6×6 mirrored figure seeded from the card's name, in one of the brand's
  eight band colours with translucent-ink depth cells, so two imageless cards never match and the same card
  always looks the same; `CardFace` renders it wherever there is no art (worklist, spotlight, tiles, lines,
  decision card, stand-ins), with the initials kept as a small legend; never zoomable. Harness at the three
  face sizes: the sigil sits inside the face, the legend never overlaps. Step for Karvi when UAT resumes:
  any card with no artwork, a stand-in or the `svp-203` promo, shows a small pixel figure with its initials
  underneath instead of bare letters.
- **Priority:** Medium (Karvi's own request — a brand decision on a state every screen can reach)
- **Area:** all (CardFace)
- **Env:** Testing

In her words, ruling on UIL-054: "That is fine. I want to use pixelated image placeholders so that it
fits with the brand of the app."

**Confirmed structure.** Every thumbnail in the app is one component, `CardFace`
([`app/(ui)/_components/CardFace.tsx`](<../app/(ui)/_components/CardFace.tsx>)). When `imageUrl` is
null, or the image fails to load (`onError`), it renders the card's initials on a plain block; that is
UIL-016's fallback and it is what Team Rocket's Wobbuffet (UIL-054, `svp-203`, no image upstream) shows
today. UIL-036's lightbox already treats such a face as not zoomable ("a block has nothing to enlarge"),
so a placeholder image must keep that guard: the placeholder is not art and must not open the lightbox.

**Scope.** One component, one asset or one generator. Either a single pixel-art placeholder shipped as a
static asset, or a deterministic pixel pattern derived from the card's name so two imageless cards do not
look identical; the name and collector number stay legible on or under it. Applies wherever `CardFace`
renders with no art: Plan rows and spotlight, Lines slot faces, Lookup, Collections tiles, Sync rows,
Backfill pickers. Not scoped here: fetching art from any other source.

**Priority rationale.** Medium, Karvi's own request: not a defect, but it is a stated brand call on a
state that several screens reach, and the change is contained to one component.

## UIL-082 — A manual match does not survive the next import: the row parks again as WAITING and the copy she created is proposed for retirement

- **Reported:** 2026-09-20 (found by Full Stack Dev - 1 while designing UIL-060's stand-in records and
  proven by a failing test before it was numbered; body written by the Senior BA, no intake session on
  the roster)
- **Status:** **Fixed** — PR [#270](https://github.com/viantihu/pokemon-tcg-tracker/pull/270) MERGED to
  `develop` 2026-09-20 (squash `df33430`), QA-gated on the merged tree (997 tests, sync suite 117; ignoring
  the manual match, or reverting `lib` to develop's, fails exactly the survives and precedence cases while
  "a row gone from the export still retires" stays green), confirmed **deployed** to Testing (Deploy,
  migrate, smoke, acceptance and Vercel green on `df33430`). The import path now loads RESOLVED entries
  that carry a `manual_match_id` alongside the WAITING ones and resolves a row to its manual match BEFORE
  the catalog lookup; re-importing the same export yields zero proposals of any kind for the matched row.
  Precedence as ruled: the manual match wins even when the catalog can later resolve the row; she releases
  it by dismissing or forgetting the entry, never by a sync. No migration. The Tech Lead's before-read
  (run 35477651416) showed her one manual match on Testing intact and no copy retired, so nothing needed
  recovering; the "do not re-import" warning is lifted with this deploy. Step for Karvi when UAT
  resumes: import the same export twice; a card you matched by hand should stay where you put it, with no
  new "waiting" row and no retire proposal.
- **Priority:** High (Senior BA's read, to be confirmed by Karvi) — a silent wrong result on the app's
  core write path: her explicit match is reversed by the very next sync, with no error and a plausible
  looking proposal, the exact shape UIL-062 and UIL-063 were High for.
- **Area:** Sync
- **Env:** Testing (one RESOLVED entry with a manual match exists there today); reproduced on PGlite

**Proven, not inferred.** `tests/sync/manual-match-survives-reimport.test.ts`, case "import → park →
manual match → import again: the row resolves to her match, nothing parks or retires", on real PGlite
with real RLS through `runSyncPipeline`, `executeApply` and `manualMatch`. The mirror holds `xy7-012`
(Ancient Origins); the export carries one row `xy7-99` in that set, a number the mirror lacks. Import one
parks it `UNKNOWN_CARD` (set resolved by name, card missing). `manualMatch(entry, "xy7-012")` marks the
entry RESOLVED with `manual_match_id = xy7-012` and creates one bulk copy. Importing the same export again
fails the assertion:

```
Expected { parks: [], retires: [], unchanged: 1 }
Received { parks: ["xy7-99 UNKNOWN_CARD"],
           retires: [{ kind: "retire", catalogCardId: "xy7-012", dexVariantRaw: "Normal",
                       consequence: "bulk-removed", needsReview: false }],
           unchanged: 0 }
```

So the next import (a) parks the row again as a fresh WAITING entry and (b), because no CSV row now
resolves to `xy7-012`, the reconcile proposes **retiring the copy her match created**. Her decision is
undone by the next sync, for real cards today, not only for stand-ins.

**Mechanism, confirmed in code.** `runSyncPipeline`'s import path resolves every CSV row against the
catalog only (`createPrefetchedCatalogLookup`) and loads WAITING entries only
(`unresolvedEntryRepo.listWaiting`); a RESOLVED entry's `manual_match_id` is never read anywhere in
`lib/sync` (`pipeline.ts`, `catalog-lookup.ts`, `reconcile.ts`, `diff.ts`: zero references). The column
UIL-047 C3 and `manualMatch` write is write-only.

**Fix, approved 2026-09-20.** The import resolver's first step becomes: a RESOLVED entry with this
`(dex_id, dex_variant_raw)` and a `manual_match_id` resolves to that id, before the catalog lookup.
Precedence ruling: **the manual match wins even when the catalog can later resolve the row itself**,
because it is her explicit override and a UIL-060 stand-in depends on exactly that; she releases it by
dismissing or forgetting the entry. Pinned by the test above (now the behaviour test), one for the
precedence, one that a row gone from the export still retires normally (the memory never resurrects rows
the export no longer has), and one that re-importing the same export yields zero proposals for the matched
row.

**Why it was never seen.** Every sync test imports once; UIL-047 C3's tests exercise the match and the
Forget path, never a second import; and Karvi has imported her real export once on Testing since her one
manual match. **Cross-reference UIL-060:** a stand-in record that the catalog will never resolve on its
own is fatal under this bug, which is how it surfaced.

**Priority rationale.** High: silent, reachable by the most routine action in the app (importing the
export), reverses an explicit user decision, and the failure looks like a normal proposal.

## UIL-083 — Nine Japanese sets cannot be mirrored: a "+" in the set id reaches TCGdex as a space, and a fractional Pokédex number is rejected by an integer column

- **Reported:** 2026-09-20 (found by the Senior BA in the first `locale: ja` mirror run, 35490587409,
  dispatched on Karvi's "resume"; causes confirmed read-only against TCGdex by Full Stack Dev - 1; body
  by the Senior BA, no intake session on the roster)
- **Status:** **Fixed** — PR [#286](https://github.com/viantihu/pokemon-tcg-tracker/pull/286) MERGED to
  `develop` 2026-09-20 (squash `3e2ffbd`), QA-gated on the merged tree (1074 tests, build; `toDexIds`
  reverted fails 3 cases incl. the real PCG2-067 payload; the route is grepped for `rawQueryParam(request.url,
  "set")` because reverting it to `searchParams.get` leaves the helper test green), confirmed **deployed**
  (all gates and Vercel green on `3e2ffbd`), and **proven by the resume run** (Tech Lead, run 35492136717,
  05:37Z): 73 of 73 sets that run needed, 0 failing; PCG2 82, PCG6 86, PCG7 52, PCG9 68 landed (+288 rows,
  verified per set on Testing as `ja:PCG2` … `ja:PCG9`); SM1+ … SM5+ now reach TCGdex correctly, which
  serves zero cards for each, reported as an upstream shortfall, not a failure. Fixes: the workflow
  URI-encodes the set id on the sync POST and the route reads `set` through `rawQueryParam` so a literal
  plus survives either dispatch form; `toDexIds` floors a fractional Pokédex id to its species and drops
  non-numbers; hp coercion is integer-only while prices keep decimals. No migration. Nothing for Karvi to
  test; closes on the run.
- **Priority:** High (Senior BA's read) — it blocks UIL-047, Karvi's ruling for this phase: until these
  sets mirror, part of the Japanese catalog she asked for is missing and one card class fails loudly on
  every run.
- **Area:** Catalog (mirror), Sync
- **Env:** Testing

**Two causes, one functional requirement (every Japanese set mirrors), so one entry.**

1. **Set ids containing "+" (SM1+, sm2+, SM3+, SM4+, SM5+) fail with `TCGdex /ja/sets/SM1%20 -> HTTP 404`.**
   The TCGdex client already percent-encodes path segments, so `SM1+` would reach TCGdex as `SM1%2B`
   (200) if it arrived intact. It does not: the workflow sends `?set=SM1+` raw and the route reads it
   with `URLSearchParams`, which decodes a bare `+` as a space per the URL spec, so the client encodes
   "SM1 " as `%20`. Fix at both ends: the workflow URI-encodes the set id (sends `%2B`) and the route
   reads `set` from the raw query with `decodeURIComponent`, which keeps a literal plus, so either form
   works. Pinned by a client URL test for a set id containing "+". Note for the resume run: TCGdex's
   `/ja/sets/SM1+` resource lists zero cards today, so after the fix these five land as upstream
   shortfalls ("got 0 of N claimed"), not errors.
2. **PCG2, PCG6, PCG7, PCG9 fail with `invalid input syntax for type integer: "384.1" [22P02]`.** One
   card, PCG2-067 レイカザの星 (Rayquaza ★), carries `dexId: [384.1]`: TCGdex marks the star variant with
   a fractional Pokédex number, and `catalog_card.dex_id` is `integer[]`; the whole set's upsert fails on
   that one row, three passes running. Fix in `toCatalogRow`: floor a fractional dex id to the species
   number (384.1 → 384; it is Rayquaza, which is what lines key on) and make the hp coercion
   integer-only (a decimal hp becomes null). No column, no migration. Pinned with the real payload shape.

**What the run did land.** 175 of 184 ja sets; catalog_card 36,041 = en 23,548 + ja 12,493 on the Senior
BA's read; every non-catalog count unchanged. The 64 sets that came back short of TCGdex's advertised
count, or 503'd, are upstream and resume on the next dispatch; they are not this entry.

**Priority rationale.** High, Senior BA's read: not user-visible on its own, but it is the only thing
between Karvi's "pull the Japanese catalog this phase" ruling and the catalog actually being there.
