# Dex → Inventory App Sync Architecture

Solutions-architect + data-engineer deliverable for the one-way, manually triggered
reconciliation sync. Written **against a real Dex CSV export** (726 data rows, verified
2026-09-07) and **verified against the live TCGdex API**, not against assumptions. The
verification evidence is in the appendix; read it before disputing any join-key claim.

Companion docs: `system-design.md` (the app it feeds), `integration-brief.md` (the mandate).

---

## 0. The one-paragraph model

Dex owns **presence** (which cards exist in the collection, in which variant, how many).
The app owns **placement** (binder, half, evolution line + slot, block role, bulk status).
A sync is a **reconciliation**: parse the full Dex snapshot, resolve every owned row to a
catalog card, diff the resulting presence set against what the app already stores, and apply
only the difference. Placement is never read from Dex and never written by the diff except
for the specific cards that changed. Re-running the same import is a no-op. That invariant —
*unchanged card, untouched placement* — is the entire product, and everything below serves it.

---

# DELIVERABLE 1 — Sync architecture

## 1.1 Field-ownership boundary (the contract)

| Field | Owner | Sync may write it? |
|---|---|---|
| Card exists in collection (presence) | **Dex** | Yes — add on appear, remove on disappear |
| Variant of a card | **Dex** | Yes — update in place |
| Quantity owned | **Dex** | Yes — add/remove copies to match count |
| Binder / half | **App** | **Never** except for the changed card |
| Evolution line + slot | **App** | **Never** except for the changed card |
| Block role / bulk status | **App** | **Never** except for the changed card |
| Color band, placement decisions | **App** | **Never** |

The sync engine is only allowed to touch placement fields through two narrow doors:
**create** (a genuinely new copy lands unplaced in the routing cascade) and **retire**
(a copy that vanished from Dex has its placement released under the removal rule, §1.6).
Everything else is off-limits to it by construction, not by discipline.

## 1.2 Scope filter — the finding that would have silently corrupted the collection

The export is **not** just the owned collection. It bundles multiple Dex lists in one file.
Verified column values:

- `Type` = `collection` (685 rows) **or** `standard_v2` (41 rows).
- `Category` = `My Collection` (685) or one of seven list names: `Okubo Wishlist`,
  `Negishi`, `Osare`, `Radiants`, `Usgmen`, `Komiya`, `Wishlist`.
- These line up exactly: **every `collection` row is `My Collection`; every `standard_v2`
  row is a wishlist/custom list.** 685 + 41 = 726.

**Rule: presence ingestion filters to `Type == "collection"`.** Ingesting the whole file
would import 41 wishlist cards as *owned*, and on the phantom-fix roundtrip those would look
like real cards needing placement. This filter is the first step of parsing, not an option.

Bonus: the seven `standard_v2` lists are structured wishlist data. They can optionally feed
the app's `WishlistItem` set on the same import (Okubo Wishlist maps directly to her OKUBO
custom set). Treat that as a separate, additive channel — never as presence.

## 1.3 Matching / identity — the join key (answers brief Q1)

Every owned row carries an `Id` column in `setCode-localId` form (`sv10-103`, `bw6-29`,
`me25-20`, `jpn_sv11w-2`). **This is the join key, not the card name.** Name matching is
disqualified and the real data proves why: the `Name` column contains owner-prefixed and
non-species strings — `Ethan's Slugma`, `Team Rocket's Tarountula`, `Cynthia's Gible`,
`Larry's Dunsparce`, `Misty's Magikarp`, `Type: Null`, trainer/item cards. Name is a display
label only.

But **the Dex `Id` is not byte-identical to the TCGdex card id.** This is the single most
important matching finding, and it is verified, not assumed:

1. **Set-code drift.** Dex `me1/me2/me3/me4/me5` → TCGdex `me01/me02/me03/me04/me05`, and
   Dex `me25` → TCGdex **`me02.5`** (Ascended Heroes — a decimal, not a zero-pad). `me2-112`
   404s against TCGdex; the card lives at `me02-112`. The transform is not a single algorithm.
