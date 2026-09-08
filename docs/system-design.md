# Pokemon TCG Binder System — System Design (Phase 1)

Version 0.1 · 2026-09-06 · Audience: UI/UX design, then developer implementation

---

## 1. What this system is

It is not a collection tracker. Dex already tracks what she owns.

This system answers one question that no existing app answers: **given a stack of several
hundred commons and uncommons, where does each card physically go, and what am I still
missing?**

The value concentrates in two places:

**Routing.** Every card in a haul gets a destination decided by a rule cascade instead of by
the collector flipping between three binders, Google, and Dex.

**Evolution line state.** The system holds the state of every evolution line: which stages are
filled, which are open placeholders, which are permanently blocked, and which cards would fill
the gaps. This is the entirety of the current pain (workflow steps 6 and 7).

Location tracking is deliberately coarse. The user does not want pocket-level addresses. Knowing
binder plus half is sufficient, which removes the entire rainbow-insertion cascade problem from
scope.

---

## 2. Scope

### In scope for phase 1

- Configurable binders, halves, and capacity
- Backfill of the existing collection through the app
- Haul intake and a prescriptive placement plan
- The evolution line engine, including placeholders, blocks, and termination decisions
- Duplicate detection with holo-swap handling
- Wishlist owned by this system, with an export she can mirror into Dex
- Binder block tracking, including which duplicate card was repurposed
- Card lookup on mobile ("where is my Charmeleon")
- Named collections with manual membership, only so the priority rule can be enforced

### Out of scope for phase 1

- Rule-based custom set definitions (illustrator = X, connected-art subsets). She wants to
  define these creatively herself for now. Phase 1 only needs "which binder is this card in."
- Camera scanning. Dex remains the scanner.
- Writing anything back to Dex. Dex has no import, permanently one-directional.
- Pocket-level or page-level positions
- Offline support
- Trade, value, or portfolio features
- Multi-user

---

## 3. Confirmed rules

Captured from discovery. These are requirements, not proposals.

### Storage

| Rule | Detail |
|---|---|
| Binder types | General and specialty. Both configurable, count grows over time. |
| General front half | Non-duplicate commons, uncommons, trainers, supporters, items. Basics, plus any Stage 1 or 2 not held in a line. |
| General back half | Evolution lines, one line per species chain per color. |
| Rainbow order | Red, Orange, Yellow, Olive, Green, Dark blue, Light blue, Purple, White. Resets between halves. |
| Trainers / supporters / items | White band. |
| Specialty binder | Cards in a running collection, plus ex, V, full art, and any non-standard card. Multiple collections may share one binder, and collections may move binders. |
| Bulk box | All duplicates. No internal structure. Never searched. |
| Binder blocks | Basic energy (untracked) or repurposed duplicates (tracked, including which card). |
| One binder in progress | But other binders' open spaces are also filled. |

### Priority

**Collection membership beats everything.** If a card belongs to a running collection it goes to
the specialty binder, even when it would have completed an evolution line. The line keeps its
placeholder and the system proposes alternate printings to fill it.

### Duplicates

A card is a duplicate if it shares **artwork** with a card already owned, **or** is the same
**set plus collector number**. Checked against the whole collection, not one binder.

Two different printings with different art are both kept. Variants (holo, reverse) are not part
of the duplicate key. When a holo arrives and the normal is already shelved, the system
instructs a **swap**: holo to the binder, normal to bulk.

### Evolution lines

| Rule | Detail |
|---|---|
| Line color | Set by the first card placed in the line. |
| Creation trigger | A Stage 1 or Stage 2 arriving. |
| Line uniqueness | One line per species chain per color. Later copies of a stage already filled go to the front half. |
| Card eligibility | Any physical card, any era. Digital-only Pokemon TCG Pocket cards excluded. |
| Baby Pokemon | Line starts at Pikachu, not Pichu. Comes free from TCG stage data. |
| Missing root | If no same-color previous stage exists in the catalog, block the root slot. |
| Viability test | A line is only created if it will hold at least two same-color members. A stage with no same-color previous stage **and** no same-color next stage goes to the front half instead. |
| Termination | System proposes, user confirms. Never auto-blocks. |
| ex-only completion | If the only same-color next stage is a specialty-class card, create the placeholder and wishlist it, tag it as living in the specialty binder, and mark the line **capped** rather than complete. |

