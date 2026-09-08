# Pokémon TCG Binder — Developer Implementation Spec

**Version 1.0 · 2026-09-07**
**Audience:** the Claude Code session(s) that will build the application on the existing scaffold.
**Author:** solution architect. **Status:** ready to build, two kickoff gates open (§3, §7).
**Start here:** [`kickoff-checklist.md`](kickoff-checklist.md) — run it before any feature code.

---

## 0. How to read this spec

This is the *build order and contract*, not the product definition. It sits on top of four
upstream docs that are authoritative for **what** the system does. This doc is authoritative
for **how and in what order** it gets built.

| Concern | Authoritative source |
|---|---|
| Product, domain model, routing cascade, line engine | [`system-design.md`](system-design.md) |
| Dex → app reconciliation, diff algorithm, identity | [`sync-architecture.md`](sync-architecture.md) |
| Sync surfaces: unresolved queue, preview/apply/undo | [`sync-ui-spec.md`](sync-ui-spec.md) |
| Source control, branching, environments, CI/CD | [`devops-strategy.md`](devops-strategy.md) |
| Visual design, screens, palette, interactions | [`design/prototype.html`](design/prototype.html), [`design/mockups.html`](design/mockups.html), [`design/rationale.md`](design/rationale.md) |

**Conflict rule.** If this spec disagrees with an upstream doc on a *fact* (a rule, a data shape,
a CSV column), the upstream doc wins and this spec has a bug — flag it, do not silently diverge.
If this spec makes a *build-sequencing or interface* call the upstream docs left open, this spec
wins.

**Standing project rules that override convenience** (from repo `CLAUDE.md` and the design docs):

- **Every example / seed / fixture card must be a real card.** Verify collector numbers, types,
  rarity, and illustrator against the live TCGdex API before writing them. Fabricated numbers have
  broken the design three times already (a "Fire" Charizard ex that is actually Darkness, etc.).
- **Store ids exactly as TCGdex returns them.** Zero-padding is not consistent across eras
  (SV/SWSH pad to 3 digits, XY/SM do not). A "normalized" id 404s the image URL.
- **`dexId` is the species key, never the name.** Names carry owner prefixes and forms
  ("Cynthia's Gible", "Dark Charizard", "Type: Null").
- **Coarse location is a feature.** Binder + half + derived color band. Do **not** reintroduce
  pocket-level or page-level slot addressing under any refactor.

---

## 1. Current state of the repo (what you inherit)

Do **not** re-scaffold. This exists and is green:

- **Next.js 16 (App Router) + React 19**, TypeScript strict, Tailwind v4, pnpm.
- **Supabase clients** (`lib/supabase/client.ts`, `server.ts`), Zod env contract (`lib/env.ts`).
- **CI/CD** (`.github/workflows/ci.yml`, `deploy.yml`), Husky + lint-staged, Dependabot.
- **PWA manifest** (`app/manifest.ts`), health route (`app/api/health/route.ts`).
- **Migration `0001_init.sql`** — baseline only (enables `pgcrypto`). **No domain schema yet.**
- **Sync engine, partially built** in `lib/sync/`:
  - `types.ts` — `DexRow`, `DEX_CSV_COLUMNS`, `ResolvedDexId`, `PresenceKey`, `SyncClass`. Done.
  - `resolve.ts` — deterministic Dex-`Id` → TCGdex resolution (set-code drift, localId padding,
    `jpn_`/`ja` locale, `SET_ALIAS_SEED` incl. `me25→me02.5`). Done and tested.
  - `csv.ts` — UTF-16LE + BOM, semicolon-delimited parse. Done.
  - Tests: `tests/sync/csv.test.ts`, `tests/sync/resolve.test.ts`.

Everything in §5 phases M1–M10 is unbuilt.

---

## 2. Module architecture

Keep non-UI logic pure and out of `app/`. Server routes and React components are thin callers of
`lib/`. This is what makes the cascade and sync engines unit-testable without a browser or a DB.