2. **localId padding drift.** TCGdex zero-pads localId in some sets; Dex does not.
   Dex `mep-87` → TCGdex `mep-087`; Dex `jpn_sv11w-2` → TCGdex `sv11w-002`. Verified 404 vs 200.
3. **Locale namespacing.** Japanese cards carry a `jpn_` set-code prefix and `Locale == Japanese`
   (14 owned rows). They resolve against the **`ja`** TCGdex locale, not `en`, after stripping
   the prefix. `jpn_mc-201` → `ja` locale, set `MC`, card `mc-201` (200 OK).

**Therefore the join is a two-step resolve, never a string compare:**

```
resolveCard(dexRow):
    locale   = (dexRow.Locale == "Japanese") ? "ja" : "en"
    rawCode  = dexRow.Id.split("-")[0].removePrefix("jpn_")
    localId  = dexRow.Id.split("-", 2)[1]           # keep as-is, may be unpadded

    setId = SET_ALIAS.get((locale, rawCode))         # cached alias table, see below
            ?? resolveSetByName(locale, dexRow.Set)  # fallback: Dex 'Set' name == TCGdex set name
    if setId is null: return UNRESOLVED(reason="unknown set")

    card = catalog.find(setId, localId)              # exact
        ?? catalog.find(setId, zeroPad3(localId))    # padding-tolerant retry
        ?? catalog.find(setId, stripPad(localId))
    return card ?? UNRESOLVED(reason="unknown card in known set")
```

The alias table is **not hand-maintained.** Dex gives the human set name in the `Set`
column (`Ascended Heroes`, `Phantasmal Flames`, `Destined Rivals`), and TCGdex exposes the
same names in its sets list. On first encounter of an unknown set code, resolve it by name
match against the cached TCGdex sets list, then persist `(locale, dexCode) → tcgdexSetId`.
Set codes are stable per set, so the table self-populates once and rarely grows.

**What breaks matching, and the fallback for each:**

- **Set not yet in TCGdex.** The app mirrors a community catalog that lags new releases.
  A row for a set TCGdex hasn't published yet resolves to `UNRESOLVED`. Do not drop it —
  park it in an **Unresolved queue** with its raw Dex fields so it re-resolves automatically
  on a later sync once the catalog catches up. (This is a real, live risk for her — see
  Limitations §L1.)
- **localId beyond the printed denominator** (secret rares: `Shuckle 136/132`, `Ambipom 107/94`).
  Not a problem: match is on localId within the resolved set, and TCGdex lists secret rares at
  their true localId. No denominator arithmetic is ever done.
- **Promos with no denominator** (`mep-87`, `Binacle "87"`). Handled by the padding-tolerant
  retry; promos are ordinary cards in their promo set.
- **Owner-prefix / alt-art names.** Irrelevant — name is never in the join. `Cynthia's Gabite`
  resolves cleanly by `sv10-103`.

## 1.4 Variant normalization — richer than the app's five flags

The app models variants as `{normal, holo, reverse, firstEdition, wPromo}`. The real export
carries **nine** distinct `Variant` values on owned rows:

| Dex `Variant` | Count | Maps to app flag | Note |
|---|---|---|---|
| Normal | 433 | `normal` | clean |
| Reverse Holo | 167 | `reverse` | clean |
| Holo | 70 | `holo` | clean |
| Poké Ball Holo | 5 | `reverse` | reverse *pattern* subtype the flag can't express |
| Cosmos Holo | 3 | `holo` | foil-pattern subtype; needs per-card review |
| Trick or Trade 2023 | 4 | *(none)* | Halloween stamped promo overlay |
| Friend Ball Holo | 1 | `reverse` | reverse pattern subtype |
| Quick Ball Holo | 1 | `reverse` | reverse pattern subtype |
| Expansion Stamp | 1 | *(none)* | stamped promo overlay (Victini) |

**Consequence for identity (critical):** collapsing "Poké Ball Holo" and "Reverse Holo" both
to `reverse` would make a card owned in both variants look like a duplicate or a phantom, and
would break idempotency. So the **reconciliation identity key preserves the raw Dex variant
string**; the app flag is a *derived display attribute*, not part of identity.

The copy identity is therefore `(tcgdexId, dexVariantRaw)`. The five-flag value hangs off the
copy for placement/display logic (rainbow band, dup detection) but is never what the diff keys on.
Store both.