---

## 4. Domain model

Two ideas carry most of the weight.

**Catalog card versus owned copy.** A `CatalogCard` is a printing that exists in the world. A
`Copy` is a physical card she holds. Splitting these is what makes duplicate detection, holo
swaps, wishlists, and repurposed blocks all expressible. Without the split, none of them work
cleanly.

**Logical versus physical.** Collection membership, evolution lines, and physical binder location
are three independent axes. A card can be in a collection, be a line member, and sit in a
specific binder half, and none of those determines the others.

### Entities

**CatalogCard** — mirrored from TCGdex, read-only
```
tcgdexId, name, dexId[], setId, setName, setSeries, localId (collector number),
rarity, types[], stage, evolveFrom, illustrator, hp,
variants {normal, holo, reverse, firstEdition, wPromo},
artworkGroupId, cardClass, isDigitalOnly, imageUrl, priceLow, priceMarket
```

`dexId` is the species key. It is far more reliable than name matching, which breaks on "Dark
Charizard," "Blaine's Charizard," and "Mega Charizard Y ex." Regional forms share a dexId with
their base form, but the same-color rule separates them naturally: Kantonian Vulpix is Fire,
Alolan Vulpix is Water, so they can never land in the same line.

`cardClass` is derived at sync: `standard` or `specialty`. Specialty covers ex, V, VMAX, VSTAR,
GX, Radiant, Prime, full art, illustration rare, and gold. This is the flag the specialty binder
rule and the ex-only line rule both read.

**Copy** — a physical card owned
```
id, catalogCardId, variant, haulId, acquiredAt,
role: shelved | bulk | block,
binderId, binderHalf, colorBand,
lineSlotId (when part of a line)
```

**Binder**
```
id, name, type: general | specialty, pages, pocketsPerPage (default 9),
backHalfStartPage, isActive, notes
```

**BinderSection** — derived, one per (binder, half). Specialty binders have one section.
```
binderId, half, capacity, shelvedCount, blockPockets, openPlaceholders, freePockets
```

**EvolutionLine**
```
id, rootDexId, colorBand, binderId, half = back,
status: open | capped | complete | terminated, createdAt
```

**LineSlot** — the ordered stages of a line
```
lineId, stageIndex, stage, state: filled | placeholder | block,
copyId, targetCatalogCardId, note
```

**WishlistItem** — every open placeholder surfaces here
```
id, lineSlotId, requiredDexId, requiredType, requiredStage,
chosenCatalogCardId, alternateCatalogCardIds[],
heldForBinderId, willLiveInSpecialty (bool), createdAt, resolvedAt
```

**Collection** — a running custom set
```
id, name, definitionType: curated (phase 1) | rule (phase 2),
currentBinderIds[], targetCatalogCardIds[], status
```

**BinderBlock**
```
id, binderId, half, pocketCount,
purpose: line-terminated | collection-reserve,
material: basicEnergy | repurposedDuplicate,
copyId (when a repurposed duplicate), lineId, createdAt
```

**Haul**
```
id, date, source: bulk-bin | pack-rip | show | trade, notes
```

**PlacementDecision** — audit trail, one per card per haul
```
haulId, copyId, decision, reason, resolvedBy: auto | user, timestamp
```

The audit trail matters more than it looks. When she later wonders why a card ended up in bulk,
or why a line was blocked, the reason needs to be recoverable. It is also the only way to debug
the cascade.

### Configuration

