# Sync UI Spec — Unresolved Queue + Preview / Apply / Undo

Functional and behavioral spec for the two surfaces that make the Dex→app sync safe and
low-anxiety. Depends on `sync-architecture.md` (the reconciliation engine) and feeds the
UI/UX chat, which owns the pixel-art visual layer. **This document specifies *behavior, states,
and data* — not pixels.** Where it names a screen, that's a functional region for the designer
to style in the established 16-bit / olive-and-cream language, not a layout mandate.

**Decisions locked with Karvi (2026-09-07):**
1. **Undo = last sync only.** One snapshot, one revert. A new sync overwrites the undo point.
2. **Preview gate = fast-path pure additions.** A sync that can only add cards auto-applies and
   notifies; anything that could disturb placement stops for review.
3. **Unresolved = wait + manual-match.** Auto-retry every sync, and let her pin a stubborn row
   to a catalog card by hand.

---

## 0. Where these two surfaces sit in the sync flow

```
export CSV  ─▶  parse + scope filter  ─▶  resolve each owned row
                                              │
                        ┌─────────────────────┴─────────────────────┐
                     resolved                                    UNRESOLVED
                        │                                             │
                   classify diff                              ▼ PART A: Unresolved Queue
                        │                                     (park, auto-retry, manual-match)
          ┌─────────────┴─────────────┐
   pure additions only          touches placement
          │                            │
   auto-apply + notify        ▼ PART B: Preview → Apply → Undo
   (still undoable)            (review diff, override, confirm)
```

---

# PART A — The Unresolved Queue

## A.1 Purpose

The catalog the app mirrors (TCGdex) lags new releases, and Karvi collects heavily in the
newest sets (Mega Evolution era, current JP sets). A Dex row for a card the catalog doesn't
know yet cannot be placed, but it must **not** be dropped or silently swallowed. The queue is
the holding area that makes catalog lag a *visible, self-healing* state instead of data loss.

## A.2 What lands here + reason codes

An owned row parks in the queue when `resolveCard` returns `UNRESOLVED`. Two reasons, shown
distinctly because they imply different odds of self-healing:

| Reason code | Meaning | Typical cause | Self-heals? |
|---|---|---|---|
| `UNKNOWN_SET` | Dex set code / name has no TCGdex match | Set newer than the catalog mirror (her common case) | Yes, when catalog updates |
| `UNKNOWN_CARD` | Set resolved, but no card at that localId | Promo/secret-rare oddity, localId Dex has that TCGdex lacks | Sometimes; often needs manual-match |

Everything a queue entry needs comes straight from the CSV row, so nothing is lost:
`Id (raw), Set name, Series, Number, Name, Variant, Quantity, Locale`.

## A.3 Entry data model

```
UnresolvedEntry {
  id            # app-generated, stable
  rawKey        # (dexId, dexVariantRaw)  — dedupe key, see A.6
  dexId         # e.g. "me6-14"  (raw, unmapped)
  dexSetName    # e.g. "Some New Set"
  dexSeries
  dexNumber     # e.g. "14/180"
  dexName       # display only
  dexVariantRaw # e.g. "Reverse Holo"
  quantity      # from CSV
  locale        # International | Japanese
  reason        # UNKNOWN_SET | UNKNOWN_CARD
  status        # WAITING | RESOLVED | DISMISSED   (state machine A.4)
  firstSeenSync # timestamp of the sync that first parked it
  lastRetrySync # timestamp of the most recent auto-retry
  retryCount
  manualMatchId # tcgdexId she pinned, if any
}
```

## A.4 State machine

```
                 parked by resolve()
        (nothing) ───────────────▶ WAITING
                                     │  ├─ auto-retry hits catalog ──▶ RESOLVED ─▶ promote to ADDED (A.5)
                                     │  ├─ she manual-matches ───────▶ RESOLVED ─▶ promote to ADDED (A.5)
                                     │  ├─ she dismisses ────────────▶ DISMISSED
                                     │  └─ Dex no longer exports it ─▶ (entry deleted, silent — A.7)
        DISMISSED ── she un-dismisses ─▶ WAITING
```