```
app/
  (ui)/                      # route groups per screen (plan, look, line, coll, binders, settings, backfill, sync)
  api/
    health/route.ts          # exists
    catalog/sync/route.ts    # M2 — trigger/refresh the catalog mirror (server-only, service role)
    sync/route.ts            # M4 — accept a Dex CSV, run reconciliation, return a preview
  ...
lib/
  env.ts                     # exists
  supabase/                  # exists (client + server)
  catalog/                   # M2 — TCGdex client, mirror sync, cardClass derivation, artwork hashing
    tcgdex.ts                #   typed fetch client (no key)
    mirror.ts                #   upsert catalog cards into DB
    classify.ts              #   cardClass: standard | specialty
    artwork.ts               #   perceptual hash -> artworkGroupId
  engine/                    # M3 — PURE placement logic, zero I/O
    bands.ts                 #   TypeColorMap, band ordering, band(card)
    cascade.ts               #   the ordered routing cascade (system-design §5)
    line.ts                  #   viability test + slot generation (system-design §6)
    duplicate.ts             #   duplicate key + holo-swap decision (system-design §3)
  sync/                      # exists (M1 finish) — reconciliation
    types.ts resolve.ts csv.ts   # done
    catalog-lookup.ts        #   resolve ResolvedDexId -> catalogCardId against the mirror
    reconcile.ts             #   PresenceGroup / Copy count reconciliation (sync-arch §1.5, §1.6)
    diff.ts                  #   desired-vs-current snapshot diff + idempotency (sync-arch §1.7)
  repo/                      # M1 — data-access layer over Supabase (one module per aggregate)
supabase/
  migrations/                # 0001 exists; 0002+ per phase
  seed.sql                   # real cards only, verified
tests/                       # mirror lib/ structure; engine + sync are the priority suites
```

**Hard boundary:** `lib/engine/*` and `lib/sync/{reconcile,diff}.ts` must be **pure functions** —
inputs in, decisions out, no Supabase, no fetch, no `Date.now()` passed implicitly (inject clocks/
prices). All I/O lives in `lib/repo/`, `lib/catalog/`, and route handlers. Every merged phase must
keep `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` green (this is the CI gate).

---

## 3. Architectural decisions (locked here — flagged for veto)

The upstream docs left these open. As solution architect I am resolving them so engineers are
unblocked. **Each is marked `[DECIDED — vetoable]`; Karvi can overturn any of them at kickoff.**
Two of them (auth, line-binder assignment) shape stored data, so raise them explicitly (§7).

1. **Front-half color band stored as a zone.** `[DECIDED — vetoable]` **Yes, store it.** `Copy`
   carries a derived `colorBand`. It is computed from card type (free, no data entry) and narrows a
   lookup from half a binder to a page or two. Recompute on `TypeColorMap` change. *(system-design §10)*

2. **Unowned same-color root.** `[DECIDED — vetoable]` **Placeholder + wishlist**, symmetric with
   the forward direction. If a same-color previous stage *exists in the catalog* but is unowned, the
   root slot becomes a `placeholder` and a `WishlistItem` is generated. A `block` is reserved for the
   case where **no** same-color card exists at all. Low-risk, reversible. *(system-design §6, §10)*

3. **Line binder assignment when several binders have room.** `[DECIDED — vetoable, raise at kickoff]`
   **Phase 1: place the new line in the active binder** (`isActive = true`), falling back to the
   binder with the most free back-half capacity if the active one is full. This matches her stated
   "one binder in progress" habit and is the least constraining. "Keep all lines of a color together"
   is deferred to phase 2 — it is the most useful long-term but over-commits the physical layout now.
   Store the chosen binder on `EvolutionLine.binderId` so a later policy change is a re-place, not a
   migration. *(system-design §10)*

4. **Auth.** `[DECIDED — vetoable, raise at kickoff]` **Supabase magic-link, single allow-listed
   email, RLS on every table.** The data is irreplaceable and the app is on the open web, so it needs
   *a* gate; magic-link is the lowest-friction real auth and needs no password store. All domain
   tables get RLS keyed to the owner. This affects stored data (owner column) so it is a gate, not a
   silent call. *(devops-strategy §12)*