**ColorBand** — ten ordered bands, editable. The order is the physical sort order in both
halves of every general binder, and the rainbow resets between halves.

**TypeColorMap** — energy type to band. Confirmed.

| # | Band | Types |
|---|---|---|
| 1 | Red | Fire |
| 2 | Orange | Fighting |
| 3 | Yellow | Lightning |
| 4 | Olive | Dragon |
| 5 | Green | Grass |
| 6 | Dark blue | Darkness |
| 7 | Light blue | Water |
| 8 | Purple | Psychic |
| 9 | Pink | Fairy |
| 10 | White | Colorless, Metal, Trainer, Supporter, Item |

Two consequences worth designing around.

**The Pink band is currently empty and may stay that way for a long time.** She owns no Fairy
cards. Fairy was retired from print after the Sword and Shield rotation, so the band only fills
if she picks up XY or Sun and Moon era bulk. Bands must therefore be first-class and orderable
even at zero cards, and the UI must not hide or collapse an empty band, since its position in the
rainbow is what reserves the physical space.

**White is going to be the heaviest band by a wide margin.** It absorbs Colorless, Metal, and
every trainer, supporter, and item. In a bulk-bin collecting pattern that is a very large share
of intake. Capacity warnings and band-level free space reporting should expect White to dominate,
and it is the most likely band to justify its own binder later.

---

## 5. The routing cascade

This is the core of the product. Every card in a haul runs the cascade in order. First match
wins. The cascade is what replaces the back-and-forth.

```
1. COLLECTION CLAIM
   Does this card belong to a running collection?
   → Specialty binder holding that collection
   → If a line needed this card, the line slot stays a placeholder
     and the system proposes alternate printings

2. CARD CLASS
   Is cardClass = specialty (ex, V, full art, Radiant, illustration rare)?
   → Specialty binder

3. DUPLICATE                     (compared against SHELVED copies only,
                                  never against copies already in bulk)
   Same artworkGroupId, or same (setId, localId), as a shelved card?
   → Incoming is holo and the shelved copy is normal?
       → SWAP: the incoming holo inherits the shelved copy's entire role,
         including binder, half, band, and its line slot if it held one.
         The displaced normal goes to bulk.
   → Otherwise: bulk box
   → Offer to repurpose as a binder block if any block need is open

4. LINE PARTICIPATION            (Stage 1 or Stage 2 only)
   Line already exists for (rootDexId, colorBand)?
     → Slot for this stage is a placeholder?  → fill it, back half of that binder
     → Slot already filled?                   → front half (lines tracked once)
   No line exists?
     → Run the VIABILITY TEST (section 6)
       → viable    → create line in back half, generate slots
       → not viable → front half

5. BASIC, no line
   → Front half. Prefer a binder with open space in the matching band,
     otherwise the active binder

6. TRAINER / SUPPORTER / ITEM
   → Front half, White band
```

Steps 1 through 4 are prescriptive and the system owns them. Steps 5 and 6 are effectively
descriptive: the system suggests a binder based on free capacity, she confirms or overrides.

### Worked examples

**Charmeleon, Obsidian Flames 027, uncommon, Fire, not in any collection.** Not a collection
card, not specialty class, not a duplicate, is a Stage 1. No Fire Charmander line exists. Viability
test looks backward and finds Fire Charmander printings in the catalog, and she owns Charmander
OBF-026 in Binder 1 front. It looks forward and finds Fire Charizard printings, but every one is
ex or full art. So: create the Fire Charmander line in the back half of the binder with room,
pull Charmander OBF-026 from Binder 1 front, place Charmeleon, and raise a decision card for the
Charizard slot with the ex-only caveat. On confirm, the Charizard is wishlisted and tagged as
destined for the specialty binder, and the line status becomes `capped`.

**A second Charmeleon, a different printing with different art.** Not a duplicate under the
art-or-printing rule. A Fire Charmeleon line exists and its Stage 1 slot is filled, so this copy
goes to the front half.

