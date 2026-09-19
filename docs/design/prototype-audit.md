# Prototype audit — `docs/design/prototype.html` against the shipped app (UIL-041)

One enumeration pass, done once so the next gap is not found the way UIL-036 was (by remembering the
prototype and noticing the app does not match it). Audited on `develop` `d40159b`, 2026-09-19. The
prototype is a single 1,803-line file: HTML, CSS and one `<script>` block (lines 696–1801) holding 80
functions, 50 inline `onclick` handlers and 11 `addEventListener` calls. Every user-visible behaviour
those drive is listed below, grouped by screen, with the React file that ports it.

**How to read this.** It is a checklist, not a bug list and not a build list. *Not ported* means two
things at once: the app has no counterpart, **and** the issue log has no entry recording a decision to
drop it. It does not mean the behaviour is wanted; some of these will turn out to be design evolution
nobody wrote down. Rows marked *Not ported* are candidates, and whether any becomes an issue-log entry is
the Senior BA's call with Karvi. Nothing here was built.

## How to read the status column

| Status | Meaning |
| --- | --- |
| **Ported** | The behaviour exists in the app with the same intent, even if the UI differs. |
| **Partial** | It exists, but a named sub-behaviour is missing or behaves differently. The note says which. |
| **Replaced** | Deliberately built differently; the issue-log entry that decided it is cited. |
| **Dropped** | Deliberately left out; one line of reason, with the entry or code comment that records it. |
| **Not ported** | No counterpart found after searching, and no record of a decision to drop it. Candidate for Karvi. |

Helpers (`esc`, `hash`, `sigil`, `pc`, `num`, `jsq`, `img`, `face`, `bandChip`, `col`, `collKey`, …) are
folded into the behaviour they serve rather than listed. Line numbers are `prototype.html` on the left and
the React file on the right, as of the commit above; they will drift.

## Screen map

| Prototype tab (`nav.menu`, line ~100) | App route | Notes |
| --- | --- | --- |
| 1 HAUL PLAN (`#scr-plan`) | `/plan` — `app/(ui)/plan/PlanScreen.tsx` | |
| 2 DECISIONS (badge, opens the queue) | inside `/plan` and `/line` | The prototype's tab opened the decision sheet directly (`openDecQueue`); the app has no separate tab — decisions are worked from the Plan and from the Lines screen's alert bar. See the Decisions section. |
| 3 LINES (`#scr-line`) | `/line` — `app/(ui)/line/LineScreen.tsx` | |
| 4 LOOKUP (`#scr-look`) | `/look` — `app/(ui)/look/LookupScreen.tsx` | |
| 5 COLLECTIONS (`#scr-coll`) | `/coll` — `app/(ui)/coll/CollHub.tsx` | The builder search moved to its own route, `/coll/search` (`CardSearchGrid.tsx`, UIL-039). |
| — | `/backfill`, `/binders`, `/settings`, `/sync` | App-only screens with no prototype counterpart; out of this audit's scope. |

## Collections