5. **Testing data refresh.** `[DECIDED]` **Reset Testing from `seed.sql` on every `develop` deploy.**
   Testing is throwaway; determinism beats sticky state for reconciliation trials. *(devops §12)*

6. **Custom domain.** `[DECIDED]` **Defer.** Ship on the Vercel URL; revisit before PWA-install
   polish (M10). *(devops §12)*

7. **Stack.** Already resolved in the repo — Supabase + Vercel is committed (README, migrations,
   clients exist). The devops "confirm stack" gate is **closed**; do not reopen the client-only fork.

---

## 4. Cross-cutting requirements (apply to every phase)

- **Migrations are forward-only and ordered.** Never edit a merged migration; add `000N_*.sql`.
  Every schema change ships as its own reviewed migration.
- **RLS on from the first domain table.** No table ships without a policy (decision §4).
- **Audit trail is not optional.** `PlacementDecision` (system-design §4) is written on every
  automated or user placement, with `reason` and `resolvedBy`. It is the only way to debug the
  cascade and answer "why did this card end up in bulk."
- **Idempotency.** Catalog sync and CSV reconciliation must be safe to re-run — both derive from a
  snapshot diff against a desired end-state (sync-arch §1.7). Re-importing the same CSV reproduces
  the same diff and changes nothing.
- **Real-card discipline in tests.** Fixtures are *tiny real-CSV slices* and *verified* catalog
  cards, never the full personal export and never fabricated numbers. Never commit a real Dex CSV.
- **Test priority order:** `lib/sync/{reconcile,diff,catalog-lookup}` and `lib/engine/*` first —
  these are the rules most likely to regress and hardest to catch by eye. UI gets smoke/interaction
  tests, not exhaustive coverage.
- **Definition of Done (per phase):** acceptance criteria met · unit tests for the phase's pure
  logic green · `typecheck`/`lint`/`test`/`build` green · migration (if any) applies cleanly to a
  fresh DB and to Testing · docs/README updated if a contract changed · lands on `develop` via PR.

---

## 5. Phased build plan

Phases are ordered by dependency. M1→M2→M3 build the testable core with no UI. M4 finishes sync.
M5–M9 are the screens (design-driven, prototype is the reference). M10 hardens for production.
Each phase is a `feature/*` branch → PR → `develop`.

### M1 — Domain schema + data-access layer

**Goal:** every entity in system-design §4 and the sync tables in sync-ui-spec §C exist in Postgres
with RLS, plus a thin typed repo layer.

**Deliverables**
- Migration `0002_domain.sql`: `catalog_card`, `copy`, `binder`, `evolution_line`, `line_slot`,
  `wishlist_item`, `collection`, `binder_block`, `haul`, `placement_decision`, and config
  (`color_band`, `type_color_map`). Plus sync tables: `presence_group`, `unresolved_entry`
  (`WAITING/RESOLVED/DISMISSED`), `set_alias` (`(locale, dex_code) → tcgdex_set_id`),
  `last_sync_snapshot`.
- `copy.dex_variant_raw` (identity) **and** the derived five-flag `variant` (display) both stored
  (sync-arch §1.4; sync-ui-spec §C).
- `binder_section` as a **view** (derived per system-design §4: capacity, shelvedCount, blockPockets,
  openPlaceholders, freePockets), not a table.
- RLS policies on all tables (decision §4). Owner column where needed.
- `lib/repo/*` — typed CRUD per aggregate; generated Supabase types checked in.
- `seed.sql`: the prototype's real cards (OKUBO 31, SABOTERI CITYSCAPE 74, the RALTS SVI-084
  Matsuno example, the Charmander/Charmeleon OBF line) — **all verified against TCGdex first**.

**Acceptance**
- Fresh DB → `0001`+`0002` apply clean; `seed.sql` loads without FK errors.
- `color_band` holds all 10 bands **including empty Pink**, ordered; band position is preserved at
  zero cards (system-design §4). `type_color_map` matches the confirmed table exactly.
- RLS denies an unauthenticated read on every domain table (test).