**Vaporeon, Water, Stage 1.** Viability test looks backward for a Water Eevee and finds none, all
Eevee printings are Colorless. It looks forward and finds no Water evolution, Vaporeon does not
evolve. Fewer than two same-color members, so the line is not viable and Vaporeon goes to the
front half in the Light blue band. Her Colorless Eevee stays where it is.

**A Charmeleon she collects for its art (Evolutions 010, Mitsuhiro Arita) while the Fire line has
an open Stage 1 slot.** She has tagged this printing into a collection, so collection claim fires
first. It goes to the specialty binder holding that collection. The line's Stage 1 slot stays open
and the system lists other Fire Charmeleon printings, cheapest first, as alternates to chase.

> **Correction (2026-09-08).** An earlier draft named "an OKUBO-illustrated Charmeleon," but no
> such card exists: OKUBO illustrated ~31 cards, none in the Charmander line (verified against
> TCGdex). Collections are user-defined groupings, not an intrinsic card property, so any printing
> she has tagged into a collection triggers this path. The M3 tests use Evolutions 010 (`xy12-10`)
> as the concrete card.

---

## 6. The line engine

### Viability test

Given an incoming Stage 1 or Stage 2 card with color band `B`:

1. Resolve the species chain from `evolveFrom` and `dexId`, walking backward to the root and
   forward to the final stage, using the catalog and excluding digital-only cards.
2. For each adjacent stage, query whether **any** physical card exists with that species and a
   type mapping to band `B`.
3. Count prospective same-color members: cards owned, plus catalog-confirmed stages that could
   be placeholders.
4. If the count is less than two, the line is not viable. Route to the front half.
5. Otherwise create the line and generate slots.

The backward and forward queries are a single TCGdex call each, filtered on `evolveFrom` and
`types`. Verified working against the live API. This is the mechanism that removes the Google
search from step 7.

### Slot generation

| Situation | Slot state | Side effect |
|---|---|---|
| Stage owned, sitting in a front half | filled | worklist action to pull the card |
| Stage owned, this haul | filled | — |
| Same-color card exists in catalog, standard class, not owned | placeholder | wishlist item |
| Same-color card exists in catalog, specialty class only | placeholder | wishlist item, `willLiveInSpecialty`, line → `capped` |
| No same-color card exists for the next stage | block | decision card, line → `terminated` |
| No same-color card exists for the root | block | root blocked |

Every block and every termination is a decision card. The system proposes with evidence shown
and never auto-blocks.

### Alternates

When a placeholder is created, or when a collection claim steals a card a line needed, generate a
ranked list of alternate printings: same species, same color band, standard class, physical only,
ranked by market price ascending. TCGdex carries TCGplayer and Cardmarket pricing, so this is
free. The top-ranked alternate becomes the wishlist target and the rest stay visible.

---

## 7. Workflows

### A. Backfill (one time, but re-runnable per binder)

She needs to load the current collection through the finished app. This is a distinct workflow
from haul intake and needs its own UI.

Front halves are entered as a flat sequence: pick binder and half, then rapid-add cards by set
plus number or by name, in the physical order they sit. Band assignment is computed from card
type, so she never types it.

Back halves are entered line by line: choose species and color, then fill each stage, marking
placeholders and blocks as she encounters them. Every sticky note in the binder today becomes a
placeholder record. Every block becomes a `BinderBlock`, and where it is a repurposed duplicate
she identifies which card.

Specialty binders are entered as a flat list with collection tags.

### B. Haul intake

1. Create a haul, note the source.
2. Add cards. Fast entry: set plus collector number, or name type-ahead against the local
   catalog mirror. Variant picked per card.
3. System runs the cascade over the whole haul and produces a **placement plan**, grouped to
   mirror the physical sort she already does: color band in rainbow order, then basics versus
   non-basics inside the band, then action. The grouping is not cosmetic. It means the plan can
   be worked in the same order the cards are already stacked on the table.