## 1.5 Copy identity across syncs (answers brief Q2 — the subtle one)

Dex exports **one row per `(Id, Variant)` with a `Quantity`**, not individually identified
copies. Verified: within the 685 owned rows there are **zero duplicate `(Id, Variant)` pairs**
(the 41 collisions in the raw file were all collection-vs-wishlist overlap, eliminated by the
§1.2 scope filter). `Quantity` is 1 for 699 rows and 2 for 27 rows. So the CSV grain is exactly:
one logical presence fact = `(tcgdexId, dexVariantRaw, quantity=N)`.

The app, meanwhile, stores **N distinct `Copy` records** for those N cards, each with its own
placement (three Charmander normals could sit in three different binders). The snapshot only
says "3". So the sync must keep those three `Copy` rows **stable** across re-imports even
though Dex never identifies them individually.

**Strategy — count reconciliation over a stable copy set, never rebuild:**

- The app keeps a `PresenceGroup` per `(catalogCardId, dexVariantRaw)` holding an ordered list
  of its `Copy` records. The group is the unit the diff reasons about; the CSV maps 1:1 to groups.
- On sync, compute `delta = dexQuantity − currentCopyCount` for the group:
  - `delta == 0` → **do nothing.** Placement of all copies untouched. (The common case.)
  - `delta > 0` → **create `delta` new copies**, unplaced, fed to the routing cascade. Existing
    copies are not touched.
  - `delta < 0` → **retire `|delta|` copies** under the removal rule (§1.6). Retire the
    **least-committed copies first** so the most-placed ones survive: bulk/unplaced before
    shelved, and among shelved, non-line before line-slot holders. This makes removal
    deterministic and minimizes placement loss.
- Copies carry a stable internal `copyId` (app-generated, never derived from Dex). Nothing in
  the sync ever reassigns an existing `copyId` to a different physical card.

This is why it survives the "quantity 3" problem: the app is authoritative on *which three
copies exist and where they are*; Dex is authoritative only on *how many there should be*. The
diff moves the count toward Dex's number by adding/retiring at the margin, never by reloading.

## 1.6 The removal rule (answers brief Q4)

When a `(tcgdexId, dexVariantRaw)` group's count drops (or the group disappears entirely):

**Default:** a retired copy's placement is *released, not destroyed*.

- If it held an **evolution line slot** → the slot reverts to a **placeholder**, the line stays
  intact and keeps its color, and the app proposes alternate printings to refill it (consistent
  with the system-design line engine). The line is not torn down.
- If it was **shelved (front-half, no line)** → its binder/half assignment is cleared; the card
  leaves the collection.
- If it was in the **bulk box** → removed silently; bulk has no structure to preserve.
- If it was a **repurposed binder block** → **do not auto-revert.** The physical block still
  exists in the binder; a card leaving Dex doesn't un-repurpose a page. Flag it for her review
  instead ("the card recorded as this block is gone from Dex — keep the block or free it?").

**Edge cases:**

- **Variant change reads as remove+add if mishandled.** If Dex changes a card from Normal to
  Reverse Holo, the naive diff sees `(id,Normal)` disappear and `(id,ReverseHolo)` appear, and
  would retire the placed copy and create an unplaced one — losing placement. **Guard:** before
  applying retire/create pairs, run a **variant-migration pass** — within the same `tcgdexId`,
  if a group lost copies and a sibling group (same card, different variant) gained the same
  number in the same sync, treat it as a variant update and **carry placement across**, don't
  retire+recreate. This is the mechanism that makes the phantom-fix clean (Deliverable 2).
- **Whole card gone (quantity → 0).** All copies retired per above; if the last line member
  goes, the line drops below viability (2+ same-color members) and the system proposes
  collapsing it — but proposes, never auto-collapses (system-design rule preserved).
- **Ambiguous shrink.** Dex says 2, app has 3 placed copies, but two of them are equally
  "least committed." Deterministic tiebreak: retire the most recently created copy first
  (highest `copyId`). Surface it in the preview so she can override which physical copy left.

## 1.7 The diff algorithm + idempotency (answers brief Q3)