- **WAITING** — the default. Auto-retried on every sync.
- **RESOLVED** — matched (auto or manual). Transient: immediately promoted into the normal
  reconciliation as an `ADDED` group (A.5), then the entry is archived, not left in the list.
- **DISMISSED** — she's decided it won't resolve and doesn't want to see it (e.g. a Dex-only
  data artifact). Excluded from auto-retry but kept, so a future export doesn't silently
  re-park it as noise. She can un-dismiss.

## A.5 Auto-resolution and promotion (the self-healing path)

On **every** sync, before classifying the main diff, the engine re-runs `resolveCard` for each
`WAITING` entry against the (possibly refreshed) catalog:

- **Hit** → the entry becomes `RESOLVED` and is **promoted**: its `(tcgdexId, dexVariantRaw,
  quantity)` enters the resolved presence set and is classified as `ADDED` — i.e. `quantity`
  new copies are created unplaced and fed to the routing cascade, exactly as if the card had
  just appeared in Dex. The entry is then archived.
- **Miss** → stays `WAITING`, `retryCount++`, `lastRetrySync` updated.

Because promotion routes through the normal `ADDED` path, **a self-heal is a pure addition** and
therefore rides the fast-path (Part B) — she just gets "3 previously-unresolved cards are now in
the catalog and ready to place." No placement is ever disturbed by a self-heal.

Refresh timing: the catalog mirror should refresh (or check for updates) at the *start* of a
sync so the retry runs against the freshest data. If offline, retries simply miss and stay
`WAITING` — no error state, no data loss.

## A.6 Idempotency and dedupe (must-haves)

- Queue entries are **not** in `appState.presenceGroups`, so they never affect the resolved
  diff and never double-count. A card is either resolved (a Copy exists) or unresolved (a queue
  entry exists), never both.
- Re-importing the same CSV must **not** create duplicate entries. Dedupe on `rawKey =
  (dexId, dexVariantRaw)`: if a `WAITING`/`DISMISSED` entry with that key exists, update its
  `quantity`/`lastRetrySync` in place rather than inserting. This makes the queue itself
  idempotent, consistent with the engine's core invariant.

## A.7 Removal from Dex while unresolved

If a card is `WAITING` and a later Dex export no longer contains its `rawKey`, delete the entry
**silently**. It never had placement (no Copy record), so there is nothing to release and
nothing to tell her — this is the queue's equivalent of the "unchanged → do nothing" rule.
(Contrast: a *resolved, placed* copy that disappears goes through the removal rule with a
preview, per Part B.)

## A.8 Manual-match interaction