| # | Behaviour | Prototype | Status | React counterpart | Notes |
| --- | --- | --- | --- | --- | --- |
| C1 | Collections list: a card per collection with name, binder, FINITE/OPEN toggle, EDIT, and a "+ NEW COLLECTION" button | `renderColls` 1398–1453 | Ported | `CollHub.tsx` `CollectionsView` 402–489, `CollectionCard` 498–686 | App adds per-card fold + Collapse/Expand all (UIL-034/059), a Draft pill (UIL-038), a Delete button in the header, most-recently-modified sort (UIL-052). The card's **note** line is gone (C14). |
| C2 | Finite progress: bar, "N / M owned · pct%", wishlist count or COMPLETE | `renderColls` 1401–1404, 1417–1420 | Ported | `CollectionCard` 588–601; `lib/surfaces/collections.ts` `finiteProgress` | Prototype says "N on the wishlist" for every unowned card; app says "N needed". Ownership is derived from shelved copies, not a stored flag. |
| C3 | Finite card grid: face, name, number, OWNED / ON WISHLIST pill or "+ WISHLIST" button; needed cards hatched | `renderColls` 1421–1432 | Ported | `CollectionCard` 602–644 | App adds "Remove ▸" on owned cards (UIL-014). |
| C3a | Wishlist a card | `wishlistCard` 1455 | Ported | `CollHub.tsx` `onWishlist` 302 → `actions.ts` `wishlistCollectionCard` 318–345 | Writes a real `wishlist_item`; shows in the Wishlist tab. No toast (C20). |
| C4 | Finite / Open toggle on the card | `setCollMode` 1454 | Ported | `CollectionCard` 555–570 → `actions.ts` `setCollectionMode` 244–252 | Persisted to `collection.mode` (migration 0005). Border width defect is UIL-025 (#260). |
| C5 | Open collection running-count box: big number, "+ LOG A CARD" | `renderColls` 1434–1441 | Partial | `CollectionCard` 648–655 | Missing: "· N unlisted + M logged" when a starting count exists — because there is no starting count (C13). |
| C6 | Open collection logged-cards grid with IN COLLECTION pill and "− REMOVE" | `renderColls` 1442–1450 | Partial | `CollectionCard` 656–681 | Grid, pill and remove ported. Missing the caption line "LOGGED CARDS · EACH LIVES IN binder". |
| C6a | Remove a logged card | `unlogColl` 1509 | Replaced | `CollHub.tsx` `requestRemove` 220–231 → `MoveOverlay` → `lib/coll/remove.ts` | UIL-014: removal is a **move**; she picks the copy's new home (default bulk box). Prototype spliced the array. |
| C7 | Log-a-card overlay: title, Close, search, results, location lock line, "LOG IT" | `openCollLog` 1460, `renderCollLog` 1480–1498 | Ported | `CollHub.tsx` `LogCardModal` 1148–1221 | |
| C7a | Live catalog search while typing (top 8, hint when empty) | `logSearch` 1463, `logResultsHTML` 1464–1476 | Ported (UI differs) | `_components/CardResultsGrid.tsx`; `actions.ts` `searchCatalog` → `lib/repo/catalog-card.ts` `search` | Image-first tiles (UIL-039 principle, UIL-071), not text rows; 2-character minimum, 200 ms debounce; failure state distinct from no-match (UIL-035). |
| C7b | Pick a result → picked row with face, name, number | `logPick` 1477 | Ported | `LogCardModal` 1173–1203 | Picking clears the query; prototype kept it. |
| C7c | Log free text "as typed" for a card not in the catalog | `logFree` 1478, button 1475 | **Not ported** | — | `LogCardModal.onLog` takes a `tcgdexId` only (1152); `lib/coll/log.ts` `applyCollectionLog` requires a real `catalog_card`. A card the catalog lacks cannot be logged. No entry records a decision. |
| C7d | Clear the pick (✕) | `logClearPick` 1479 | Ported | `LogCardModal` 1199–1201 | |
| C7e | Confirm "LOG IT": disabled until a pick; card becomes owned; Lookup then answers with the collection | `confirmCollLog` 1499–1508 | Ported | `LogCardModal` 1208–1215 → `actions.ts` `logCardIntoCollection` → `lib/coll/log.ts` | One `apply_write_ops` transaction (UIL-033); refuses when she already owns the card elsewhere (UIL-048). Errors go to the page alert bar, not a toast. |
| C7f | Close the log overlay: Close button, Esc, click on the backdrop | veil click 1748, Esc 1776–1779 | Partial | `LogCardModal` Close 1162–1164, backdrop 1157 | **Esc does not close the Log-a-card modal**; the only `Escape` handler in `CollHub.tsx` (930) belongs to the editor. |
| C8 | Open the editor: "+ NEW COLLECTION" (defaults) or "✎ EDIT" (working copy) | `openCollEditor` 1515–1528 | Replaced | `CollHub.tsx` `openNew` 167–194, `openEdit` 195–212, `CollectionEditor` 850–1146 | UIL-038: "new" creates a server-side draft at once and every edit autosaves (`coll/autosave.ts`); `?edit=<id>` reopens after the search page. |
| C8a | Close the editor: button, Esc, backdrop click; discards the working copy | `closeCollEditor` 1529, veil 1749, Esc 1776–1779 | Replaced | `CollectionEditor` `requestClose` 905–913, Esc 928–934 | Backdrop click deliberately does not close (UIL-009). Nothing is discarded (autosave); an empty new draft is deleted on close. |
| C9 | Name field | `ceType('name')` 1531 | Ported | `CollectionEditor` 1001–1009 | The live name is not echoed in the sheet caption. |
| C10 | Specialty-binder chips + "+ NEW BINDER" chip revealing a name input | `ceSet('binder')` 1533, `ceResolvedBinder` 1542 | Ported | `CollectionEditor` 1029–1061; `lib/coll/save.ts` 61–80 | Rebinding a collection with owned copies is refused (UIL-040). App does not clear the new-binder name when an existing chip is picked. |
| C11 | Size toggle: FINITE · SET LIST / OPEN · RUNNING COUNT | `ceSet('mode')` 1533 | Ported | `CollectionEditor` 1011–1027 | Labels shortened to Finite / Open. |
| C12 | Finite card list in the editor: rows with face, name, number, OWNED/NEEDED, ✕ | `renderCollEditor` 1556–1568 | Partial | `CollectionEditor` 1076–1108 | Rows have no card face thumbnail. |
| C12a | Toggle OWNED / NEEDED per card in the editor | `ceOwn` 1540 | Dropped | — | Ownership is derived from what is on the shelf (`actions.ts` 103–147); the editor says so at 1066 and shows a static "Owned · remove on the card" pill. Recorded only in code comments (`CollHub.tsx` 59–66), not in the issue log. |
| C12b | Remove a card from the list (✕) | `ceRemoveCard` 1541 | Partial (by design) | `CollectionEditor` `removeTarget` 946–951; `lib/coll/save.ts` `blockedTargetDrops` | Offered only for un-owned targets; owned rows refuse and point to Remove on the card (UIL-014 defect 2). |
| C12c | Add a card by typing name + set/number ("+ ADD") | `ceAddCard` 1534–1539 | Replaced | "Search & add cards →" → `/coll/search`, `CardSearchGrid.tsx`, `actions.ts` `bulkAddTargets` | UIL-039: inline add removed in favour of the filtered, multi-select search page. Only catalog cards can be targets. |
| C13 | Open-mode STARTING COUNT input ("N unlisted + M logged") | `ceType('count')` 1531, 1573–1576 | **Not ported** | — | No count input; `collection` has no count column (`supabase/migrations/0002_domain.sql` 102–110). Caption at `CollHub.tsx` 1121 says cards are logged one at a time. No entry records a decision. |
| C14 | NOTE field ("what this collection is"), shown on the card | `ceType('note')` 1531, 1565–1566, shown 1406 | **Not ported** | — | No note input, no column, `CollectionInput` (`coll-types.ts` 71–78) has no note. No entry records a decision. |
| C15 | Validation: Save disabled unless name, binder and **unique name** | `ceValid` 1543–1549 | Partial | `CollectionEditor` `valid` 979–981; `lib/coll/save.ts` 55, 78 | Name and binder are enforced client- and server-side. **Duplicate names are not**: no client check, no server check, no unique constraint in any migration. Two collections can share a name. |
| C16 | Save / Create | `saveColl` 1601–1610 | Replaced | `CollHub.tsx` `submitEditor` 233–245; `lib/coll/save.ts` `applyCollectionSave` | UIL-038: the button confirms what autosave already wrote. New binder is created as a specialty binder. No toast. |
| C17 | Delete collection (inside the editor, edit mode only) | `deleteColl` 1611–1614 | Ported (moved) | `CollectionCard` header 574–582 → `actions.ts` `deleteCollection` | Now on the card with a native confirm; also used silently to discard an empty new draft. |
| C18 | Hover styles on collection controls | CSS 365–418 | Partial | `globals.css`: `.wbtn` 2092, `.logbtn` 2125, `.newcollbtn` 1939, `.editcollbtn` 2002, `.cex` 2561 | Five of nine. `.ceaddbtn`, `.cedel`, `.logrow`, `.logrow.free` (and `.logres`, `.logpick`, `.cebtn`, `.ceadd`) have no rule and no consumer: orphaned with the behaviours in C7a, C7c, C12a, C12c, C17. |
| C19 | Toast after wishlist / log / remove / save / delete | 1455, 1507, 1509, 1609, 1613 | **Not ported** (this screen) | — | `.toast` exists and the Plan and Settings screens use one; `CollHub.tsx` has none. Success is the list re-rendering; only errors are shown (alert bar 260–265). |

## Haul Plan and spotlight

`Plan` = `app/(ui)/plan/PlanScreen.tsx`.

| # | Behaviour | Prototype | Status | React counterpart | Notes |
| --- | --- | --- | --- | --- | --- |
| P1 | Worklist grouped band → BASICS / STAGE 1·2 (TRAINERS · ITEMS for white) → rows; band header with chip, name, count; empty band reads "RESERVED. THE SLOT HOLDS EVEN AT ZERO." / "NOTHING THIS HAUL." | `renderPlan` 1045–1072, `cardsIn` 1073, `actOrder` 1044 | Ported | `Plan` `PlanView` 1244–1263, `BandSection` 1344–1473; `lib/plan/group.ts` | Rows are A–Z within a sub-group (UIL-076), not action order. Bands and sub-groups fold (UIL-018/075). Batched rows ("×N") have no counterpart: `PlanItem` has no batch field. |
| P2 | Row: box, colour rail, face, name, number, destination, action chip; DECIDE when pending, RESOLVED when decided | `rowHTML` 1074–1087 | Partial | `Plan` `PlanRow` 1476–1556 | "Decide" chip ported; **RESOLVED chip not ported** — the plan holds no resolution state (decisions resolve on `/line`, P13). "Moved" chip added for overrides (UIL-037). |
| P3 | Click a row → it becomes the current card and scrolls into view | `renderPlan` 1066–1070, `setCur` 1088 | Partial | `PlanRow` onClick 1497; Enter on a focused row 1500–1502 | Selection ported. **`scrollIntoView` not ported** (zero hits in `app/`), so Back/Skip can leave the current row off-screen. |
| P4 | Click the row's box → toggle done; clicking again un-does | `renderPlan` 1068, `toggle` 1090 | Dropped (un-toggle) | `PlanRow` box 1506–1516 → `shelveCard` 428–498 | UIL-027: the box now writes the placement and is disabled once done; corrections go through Move (`Plan` 421–423). Box click no longer selects the row. |
| P5 | Haul bar: count, one pip per card, done / total, FRONT · BACK · SPECIALTY · BULK summary | `updateProgress` 1129–1135 | Ported | `PlanView` 1161–1185; `lib/plan/progress.ts` | Pips capped at 40 and bucketed (UIL-007); bar is sticky (UIL-019/058); RESUMED tag (UIL-006). |
| P6 | Decision alert bar "N DECISIONS WAITING · OPEN FIRST [D]" vs "ALL RESOLVED · READY TO COMMIT"; DECISIONS tab badge | `updateProgress` 1136–1150, `#decBadge` 598 | Partial | `PlanView` 1187–1199; `Line` 303–325 | On the Plan the bar says "resolve in Lines" with no Open-first button; **the tab badge is not ported** — `_components/TopBar.tsx` has no Decisions tab (see Decisions below). |
| P7 | Spotlight cap "NOW HANDLING · i / N" | `renderSpot` 1095 | Ported | `PlanView` 1266–1270 | |
| P8 | Spotlight identity: large face, name (+×batch), number, set name, stage · variant, band chip | `renderSpot` 1101–1106 | Ported | `Plan` `Spotlight` 1636–1665 | Shows set id rather than set name; no batch. Face is zoomable (UIL-036). |
| P9 | Instruction: big verb + destination; "FROM · source" for pulls; MOVED · OVERRIDE tag | `renderSpot` 1107–1110 | Partial | `Spotlight` 1667–1670, `displayFor` 971–994, movedtag 1756 | **"FROM · …" not ported** — `PlanItem` has no source field. Additive: colour-mismatch radios (UIL-069), proposed-pull ticks (UIL-061), "Changed by this haul" (UIL-045). |
| P10 | "↔ CHANGE POSITION" opens the Move sheet pre-seeded with the card's binder / half / band | `renderSpot` 1098, `openMove({src:'spot'})` 1274–1284 | Ported | `Spotlight` 1780–1782 → `Plan` `openMove` 340–372 → `MoveOverlay` | Seeds from an existing override or the general binder; loads line-join candidates so BACK HALF works from the plan (UIL-070). Confirm records a client-side override applied at Done (P30). |
| P11 | Reason line under the instruction | `renderSpot` 1112 | Ported | `Spotlight` 1784–1786 | The prototype's "sample" line has no counterpart (minor). |
| P12 | "NEEDS YOU" block with DECIDE [D] opening the sheet; "YOUR CALL" block showing the resolution | `renderSpot` 1113–1116, `openDec` | Partial | `Spotlight` 1788–1795 ("Needs a decision — resolve in Lines") | Flag ported. **Opening the decision from the plan and the YOUR CALL block are not ported**; the sheet is mounted only on `/line`. UIL-064 problem 2 records "sent away from the Haul Plan" as a deliberate call, later reversed for back-half moves only (UIL-070). |
| P13 | "DONE, NEXT CARD [SPACE]" marks done and advances; UNDO reverses | `toggle(cur);advance()` 1120, `advance` 1091 | Dropped (UNDO) | `Spotlight` 1809–1824 → `shelveCard` + `advance` 659–663 | Done is a DB write per card and advances on success (UIL-027); UNDO dropped by the same ruling (`Plan` 1798–1799). Disabled while re-checking (UIL-045) or a colour mismatch is open (UIL-069). |
| P14 | ◀ BACK / SKIP ▶ move the cursor without marking | `setCur(cur±1)` 1121–1122 | Ported | `Spotlight` 1825–1830 | |
| P15 | "THE LINE" button jumps to the card's evolution line | `renderSpot` 1123 → `goLine` 1620 | **Not ported** | — | `Spotlight` (1559–1841) has no link to `/line`; `PlanItem` carries no line id. |
| P16 | NEXT UP strip: the next five not-done faces, click to jump; hidden on phones | `renderSpot` 1097, 1124–1127; `.nextup` 243–247 | **Not ported** | — | No `.nextup` rule in `globals.css`, no upcoming faces in `Spotlight`, no issue-log mention. |
| P17 | Keyboard on the plan: SPACE / Enter = done + advance, J K ↓ ↑ = move, D = decide; hint "SPACE DONE · J K MOVE · D DECIDE" | keydown 1770–1798, hint 1128 | **Not ported** | Esc only, in `MoveOverlay` 62–68 and `CardLightbox` 67–71 | No global key handler on the plan and no `.kbd` hints. Only Enter on a focused row exists (`PlanRow` 1500). No entry drops the shortcuts on purpose. |
| P18 | Toast: bottom-centre, slides up and fades in, hides after 2.6 s, new message replaces old | `toast` 1313–1317; `#toast` CSS 430–434 | Partial | `Plan` `flashToast` 335–338; `Line` 197–200; `Look` 68–71; `globals.css` `.toast` 1544–1557 | Same 2600 ms timer and replace-on-new. **No transition rule**: the element mounts and unmounts with no fade or slide. Sync uses a click-to-dismiss variant. |

## Decisions

`DC` = `app/(ui)/_components/DecisionCard.tsx`, `Line` = `app/(ui)/line/LineScreen.tsx`.

| # | Behaviour | Prototype | Status | React counterpart | Notes |
| --- | --- | --- | --- | --- | --- |
| D1 | Open the queue (DECISIONS tab, OPEN FIRST, key 2) → first unresolved decision | `openDecQueue` 1153–1156 | Partial | `Line` 315–324 "Work the decisions ▶" | Queue lives on `/line` only: no tab, no badge, no entry from the plan (P6, P12). |
| D2 | Decision sheet: cap, kind, card hand, question, CATALOG / YOU OWN / WHY columns, PROPOSED choices | `openDec` 1157–1180 | Ported | `DC` 66–137; `lib/line/decisions.ts` | UIL-067 (open) says the card is crowded — a future change, not a port gap. |
| D3 | Pick a proposal (recommended one marked) → resolved; sheet shows YOU CHOSE; plan re-renders | `choose` 1385 | Ported | `DC` 222–253 → `Line` `onChoose` 202–220 → `line/actions.ts` `resolveDecisionAction` | Now a server write, persisted via slot markers (UIL-078); after a reload the decision leaves the queue rather than showing YOU CHOSE. Toast "Decision recorded". |
| D4 | Resolved state: YOU CHOSE (green) / YOU OVERRODE (amber, "logged as a manual call") + CHANGE / THE LINE ▶ / ◀ PLAN | `openDec` 1181–1185 | Partial | `DC` 193–219 | Amber now means "picked a non-recommended choice" (`DC` 57–59); the prototype reserved it for a manual override (D7). THE LINE / PLAN buttons collapsed into "◀ Back to the line" since the sheet already lives on `/line`. |
| D5 | CHANGE (reopen) a resolved decision | `reopen` 1386 | Ported | `DC` 212–214 → `Line` `onReopen` 222–228 | Same-session only; re-choosing writes again. |
| D6 | Close the sheet: CLOSE, click the veil, Esc | `closeDec` 1387, veil 1747, Esc 1773 | Partial | `DC` 70–77; `Line` backdrop 434–436 | **Esc not ported for the decision veil** — `Line` registers no keydown listener; `MoveOverlay` does. |
| D7 | "✎ PLACE IT MYSELF · OVERRIDE THE RULE" toggle inside a decision reveals the placement panel; PLACE IT HERE resolves it as MANUAL OVERRIDE | `toggleOvr` 1232, `ovrBlock` 1318–1326, `confirmOvr` 1260–1266 | **Not ported** | — | `DC` offers choices only; hint reads "Pick a proposal above. The system never blocks a line without you." (254–256). Manual placement survives only as Move (M1), which does not resolve a decision. `DecisionChoiceId` (`lib/line/types.ts` 130–141) has no manual-placement choice. No entry records the drop. |
| D8 | Wishlist strip inside the sheet: art, badge, number, price; tap to pick (WISHLISTING pill); "TAP ART TO ENLARGE" | `wishStrip` 1367–1383, `pickWish` 1384 | Partial | `DC` 139–191 (`pickedAlt` → `onChoose`, UIL-057) | Same place. Header reads "CHEAPEST FIRST"; the strip's `CardFace` (`DC` 177) is **not zoomable**, so enlarging from the strip is unavailable although UIL-036 ported the lightbox. |

## Move / manual placement

`MO` = `app/(ui)/_components/MoveOverlay.tsx`, `MP` = `app/(ui)/_components/MovePanel.tsx`.

| # | Behaviour | Prototype | Status | React counterpart | Notes |
| --- | --- | --- | --- | --- | --- |
| M1 | Move a shelved card from a line slot, a lookup result or the spotlight: sheet "MOVE A SHELVED CARD", NOW · current home, placement panel, hint "no rule applies here, it is your call" | `openMove` 1274–1284, `renderMove` 1286–1299 | Ported | `MO` 41–137; `Line` `openMove` 230–233 + `Slot` 636–640; `Look` `openMove` 95–109 (UIL-051); `Plan` P10 | Also offered from Collections (UIL-014/043), additive. Line slots show Move only when `slot.moveable`. |
| M2 | Pick a BINDER (chips; specialty binders styled); the binder decides shelf vs collection mode | `setOvr(id,'binder')` 1233–1244, `isSpec` 1224 | Ported | `MP` 152–171, 89–92 | Options come from the DB (`MoveOptions`). |
| M3 | "+ NEW BINDER" chip with a name input inside the panel | `setOvr binder '__new'` 1332, 1345, `ovrName` 1247 | **Not ported** | — | `MP` lists existing binders only. Binder creation exists on the Collections editor (C10), not from a decision or a move. |
| M4 | "▤ BULK BOX · DON'T SHELF" chip with explanatory line | `setOvr binder '__bulk'` 1333, 1346–1348 | Ported | `MP` 172–195 | |
| M5 | HALF chips FRONT / BACK | `setOvr(id,'half')` 1355–1356 | Ported | `MP` 221–245 | BACK is disabled with an inline reason until a line is picked (UIL-056/072); from the plan the line picker is available (UIL-070). |
| M6 | COLOUR BAND · RAINBOW ORDER chips with swatch, RSV on pink | `setOvr(id,'band')` 1327–1329 | Ported | `MP` 246–272 | |
| M7 | Specialty binder: COLLECTION chips scoped to that binder, "+ NEW COLLECTION" + name input, grouped-by-collection note | `setOvr(id,'coll')` 1336–1339, 1349–1353 | Partial | `MP` 196–218 | Scoped chips ported. **"+ NEW COLLECTION" not ported** — an empty binder says "Create one on the Collections screen." (201–203). The note is not shown. |
| M8 | Live summary "PLACING · dest" with PICK A BAND / PICK A COLLECTION placeholders | `ovrSummary` 1259, `ovrDest` 1248–1258 | Ported | `MP` `summary()` 132–148 | Adds the line-join placeholders (UIL-070). |
| M9 | "PLACE IT HERE ▶" disabled until the destination is complete | `canConfirm` 1341 | Ported | `MP` 107, 421–428; `lib/line/move.ts` `isMoveDestinationComplete` | Same predicate the server refuses on (UIL-070). |
| M10 | Panel header "MANUAL PLACEMENT · AGAINST THE PROPOSAL" / "YOUR CALL" | `ovrBlock` 1342 | Ported | `MP` 380–384 | Wording changed because there is no proposal in the Move context; JOIN A LINE section added (UIL-064/068). |
| M11 | Close the Move sheet: CLOSE, veil, Esc | `closeMove` 1285 | Ported | `MO` 62–68, 76–78, 86–93 | |
| M12 | Confirm a move → destination recorded, originating screen refreshed, toast "MOVED · name → dest" | `confirmMove` 1300–1312 | Ported | `Line` `onMoveConfirm` 244–257; `Look` 111–125; `Plan` 374–385 | Line and Lookup moves are real writes now. The Plan keeps the prototype's deferred model: the override is applied when she clicks Done (UIL-037). |

## Lines

`Line` = `app/(ui)/line/LineScreen.tsx`.

| # | Behaviour | Prototype | Status | React counterpart | Notes |
| --- | --- | --- | --- | --- | --- |
| L1 | Jump to a specific line from the spotlight, the decision sheet or a lookup fact ("THE LINE ▶") | `goLine` 1620; call sites 1122, 1182, 1725 | Partial | `/line` exists; `Line` reads only `?view=` (156) and defaults to the first line (173) | **No deep link to a given line.** Lookup renders a static "LINE · M7" tag (`LookupScreen.tsx` 285–290) although `LookupFact.lineId` is populated (`lib/surfaces/lookup.ts` 150–163). Same gap as P15. |
| L2 | Line tab strip: one tab per line (band chip + label), click switches, active tab inverted | `renderLine` 1622–1626 | Ported | `Line` `LineTabs` 97–139; `globals.css` 755–777 | Label omits the band word. App adds the order toggle and binder headings (UIL-074). |
| L3 | Line header: species, chip + band + binder + ◆/◇/✕ counts, status badge, coloured page rail | `renderLine` 1627–1636 | Ported | `Line` 351–372 | App adds ◆ COMPLETE. |
| L4 | Slot strip joined by pixel arrows, arrows greyed next to a block; capped line ends in a torn edge + CAP plate | `renderLine` 1638–1646 | Ported | `Line` 379–425; `globals.css` 1041–1116 | Scroll-snap at all widths, not mobile only. |
| L5 | Slot card: stage / FILLED · HUNTING · BLOCKED, band-coloured top tag, art (X for a block, dimmed when hunting), name, number, set, price + blinking caret, alternates, wedge; filled slot shows "MOVED → dest" and ↔ MOVE | `slotHTML` 1649–1687 | Partial | `Line` `Slot` 550–645 | Missing: **the "MOVED → …" tag on a relocated slot** (`.movedtag` exists but only `PlanScreen.tsx` 1756 renders it) and **the slot face is not zoomable** (582–586; see S3). Move is gated on `slot.moveable`, not every filled slot. |

## Lookup

`Look` = `app/(ui)/look/LookupScreen.tsx`.

| # | Behaviour | Prototype | Status | React counterpart | Notes |
| --- | --- | --- | --- | --- | --- |
| K1 | Type a name or number → "binder → half → band" appears as she types; empty box clears; FIND re-runs | `doLook` 1693–1698, `#q` listener 1768, `#qgo` 1769 | Replaced | `Look` 129 mounts `CardResultsGrid`; pick a tile → `lookupAnswer` (`look/actions.ts` 47–54) → `AnswerPanel` | UIL-071: every search is the image-first grid, so the answer takes a second tap (pick the tile). No FIND button, no uppercase styling. |
| K2 | Suggestion chips under the box (CHARMELEON, CHARIZARD ex, …), tap to look up | `renderSugg` 1689–1692; boot `doLook('CHARMELEON')` 1801 | **Not ported** | — | The `.sugg` rules in `globals.css` (619–642) are orphaned: no TSX renders the class. The chips were canned demo data; whether a "recent lookups" equivalent is wanted is a product question. |
| K3 | Answer panel: YOU OWN IT / NOT OWNED cap, face + name + number, rainbow band stack with hers tall, big BINDER / HALF / band address; unowned → NOT IN A BINDER; blocked → "NOT OWNED AND BLOCKED · NOTHING CAN FILL IT"; moved → address + MOVED · OVERRIDE; facts with tone icons | `doLook` 1704–1729 | Partial | `Look` `AnswerPanel` 197–297; `lib/surfaces/lookup.ts` `buildLookupAnswer` 129–229 | Missing: **the "not owned and blocked" branch** (no "blocked" in `lib/surfaces/lookup.ts`) and the MOVED · OVERRIDE annotation (the app reads real placement; there is no override map). App adds SPECIALTY · BY COLLECTION and the full number (UIL-077). |
| K4 | Move the looked-up card from the answer | `openMove({src:'look'})` 1710–1711 | Ported | `Look` `CopyRows` 305–340 → `openMove` 95–109 (UIL-051) | One Move per physical copy; a block copy shows the reason and remedy instead. |
| K5 | "NO MATCH." notice | `doLook` 1699–1702 | Ported | `Look` `LookupNotice` 174–183 | Copy changed on purpose (UIL-035, UIL-011); failure states are separate. |
| K6 | Opening the Lookup tab focuses the search box | tab listener 1743, hotkey 4 1788 | **Not ported** | — | No `autoFocus` in `CardResultsGrid.tsx` or `Look`; only the Collections search page autofocuses (`CardSearchGrid.tsx` 187). |

## Shared chrome: navigation, keyboard, zoom, toast, hover

| # | Behaviour | Prototype | Status | React counterpart | Notes |
| --- | --- | --- | --- | --- | --- |
| S1 | Top nav: 1 HAUL PLAN · 2 DECISIONS (pending-count badge, opens the queue) · 3 LINES · 4 LOOKUP · 5 COLLECTIONS; click shows the screen, scrolls to top | `show` 1732–1737, tab listener 1738–1745, `#decBadge` 1137 | Partial | `_components/TopBar.tsx` 13–22: eight `Link` tabs (Plan, Lookup, Lines, Collections, Backfill, Sync, Binders, Settings) | **No DECISIONS tab and no pending-count badge anywhere** (the only `.badge` rule is the wishlist card's). Decisions are reached from the Lines alert bar (D1). Tab numerals are decorative, not hotkeys (S2). |
| S2 | Keyboard: hotkeys 1–5 switch screens (4 also focuses the search); Esc blurs a text box or closes the open sheet; Plan keys per P17 | keydown 1771–1798 | Partial | Esc closes the lightbox (`CardLightbox.tsx` 66–72), the Move sheet (`MoveOverlay.tsx` 62–68) and the collection editor (`CollHub.tsx` 927–934, dirty-guarded) | **Not ported: screen hotkeys, the Plan keys (P17), Esc on the decision veil (D6) and on the Log-a-card modal (C7f), blur-on-Esc in inputs.** No entry mentions keyboard shortcuts. |
| S3 | Card art enlarges: zoom cursor + ring on hover, click opens a full-screen lightbox (LOADING → high-res, "unavailable offline" on error) with caption and "click anywhere or press Esc to close"; the click does not fire the row underneath; blocks are not zoomable | `face` 1023–1033, `openZoom` 1752–1761, `closeZoom` 1762, listeners 1763–1767, 1773–1775 | Partial | `CardFace.tsx` 51–101, `CardLightbox.tsx` 39–105 (UIL-036, #232, #241); wired on the Plan, Lookup and Collections | Not zoomable yet: **Lines slot faces** (`Line` 582–586) and unlined-card faces (523), the **decision card's wishlist strip** (D8), and search-result tiles. UIL-036 names the tiles and the decision card as follow-ons; the Lines strip is not on its list. |
| S4 | Toast slides up and fades in, hides after 2.6 s, new message replaces old | `toast` 1313–1317; `#toast` CSS 430–434 | Partial | `.toast` `globals.css` 1544–1557; per-screen `flashToast` on Plan, Lines, Lookup | Timer and replacement ported. **No slide or fade**: `.toast` carries only a static transform, no `transition`, and the element mounts and unmounts. Collections has no toast at all (C19); Sync's is click-to-dismiss; Settings uses an alert bar. |
| S5 | Click outside a sheet dismisses it (decision, move, collection editor) | veil listeners 1747–1749 | Ported / Replaced | `Line` 432–437; `MoveOverlay.tsx` 71–80 | The collection editor deliberately does not dismiss on backdrop (UIL-009: "a form, not a lightbox"). |
| S6 | Blinking "!" while decisions are pending; blinking caret after a hunting slot's price | `@keyframes blink` 124; 487–488 | Ported | `globals.css` 267–274, 970–978; `Line` 307, 607; `Plan` 1188 | |
| S7 | Hover states on buttons and chips (22 rules) | CSS 63–538 | Partial | `globals.css`: `.btn` 91, `.btn-primary` 113, `.movebtn` 1152, `.wbtn` 2092, `.logbtn` 2125, `.newcollbtn` 1939, `.editcollbtn` 2002, `.oconfirm` 1518, `.cex` 2561, `nav.menu .tab` 202, `.row` 358, `.dchoice` 1385, `.ochip` 1470, `.face.zoomable` 3089 | Missing where the component still exists: **`.wcard:hover`** (the wishlist card is interactive, `role="button"`, and has no hover). Absent because the component was replaced or dropped: `.ovrtoggle`, `.ceaddbtn`, `.cedel`, `.logrow`, `.logrow.free`, `.nextup button .face`. App adds hovers the prototype lacked (`.linetabs .lt`, `.bandhead`, `.collfold`, `.subhead`). |
| S8 | Collection progress bar animates its width | `.cbar i { transition: width .2s }` 352 | Ported | `globals.css` 2012–2018 (+ reduced-motion guard on `pbslide`) | |
| S9 | Card identity helpers: printed number only with a real denominator, set name, TCGdex art at low/high, band chip with dither for white | `pc`, `num`, `setName`, `img`, `bandChip`, `face` 1004–1033 | Ported | `lib/catalog/collector-number.ts` `formatCollectorNumber`; `CardFace.tsx` 50; `CardLightbox.tsx` 91; `BandChip.tsx` | UIL-077 restored the denominator. No `xl` face size. |
| S10 | Offline identity: a deterministic pixel "sigil" behind every face so a card stays recognisable when its image fails | `hash` 992, `sigil` 994–1003, `face` 1029–1032 | Replaced | `CardFace.tsx` 25–31 `initials()`, `onError` 85; `.face .fallback` `globals.css` 471 | Text initials instead of the pixel sigil; UIL-016 treats initials as the designed fallback. |

## Summary

Counted over the 90 rows in the six tables above (behaviours, not functions; S5 counts as Ported):

| Status | Rows |
| --- | --- |
| Ported | 43 |
| Partial (exists; a named piece missing) | 26 |
| Replaced or Dropped, with the deciding entry or comment cited | 10 |
| **Not ported, no record of a decision** | **11** |

### Not-ported candidates, for the Senior BA to take to Karvi

Listed, not built. Each is a prototype behaviour with no counterpart and no issue-log entry recording a decision to drop it.

| Row | Behaviour | Screen |
| --- | --- | --- |
| C7c | Log a card that is not in the catalog ("as typed" free text) | Collections |
| C13 | Starting count for an open collection ("N unlisted + M logged") | Collections |
| C14 | A note on a collection, shown on its card | Collections |
| C19 | Success toasts on the Collections screen (wishlist, log, remove, save, delete) | Collections |
| P15 / L1 | "THE LINE" jump from the spotlight (and from a decision or a lookup fact) to that card's line | Plan → Lines |
| P16 | NEXT UP strip: the next five cards, click to jump | Plan |
| P17 / S2 | Keyboard: Space / Enter done-and-advance, J K ↑ ↓ cursor, D decide, 1–5 screen hotkeys, Esc everywhere | Plan, all |
| D7 | "Place it myself" manual-override panel inside a decision, resolving it as a manual call | Decisions |
| M3 | "+ NEW BINDER" (and M7's "+ NEW COLLECTION") from inside the placement panel | Move |
| K2 | Suggestion chips under the Lookup box | Lookup |
| K6 | Lookup box focused on arrival | Lookup |

### Partial rows whose missing piece is a real gap (smaller candidates)

C7f Esc on Log-a-card · D6 Esc on the decision veil · C15 duplicate collection names allowed · C6 logged-cards caption · P2 RESOLVED chip on a plan row · P3 current row scrolls into view · P6 / S1 DECISIONS tab and pending badge · P9 "FROM · source" on pulls · P12 open a decision from the plan; YOUR CALL block · L5 "MOVED →" tag on a relocated slot · L5 / D8 / S3 zoom on Lines slots, the wishlist strip and result tiles · K3 "not owned and blocked" answer · S4 toast slide / fade · S7 `.wcard:hover`.

### Orphaned CSS

Rules in `app/globals.css` with no consumer, left behind by replaced behaviours: `.sugg` (619–642). Prototype classes that never made it into `globals.css` at all, so nothing to remove: `.ceaddbtn`, `.cedel`, `.cebtn`, `.ceadd`, `.logrow`, `.logrow.free`, `.logres`, `.logpick`, `.ovrtoggle`, `.nextup`, `.kbd`, `.searchbox`, `.face.xl`.

### Method

Three read-only passes (Plan/decisions/move; Collections; Lines/Lookup/shared) read every prototype function body in `docs/design/prototype.html` lines 696–1801 and searched `app/`, `lib/`, `app/globals.css` and `docs/issue-log.md` for each behaviour's nouns, then every Not-ported and Partial claim was re-verified by direct grep before it was written here. Companion files `docs/design/mockups.html` and `docs/design/rationale.md` were not audited; the entry names the prototype only.
