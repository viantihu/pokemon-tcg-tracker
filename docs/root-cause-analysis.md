# Root Cause Analysis — UAT issue log UIL-001 through UIL-057

> **Read this block first (added 2026-09-19 when the document was committed).** Four findings below were
> already closed on `develop` when draft 2 was written, and the document does not know it. Do not
> schedule them again:
>
> | Finding | Status |
> |---|---|
> | RC-4 step 1 — re-derive at commit, compare with what she was shown, refuse on mismatch; "the single highest-value test in this document, fails today" | **Done** in [#121](https://github.com/viantihu/pokemon-tcg-tracker/pull/121) (UIL-045, merged 2026-09-16): the client sends a digest of the displayed placement, `commitCardPlacement` compares it against its fresh derivation and throws `PlacementChangedError` having written nothing. RC-4 step 3 (stateful forecast for the tail of the worklist) is still open; #121's description explains the cost that scoped it out. |
> | RC-2 — `saveBinder` lets capacity drop below occupancy (UIL-050) | **Done** in [#171](https://github.com/viantihu/pokemon-tcg-tracker/pull/171). |
> | RC-6b — `migration-order` runs only on `pull_request`, so a direct push skips it | **Done** in [#157](https://github.com/viantihu/pokemon-tcg-tracker/pull/157): it runs on push too. Branch protection on `develop` and `main` (2026-09-18/19) now blocks direct pushes as well. |
> | RC-5 — `tests/support/pglite-rpc.ts` frozen at 0008 | **Current** through 0013 after UIL-029 ([#189](https://github.com/viantihu/pokemon-tcg-tracker/pull/189)) and the migration PRs since. The recommendation to have it read the directory still stands; the list is maintained by hand. |
>
> Also superseded: "No session in this environment can query the Testing database" (§0). Since
> 2026-09-18 the parked `ops/read-band-config` workflow takes dispatch inputs and reports counts and
> schema shape from Testing (never card identity), so every **[L]** data claim below can be checked.
> The Tech Lead owns the RC-6b CI items (acceptance on the deploy target, `DEPLOY_ENABLED` preflight,
> the mirror's soft-pass); each is its own PR.

**Written:** 2026-09-18 · **Author:** Staff Engineer (Cowork session) · **Audience:** tech lead working in Claude Code
**Companion:** [`docs/issue-log.md`](./issue-log.md) — this document does not replace it, it explains it.
**Revision:** draft 2. Draft 1 contained fifteen factual errors, found by adversarial review and listed in
Appendix A. If you are holding a copy without that appendix, discard it.

---

## 0. How to use this document

The issue log has 57 entries. The instruction that produced this document was: *make sure we are not
accumulating technical debt and are truly solving root causes rather than patching issues as they come.* So
the unit of work below is a cause, not an entry. Each section gives you:

1. **The cause**, stated as a property of the system rather than as a bug.
2. **Verified evidence**, with file and line, checked against the code on disk.
3. **Symptoms** — the UIL entries that are instances of it.
4. **The structural fix** — the change that makes the class of defect hard to represent.
5. **Proof of fix** — a check that fails today and passes after. If you cannot write one, you have not fixed
   a cause.
6. **The tempting patch** — the local change that will look like a resolution and will not be one.
7. **What the code says back.** Several of these causes have a written rationale in the codebase defending
   the current behaviour. Those are quoted rather than ignored, because three of them are correct and two are
   correct about the wrong objective. A recommendation that has not engaged the comment sitting directly
   above the line it wants to change is not a recommendation yet.

### Evidence discipline

- **[V]** Verified against the code on disk, 2026-09-18, and re-verified after adversarial review.
- **[I]** Inferred. Consistent with the code, not directly observed. Re-check before acting.
- **[L]** Asserted by the issue log, not verified here. A hypothesis.

Draft 1 tagged several misattributions **[V]** and tagged two closed defects as live. The tags are worth
something only if they are earned, so where draft 2 downgrades or withdraws a claim it says so explicitly.

### What cannot be checked here, and what not to do

- **No session in this environment can query the Testing database.** The password and secret key exist only
  in GitHub secrets and Vercel env; nothing here surfaces them and nothing should try. Every claim about
  *data* is therefore **[L]**.
- **`reset-testing.yml` is deliberately broken.** It is destructive and Testing holds Karvi's real
  collection. Do not repair it. Do not run it.
- The tail of **UIL-013** and the whole of **UIL-031** were inventoried across a subagent range boundary.
  Read those two entries directly before asserting anything about them.

### Before you grep: pass `-a`

**[V]** Two source files contain a raw `U+0000` byte inside a template literal, used as a composite-key
delimiter and written as an actual control character rather than as an escape sequence:

- [`lib/sync/diff.ts:29`](../lib/sync/diff.ts:29) — `` return `${catalogCardId}<NUL>${dexVariantRaw}`; ``
- [`lib/sync/pipeline.ts:66`](../lib/sync/pipeline.ts:66) — `` const key = (dexId: string, variantRaw: string) => `${dexId}<NUL>${variantRaw}`; ``

`grep` and `ripgrep` therefore classify both files as binary and print `binary file matches` **instead of the
matching lines**. A content search across `lib/` silently returns zero lines from two files at the centre of
the sync reconciler. File-level matching (`grep -l`) still works; line-level does not without `-a` /
`--text`.

This is not a footnote. **Draft 1 wrote that warning and then miscounted two of its own headline figures,
because it ran an unflagged grep four paragraphs later.** Corrected counts are in RC-5. Assume any number in
the issue log that came from a `grep | wc -l` is low.

Two qualifications draft 1 got wrong. [`lib/sync/diff.ts:27`](../lib/sync/diff.ts:27) *does* name the
separator in a comment ("NUL separator can't appear in a tcgdex id or variant"), so the idiom is documented,
not smuggled. And there are two copies in the working tree but twenty-four across the repo directory, because
eleven `.claude/worktrees/*` checkouts each carry both; `eslint.config.mjs:19` ignores `.claude/**`, so that
part is cosmetic, but a grep from the repo root will hit them.

The fix is to write the byte as a unicode escape instead. No behaviour change.

---

## 1. The honest shape of the problem

Draft 1 opened by claiming 57 entries were seven independent structural causes. That claim does not survive
its own evidence, and the way it fails is worth more to you than the claim was.

**[V] One defect supplies roughly half the verified evidence in this document.** The colour-band vocabulary —
DB keys (`red`, `dark_blue`, `white`) versus engine display names (`Red`, `Dark blue`, `White`) — is the
source of RC-1's entire cast table and its thesis, RC-2's guard-coverage row, RC-3's duplicate-derivation
row, RC-5's test-fixture finding, and RC-7's lead example. Unify that vocabulary and a large fraction of the
evidence base below retires at once.

So the accurate statement is not "seven independent causes." It is:

> **Two structural causes that are one defect seen from two sides** (RC-1, the boundary does not check;
> RC-2, enforcement is opt-in), **two correctness causes they enable** (RC-3, duplicate derivation; RC-4,
> the displayed placement is not the written one), **two detection causes that let all four persist** (RC-5,
> the harness cannot reach production conditions; RC-6, failures return success-shaped values), **and one
> procedural cause that explains why they were repeatedly misdiagnosed** (RC-7).

That is a dependency graph, not a list, and it is why section 9's sequence matters more than the section
count. RC-1 is the highest-leverage single change in the document.

**[V/L] The strongest available evidence that the causes are structural: fixes expose the next defect.**
UIL-003's fix made UIL-006 and UIL-007 reachable; UIL-010's produced UIL-015 and UIL-044; UIL-014's surfaced
UIL-022 and UIL-023; UIL-020's obvious fix would have introduced a silent correctness regression, which is
why it was not applied. The `[V]` half is not separable from the log's narrative, so treat it as **[L]**. But
a codebase where local fixes are safe does not behave this way. This is the signature of an invariant that no
single call site owns.

**One thing to hold onto while reading.** This codebase is better than this document makes it sound. The read
layer is genuinely disciplined, `apply_write_ops` is a real atomic boundary, `lib/errors.ts` is a correct
solution to a subtle problem, and the comments are unusually honest about their own hazards. The problem is
not carelessness. It is that almost every rule here is held by a convention, and conventions have a
half-life.

---

## 2. RC-1 — The DB/domain boundary asserts instead of checking

**The cause.** Data crossing from Postgres into the domain model is *asserted* to have the right type, never
*checked*. Nothing distinguishes the two band vocabularies at the type level, and nothing rejects an invalid
enum value at runtime, so a wrong string travels as a correctly-typed value until something user-visible
breaks.

### Verified evidence

**[V] Zero branded or nominal types exist.**
`grep -rnaE "unique symbol|__brand|_brand|Brand<|Opaque<|Tagged<" lib app tests` returns nothing.
`catalog_card_id`, `copy_id`, `binder_id` and `tcgdex_id` are all bare `string` and mutually assignable.

**[V] `Band` is a display-name union that routinely carries DB keys.**
[`lib/engine/bands.ts:30`](../lib/engine/bands.ts:30) defines `Band` from `BAND_ORDER`
([`:17`](../lib/engine/bands.ts:17)), whose members are display names. Seven `as Band` casts move a key into
that union. Re-verified with `-a`; there is no eighth hiding in the NUL files:

| Site | Note |
|---|---|
| [`lib/engine/bands.ts:56`](../lib/engine/bands.ts:56) | in `whiteKey` |
| [`lib/engine/bands.ts:113`](../lib/engine/bands.ts:113) | in `band()`, the primary entry point |
| [`lib/engine/cascade.ts:250`](../lib/engine/cascade.ts:250) | `(inherit.colorBand as Band) ?? b` — a DB column cast into the display union |
| [`lib/backfill/resolve.ts:54`](../lib/backfill/resolve.ts:54) | |
| [`lib/line/load.ts:180`](../lib/line/load.ts:180) | |
| [`lib/line/load.ts:197`](../lib/line/load.ts:197) | |
| [`tests/plan/placement.test.ts:12`](../tests/plan/placement.test.ts:12) | `const dbBand = (key: string) => key as Band;` |

Draft 1 called that last row "the one that matters more than the other six," on the theory that the suite
encodes the conflation and therefore cannot detect it. **That was wrong, and the correction matters.** See
RC-5.

**[V] The `?? default` idiom gives false reassurance.** In [`lib/plan/adapt.ts`](../lib/plan/adapt.ts):

```ts
variant: (row.variant as Variant) ?? "normal",                      // :97   (toOwnedCopy)
role:    (row.role as Role) ?? "shelved",                           // :98
binderHalf: (row.binder_half as OwnedCopy["binderHalf"]) ?? null,   // :100
state:   s.state as LineSlotRecord["state"],                        // :119  (toEvolutionLine)
status:  line.status as EvolutionLine["status"],                    // :129
```

`??` fires only on null or undefined. A **non-null invalid** string — `"reverse_holo"` where the union
expects `"reverseHolo"` — passes through as a value the compiler now believes is a `Variant`. The fallback
covers the one case that was never the risk.

*Correction to draft 1:* it described these as a widen-then-narrow chain beginning at
[`:42`](../lib/plan/adapt.ts:42). Line 42 is `const r = raw as Record<string, unknown>;` inside
`toCardVariants` ([`:40-51`](../lib/plan/adapt.ts:40)), which coerces the `variants` **jsonb blob**, an
unrelated path. `toOwnedCopy`'s parameter is already a typed `Row<"copy">`. Two code paths were joined into
one sentence. The cast lines and the `??` critique stand; the narrative around them does not.

**[V] `lib/repo/database.types.ts` is 735 lines, hand-authored** ([`:3`](../lib/repo/database.types.ts:3) —
"HAND-AUTHORED to mirror `supabase gen types typescript --local`"). It is an assertion about the schema, not
a fact derived from it.

*Correction to draft 1:* it implied the file has drifted. It has not. `set_card_count_official` and
`set_release_date` from 0009 are present at [`:61-62`](../lib/repo/database.types.ts:61),
[`:87-88`](../lib/repo/database.types.ts:87) and [`:113-114`](../lib/repo/database.types.ts:113). Only the
file's own **header comment** is stale, still saying "migrations 0001 + 0002 + 0004 + 0005". The real finding
is narrower and still worth acting on: someone has kept this current by hand across nine migrations, and
nothing would tell you the day they stop.

### Symptoms

UIL-012, UIL-013, UIL-016, UIL-017. UIL-047 root cause C2 is the same shape one layer out:
[`lib/sync/resolve.ts:31-32`](../lib/sync/resolve.ts:31) has a `detectLocale` that correctly returns `"ja"`,
and the value then dies at a `catalog_card` schema keyed on `tcgdex_id` with no locale column at all, so a
Japanese printing cannot be stored beside its English counterpart without a PK collision.

### Structural fix

1. **Parameterise the map by its space; do not flatten it into two unions.** Draft 1 proposed `BandKey` and
   `BandName` with "one total function each way." That cannot be written.
   [`lib/engine/bands.ts:69-79`](../lib/engine/bands.ts:69) `DEFAULT_TYPE_COLOR_MAP` is display space
   (`Fire: "Red"`), production `type_color_map` rows are key space, and `band()` / `whiteKey()` are
   **deliberately space-polymorphic** ([`:42-53`](../lib/engine/bands.ts:42)). That polymorphism *is* the
   UIL-012 fix, and [`tests/engine/bands.test.ts:101-102`](../tests/engine/bands.test.ts:101) pins both
   behaviours. The correct shape is `TypeColorMap<S>` with `S` the space, so `band()` stays polymorphic and
   its return type is tied to its input. Then delete the casts. This is a real design change, not the
   "mechanical diff" draft 1 advertised.
2. **Brand the ids.** `type Id<K extends string> = string & { readonly __brand: K }` plus a constructor per
   kind. Removes a silent argument-swap class outright.
3. **Parse, do not cast, at the boundary.** One decoder per table returning `Result<T, DecodeError>` that
   rejects unknown enum values loudly.
4. **Detect `database.types.ts` drift without Docker.** Draft 1 said "generate it in CI and fail on diff."
   `supabase gen types typescript --local` needs a local Supabase stack, and this project deliberately has
   none: every DB test uses PGlite specifically to avoid Docker
   ([`tests/catalog/migration.test.ts:2-3`](../tests/catalog/migration.test.ts:2)) and
   [`ci.yml`](../.github/workflows/ci.yml) has no Supabase service. The fix that fits the project: apply the
   migration directory to PGlite, introspect `information_schema`, assert the column set matches
   `database.types.ts`. Same guarantee, no Docker, and it reuses the harness that already exists.

### Proof of fix

- `grep -rna "as Band" lib app tests` returns nothing.
- A test feeding `{ variant: "reverse_holo" }` through the adapter asserts it **throws**. Fails today.
- A PGlite introspection test fails when a migration adds a column `database.types.ts` lacks.

### The tempting patch

Adding `"dark_blue"` and friends to the `Band` union so both spellings are legal. Every current error
disappears and the conflation becomes permanent.

### What the code says back

Nothing defends the casts. [`lib/plan/adapt.ts:8`](../lib/plan/adapt.ts:8) opens with a "BAND SPACE" note
directly above them, and [`lib/engine/cascade.ts:378`](../lib/engine/cascade.ts:378) carries the correct rule
("stays in the caller's band space instead of minting the literal `White` (UIL-012 …)"). The authors know.
They wrote it down instead of encoding it, which is RC-2.

---

## 3. RC-2 — Enforcement is opt-in, so invariants live in prose

**The cause.** Rules are stated in comments and enforced by function calls the next author must remember. A
comment cannot fail a build, and a guard that must be invoked protects only the call sites someone thought
of.

### Verified evidence

**[V] `assertBandConfig` guards one of six sites that build the thing it validates.** Draft 1 said "1 of 3
context loaders." The real denominator is worse and is the better argument. Six sites construct a
`typeColorMap` from `typeColorMapRepo` rows; exactly one guards it:

| Site | Guarded? |
|---|---|
| [`lib/plan/context.ts:150`](../lib/plan/context.ts:150) | **yes** — [`:156`](../lib/plan/context.ts:156) |
| [`lib/backfill/context.ts:49`](../lib/backfill/context.ts:49) | no |
| [`lib/line/load.ts:118`](../lib/line/load.ts:118) | no |
| [`lib/sync/pipeline.ts:307`](../lib/sync/pipeline.ts:307) | no — and a grep without `-a` will not show you this line |
| [`app/(ui)/settings/actions.ts:156`](<../app/(ui)/settings/actions.ts>:156) | no |
| [`app/(ui)/coll/actions.ts:92`](<../app/(ui)/coll/actions.ts>:92) | no |

**[V] `assertPlacementBandsConfigured` has two call sites across eight write paths, and that is much less
serious than draft 1 claimed.** The two are [`lib/plan/commit.ts:106`](../lib/plan/commit.ts:106) and
[`:161`](../lib/plan/commit.ts:161); the definition is [`:174`](../lib/plan/commit.ts:174). Draft 1's table
implied the other six write paths can store an invalid band. **They cannot.** The invariant is already a
database constraint, in exactly the place this section argues invariants belong:
[`supabase/migrations/0002_domain.sql:38`](../supabase/migrations/0002_domain.sql:38),
[`:120`](../supabase/migrations/0002_domain.sql:120) and
[`:159`](../supabase/migrations/0002_domain.sql:159) all declare `text references color_band (band)`. The
guard exists to turn an opaque `23503` into a sentence naming the card, which
[`lib/plan/commit.ts:174-181`](../lib/plan/commit.ts:174) says outright. So this row is about **error
quality**, not correctness. Downgraded, and the downgrade is load-bearing: a tech lead told that six write
paths are unguarded will go add six calls and fix nothing.

**[V] A genuinely missing write-path invariant: UIL-050.** `saveBinder`
([`app/(ui)/settings/actions.ts:56-95`](<../app/(ui)/settings/actions.ts>:56)) writes `pages`,
`pockets_per_page` and `back_half_start_page` ([`:65-70`](<../app/(ui)/settings/actions.ts>:65)) with no
check that currently shelved copies still fit — `pages: Math.max(0, …)` even permits zero. Capacity drops
below occupancy and the UI renders `shelved > capacity`. This one the database could hold and does not.

**[V] Three of draft 1's five "prose hazard" citations were wrong, and the error was instructive.** Recorded
because inheriting them would waste your time:

- `lib/repo/base.ts:87-94` "this SILENTLY TRUNCATES" — **the string does not exist in `lib/` or `app/`.**
  Lines 87-94 are `pageAll`'s paging loop. The real comment is at
  [`lib/repo/base.ts:40-54`](../lib/repo/base.ts:40): "Guards a 'read everything' query against PostgREST's
  silent `max-rows` truncation (UIL-031)" — describing a hazard that is **enforced**. It was evidence for the
  opposite conclusion.
- `lib/line/write.ts:11-12` "No cross-statement transaction" — **also does not exist.**
  [`:12-19`](../lib/line/write.ts:12) says the reverse: "**ATOMICITY.** `applyMove` is now ONE transaction …
  all-or-nothing (UIL-023)." The real hazard comment is [`:21-25`](../lib/line/write.ts:21), and it is a
  deliberate, PR-flagged exception: `applyDecision` stays un-transacted because `wishlist_item` can only be
  INSERTed through the RPC (0006), never patched.
- `lib/repo/catalog-lookup.ts` — **the file does not exist.** `lookupCatalog` is a server action at
  [`app/(ui)/plan/actions.ts:49`](<../app/(ui)/plan/actions.ts>:49). There is no "same-pass alias drain"
  comment and no doc comment documenting a defect as intent.

Draft 1's "roughly 25 hazards documented but unenforced" is therefore **withdrawn**. It was never enumerated,
and three of five specimens were fabrications. What remains verified is the guard-coverage table above and
UIL-050. If you want the real number, enumerate it; do not inherit it.

### Structural fix

- **Make the guard part of construction.** If a `PlanContext`, and a `typeColorMap`, is only obtainable from
  a factory that runs `assertBandConfig`, none of the six sites can skip it. This is the fix for the one row
  that survived review.
- **Do not fold `assertPlacementBandsConfigured` into `applyWriteOps`.** Draft 1 recommended this. It is not
  implementable: the guard's signature is `(payload: WritePayload, pc: PlanContext)` and it needs
  `pc.orderedBandKeys` and `pc.catalogById`, while `applyWriteOps`
  ([`lib/repo/write-ops.ts:202`](../lib/repo/write-ops.ts:202)) is `(db, payload)` and twelve lines of pure
  RPC dispatch. The six non-plan callers have no `PlanContext` to give it. Folding it in means either giving
  `applyWriteOps` I/O or hand-threading a context through six call sites, which is the decaying coverage this
  section is against. Since the FK already holds correctness, the right move is to improve the **error
  translation** at the RPC boundary: map `23503` on a `color_band` FK to a readable message once, in
  `lib/errors.ts`, where every caller already passes.
- **Put the remaining invariants where the DB can hold them.** `shelved > capacity` is a check constraint or
  a trigger. So is the locale collision in RC-1.
- For anything genuinely un-encodable, convert the comment into a failing test, so it lands in CI rather than
  in prose.

### Proof of fix

- A seventh `typeColorMap` construction site that skips `assertBandConfig` **fails to compile**.
- A test that shrinks a binder below its shelved count asserts `saveBinder` rejects.
- A test asserting an FK violation on `color_band` surfaces a message naming the card.

### The tempting patch

Adding the five missing `assertBandConfig` calls by hand. It resolves today's instances and leaves opt-in
enforcement fully intact, which is the fix shape that produced the UIL-003 to UIL-006/007 and UIL-014 to
UIL-022/023 chains.

---

## 4. RC-3 — Several implementations of the same decision

**The cause.** Important operations are implemented more than once. While the duplicates agree the app works;
when one is edited they diverge, and nothing compares them because there is no shared definition to compare
against.

### Verified evidence, with draft 1's counts corrected

**[V] Write to the DB: 8 `applyWriteOps` call sites.** Confirmed exactly, with `-a`, no ninth:
[`plan/commit.ts:107`](../lib/plan/commit.ts:107), [`:162`](../lib/plan/commit.ts:162),
[`backfill/commit.ts:154`](../lib/backfill/commit.ts:154), [`coll/remove.ts:277`](../lib/coll/remove.ts:277),
[`line/write.ts:87`](../lib/line/write.ts:87), [`sync/exec.ts:330`](../lib/sync/exec.ts:330),
[`:403`](../lib/sync/exec.ts:403), [`:494`](../lib/sync/exec.ts:494).

**[V] Derive a colour band: three implementations, not four.**
[`lib/engine/bands.ts:107`](../lib/engine/bands.ts:107) `band()`;
[`lib/backfill/resolve.ts:29-32`](../lib/backfill/resolve.ts:29) `bandKeyForTypes`, whose own comment at
[`:26`](../lib/backfill/resolve.ts:26) admits it "Mirrors the engine's `band()`";
[`app/(ui)/backfill/BackfillScreen.tsx:45-48`](<../app/(ui)/backfill/BackfillScreen.tsx>:45)
`bandKeyForCard`, a client-side copy of server logic.

Draft 1's fourth, [`app/(ui)/coll/actions.ts:95`](<../app/(ui)/coll/actions.ts>:95), is
`band(toCatalogCard(row), typeColorMap) ?? "white"` — **a call into the shared engine function**. That is the
choke point working as intended, and it was cited as evidence against itself. Of draft 1's "minted
literals," [`lib/plan/group.ts:25`](../lib/plan/group.ts:25) is a `bandKey === "white"` comparison for a
subgroup heading and [`lib/sync/preview.ts:107`](../lib/sync/preview.ts:107) is an `UNKNOWN_CARD` fallback
constant. Neither mints a band. The real duplication is the backfill pair, and the client-side copy is the
sharp end of it.

**[V] Build the op payload: four named builders plus three inline sites, and they are partly shared.**
Named: [`plan/commit.ts:213`](../lib/plan/commit.ts:213),
[`backfill/commit.ts:43`](../lib/backfill/commit.ts:43), [`coll/remove.ts:102`](../lib/coll/remove.ts:102),
[`line/move.ts:190`](../lib/line/move.ts:190). Inline `const ops: WriteOp[] = []`:
[`sync/exec.ts:153`](../lib/sync/exec.ts:153), [`:360`](../lib/sync/exec.ts:360),
[`:434`](../lib/sync/exec.ts:434). Draft 1 said "5 builders, none shared." **"None shared" is wrong.**
`placementForMove` (definition [`lib/plan/commit.ts:385`](../lib/plan/commit.ts:385), placement columns at
[`:393`](../lib/plan/commit.ts:393)) is consumed by three call sites:
[`plan/commit.ts:264`](../lib/plan/commit.ts:264), [`line/move.ts:191`](../lib/line/move.ts:191) and
[`coll/remove.ts:103`](../lib/coll/remove.ts:103), with a dedicated test at
[`tests/coll/remove-from-collection.test.ts:484`](../tests/coll/remove-from-collection.test.ts:484). The
consolidation this section recommends is already underway. Extend it; do not announce it.

**[V] The un-transacted surface is always reachable.** `createRepo`
([`lib/repo/base.ts:138-229`](../lib/repo/base.ts:138)) exposes raw `insert` / `update` / `remove` to every
caller, so `applyWriteOps` is a convention rather than a boundary. Live bypasses:
[`lib/line/write.ts:138-205`](../lib/line/write.ts:138) `applyDecision` (deliberate, reason at
[`:21-25`](../lib/line/write.ts:21));
[`app/(ui)/settings/actions.ts:195-198`](<../app/(ui)/settings/actions.ts>:195) (unbounded `Promise.all`
fan-out of individual updates);
[`app/(ui)/coll/actions.ts:286-326`](<../app/(ui)/coll/actions.ts>:286) `logCardIntoCollection` (three
sequential writes plus the read-modify-write in RC-6).

### Symptoms

UIL-014, UIL-022, UIL-023, UIL-032, UIL-033, UIL-040, UIL-048, UIL-053. UIL-045 was filed here in draft 1
and has moved to RC-4, because it is not this.

### Structural fix

1. **One band derivation.** Delete `bandKeyForTypes` and `bandKeyForCard`; have the backfill paths call
   `band()`. The client copy is the urgent half: it will drift the moment the engine changes, and nothing in
   CI compares them.
2. **Extend `placementForMove`** rather than building a fourth placement shape.
3. **Close the bypass.** Narrow `createRepo`'s return type so raw `insert`/`update`/`remove` are unreachable
   from feature code, with an explicit escape hatch for the two documented exceptions. As long as they are
   reachable, every choke point is advisory.
4. **Bound the fan-out** at `settings/actions.ts:195-198`.

### Proof of fix

- Exactly one function in the repo maps card type to band, and the client imports it.
- A feature module importing raw `insert` fails typecheck.

---

## 5. RC-4 — The placement she is shown is not the placement that gets written

**The cause.** For a card she has not overridden, the haul screen shows a forecast and the commit writes an
independently derived result. The two can disagree, and the disagreement is **by design**, which makes this a
requirements error rather than an oversight, and moves it out of RC-3.

This is the highest-stakes finding in the document, so it gets the fullest treatment.

### Verified evidence

**[V] The commit does not receive what she saw.** `commitCardPlacement`
([`lib/plan/commit.ts:138`](../lib/plan/commit.ts:138)) takes `card: DraftItem`
([`:144`](../lib/plan/commit.ts:144)), not the `PlanItem` rendered to her. It loads a fresh context
([`:152`](../lib/plan/commit.ts:152)) and re-runs the cascade ([`:153`](../lib/plan/commit.ts:153)).

**[V] The forecast is computed against pre-haul state.** `planFromDraft`
([`lib/plan/context.ts:200-221`](../lib/plan/context.ts:200)) loops `placeCard(incoming, pc.ctx)` and never
mutates `pc.ctx` between cards. Every row on the haul screen is computed as if no other card in the haul
existed.

**[V] Correction to draft 1, and it changes the diagnosis.** Draft 1 presented "never mutates `pc.ctx`
between cards" as a finding about the commit path. On the commit path it is **vacuous**:
[`lib/plan/commit.ts:151`](../lib/plan/commit.ts:151) is `const draft = [input.card]`, so the loop body runs
exactly once. It is a property of the **forecast** path
([`app/(ui)/plan/actions.ts:97`](<../app/(ui)/plan/actions.ts>:97)). Draft 1 had the right defect attached to
the wrong mechanism, which is the RC-7 failure mode operating inside the RC-7 document.

**[V] The divergence is documented and intentional.**
[`app/(ui)/plan/actions.ts:151-156`](<../app/(ui)/plan/actions.ts>:151): *"The plan's remaining rows are a
FORECAST either way — `commitCardPlacement` re-derives each card's placement server-side at write time, so
what gets written is never stale even when what is displayed has drifted."* And
[`lib/plan/commit.ts:128-132`](../lib/plan/commit.ts:128) argues the per-card re-read makes cross-card
threading unnecessary: *"each card is planned against a context re-read from the database … Reality is the
mirror."*

### Why the rationale is coherent and still wrong

That reasoning optimises **"never write a stale value."** For a normal CRUD app it is correct. For this app it
is the wrong objective function, because of a property of the domain the comment does not account for:

**the display is not a report, it is an instruction.** She reads the row and puts a physical card into a
physical binder. So the requirement is not "never write a stale value," it is **"never tell her a location
you are not going to write."** Under the current design the database and the write agree with each other, the
audit trail is clean, nothing errors, and the card is in the wrong binder. There is no surface anywhere that
can detect it afterwards.

**[V] The most common trigger is the most ordinary case.** Two copies of one card: the first forecasts "front
half," the second re-derives at commit to "duplicate, bulk box," because by then the first is a real row.
**[L]** The log reports the same shape for two cards of one evolution line.

### An alternative cause draft 1 did not consider

The stale row survives a commit for a specific, deliberate reason: `shelveCardAction`
([`app/(ui)/plan/actions.ts:158-189`](<../app/(ui)/plan/actions.ts>:158)) returns a post-write `stamp`
([`:184`](<../app/(ui)/plan/actions.ts>:184)) so the client can **roll its resume cache forward** instead of
discarding a half-worked plan (UIL-006). [`:151-153`](<../app/(ui)/plan/actions.ts>:151) says so explicitly.
Under that reading the minimal fix is cache invalidation at one call site, not a re-architecture, and the cost
of the alternative is stated at [`lib/plan/commit.ts:134-136`](../lib/plan/commit.ts:134): re-planning "loads
the full plan context per card, and that context pages the whole catalog mirror." Draft 1 labelled re-planning
"the tempting patch" without engaging that cost. It is a real cost and it interacts with RC-5's scale
findings.

### Structural fix

1. **Re-derive and compare; refuse to write silently on mismatch.** At commit, recompute, diff against the
   `PlannedCard` she was shown, and if they differ, **stop and show her both** before writing. This preserves
   "never write a stale value" and adds "never contradict the instruction you gave her." It is small, local,
   and testable, and it should be first.
2. **Do not write the displayed payload.** Draft 1 offered this as an equally acceptable option. It is not.
   [`lib/line/write.ts:8`](../lib/line/write.ts:8) states the rule: a resolution re-derives from fresh state
   and **"never trusts a client write payload."** Writing the displayed `PlannedCard` makes placement
   client-authoritative; under RLS a crafted payload writes an arbitrary `binder_id`, `color_band` or
   `line_slot_id`. Withdrawn.
3. **Then make the forecast stateful,** so the screen is internally consistent before any commit. This is
   where the catalog-paging cost lands, so it needs the scoped `loadPlanContext` that
   [`lib/plan/commit.ts:135-136`](../lib/plan/commit.ts:135) already flags as becoming load-bearing. Sequence
   it after step 1, not instead of it.

### Proof of fix

A test that plans two copies of the same card in one haul, commits both, and asserts that for each card the
written placement equals the displayed placement, or that the commit refused. **This test fails today and is
the single highest-value test in this document.**

### The tempting patch

Reloading the plan after each commit so the screen refreshes. It hides the divergence behind a re-render, and
the card she was holding was already placed.

---

## 6. RC-5 — The harness cannot reach the conditions that produce the defects

**The cause.** The suite is green, extensive, and cannot reproduce production. Draft 1 overstated this badly
in two places; the corrected version is narrower and still serious.

### Verified evidence

**[V] There is no browser, DOM, or end-to-end layer.** No playwright, jsdom, happy-dom, testing-library or
puppeteer in `package.json`; [`vitest.config.mts`](../vitest.config.mts) is `environment: "node"`. No click,
focus, layout or hydration behaviour is tested anywhere. This is the finding that survived review intact, and
it is the one that explains why UIL-007, 016, 018, 019, 025 and 037 all reached Karvi before anyone else.

**[V] Correction: render coverage is real.** Draft 1 said "5 assertions over `renderToStaticMarkup`." It is
**five test files** — `plan-resume-collapse`, `override-display`, `band-collapse`, `plan-artwork`,
`collection-fold` — containing **38 `it()` blocks, 109 `expect()` calls and 13 `renderToStaticMarkup` call
sites.** "5 assertions" would have read as licence to discount existing coverage. Build on it.

**[V] Correction: the suite does not encode the band conflation.** Draft 1's most confident RC-1 claim was
that `tests/plan/placement.test.ts:12` means the suite cannot detect the conflation.
[`tests/engine/bands.test.ts`](../tests/engine/bands.test.ts) tests both spaces explicitly and catches
exactly the UIL-012 candidate: [`:100-103`](../tests/engine/bands.test.ts:100) asserts
`whiteKey(DB_KEY_MAP) === "white"` **and** `whiteKey(DEFAULT_TYPE_COLOR_MAP) === "White"`;
[`:116-127`](../tests/engine/bands.test.ts:116) asserts `bandPosition` scores keys and display names
identically; [`:147-152`](../tests/engine/bands.test.ts:147) asserts
`assertBandConfig({ ...DB_KEY_MAP, Trainer: "White" }, DB_BAND_KEYS)` **throws**, with the comment "The exact
UIL-012 candidate." `placement.test.ts:12` is one fixture cast feeding a band-agnostic pass-through, and its
comment at [`:10-11`](../tests/plan/placement.test.ts:10) says it deliberately mirrors production. Withdrawn.

**[V] Hand-written `DbClient` doubles are unverified against Postgres.** The harness says so, verbatim, at
[`tests/support/pglite-client.ts:6-9`](../tests/support/pglite-client.ts:6): *"A fake DbClient proves a module
emits the ops the author expected; it cannot prove those ops do what the author expected once Postgres runs
them … (UIL-012 shipped through a fully green suite exactly that way)."* UIL-029 is the same shape: two tests
passed while the bug was live.

**[V] Correction: most hardcoded migration lists are load-bearing.** Draft 1's step-one recommendation was
"delete every hardcoded migration list," with the proof of fix "adding `0010_*.sql` requires no test edits."
That would break three tests that exist precisely to pin a prefix:

- [`tests/repo/collection-mode-migration.test.ts:20-26`](../tests/repo/collection-mode-migration.test.ts:20)
  — `PRE_MIGRATIONS` is 0001-0004 under the comment "The full frozen chain up to (but not including) the
  migration under test," then applies `0005_collection_mode.sql` and asserts the backfill. A directory read
  applies 0005-0009 up front and the test means nothing.
- [`tests/repo/promote-collection.test.ts:400`](../tests/repo/promote-collection.test.ts:400) —
  `freshDb(MIGRATIONS.slice(0, 5))`, asserting `/migration histories differ[\s\S]*MISSING: 0006, 0007/`.
- [`tests/catalog/migration.test.ts:17`](../tests/catalog/migration.test.ts:17) — omitting 0003 is deliberate
  per its header ([`:1-6`](../tests/catalog/migration.test.ts:1)): it proves "0004 applies on top of the
  frozen 0001+0002." Draft 1 called this "0003 is skipped entirely," as if accidental.

Only [`tests/support/pglite-rpc.ts:16-24`](../tests/support/pglite-rpc.ts:16) and
[`tests/backfill/binder-section.test.ts:27`](../tests/backfill/binder-section.test.ts:27) plausibly want the
directory read. A test that pins a prefix **must** change when the prefix definition changes; that is the
point of it.

**[V] Correction: the 0008 freeze is decay risk, not a live gap.** `pglite-rpc.ts` does stop at
`0008_collection_removal_ops.sql` while `0009_set_metadata.sql` is deployed, so RPC atomicity tests run a
0008 schema. But 0009 adds **two nullable columns to `catalog_card`**
([`0009_set_metadata.sql:22-26`](../supabase/migrations/0009_set_metadata.sql:22): "BOTH NULLABLE,
deliberately"; "POPULATED BY THE MIRROR, NOT HERE") and touches no RPC. Draft 1 bolded this beside genuinely
dangerous findings. The harness header at [`:4`](../tests/support/pglite-rpc.ts:4) self-identifies as a
snapshot. Real risk, wrong magnitude.

**[V] Correction, preserved from draft 1, about PGlite `count`.** An earlier pass reported that PGlite
computing `count` as `rows.length` means `assertReadComplete` can never fire, framed as an unaddressed gap.
The harness documents it deliberately: the count *is* accurate because the SQL runs with no LIMIT/OFFSET, and
cap-firing coverage is delegated to
[`tests/repo/truncation-detection.test.ts`](../tests/repo/truncation-detection.test.ts) "against a fake that
models the cap explicitly instead."

### Scale, folded in

Draft 1 made this a separate root cause. It is a subcase of harness fidelity: its only verified content is
code consequences already cited elsewhere, its data claims are **[L]**, and its fix and proof are both
test-fixture changes.

**[V]** [`supabase/seed.sql:31-46`](../supabase/seed.sql:31) holds exactly **3** catalog cards (`sv03-026`,
`sv03-027`, `sv01-084`). **[L]** Testing holds roughly 23,548 cards, 214 sets and 702 copies; the log's line
is *"'works with three cards in the catalog' has never been evidence of anything in this app."*
**[V]** Code consequences: the PostgREST 1000-row cap that `assertReadComplete`
([`lib/repo/base.ts:56`](../lib/repo/base.ts:56)) and `pageAll` ([`:73`](../lib/repo/base.ts:73)) exist for;
[`lib/repo/catalog-card.ts:61-72`](../lib/repo/catalog-card.ts:61) chunking at 100, sized for **URL length**
rather than row count; the unbounded fan-out at `settings/actions.ts:195-198`; and the catalog-paging cost
that RC-4's step 3 has to pay.

**[V] Credit, so you do not rewrite working parts.** The read layer is the most disciplined part of this
codebase. `assertReadComplete` **throws** rather than returning short
([`lib/repo/base.ts:56-64`](../lib/repo/base.ts:56)) and is wired into `list`
([`:154`](../lib/repo/base.ts:154)); `pageAll` / `listAll` page past the cap
([`:73`](../lib/repo/base.ts:73), [`:161`](../lib/repo/base.ts:161)); and there are **no** direct
`db.from(...)` calls outside `lib/repo/`.

**[V] And here is draft 1's own grep failure, corrected.** Draft 1 reported "33 `.list(` and 19 `.listAll(`
call sites." With `-a` the real figures are **37** and **21**. The suppressed lines were
[`lib/sync/pipeline.ts:98`](../lib/sync/pipeline.ts:98), [`:299`](../lib/sync/pipeline.ts:299),
[`:301`](../lib/sync/pipeline.ts:301) and [`:113`](../lib/sync/pipeline.ts:113) — four read sites in the sync
reconciler, i.e. in the subsystem draft 1 had just finished calling the most placement-destructive in the app.
Any audit of read breadth must start from 37, not 33.

### Structural fix

1. **Add one browser-level layer.** Playwright over the three flows where a wrong pixel becomes a misplaced
   physical card: haul commit, move/override, sync preview. This is the single largest gap in the project's
   verification story.
2. **Contract-test the doubles.** One suite run twice, once per `DbClient` implementation; a double that
   diverges from PGlite fails. This is the direct answer to what `pglite-client.ts:6-9` admits.
3. **Make `pglite-rpc.ts` read the directory** (and `binder-section.test.ts:27`). Leave the three
   prefix-pinning tests alone, and add a comment to each saying why it is hardcoded, so the next auditor does
   not file it as debt.
4. **Raise fixture scale.** A fixture whose catalog exceeds 1000 rows, exercised by the plan and sync flows.

### Proof of fix

- `playwright` in `package.json`, and at least one test driving a real click through a commit.
- The contract suite exists and passes against both `DbClient` implementations.
- Adding `0010_*.sql` requires edits **only** to tests that pin a prefix, and each of those says why.
- A catalog fixture above 1000 rows is green through plan and sync.

---

## 7. RC-6 — Failures return success-shaped values

**The cause.** At most layers the failure path returns something indistinguishable from a legitimate result.
An empty array is a valid answer. HTTP 000 is a number. A skipped job is green.

This is two causes wearing one slogan, and draft 1's bundling is what let two bad fixes through. They are
separated here because they have different mechanisms, different fixes, and, importantly, the CI half is
**partly deliberate with written rationale** while the application half is not.

### 7a. Application layer

**[V]** [`app/(ui)/plan/actions.ts:56-58`](<../app/(ui)/plan/actions.ts>:56) — `catch { return []; }`.
**[V]** [`app/(ui)/backfill/actions.ts:48-50`](<../app/(ui)/backfill/actions.ts>:48) — the same.
**[V]** [`app/(ui)/look/LookupScreen.tsx:33-35`](<../app/(ui)/look/LookupScreen.tsx>:33) —
`catch { setAnswer(null); setNotFound(true); }`. An infrastructure failure is rendered to Karvi as a
**factual claim about her collection**: "you do not own this card." *Not found* and *lookup failed* must be
different states in the type, not the same boolean.

**[V]** [`app/(ui)/coll/actions.ts:308-311`](<../app/(ui)/coll/actions.ts>:308) — read-modify-write on an
array column: `const targets = col.target_catalog_card_ids ?? []; … [...targets, tcgdexId]`. Loses writes
under concurrency, without erroring.

**[V] Correction: the atomic op you need already exists.** Draft 1 said "add an atomic array append to the
RPC." `union_collection_targets` shipped in **0007**
([`0007_backfill_ops.sql:20`](../supabase/migrations/0007_backfill_ops.sql:20),
[`:253`](../supabase/migrations/0007_backfill_ops.sql:253)), is typed at
[`lib/repo/write-ops.ts:179`](../lib/repo/write-ops.ts:179), built by `collectionTargetJoinOp`
([`lib/line/move.ts:154-158`](../lib/line/move.ts:154)), and [`lib/line/move.ts:148`](../lib/line/move.ts:148)
says it "unions SERVER-SIDE in one statement." The fix is "use the op that exists," which is a much smaller
change than "add one." Draft 1 also claimed this read-modify-write reproduces "the exact orphan bug
`lib/coll/remove.ts` exists to prevent"; `lib/coll/remove.ts` exists for UIL-014 removal symmetry
([`:6`](../lib/coll/remove.ts:6), [`:15`](../lib/coll/remove.ts:15)). Withdrawn.

**[V] `union_collection_targets` writing nothing when no row matches** is real and is stated in the code at
[`lib/line/write.ts:104`](../lib/line/write.ts:104). Upgraded from **[L]** to **[V]**.

**[V] Correction: `PostgrestError` is fixed, and draft 1 listed a closed defect as live.**
[`lib/errors.ts`](../lib/errors.ts) exists for exactly this. [`:4-9`](../lib/errors.ts:4): "supabase-js
rejects with a `PostgrestError`, which is a PLAIN OBJECT … So `String(err)` renders the literal text
`[object Object]`." [`:17-22`](../lib/errors.ts:17) `asMessageBearing` does a structural, non-`instanceof`
check; [`:41-48`](../lib/errors.ts:41) appends `code`/`details`/`hint`. Wired into `plan/actions.ts:136`,
`:187`, `settings/actions.ts:93`, `:202`, `coll/actions.ts:324`. **Withdrawn, and this was the most dangerous
class of error in draft 1**, because a tech lead sent to fix a solved problem loses the time and learns to
distrust the document.

**[V] The lint rule draft 1 proposed catches none of this.** `no-empty-catch` does not exist; ESLint has
`no-empty` with `allowEmptyCatch`, and it flags **empty** blocks only. All three catch blocks above are
non-empty (`return []`, `setNotFound(true)`). The rule would produce zero findings and a false sense of
closure. What you want is a `no-restricted-syntax` selector on catch clauses whose body only returns a
literal, or, better, a ban on the pattern that becomes trivial once actions return `Result`.
[`eslint.config.mjs`](../eslint.config.mjs) confirms no custom rules exist today.

**Fix.** Server actions return `Result<T, AppError>`; the UI renders "could not load" as a third state
alongside empty and populated. Route the array append through `collectionTargetJoinOp`.

### 7b. CI/CD

**[V]** [`deploy.yml`](../.github/workflows/deploy.yml) gates all three jobs on
`vars.DEPLOY_ENABLED == 'true'` (lines 42, 216, 434). If the variable is unset the workflow reports **green
having deployed nothing**.

**[V] The real acceptance hole is not the one draft 1 found.** `acceptance` carries a **second** condition at
[`:216`](../.github/workflows/deploy.yml:216): `github.ref_name == 'develop'`. **A deploy from `main` skips
acceptance entirely.** That is a larger gap than the `needs:` edge, and draft 1 missed it.

**[V] Draft 1's `needs:` fix would manufacture the defect this section opens with.** `smoke` is
`needs: migrate` ([`:433`](../.github/workflows/deploy.yml:433)), and draft 1 said make it
`needs: [migrate, acceptance]`. [`:206-213`](../.github/workflows/deploy.yml:206) is a rebuttal draft 1 did
not quote: *"`smoke` is `needs: migrate`, NOT `needs: acceptance`, so a red acceptance never suppresses the
migration or health-check signal … An advisory notice buys a green check that asserts nothing."* Adding
`acceptance` to `needs` makes a red acceptance turn smoke into a **skipped** job, and this section's own
thesis is that a skipped job is green. Withdrawn.

**[V]** [`ci.yml:19`](../.github/workflows/ci.yml:19) — `migration-order` runs only
`if: github.event_name == 'pull_request'`, so a direct push to `develop` or `main` skips the collision check.
**But do not just delete the guard**, which is what draft 1 said.
[`ci.yml:31`](../.github/workflows/ci.yml:31) passes `"origin/${{ github.base_ref }}"`, and `base_ref` is
empty on a push; [`scripts/check-migration-order.mjs:19`](../scripts/check-migration-order.mjs:19) is
`process.argv[2] ?? "origin/develop"`, so the **truthy** string `"origin/"` wins,
`git ls-tree … origin/` fails, and `execFileSync` throws. Deleting the guard as written turns **every push
red**. The guard needs replacing with a per-event base ref.

**[V]** [`catalog-mirror.yml`](../.github/workflows/catalog-mirror.yml) — `|| printf '\n000'` at lines 92 and
279 turns a curl failure into HTTP 000. **[V] But draft 1's headline mechanism here is false.** It claimed
line 254's `::warning::` is followed by an `exit 0` "byte-identical to the output of a broken read." The
failed-resume branch does `cp set-ids.txt remaining.txt` at
[`:255`](../.github/workflows/catalog-mirror.yml:255), so `[ ! -s remaining.txt ]` at
[`:258`](../.github/workflows/catalog-mirror.yml:258) is false and the `exit 0` is **unreachable from that
path**. The workflow even carries the counter-argument at
[`:252-253`](../.github/workflows/catalog-mirror.yml:252): *"Do NOT quietly fall back to a presence-free full
run without saying so — the whole reason UIL-004 went unnoticed is a step that degraded silently."* The
residual real defect is narrow and still worth fixing: a `::warning::` yields a green job.

**[V]** [`.husky/pre-commit`](../.husky/pre-commit) is `pnpm lint-staged` only, and `lint-staged` runs
`eslint --fix` + `prettier --write`, i.e. it **mutates** staged files rather than rejecting them. No
typecheck, no tests.

**[V] Credit.** `deploy.yml:186` reads `supabase_migrations.schema_migrations` back and `comm -23`s local
against applied. The acceptance job's "Prove the suite actually ran" step
([`:407`](../.github/workflows/deploy.yml:407), [`:415`](../.github/workflows/deploy.yml:415)) fails on
`numTotalTests == 0` or `numPendingTests > 0`. Both are exactly right, applied in two places out of many.

**Fix.**

1. **Gate `acceptance` on the deploy target, not on `develop`.** Highest-value CI change here.
2. **Fail on missing configuration** rather than vanishing. `DEPLOY_ENABLED` unset should be a red
   misconfiguration, **but add a `workflow_dispatch`-only escape hatch first**, because it is currently the
   only off switch for a workflow that touches Production and every fork and var-less branch would go red.
   Draft 1 called this "the single highest leverage line in this document" without noticing it removes the
   kill switch.
3. **Replace `migration-order`'s event guard** with a per-event base ref (`github.base_ref` on PRs, the
   merge-base on pushes), and change the script's `??` to a real emptiness check.
4. **Turn every soft-pass into a failure,** and distinguish "nothing to do" from "could not determine whether
   there was anything to do." Today they are one exit path.
5. **Leave `smoke: needs: migrate` alone** unless you first make a skipped job red.

### Proof of fix

- A test that makes the DB throw and asserts the lookup screen shows an error state, not "not found."
- Unsetting `DEPLOY_ENABLED` turns the pipeline red, and `workflow_dispatch` still works.
- A `main` deploy runs acceptance.
- Pointing the mirror at an unreachable host turns the job red.
- A push to `develop` with a migration collision turns CI red; a push without one stays green.

---

## 8. RC-7 — The diagnostic process accepts a narrowing as a premise

**The cause.** When a defect is investigated, the first plausible location becomes the search space, and
subsequent passes verify *within* it instead of re-testing it. A confirmation is cheaper than a falsification,
so the search terminates on the first agreement.

### Evidence from the log

**[L, from the log]** UIL-012 was narrowed twice toward the configuration tables, with three consecutive
sessions agreeing, and none asked *does `copy.color_band` have a second writer?* UIL-017 was checked by asking
"was line N edited?" rather than "can the bad output still occur?" — the first question is about the patch,
only the second is about the defect. UIL-029 was investigated in `pending.ts` because that was the file the
failing test was named for; the ordering lived in `copy.ts`. UIL-020 evaporated because no one owned it.

### Evidence from this document

Draft 1 is the best available case study, which is why Appendix A exists. It:

- wrote a tooling warning about NUL-suppressed greps and then miscounted two headline figures with an
  unflagged grep;
- cited a file that does not exist, and two comments whose text does not exist, one of which said the
  **opposite** of what it was cited for;
- presented two **closed** defects (`PostgrestError`, the atomic array append) as live;
- claimed the test suite could not detect the band conflation when a dedicated test detects exactly it;
- attached a real defect (RC-4) to a mechanism that is vacuous on the path it was attributed to;
- counted a function's *caller* as a duplicate *implementation* of it, in the section about duplication;
- and recommended four fixes that were unimplementable, self-defeating, or would have reddened CI.

Every one of those errors has the same shape: a plausible framing was adopted and then evidence was gathered
*inside* it. None were caught by re-reading. All were caught by one pass that was told to falsify rather than
to check.

### Structural fix

A checklist, not code. Before an entry is marked resolved:

1. **Name the second writer.** For any defect involving a stored value, enumerate every writer of that column
   and state the number. If the answer is one, show the grep — **with `-a`**.
2. **Quote the comment above the line you are changing.** Three of draft 1's bad recommendations were sitting
   directly beneath a written rationale that refuted them. If a comment defends the current behaviour, the fix
   must say why the rationale does not hold. Twice here it did not hold because it optimised the wrong
   objective, which is a real and statable answer.
3. **Ask whether the bad output can still occur,** not whether the identified line changed. Re-running the
   original reproduction is the only acceptable evidence.
4. **Write the test before the fix and watch it fail.** UIL-012 and UIL-029 both shipped green; a test
   authored after a fix encodes the fix rather than the requirement.
5. **Check whether the defect is already closed** before scheduling work on it. Two of draft 1's were.
6. **Have one pass whose job is falsification,** with an explicit instruction that agreement is failure. It
   found fifteen errors in a document that had already been self-reviewed.
7. **Record confidence per claim, and let claims be downgraded.** The log is careful about status and not yet
   careful about the difference between *observed* and *reasoned*. Most wrong narrowings were reasoned claims
   later read as observed ones.
8. **Every open entry has an owner.**

---

## 9. Suggested sequence

Draft 1's sequence had three dependency breaks, so this one is more conservative. Detection before
correctness, and nothing that weakens a gate immediately before changing what the gate protects.

1. **Zero-risk, high-clarity.** Replace the two raw NUL bytes with unicode escapes. Fix the stale header
   comment on `database.types.ts`. Add "why this list is hardcoded" comments to the three prefix-pinning
   migration tests, and make `pglite-rpc.ts:16-24` and `binder-section.test.ts:27` read the directory. No
   behaviour change, and it makes everything below greppable and auditable.
2. **RC-4 step 1 — re-derive and compare, refuse on mismatch.** Highest user-facing stakes: it silently
   desynchronises the database from the physical binders, it is worst for duplicates, and it is the one defect
   here that gets *harder* to repair the longer it runs, because every card placed under it is a wrong row
   nobody flagged. It is also small and local, which is why it goes before the type work rather than after
   it. Draft 1 put a client-authoritative variant of this at step 3, and that would have opened an RLS hole;
   use the compare-and-refuse form only.
3. **RC-6a — application-layer silence.** `Result` types, the third UI state, and route the array append
   through `collectionTargetJoinOp`. Until failures are visible you cannot tell whether anything below worked.
4. **RC-6b — CI, in this order:** gate `acceptance` on the deploy target; add the `workflow_dispatch` escape
   hatch; *then* make `DEPLOY_ENABLED` unset fatal; fix `migration-order`'s base ref. Do the CI work before
   the schema-adjacent type work in step 5, so the migration gate is trustworthy when you start changing the
   type layer.
5. **RC-1 — the boundary.** `TypeColorMap<S>`, branded ids, decoders, PGlite introspection for
   `database.types.ts`. Expect a large diff and expect it to reveal conflations that currently typecheck.
   Note that `tests/plan/placement.test.ts:12` cannot be fixed before this: there is nothing to fix it *to*
   until the space parameter exists, and switching the fixture to display names beforehand would remove the
   production mirroring its comment exists to preserve. Draft 1 sequenced that edit first; do not.
6. **RC-2 — construction-time guards,** and error translation for the `color_band` FK. After RC-1, so the
   guards check a type system that means something.
7. **RC-3 — consolidate.** One band derivation (delete the client copy first), extend `placementForMove`,
   narrow `createRepo`.
8. **RC-5 — Playwright, the `DbClient` contract suite, the 1000-plus-row fixture.** Then RC-4 step 3, the
   stateful forecast, which needs the scoped context and is the change most likely to need the new fixture.
9. **RC-7 runs throughout,** not at the end.

---

## 10. The one-paragraph version

The app has a well-designed domain model, a disciplined read layer, a real atomic-write RPC, a correct
solution to a subtle error-rendering problem, and unusually honest comments. What it does not have is a
mechanism that makes a rule true. Types assert where they should check, enforcement is opt-in, a few
operations have several implementations, the placement she is shown is re-derived rather than honoured, the
harness runs in an environment that cannot reproduce the conditions under which any of this breaks, and
failures return values shaped like success. Those are not seven independent problems: one colour-band
vocabulary supplies about half the evidence, and the detection gaps are why the rest survived several rounds
of fixing. UIL-001 through UIL-057 are what that combination looks like from the outside. Fixing entries one
at a time will keep working and will keep producing the next entry, because the fixes land on the instances
and the causes are in the mechanisms.

---

## Appendix A — What draft 1 got wrong

Kept so a stale copy is identifiable, and because the pattern is itself RC-7 evidence. Each correction was
verified against the code before being accepted.

**Fabricated or misattributed citations.** `lib/repo/base.ts:87-94` "this SILENTLY TRUNCATES" — string does
not exist; the real comment is at `:40-54` and it describes an **enforced** guard. `lib/line/write.ts:11-12`
"No cross-statement transaction" — does not exist; `:12-19` says the opposite; the real exception is at
`:21-25`. `lib/repo/catalog-lookup.ts` — **file does not exist.** `lib/plan/commit.ts:249-252` cited as the
`placementForMove` pattern — that range is haul-id logic; the real lines are `:264`, `:385`, `:393`.
`lib/plan/adapt.ts:42` described as the start of a widen-then-narrow chain — it is a separate function
coercing a jsonb blob. `lib/sync/resolve.ts:32` described as typing a row — it is a `detectLocale` return.

**Closed defects presented as live.** `PostgrestError` rendering `[object Object]` — solved by
`lib/errors.ts` and wired into five call sites. "Add an atomic array append to the RPC" —
`union_collection_targets` has existed since 0007.

**Miscounts.** `.list(` is 37 and `.listAll(` is 21, not 33 and 19, because the counting grep lacked `-a`
(`lib/sync/pipeline.ts:98`, `:299`, `:301`, `:113` were suppressed). Band derivations are 3, not 4 —
`app/(ui)/coll/actions.ts:95` *calls* `band()`. Render tests are 38 `it()` blocks and 109 `expect()` calls,
not "5 assertions." Op builders are 4 named plus 3 inline, and `placementForMove` **is** shared by three
consumers, so "none shared" was wrong. `assertBandConfig`'s denominator is 6 `typeColorMap` construction
sites, not 3 context loaders.

**Wrong conclusions.** The suite does **not** encode the band conflation:
`tests/engine/bands.test.ts:100-103`, `:116-127` and `:147-152` test both spaces and catch the exact UIL-012
candidate. `catalog-mirror.yml`'s `::warning::` does **not** fall through to `exit 0`; `:255` makes it
unreachable. The 0008 test freeze is harmless today, since 0009 adds two nullable columns and no RPC.
`database.types.ts` has **not** drifted; only its header comment has. UIL-045's "never mutates `pc.ctx`
between cards" is vacuous on the commit path (`lib/plan/commit.ts:151`), and the forecast/write divergence is
**documented and deliberate**, which makes it a requirements error rather than an unnoticed duplication.

**Bad recommendations.** Folding `assertPlacementBandsConfigured` into `applyWriteOps` — not implementable,
and the FK at `0002_domain.sql:38/:120/:159` already holds the invariant. Writing the displayed
`PlannedCard` — makes placement client-authoritative, violating `lib/line/write.ts:8`. `no-empty-catch` — the
rule does not exist and would match none of the cited blocks. `smoke: needs: [migrate, acceptance]` —
converts a red acceptance into a skipped, therefore green, job. Deleting `migration-order`'s event guard —
reddens every push, because `github.base_ref` is empty and the script's `??` lets `"origin/"` through.
"Delete every hardcoded migration list" — three of five are load-bearing. "Generate `database.types.ts` in
CI" — needs Docker, which the project deliberately avoids. Making `DEPLOY_ENABLED` unset fatal — removes the
only kill switch on a Production-touching workflow, with no replacement. Two flat band unions with total
converters — the maps are deliberately space-polymorphic, so the type must be parameterised instead.

**Missed entirely.** `acceptance` is gated on `github.ref_name == 'develop'`
([`deploy.yml:216`](../.github/workflows/deploy.yml:216)), so a `main` deploy skips it. That is a larger hole
than anything draft 1 found in that file.