For a stubborn entry (usually `UNKNOWN_CARD`, or an `UNKNOWN_SET` she knows won't be added), she
can pin it to a catalog card herself:

1. From the entry, open a **catalog picker** pre-filtered by her raw data: same `dexSetName`/
   series if the set resolved, same `Number`, name contains `dexName`. She picks the real card.
2. On confirm, `manualMatchId` is set, entry → `RESOLVED`, promoted as `ADDED` (A.5). The
   `dexVariantRaw` still drives variant identity; her pick only supplies the `tcgdexId`.
3. **Persist the mapping.** If the reason was `UNKNOWN_SET`, record the learned
   `(locale, dexCode) → tcgdexSetId` alias (architecture §1.3) so the rest of that set — and
   future imports — resolve automatically. One manual match can drain many entries.

Guardrail: manual-match pins an *identity*, never a *placement*. The matched card still lands
unplaced in the cascade. The sync engine never places anything itself.

## A.9 Screens (functional regions, for the UI/UX chat to style)

- **Queue list.** Entries grouped by `reason` (Waiting on catalog / Needs your match), each row
  showing name, set name, number, variant, quantity, and how long it's waited. A count badge
  lives wherever the app surfaces sync status ("5 waiting on catalog"). Empty state is the
  normal, healthy state and should read as calm, not alarming.
- **Entry detail.** All raw Dex fields (so she can sanity-check against the physical card),
  the reason, retry history, and the actions: *Match manually*, *Dismiss*, and for dismissed
  entries *Un-dismiss*.
- **Catalog picker** (manual-match). Pre-filtered per A.8, real card thumbnails (live TCGdex
  image URLs, per the established design), full collector numbers. She confirms one card.

---

# PART B — Sync Preview / Apply / Undo

## B.1 The fast-path rule (when preview is skipped)

After classification (architecture §1.7) and the variant-migration pass, the engine inspects the
operation set:

> **Fast-path iff the diff contains ONLY `ADDED` and `CHANGED(+)` operations** (new cards, or
> count increases that create new unplaced copies) **— and zero `REMOVED`, `CHANGED(−)`, and
> zero `VARIANT_UPDATE`.** New `UNRESOLVED` parks and self-heal promotions do not disqualify it,
> since neither touches existing placement.

- **Fast-path taken →** apply immediately, no gate. Show a **non-blocking notification**:
  "6 new cards added · 5 waiting on catalog · tap to place." The apply still writes an undo
  snapshot (B.4), so a wrong auto-apply is one tap to reverse.
- **Fast-path NOT taken →** any removal or variant change means placement could move, so the
  sync **stops at the Preview screen** and writes nothing until she confirms.

Rationale: additions can only ever add unplaced copies to the cascade — they cannot overwrite,
reset, or lose an existing placement. So gating them buys no safety, only friction. Everything
that *can* disturb placement is exactly what the preview exists to catch.

## B.2 Preview diff model

When the gate triggers, the preview presents the classified diff in fixed sections, most-
consequential first, with a summary line at the top:

> **Summary:** `2 removed · 3 variant changes · 4 added · 5 waiting on catalog · 671 unchanged`

| Section | Contents | Why it's shown |
|---|---|---|
| **Removals** | Each retiring copy: card, variant, and its **current placement + the consequence** ("frees Lightning line slot → placeholder", "was Binder 2 back", "recorded as a binder block — needs your call") | Highest risk; every removal is the app trusting the snapshot |
| **Variant changes** | Each `VARIANT_UPDATE`: old→new variant, and "placement preserved" | Reassures her the common case keeps placement |
| **Additions** | New cards / new copies, all headed to the cascade unplaced | So new arrivals aren't a surprise |
| **Unresolved** | New parks + still-waiting count, with the reason | Makes catalog lag visible |
| **Unchanged** | Collapsed to a count only | Proof the sync is leaving her collection alone |

## B.3 Overrides she can make in the preview

The preview is not read-only; it's where she corrects the snapshot's inevitable ambiguity:

- **Which copy left (on a shrink).** When a group goes 3→2 and copies sit in different places,
  the engine's default retires the least-committed copy (architecture §1.6). The preview shows
  that choice and lets her pick a different physical copy instead.
- **Confirm / reject a variant migration.** The migration pass pairs a `REMOVED` with an
  `ADDED` on the same card to carry placement across (this is what makes the phantom-fix clean).
  The preview surfaces each pairing so she can reject a coincidental pairing that isn't really
  the same physical card — rejecting splits it back into a true remove + a true add.
- **Block consequences.** A removal that would strand a repurposed binder block is flagged for a
  keep-or-free decision (never auto-reverted).

Line-slot reversions and bulk removals apply as specified without asking; they're shown, not
gated per-item.

## B.4 Apply and the undo snapshot

- **Apply is transactional.** All mutations (creates, retires, variant updates, slot reversions)
  commit together or not at all. A half-applied sync is never a valid state.
- **Immediately before committing, write a single `LastSyncSnapshot`** capturing the pre-apply
  state of everything the diff will touch: affected `Copy` records (placement included), the
  `PresenceGroup` counts, line-slot states, block roles, and queue entries. Last-sync-only, so
  each apply overwrites the previous snapshot.
- Applies triggered by the fast-path write the same snapshot — auto-applied syncs are equally
  undoable.

## B.5 Undo

- **One action reverts the entire most-recent sync**, restoring the `LastSyncSnapshot`: retired
  copies come back with their old placement, created copies are removed, variant updates revert,
  reverted line slots return to their filled state, and promoted/queue changes roll back.
- Available until the **next** sync applies (which overwrites the snapshot) — after that the
  undo point is gone and the button is disabled with a plain explanation.
- Undo does **not** re-contact Dex; it's a pure local state restore. It cannot "un-sell" a card
  in Dex — it only reverses what the app did.

## B.6 Screens (functional regions)

- **Sync entry point.** "Import Dex export" → file hand-off (per the painless-manual decision:
  one tap to point at the CSV). While parsing/resolving, a lightweight progress state.
- **Preview screen.** The sectioned diff (B.2) with inline overrides (B.3), a persistent summary
  line, and a single **Apply** action. A **Cancel** discards the whole thing and writes nothing.
- **Post-apply state.** For gated syncs, a confirmation with counts and an **Undo last sync**
  action. For fast-path syncs, the non-blocking notification carrying the same **Undo** and a
  **Place new cards** link into the routing cascade.
- **Place-now handoff.** After any apply that added cards, an optional jump into the cascade to
  place them, so "added" doesn't dead-end in a list (satisfies the brief's "must not silently
  vanish into a list").

---

## C. New data the app needs (summary for the dev spec)

- `UnresolvedEntry` table (A.3) with the `WAITING/RESOLVED/DISMISSED` state.
- `PresenceGroup` as the reconciliation unit keyed by `(catalogCardId, dexVariantRaw)`, holding
  its ordered `Copy` list (introduced in architecture §1.5; the UI reads counts from it).
- `Copy.dexVariantRaw` (identity) alongside the derived five-flag `variant` (display/placement).
- `LastSyncSnapshot` (B.4): a single serialized pre-apply state, overwritten each sync.
- Learned `SetAlias (locale, dexCode) → tcgdexSetId`, writable by manual-match (A.8) and by
  name-based auto-resolution (architecture §1.3).

## D. Edge cases

| Case | Behavior |
|---|---|
| Fast-path auto-applied the wrong additions | Undo is available exactly as for a gated sync (B.4–B.5). |
| Manual-match a set → many entries resolve | One learned alias drains every `WAITING` entry in that set on the next retry (A.8). |
| Unresolved card disappears from Dex before it ever resolved | Entry deleted silently; nothing was placed (A.7). |
| Self-heal promotes cards on a sync that ALSO has removals | Promotions are additions (fast-path-eligible), but the removals force the gate; both appear in one preview. |
| She dismisses an entry, then Dex exports it again | Stays `DISMISSED`, not re-surfaced as noise; she can un-dismiss (A.4). |
| Undo, then immediately re-import the same CSV | Re-import reproduces the same diff deterministically (engine idempotency); safe to redo. |
| Variant migration she rejects in preview | Splits into a real remove (removal rule) + real add (cascade); placement is released, not carried. |

## E. Open items for Karvi / the UI-UX chat

- **Notification surface for fast-path applies** — where does "6 new cards added" live (banner,
  badge, sync-status area)? Behavior is specified; placement is a design call.
- **Queue "waiting" affordance** — how prominent should the catalog-lag count be so it's honest
  without nagging, given her collection will often have new-set cards waiting?
- **Manual-match picker filtering** — confirm the default pre-filter (set + number + name
  contains) matches how she'd actually hunt for the right card.