```
sync(csvBytes, appState):
  # 1. PARSE
  rows = decodeUtf16(csvBytes) |> splitSemicolon           # see appendix: encoding is fixed
  owned = rows.filter(Type == "collection")                # §1.2 scope filter

  # 2. RESOLVE + BUILD DESIRED PRESENCE
  desired = {}                                             # (tcgdexId, dexVariantRaw) -> qty
  unresolved = []
  for r in owned:
      card = resolveCard(r)                                # §1.3
      if card is UNRESOLVED: unresolved.append(r); continue
      desired[(card.id, r.Variant)] += int(r.Quantity)

  # 3. CLASSIFY (compare desired vs appState.presenceGroups)
  for key in union(desired.keys, appState.groups.keys):
      d = desired.get(key, 0); a = appState.count(key)
      if   d == a and a > 0: classify UNCHANGED             # -> no-op, placement untouched
      elif a == 0 and d > 0: classify ADDED    (d copies)
      elif d == 0 and a > 0: classify REMOVED  (a copies)
      else:                  classify CHANGED  (delta d-a)

  # 4. VARIANT-MIGRATION PASS  (§1.6): pair REMOVED/ADDED within same tcgdexId,
  #    convert matched pairs to VARIANT_UPDATE that carries placement across.

  # 5. APPLY  (order matters: updates, then adds to cascade, then retires)
  #    - VARIANT_UPDATE: rewrite dexVariantRaw + derived flag on the copy, keep placement
  #    - ADDED / CHANGED(+): create copies unplaced -> routing cascade
  #    - REMOVED / CHANGED(-): retire least-committed copies -> removal rule
  #    UNCHANGED: touch nothing.

  # 6. Park `unresolved` in the Unresolved queue for re-resolution on a future sync.
```

**Idempotency proof sketch.** After a successful apply, `appState.count(key) == desired[key]`
for every resolved key. Re-parsing the *same* CSV yields the identical `desired` map, so step 3
classifies every key `UNCHANGED` (or still-unresolved), step 4 finds no pairs, and step 5 does
nothing. Running the same import twice is a guaranteed no-op **because the diff is computed
against the desired end-state, not against an event log.** Snapshot-diff is what buys
idempotency for free; a delta/event model would not.

---

# DELIVERABLE 2 — Worked trace: the phantom-variant fix

The acid test. Dex's known bug: adding a reverse holo can also insert a phantom **Normal**.
Take a real card from her export: **`me4-29` Ampharos**, owned as `Holo` and `Reverse Holo`
(a genuine two-variant row pair in the data). Suppose the Ampharos Holo is placed in the
Lightning line, and the bug has just added a phantom **Normal** row.

### State BEFORE the fix (after a sync that ingested the phantom)

| PresenceGroup key | Dex qty | App copies | Placement |
|---|---|---|---|
| `(me04-29, Holo)` | 1 | copy #A101 | Binder 1 · front · Lightning line · slot Ampharos |
| `(me04-29, Reverse Holo)` | 1 | copy #A102 | Binder 2 · back · shelved |
| `(me04-29, Normal)` ← **phantom** | 1 | copy #A103 | **unplaced — sitting in routing cascade, nagging her** |

She sees copy #A103 in the app as an Ampharos needing placement she never physically pulled.

### The roundtrip

1. She recognizes the phantom in the app.
2. She opens **Dex** (source of truth) and deletes the stray Normal Ampharos there.
3. She re-exports (full snapshot) and re-imports.

### Reconciliation on that import

- Parse + scope filter → owned rows. Resolve `me4-29` → `me04-29` (set-code drift handled).
- Desired presence now: `(me04-29, Holo)=1`, `(me04-29, Reverse Holo)=1`. The Normal group is
  **absent** from the snapshot.
- Classify: Holo `UNCHANGED`, Reverse Holo `UNCHANGED`, **Normal `REMOVED` (1 copy)**.
- Variant-migration pass: is there a matching `ADDED` on another `me04-29` variant this sync?
  **No** — nothing was added. So it stays a true removal, not a variant migration. Correct:
  the phantom is genuinely gone, not moved.
