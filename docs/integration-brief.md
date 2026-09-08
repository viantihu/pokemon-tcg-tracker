# Prompt for the Dex Integration Cowork chat

Paste everything below the line into a fresh Cowork chat. It stands alone, so it repeats the
context that matters for the integration.

---

You are a senior solutions architect and data engineer designing a one-way sync between two
systems for a personal Pokemon TCG tool. The product decisions are already made. Your job is the
integration architecture, not the product scope or the UI.

If you can read the folder, `Code Projects/Pokemon TCG Tracker/system-design.md` has the full
system. Everything you strictly need is below.

## The two systems and who owns what

**Dex** is a third-party iOS app. It is the user's scanner and the way she shares her collection
with friends. It is the source of truth for **presence**: which cards she owns and in what
variant. This is a fixed product decision and Dex is not being replaced.

**The inventory app** is what we are building. It is the sole source of truth for **placement**:
which binder a card is in, which half, which evolution line and slot, whether it is a duplicate in
the bulk box, whether it is a repurposed binder block, and everything else in the system design.
Dex knows none of this.

Same cards, different fields, two owners. That split is the whole problem.

## Hard constraints, already verified. Do not design around these, design within them.

- Dex has **no public API** and **no import** of any kind. Nothing can write to it and nothing can
  query it live.
- Dex's only outbound channel is a **manual CSV export**, and it is **iOS only** and behind the
  paid **Dex+** tier, at Settings, Data, Export Collection. Recent versions include card number
  and illustrator columns.
- The export is a **full snapshot every time**, not a delta. There is no incremental export.
- Therefore sync is inherently **one-directional, Dex to app, and manually triggered.** You cannot
  make it real-time or push-based. Accept that and make it painless and safe instead.

## What sync has to accomplish

Every re-import is a **reconciliation against existing app state**, never a fresh load. On each
sync the app must diff the new Dex snapshot against what it already knows and:

- **New card in Dex** → appears in the app as owned but **unplaced**, and gets fed into the
  routing cascade so she can place it. It must not silently vanish into a list.
- **Card gone from Dex** → she sold, traded, or removed it. The app must decide what happens to
  its placement. If it filled a line slot, that slot presumably reverts to a placeholder. This is
  a design question for you: propose the rule.
- **Variant changed in Dex** → update the variant, **keep the placement.** This is the common
  case and the one most likely to be mishandled.
- **Everything unchanged** → do nothing, and critically, **do not disturb placement.** A re-sync
  that touches unchanged cards is a bug.

Placement is sacred. Dex can add, remove, and correct presence, but a sync must never overwrite,
reset, or lose a card's binder, half, line slot, or block status unless that specific card is the
one that changed.

## The scenario that motivated this: the phantom-variant fix

Dex has a known bug where adding a reverse holo can add **both** a normal and a reverse holo. She
will notice the phantom card inside our app, because it will show up as an extra copy needing
placement. The workflow she wants:

1. She sees the phantom copy in the app.
2. She goes back into **Dex** and deletes the wrong one there, since Dex is the source of truth.
3. She re-exports and re-imports.
4. The app reconciles: the phantom normal is gone, the real reverse holo remains, its placement is
   preserved, and **nothing else moved.**

Design the reconciliation so that this specific roundtrip is clean and obvious. It is the acid
test for the whole sync.

## Questions you need to answer

1. **Matching / identity.** How does a Dex CSV row map to a specific card, and then to an app
   `Copy` record? The app already mirrors the TCGdex catalog, which has stable card IDs, set
   codes, collector numbers, illustrators, and variant flags. What is the join key, and what is
   the fallback when a row is ambiguous? What breaks matching (promos, alternate arts, name
   prefixes like "Dark Charizard")?
2. **Copy identity across syncs.** Dex likely exports quantities, not individually identified
   cards. If she owns three of the same card in the same variant and the app has placed each in a
   different binder, how do you keep those three app `Copy` records stable across re-imports when
   the CSV just says "quantity 3"? This is the subtlest part. Think it through carefully.
3. **Diff and reconciliation algorithm.** Lay out the actual steps of a re-sync: parse, match,
   classify each card as added / removed / changed / unchanged, and apply, with placement
   preserved. Include idempotency: running the same import twice must be a no-op.
4. **The removal rule.** When a card disappears from Dex, what happens to its placement, its line
   slot, its block role? Propose the default and the edge cases.
5. **Friction reduction.** Given the export is manual, iOS-only, and paywalled, how do you make
   the re-sync as low-effort and low-anxiety as possible? Preview-before-apply, an undo, a dry-run
   diff she can eyeball first?
6. **A specific lead to investigate.** Dex writes automatic on-device backups to Files › On My
   Phone › Dex. That backup file might be a richer and non-paywalled sync source than the paid CSV
   export. Look into its format and whether it is a better ingestion source than CSV. Note that
   uninstalling Dex deletes it, so it cannot be the only path.

## What to deliver

1. A **sync architecture document**: the reconciliation model, the field-ownership boundary, the
   diff algorithm, the matching and copy-identity strategy, and the removal rule.
2. A **worked trace of the phantom-variant fix** from step 1 to step 4 above, showing the state of
   the relevant records before and after.
3. A **findings note on the Dex backup file** versus CSV as the ingestion source, with a
   recommendation.
4. A short list of **anything that cannot be solved cleanly** given the manual, snapshot-only
   constraint, stated honestly rather than papered over.

Before you get an artifact, get me a real sample of a Dex CSV export if you can reason about its
columns, and confirm the join key against the TCGdex catalog schema. Do not assume the CSV shape,
verify it. Ask me only questions that would change the architecture.