4. She works the decision cards: line terminations, ex-only caps, orphan roots, collection
   versus line conflicts, holo swaps.
5. She executes the plan physically, checking off actions.
6. On commit, `Copy` records are written, lines and slots updated, wishlist items created, blocks
   recorded, and the audit trail written.

The plan is the deliverable. It should be workable top to bottom without opening another app or
a browser.

### C. Lookup (mobile, at a show or with friends)

Search by name, set, or number. Result states plainly where the card is: binder, half, and color
band. Also shows whether she already owns it, whether it is on the wishlist, whether it would
complete a line, and whether it belongs to a running collection. That last set is what makes a
purchase decision at a show fast.

### D. Wishlist

Every open placeholder is a wishlist item, grouped by line and by binder. Shows required species,
stage, and color, the chosen target, the alternates, and where it will live. Exports as a
copy-paste list and a CSV so she can mirror it into Dex for in-store scanning.

### E. Capacity review

Per binder section: capacity, shelved count, pockets consumed by blocks, open placeholders, and
free pockets. Flags sections nearly full and answers "which binder has room for a new Fire line."

---

## 8. Screens implied

For the UI/UX designer. Ten surfaces, in rough priority.

1. **Haul plan / worklist** — the primary screen, desktop. Grouped by band, then action. Must be
   workable while both hands are busy with cards.
2. **Decision card** — the confirm-or-override moment. Needs to show evidence: what the catalog
   says exists, what she owns, why the system is proposing this.
3. **Haul intake** — fast repetitive entry, hundreds of cards.
4. **Card lookup** — mobile-first, single search field, answer above the fold.
5. **Binder view** — sections, capacity, lines, blocks.
6. **Line detail** — stages as an ordered strip: filled, placeholder, block.
7. **Wishlist** — grouped, exportable.
8. **Collections** — membership and which binder each currently occupies.
9. **Settings** — binders, pages, pockets, half split, rainbow order, type-to-color map.
10. **Backfill wizard** — front half flat entry, back half line-oriented entry.

Two notes worth carrying into design. The line detail strip is the emotional center of the
product, it is the thing she is actually building, so it deserves real visual treatment rather
than a table. And intake plus plan are volume screens where keyboard speed and scan-ability beat
polish.

---

## 9. Data and integration

**TCGdex** is the catalog. Free, no key, and verified to support the queries the line engine
needs. `?evolveFrom=Charmeleon&types=Fire` returns exactly the candidate set. Full card records
carry `stage`, `types`, `evolveFrom`, `dexId`, `rarity`, `illustrator`, `variants`, and dual-source
pricing.

**Sync a local mirror rather than live-querying.** Roughly 23.5k English cards. A local mirror
makes the cascade instant, makes artwork grouping possible, removes rate-limit risk, and is the
foundation the phase 2 rule-based collections will need. Refresh on a schedule and on new set
release.

**Dex** stays the scanner and the presence record. A card becomes officially part of the
collection in this system when it is placed in a binder. Integration is one-directional and
partly paywalled: CSV export is iOS only and a Dex+ feature, at Settings, Data, Export Collection.
Recent versions include card number and illustrator columns. Because it is paywalled and
one-directional, phase 1 does not depend on it. Build the app's own fast entry first and treat
CSV import as an optional accelerator.

**Platform.** One responsive web app, installable to the phone home screen. That satisfies both
the desktop sorting session and the mobile lookup with a single codebase and no app store.
Since offline is not required, a native app buys nothing in phase 1.

---

## 10. Open items

Three things still need decisions before implementation.

### Resolved

**Artwork identity — approved.** Compute a perceptual hash of every card image during catalog
sync and cluster near-identical images into an `artworkGroupId`, with a manual merge and split
override for the cases the hash gets wrong.