- Apply: retire copy #A103. It was **unplaced**, so the removal rule releases nothing —
  no line slot reverts, no binder changes. Holo #A101 and Reverse Holo #A102 are `UNCHANGED`
  and are **not touched**.

### State AFTER the fix

| PresenceGroup key | Dex qty | App copies | Placement |
|---|---|---|---|
| `(me04-29, Holo)` | 1 | copy #A101 | Binder 1 · front · Lightning line · slot Ampharos — **unchanged** |
| `(me04-29, Reverse Holo)` | 1 | copy #A102 | Binder 2 · back · shelved — **unchanged** |
| `(me04-29, Normal)` | — | *(gone)* | phantom retired, released nothing |

The phantom is dropped, the real card's line placement is preserved to the slot, and **nothing
else moved.** That is the whole design working as one behavior, and it falls out of the
snapshot-diff + variant-migration guard rather than any phantom-specific special case.

*(Counter-example that proves the guard matters: if instead she had* changed *the Normal to a
Reverse Holo in Dex — not deleted it — the same sync would show Normal `REMOVED` and Reverse
Holo `ADDED` on the same `tcgdexId`; the migration pass pairs them and carries the Normal's
placement onto the Reverse Holo copy instead of retiring and re-queuing it.)*

---

# DELIVERABLE 3 — Findings: on-device backup file vs CSV as the ingestion source

**Recommendation up front: build on the CSV export. Treat the on-device backup as an unverified
optimization to probe later, never as the primary path.**

### What the backup is

Dex writes automatic backups to **Files › On My Phone › Dex** on iOS. It is the app's private
persistence, almost certainly a **SQLite database or a serialized store**, and it would very
likely be *richer* than the CSV — internal card IDs, per-copy rows (not just quantities),
timestamps, list membership — the exact things the CSV flattens away. If per-copy identity
existed in it, brief Q2 would get materially easier.

### Why it does not become the primary source

- **Undocumented, unversioned, and private.** Its schema is whatever Dex's build ships and can
  change without notice on any app update. The CSV is a *published, stable* export surface with
  named columns; the backup has no contract at all. Building identity resolution on a private
  schema is the same class of fragility as reverse-engineering the private API, minus the
  network — the account-risk goes away but the brittleness does not.
- **Uninstall deletes it.** The brief flags this and it is disqualifying for a *sole* path:
  the ingestion source cannot be something that vanishes if she reinstalls Dex.
- **No verification possible yet.** I have not seen the file. Every richer-data claim above is
  informed inference, not confirmed fact. Architecture must not depend on unverified structure —
  the same discipline that made us demand a real CSV before writing this document.