### M2 — Catalog mirror (TCGdex)

**Goal:** a local mirror of the ~23.5k English catalog, refreshable, with `cardClass` and
`artworkGroupId` derived. This makes the cascade instant and enables duplicate detection.

**Deliverables**
- `lib/catalog/tcgdex.ts` — typed client (no key). Must support the two line-engine queries
  server-side: `?evolveFrom=<name>&types=<type>` (verified working) and full card records.
- `lib/catalog/mirror.ts` — paginated fetch + upsert into `catalog_card`. Idempotent. Stores ids
  **exactly** as returned. Scheduled refresh + on-new-set.
- `lib/catalog/classify.ts` — derive `cardClass = specialty` for ex/V/VMAX/VSTAR/GX/Radiant/Prime/
  full art/illustration rare/gold; else `standard` (system-design §4).
- `lib/catalog/artwork.ts` — perceptual hash (dHash or pHash, low-res, **artwork region only**,
  not the full card) → cluster into `artworkGroupId`; store the raw hash alongside for re-tuning
  without a full re-sync; manual merge/split override (system-design §10 resolved).
- `app/api/catalog/sync/route.ts` — server-only trigger (service role, never client).

**Acceptance**
- Mirror populates and re-runs without duplicating rows.
- Holo and reverse-holo of the same printing land in the **same** `artworkGroupId`.
- `cardClass` spot-checks pass against real cards (e.g. an "ex" is `specialty`; a plain uncommon is
  `standard`). Digital-only TCG Pocket cards are flagged `isDigitalOnly` and excluded downstream.

### M3 — Placement engine (pure)

**Goal:** the heart of the product as pure, exhaustively-tested functions. No DB, no fetch.

**Deliverables**
- `lib/engine/bands.ts` — `band(card)` from `TypeColorMap`; ordered band list; White absorbs
  Colorless/Metal/Trainer/Supporter/Item; Fairy after Purple.