Implementation notes for the dev spec. Use a difference hash or pHash at low resolution, and
compare on the artwork region rather than the full card, because border treatment, set symbol,
and holo pattern differ across reprints of identical art and will otherwise push genuine matches
apart. Reverse-holo and holo variants of the same printing must land in the same group, which
they will since they share a source image in TCGdex. Expect two failure modes and expose the
override for both: false merges on near-identical art such as the many plain-background Basic
energy-adjacent trainers, and false splits where a reprint was recropped or recolored. Store the
raw hash alongside the group so groups can be recomputed without a full re-sync when the
threshold is tuned.

**Color bands — resolved.** Ten bands, Fairy inserted after Purple, Metal folded into White. See
section 4.

### Still open

**Front-half color band as a stored zone.** Recommended yes. It is computed from card type so it
costs nothing to maintain, and it narrows a lookup from half a binder to a page or two. Confirm.

**Unowned same-color root.** When a same-color previous stage exists in the catalog but she does
not own it, the assumption is a placeholder plus wishlist, symmetric with the forward direction.
Her stated rule only covers the case where no such card exists. Confirm.

**Line binder assignment.** When several binders have room, which gets the new line? Options:
the active binder, the one with the most free space, or keep all lines of a color together. The
third is the most useful long-term and the most constraining short-term.

---

## 11. Trace against the current workflow

Every step of the existing ten-step process, and where it lands in this design.

| Current step | Where it goes |
|---|---|
| 1. Scan all cards in Dex | Unchanged. Dex stays the scanner. Cards enter this system at haul intake. |
| 2. Add cards to specialty binder | Cascade steps 1 and 2. Collection claim, then card class. |
| 3. Sort into energy types | Plan is grouped by color band in rainbow order. |
| 4. Split each color into basics and non-basics | Plan sub-groups by basic versus non-basic inside each band. |
| 5. Check the back half of every binder for a placeholder | Cascade step 4a. The system already knows every open placeholder across every binder. This is the single biggest time saving. |
| 6. Start a new series, find and pull the previous evolution | Cascade step 4b plus slot generation. A pull action is emitted naming the exact binder and half to retrieve from. |
| 7. Web search for the full evolution, sticky-note the gap, add to Dex wishlist | Viability test plus slot generation. Two TCGdex queries replace the search. The sticky note becomes a placeholder record and the wishlist entry is created automatically with priced alternates. |
| 7.1 Same-color rule, block if no same-color evolution | Viability test and slot generation. Every block is a decision card she confirms. |
| 7.2 Track each line once, extras to the front half | Cascade step 4a, second branch. |
| 8. Fill open spaces in the front half of any binder | Cascade step 5. Capacity per section drives the suggestion. |
| 9. Remaining cards to the front half of the binder in progress | Cascade step 5 fallback, the active binder. |
| 10. Repeat per color | The plan is already ordered by color, so the repetition is structural rather than manual. |

Two things her stated workflow never mentions but the storage rules require, so the design adds
them explicitly: duplicate detection with the holo swap, which becomes cascade step 3, and
binder block bookkeeping including which duplicate was repurposed.

---

## 12. Why this design

Three choices are worth defending, because a developer agent will otherwise be tempted to
undo them.

**Coarse location is a feature.** Pocket-level tracking would force the system to model rainbow
insertion, shift cascades, and page reflow, and would demand perfect data discipline from a
collector who is holding a stack of cards. Binder plus half plus computed color band gives
roughly ninety percent of the findability for roughly five percent of the complexity and zero
extra data entry.

**The cascade is ordered and total.** Every card gets a destination from one pass of one ordered
rule set. No card falls through. The ordering encodes her actual priorities: collections beat
lines, lines beat loose placement.

**Placeholders are first-class records, not notes.** A sticky note in a binder cannot tell her
what to buy, cannot rank alternates by price, and cannot be searched at a card show. Promoting
the placeholder to an entity with a required species, a required color, a chosen target, and a
list of alternates is what turns the most painful step in her workflow into a shopping list.