- **Extraction friction is similar.** She still has to manually get the file off the phone
  (Files app → share → into the app's watched location). That is the same manual gesture as
  exporting a CSV, so the backup buys no automation win on its own.

### Where the backup *could* earn a place (future, opt-in, additive)

If a later probe confirms the schema and finds **per-copy rows**, the backup could become a
*secondary enrichment* source that resolves the one thing the CSV cannot: stable copy identity
across syncs (§1.5), letting the app match physical copies exactly instead of reconciling by
count. That would be a real upgrade to the subtlest part of the system. It would still sit
behind the CSV as the contract-bearing path, and behind a manual "I've placed the backup file
here" step. **Concrete next action:** one-time, copy the backup out, open it read-only, confirm
whether it's SQLite (`file` / `sqlite3 .tables`), and check for a per-copy table. Decide then.
Until that probe happens, it stays out of the architecture.

---

# DELIVERABLE 4 — What cannot be solved cleanly (honest limitations)

Stated plainly rather than papered over. These are consequences of *manual + snapshot-only +
mirrored-catalog*, not implementation laziness.

**L1 — New sets lag the catalog, and that's most of her collection right now.** The app mirrors
a community catalog (TCGdex). Her collection is heavily **Mega Evolution era** (`me01`–`me05`,
`me02.5`, `mep`) and current SV Japanese sets (`sv11w` White Flare). Those resolved *today*, but
the newest set she pulls from a just-released product may not exist in the catalog yet, so those
rows land in the Unresolved queue until the catalog catches up. There is no clean fix under a
mirrored catalog — only graceful deferral (park + auto-retry) and an honest "N cards waiting on
catalog data" indicator. Do not fabricate placeholder catalog cards; that corrupts the mirror.

**L2 — Copy identity is inferred, not known.** Because the CSV gives quantities, not identified
copies, the app can only reconcile *counts* (§1.5). When Dex says "3 → 2," the app decides which
physical copy left by the least-committed heuristic; it cannot *know* which one she actually
sold. The preview lets her correct it, but absent per-copy data (see Deliverable 3) this is
inference with a human in the loop, not certainty.

**L3 — Variant subtypes are lossier than Dex.** Dex distinguishes Poké Ball / Friend Ball /
Quick Ball / Cosmos Holo / Expansion Stamp / Trick-or-Trade patterns; the app's five flags
collapse several to `reverse` or `holo`. We preserve the raw Dex string for identity and
display, so nothing breaks, but the app's *placement logic* (rainbow band, dup detection)
treats these as their base variant. A "Poké Ball Holo" and a plain "Reverse Holo" of the same
card won't be told apart by the dup engine unless the raw string is consulted. Acceptable, but
it is a real fidelity gap, called out so it isn't discovered as a "bug" later.

**L4 — No real-time, no push, no confirmation of intent.** The sync is only as fresh as the last
manual export, and a snapshot can't distinguish *sold* from *miscounted in Dex* from *scanned
twice*. Every removal is the app trusting the snapshot. The mitigation is entirely UX: a
preview-before-apply diff (adds / removes / variant changes / unresolved), an explicit apply,
and a one-step undo of the last sync. That reduces anxiety; it does not make the snapshot smarter.

**L5 — Japanese ↔ English printings are different catalog cards.** `jpn_` rows resolve to `ja`
catalog cards with their own IDs. If she owns the same species in both a JP and an EN printing,
they are legitimately two different cards with two placements — correct, but worth stating so a
future "why do I have two Absols" question has an answer.

**L6 — The manual gesture itself.** iOS-only, Dex+ paywalled, full-snapshot export is a fixed
external constraint. No architecture removes the "open Dex, export, hand the file to the app"
step. The chosen bar is *painless*, not *automatic*: make the file hand-off one tap and the
reconciliation trustworthy. Full automation would require the private API or a confirmed backup
schema, both explicitly out of scope by prior decision.

---

## Appendix — verification evidence (so none of the above is assumed)

**CSV physical format (verified from the uploaded export, 727 lines / 726 data rows):**
- Encoding **UTF-16 little-endian with BOM** (`FF FE`); delimiter **semicolon** `;`.
- Header: `Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes`
- A parser that assumes UTF-8 or comma-delimited fails immediately. This is fixed, not a guess.

**Scope (verified):** `Type=collection` ⟺ `Category=My Collection` (685 rows); `Type=standard_v2`
= 7 wishlist/custom lists (41 rows). Within owned rows: **0 duplicate `(Id,Variant)` pairs.**
`Quantity` ∈ {1 (699 rows), 2 (27 rows)}.

**Join key (verified against live TCGdex API):**
- `sv10-103` → 200 (Cynthia's Gabite, Destined Rivals). `bw6-29` → 200 (Spheal, Dragons Exalted).
- `me2-112` → **404**; TCGdex has the set as `me02` (Phantasmal Flames). `me25` → `me02.5`
  (Ascended Heroes) — confirmed via the TCGdex sets list, which contains `me01, me02, me02.5,
  me03, me04, me05, mep, mee`.
- `mep-87` → 404 but `mep-087` → 200 (localId padding). `jpn_sv11w-2` → 404 but `ja/sv11w-002`
  → 200. `jpn_mc-201` → `ja` MC → 200. `jpn_s12a-083` → `ja` S12a → 200.
- Set names match between Dex `Set` column and TCGdex set names, enabling name-based set
  resolution as the alias-table fallback.

**Variant vocabulary (verified, owned rows):** Normal 433, Reverse Holo 167, Holo 70, Poké Ball
Holo 5, Cosmos Holo 3, Trick or Trade 2023 4, Friend Ball Holo 1, Quick Ball Holo 1, Expansion
Stamp 1.