- `lib/engine/duplicate.ts` — duplicate key = same `artworkGroupId` **or** same `(setId, localId)`,
  checked against **shelved** copies only (never bulk); holo-swap decision (incoming holo inherits
  the shelved normal's entire role incl. line slot; normal → bulk) (system-design §3, cascade step 3).
- `lib/engine/line.ts` — viability test (walk chain via `evolveFrom`/`dexId`, exclude digital-only;
  a line forms only if ≥2 same-color members) and slot generation (filled/placeholder/block per the
  §6 table, incl. ex-only → `capped`, missing root → per decision §2, no-same-color-next → `terminated`).
- `lib/engine/cascade.ts` — the ordered, total cascade (system-design §5): collection claim → card
  class → duplicate → line participation → basic/no-line → trainer. First match wins; every card
  gets a destination; every block/termination emits a decision, never auto-blocks.

**Acceptance**
- All four **worked examples** in system-design §5 pass as unit tests, exactly (Charmeleon OBF-027
  capped Fire line; second-printing Charmeleon → front half; Vaporeon non-viable → Light-blue front;
  OKUBO Charmeleon → collection claim, line slot stays open with priced alternates).
- Structural invariants tested: a 2-stage chain dies on a mid-block but a 3-stage survives; a
  terminated line has no page and must never appear in a back-half walk; no "top-of-chain-only"
  block is invented.
- Alternates ranked by market price ascending, standard class, physical only.

### M4 — Finish the Dex CSV sync engine

**Goal:** complete `lib/sync/` from the resolved-id stubs to a full reconciliation + preview,
matching sync-architecture and sync-ui-spec.

**Deliverables**
- `lib/sync/catalog-lookup.ts` — take `ResolvedDexId` → `catalogCardId` against the M2 mirror; on
  set-code miss, match by set **name** and persist a learned `set_alias` (drains the whole set).
- `lib/sync/reconcile.ts` — **scope filter first** (`Type=collection` only; wishlist/standard_v2
  lists must not import as owned — this would have silently corrupted the collection). Then
  `PresenceGroup` count-delta reconciliation over stable `Copy` records; removal rule (release
  placement, line slot → placeholder, binder **block never auto-reverts** — flag for review);
  variant-migration pass (pair REMOVED+ADDED on same `tcgdexId` → carry placement, don't
  retire+recreate) (sync-arch §1.4–1.6).
- `lib/sync/diff.ts` — desired-vs-current snapshot diff → `ADDED/REMOVED/CHANGED/VARIANT_UPDATE/
  UNCHANGED`; idempotent (sync-arch §1.7).
- `app/api/sync/route.ts` — accept an uploaded CSV, run the pipeline, write a `last_sync_snapshot`,
  return a preview payload. Unresolved rows (catalog lag) → `unresolved_entry` WAITING, auto-retry.

**Acceptance**
- The phantom-variant fix trace (sync-arch Deliverable 2) reproduces exactly: re-import drops the
  phantom and leaves all other placement untouched.
- Wishlist rows in a real export never import as owned (scope-filter test).
- Re-importing the same CSV twice is a no-op (idempotency test).
- Set-code drift, localId padding, and `jpn_` cases resolve (extends existing resolve tests with
  catalog-lookup integration).

### M5 — Backfill workflow

**Goal:** load the existing physical collection through the app (system-design §7A). Re-runnable
per binder.

**Deliverables**
- Front-half flat rapid-entry (set+number or name type-ahead against the mirror; band auto-computed).
- Back-half line-oriented entry (species + color, fill each stage, mark placeholders/blocks; a
  repurposed-duplicate block records **which** copy).
- Specialty flat list with collection tags.
- Writes `Copy`, `EvolutionLine`, `LineSlot`, `BinderBlock`, `WishlistItem`, `PlacementDecision`.

**Acceptance:** a binder can be fully entered and its `binder_section` view reports correct
capacity/blocks/placeholders; a terminated line never offers a back-half slot.

### M6 — Haul intake + placement plan (primary screen)

**Goal:** the core daily surface. Prototype screen `scr-plan` is the reference.

**Deliverables**
- Create haul (source) → fast card entry (set+number / name type-ahead, variant per card).
- Run the M3 cascade over the whole haul → **placement plan grouped to mirror her physical sort**:
  color band in rainbow order → basics vs non-basics within band → action. Grouping is functional,
  not cosmetic (worked top-to-bottom in the same order cards are stacked).
- Check-off execution; on commit, write all records + audit trail.

**Acceptance:** a mixed haul produces a plan in exactly the grouped order; committing is atomic and
writes `PlacementDecision` per card; plan is workable without opening another app or a browser.

### M7 — Decision cards + line detail

**Goal:** the confirm-or-override moments and the emotional center of the product. Prototype
`scr-line`.

**Deliverables**
- Decision card: shows evidence (what the catalog says exists, what she owns, why the system
  proposes this) for terminations, ex-only caps, orphan roots, collection-vs-line conflicts, holo
  swaps. System proposes; she confirms; never auto-blocks.
- Line detail: stages as an ordered strip (filled / placeholder / block) with real TCGdex
  thumbnails and full collector numbers.
- **Placement override on ALL cards** (memory-confirmed): any owned/shelved card can be moved
  (binder+half+band, into a collection, or to Bulk Box "don't shelf") via the move panel.

**Acceptance:** every block/termination routes through a decision card; a confirmed cap sets the
line `capped` and wishlists the ex with `willLiveInSpecialty`; a move rewrites placement + audit.

### M8 — Lookup · Wishlist · Collections · Capacity · Settings

**Goal:** the remaining product surfaces. Prototype `scr-look`, `scr-coll`.

**Deliverables**
- **Lookup** (mobile-first, single field, answer above the fold): binder + half + band; owned?
  wishlisted? completes a line? in a collection? — the show-floor decision set.
- **Wishlist:** every open placeholder, grouped by line and binder; required species/stage/color,
  chosen target + alternates, where it will live; export as copy-paste **and** CSV to mirror into Dex.
- **Collections** (`scr-coll`): create/edit/delete in-app; FINITE (owned vs needed→wishlist) or OPEN
  (running count) per-collection toggle; COLLS is the single source of truth (saving pushes a new
  binder into the binder list and the collection into the placement picker); "＋ LOG A CARD" is a
  **placement** with catalog lookup, not a blind tally (memory-confirmed).
- **Capacity review:** per `binder_section` — capacity, shelved, block pockets, placeholders, free;
  flags near-full; answers "which binder has room for a new Fire line."
- **Settings:** binders/pages/pockets/half-split, rainbow order, `TypeColorMap` (edits recompute
  bands). Empty Pink band must never be hidden or collapsed.

**Acceptance:** lookup answers above the fold on a phone viewport; wishlist CSV round-trips into Dex
format; a collection created in Settings/Collections immediately appears in the intake placement
picker; editing `TypeColorMap` recomputes stored `colorBand` on affected copies.

### M9 — Sync UI (preview / apply / undo + unresolved queue)

**Goal:** wrap the M4 engine in the surfaces from sync-ui-spec.

**Deliverables**
- **Fast-path rule:** additions-only diffs auto-apply + notify; any REMOVED / CHANGED(−) /
  VARIANT_UPDATE gates for review (sync-ui-spec B.1).
- **Preview diff** with per-row overrides; **apply** writes the single `last_sync_snapshot`.
- **Undo:** last-sync-only, restores from the snapshot (B.4–B.5).
- **Unresolved queue:** WAITING/RESOLVED/DISMISSED; auto-retry each sync; manual-match pins a row to
  a catalog card and persists a learned `set_alias` that drains the set; dedupe on
  `(dexId, dexVariantRaw)`; silently dropped if Dex drops the row (A.1–A.9).

**Acceptance:** an additions-only import applies without a gate and notifies; an import with any
removal forces the preview; undo restores exactly the pre-apply state; one manual set-match resolves
every WAITING entry in that set on next retry.

### M10 — PWA polish + production cutover

**Goal:** installable, durable, live.

**Deliverables**
- PWA install polish (icons, manifest, home-screen); revisit custom domain (decision §6).
- Enable Supabase **PITR/automated backups on Production before the first real import** (devops §6).
- Post-deploy smoke check (health + one read path) wired in `deploy.yml`.
- First real CSV import against Production; Testing reset from seed.

**Acceptance:** installs to phone home screen; prod backups confirmed on; `develop`→Testing and
`main`→Production deploys both green with migrate-before-deploy ordering.

---

## 6. Suggested milestone dependency graph

```
M1 schema ─┬─> M2 catalog mirror ─┬─> M3 engine ─┬─> M6 intake+plan ─> M7 decisions/line ─┐
           │                      └─> M4 sync ────┘                                        ├─> M9 sync UI ─> M10 prod
           └─> M5 backfill (needs M1+M2; can run parallel to M3) ─────> M8 surfaces ───────┘
```

M3 (pure engine) and M4 (sync) are the highest-value, highest-regression-risk code — spec and test
them hardest. UI phases are design-led; the prototype is the visual contract.

---

## 7. Kickoff gates (confirm with Karvi before the gated module)

1. **Auth model (decision §4)** — confirm magic-link + allow-listed single account + RLS before M1
   ships the owner column and policies.
2. **Line binder assignment (decision §3)** — confirm "active binder" for phase 1 before M3 writes
   `EvolutionLine.binderId`.
3. **Supabase project names/region + enable prod PITR (devops §11 step 5)** — needed before M1
   migrations run against the *cloud* projects and before M10's first real import. Local Supabase
   development (M1–M9) does not wait on this.

Decisions §1, §2, §5, §6, §7 are made and do not block; overturn only if Karvi objects.

---

## 8. Global definition of done

- All ten phases merged to `main`, CI green throughout.
- system-design §5 worked examples and sync-arch §Deliverable-2 trace both pass as automated tests.
- Production has backups/PITR on and one successful real CSV import reconciled non-destructively.
- No fabricated card data anywhere in seed or fixtures (verified against TCGdex).
- Coarse location preserved end-to-end; no pocket/page addressing anywhere in the schema or UI.
