# Binder Ops: design rationale

Covers the visual language, the three slot states, the empty Pink band, the oversized White band, the
copy budget, how a card is identified, and every assumption I made rather than asking about.

Third revision. The first pass established the structure. The second moved the palette to the olive
and cream scheme from the reference sheet and cut roughly an eighth of the interface text, which
section 7 covers. This one answers three notes: full collector numbers, real card thumbnails, and
"the UX is not user-friendly enough." Section 9 covers card identity, and the density work is folded
into sections 6 and 7.

Files: `prototype.html` (clickable, screens 1 to 4) and `mockups.html` (static, screens 5 to 10).
Both are still single files with no build step, but they are no longer offline-only: every card face
now loads a real scan from `assets.tcgdex.net`. Section 9 explains that tradeoff and what happens
when the network is not there.

---

## 1. Visual language

**16-bit menu structure, cozy-game palette.** Chunky beveled panels with inset light and dark edges,
3px hard ink borders, hard offset drop shadows, zero border radius, uppercase pixel-monospace type
with generous letter spacing, and font smoothing switched off so the type stays crisp instead of
going soft. Every surface is either a panel, a plate, or a button, and each of those reads as a
physical object with an edge.

The palette comes from the reference sheet you sent: an olive green field with cream panels sitting
on top of it, warm browns for ink, and the sheet's own saturated hues doing the band work. Structure
stayed 16-bit, only the color changed, which moves the register from RPG menu toward Animal Crossing
or Stardew: still a game UI, no longer a dungeon one. Olive as the app background rather than as an
accent is what makes cream panels read as objects on a surface instead of as cards floating on
nothing, and it mirrors how the reference image hangs cream frames on an olive wall.

Three reasons this is the right register rather than a costume.

It matches the task. She is standing at a desk moving physical objects into physical slots. An RPG
inventory menu is the one interface convention that has always been about exactly that: a fixed
number of slots, an item in each, and a decision about where a new item goes. The metaphor is not
decorative, it is load bearing.

It kills the dashboard reflex. Once every element has a hard border and an offset shadow, a KPI
card row looks obviously wrong. The style does the enforcement so I do not have to keep resisting
the pull toward sidebar-plus-table.

It gives the ten bands somewhere to live. In a flat modern UI, ten saturated colors fight the
chrome. On cream, inside ink borders, they read as labels on a physical thing, which is what they
are.

**Where the bands came from.** Seven of the ten are lifted straight off the reference sheet: Fire
`#EC6F4D`, Lightning `#FEDF4F`, Grass `#45C55D`, Fairy `#FF94A6`, and the neutrals. The sheet has no
blue and no purple, so Darkness `#3B5687`, Water `#6FB9DD`, and Psychic `#9D6FB8` are derived, pitched
to the blues in the reference artwork so they belong to the same family. Dragon needed the most care,
because an olive band on an olive background is invisible: the background dropped to `#6D7B3C`, Dragon
lifted to `#8F9A3A`, and every swatch in the app carries the same 3px ink border, which is what
actually keeps the two apart.

**No licensed chrome anywhere.** The interface itself borrows nothing: no official logo, symbol,
type treatment, energy icon, or set graphic. Every border, bevel, band, glyph, and plate is drawn
from scratch in CSS. Card art is the one exception, and it is an exception you asked for; section 9
covers it.

**The generated sigil survived as the fallback.** A hash of the card name plus set expands into a
vertically mirrored 6 by 3 pixel pattern in that card's band color, with a darker shade for accent.
Same card always produces the same sigil. It used to be the card face. It now sits behind the
scan, so if an image cannot load the card is still visually distinct rather than an empty rectangle.
That was the reason to keep it rather than delete it.

**One deliberate concession.** The pixel font stack lists Silkscreen, Press Start 2P, and
DotGothic16 first, then falls back through system monospace. Nothing fetches a webfont, so most
machines will render the fallback. Everything else in the visual language, the bevels, the borders,
the shadows, the letter spacing, the pixel grid on the body, does the era work on its own, so the
prototype reads correctly with or without the font. If this goes to build, bundle Silkscreen locally
rather than adding a font CDN: card art is worth a network dependency, decorative type is not.

---

## 2. The three slot states

The brief says the line detail view is the emotional center and that if it reads as a table the
whole app becomes inventory software. So the states are not variations on a row. They are three
different objects.

**Filled** is a solid card. Band-colored header, the real scan at full brightness, the printed
collector number, a raised panel with a real shadow. It looks like something you own.

**Placeholder** is a sticky note, because in her binder today it literally is one. Yellow fill,
dashed border, the target card name, its printed number, a live market price, and the ranked cheaper
alternates underneath. The art shows too, dimmed and slightly desaturated, which is the point: she
can see exactly which card she is hunting without it reading as owned. Every element on the note is
an unfinished action. A blinking caret sits in the price line, the only motion in the app, on purpose:
this is the state she is supposed to feel restless about.

**Block** is a dead card. Flat grey-brown fill, a hatched diagonal area where the art would be, a
hard X built from two rotated bars, a dark tag strip, and the name of the spare card physically
wedged in that pocket. No price, no alternates, no action, no color from the band. It has been
drained.

The critical difference the brief called out, hunting versus can-never-be-filled, is carried by four
signals at once rather than by a label. Color: yellow versus grey. Motion: blinking versus completely
static. Presence of a price: a number versus nothing. And now presence of art: a dimmed real card
versus a hatched void. That last one is the strongest of the four, because a block is the only state
in the app with nothing to show, for the true reason that there is no card to show. You can tell them
apart from across the desk, in peripheral vision, and in greyscale.

Two line-level states sit on top of those three.

**Capped** gets its own object rather than a badge. Where the next stage would be, a purple plate
with a torn corner sits behind a broken arrow, reading that the only printing is an ex and lives in
another binder. The corner is clipped away so the line visibly does not close. That is the honest
representation: the line is fine, it is just never going to look finished.

**Terminated** greys the whole line header. A line needs two same-color members to be worth a page at
all, so a single block can kill it outright: the sample Scizor line is two stages, Scyther has no
Metal printing, and one block therefore leaves one member and no line. The header says so instead of
leaving her to infer it from a slot, and the surviving card falls through the cascade to the front
half.

**Same block, opposite consequence.** In a three-stage chain the arithmetic flips. Trapinch has no
Dragon printing, so the Dragon Trapinch-Vibrava-Flygon line loses its root, but Vibrava and Flygon
are two members, so the line lives with a blocked root. Identical catalog fact, identical slot state,
and the line dies in one chain and survives in the other purely on member count. That is why the
viability rule is stated as a threshold rather than as "a blocked root kills the line."

**A wedge only exists inside a surviving line.** The spare card wedged in a pocket is how a block is
represented physically, and a terminated line has no back-half page, so it has no pocket to wedge
into. The Scizor case therefore shows the line as terminated with the words NO PAGE, SO NO POCKET
instead of naming a wedge card. The same reasoning is why the backfill wizard's back-half walk never
lists a terminated line: there is no page to walk to. An earlier draft of the wizard showed one, and
it was teaching a rule that does not exist.

**Where blocks show up as an absence.** On the wishlist, a block produces no row at any price. That is
the entire practical consequence of the distinction. Rather than explain it in a footer, the Trapinch
group carries a ROOT BLOCKED tag and lists exactly one buyable card, so the gap is labeled at the
point where it occurs.

---

## 3. The empty Pink band

Pink is never hidden, never collapsed, never sorted to the bottom, and never behind a "show empty"
toggle. Its position reserves physical space in a real binder, so it holds its slot in all four
places a band can appear.

On the haul plan it renders as a dedicated row with a dashed reserved bar and one line of copy
explaining why it is empty and why it stays. On the binder view it gets a full band row with a
dashed meter and a RESERVED, 0 CARDS readout. On the lookup screen the vertical band stack shows all
ten bands with the active one enlarged, so Pink is visible on the card-show screen even when the
answer has nothing to do with it. On the settings band order list it carries a RESERVED tag.

Under the hood the sample haul genuinely contains zero Fairy cards, which I verified: nine of ten
bands are used in the data, and the tenth still renders. So the reserved treatment is a real empty
state, not a decorative row.

It is also structurally empty rather than accidentally empty. Fairy was retired as a card type during
the Sword and Shield era, so no card printed since carries it, and the sample sets are all from that
era or later. Pink will therefore stay empty unless she buys backward into older sets. That makes the
reserved row more important, not less: an empty band that will probably never fill is exactly the one
a future cleanup would delete, and deleting it would silently shift the physical position of every
band after it.

---

## 4. The oversized White band

White absorbs Colorless, Metal, and every trainer, supporter, and item, so it runs several times the
next band. It breaks two things, and each gets a different fix.

**It breaks the worklist by volume.** Roughly half a haul lands in White, and most of those cards
take the identical action, so a naive plan would be nine readable bands followed by forty-six
near-identical rows. The fix is batch rows: inside a band, cards sharing one action collapse into a
single checkable row that states its real count and lists a few sample cards. The White group in the
prototype is two rows covering forty-six physical cards, one BATCH PLACE IN FRONT HALF for
thirty-four trainers and one BATCH SEND TO BULK BOX for twelve duplicates. Progress counts cards, not
rows, so the progress bar stays truthful while the list stays short. Batching is safe here precisely
because White contains almost no evolution lines, so almost nothing in it needs a per-card decision.

**It breaks the binder view by scale.** Normalizing all ten bars to the largest band flattens Red
through Purple into indistinguishable stubs and makes the screen useless for the nine bands she
actually reasons about. So bars are scaled to the second largest band and White is allowed to run
past a hard zigzag break edge with its true multiple printed on the overflow, currently "x3.3 the
next band" for the front half. The distortion is stated rather than smoothed away. The break only
appears when the leader is at least 1.5x the runner-up, so the back half, where the spread is even,
renders as a plain set of bars with no break edge at all.

**It also breaks visibility.** A white swatch on a cream panel is nearly a blank. Every White element
therefore gets white fill plus a 3px ink outline plus a dither overlay, in the band chips, the meters,
the page rail, the lookup band stack, and the intake tally. White reads as a chosen color, not as a
hole in the panel. The olive background helps here in a way the earlier warm-paper base did not: any
White element that touches the app surface is already separated by contrast, so the dither is only
load bearing inside cream panels rather than everywhere.

---

## 5. Coarse location, held everywhere

The hard constraint was no pocket grid and no page spread that implies exact positions. The line
detail view still had to feel like looking at the binder page, which is the tension worth naming.

Resolution: the page surface carries binder signals with no positional grammar. A colored spine
rail, four binder rings, ruled paper texture. The stages sit in a single horizontal strip in
evolution order, scrolling sideways on a phone with scroll snapping. Because it is one line rather
than a grid, nothing implies a row, a column, a pocket, or a facing page. The address printed
anywhere in the app is always exactly three parts: binder, half, band.

Two places tried to leak addressing, and both are handled explicitly.

Settings has a "pockets per page" field, which exists only so the binder view can say a band is
running out of room. This is the field a future contributor would reach for first, so the column
header carries four words under it, CAPACITY, NOT ADDRESS, rather than a paragraph.

The backfill wizard asks for front halves as a flat ordered sequence, which looks like position
entry. The section heading says TYPING AID, NOT STORED. The order lets her flip pages without losing
her place and is discarded once each card has its three-part address.

The one exception is deliberate. The Saboteri connected-art collection shows a 24-cell sequence
grid, because in a connected-art set the position is part of the picture rather than a location.
That grid exists only inside a fixed-size collection and never in a general binder, and it is labeled
A PICTURE, NOT A MAP.

---

## 6. Interaction decisions

**The haul plan is a list plus spotlight.** The worklist on the left is the scannable body: sticky
band headers in rainbow order, basics separated from non-basics, 65px rows, 24px checkboxes, action
tags color-coded by kind, and a red DECIDE flag on any row that needs a judgment call. The spotlight
on the right shows one card large with its destination as three segments and a WHY block holding the
single fact that fired the rule. Two jobs, two zones: find the next card fast on the left, confirm
what to do with the card in her hand on the right.

**Rows got taller on purpose.** Each row now leads with a 52 by 72 thumbnail and prints the full
collector number, which is a direct trade: fewer rows fit on screen, and the ones that do are
identifiable at a glance instead of requiring a read. You chose that trade explicitly. The row grid
widened rather than the layout flipping, so the list-plus-spotlight arrangement is unchanged; only
the density inside a row changed.

**"Don't know what to do next" got a dedicated answer.** Three things came out of that note. The
spotlight now ends in a single primary DO IT block rather than leaving the action implied by a tag,
so there is one obviously clickable thing on the screen at all times. A NEXT UP strip sits under it
showing the following card, so the queue is visible instead of inferred. And the DONE control is a
real button with a large hit area rather than a keyboard-only affordance. Shortcuts all still work,
since you did not flag keyboard dependence as a problem, but nothing now requires knowing one.

**Keyboard first, because both hands are full.** Space or Enter checks off and advances. J, K, and
the arrows navigate. D opens the decision for the current row. Number keys 1 to 4 switch screens,
guarded when an input has focus and while the decision overlay is open. Nothing on the worklist
requires a pointer, and after this pass nothing requires a keyboard either.

**Decisions are a modal overlay, not a separate screen.** She is mid-stack with a card in hand, so
losing the plan behind a route change is the wrong cost. The sheet shows a three-column evidence grid,
CATALOG, YOU OWN, and WHY, each column a list of ticked one-line facts rather than a paragraph, then
the proposal with a recommended choice marked and every override adjacent. The overlay can be reopened
from the plan, and a top alert bar counts unresolved decisions until they are all cleared, then flips
to a green ready-to-commit state.

**Lookup is one field and one answer.** Mobile first, capped at 520px, the address rendered at 26px
so it is readable at arm's length in bad light, and the supporting facts, wishlisted, completes a
line, belongs to a collection, underneath. Answerable in about three seconds standing at a table.

The identity block now sits above the address rather than beside it: art, name, printed number, then
the binder, half, and band. That ordering matters at a card show, because the first question is
always "is this the card I searched for," and only once that is settled does the address mean
anything. Getting it backward made her verify the answer after reading it.

**Progress is a segmented XP bar,** counting cards rather than rows, so the White batch rows cannot
make it lie.

---

## 7. The copy budget

The first pass explained itself in the interface. Every state had a caption, every rule had a
paragraph, every screen had a note block justifying its own existence. That is a reasonable way to
present a design and a bad way to ship a working tool, because she already knows the rules. She wrote
them. Second pass cut the prototype by 12% and the mockups by 16%, all of it text.

Four rules drove the cuts.

**Say it once, in the cheapest channel.** A filled slot was announcing itself three times: the slot
label said FILLED, the pocket header said OWNED, and a tagline underneath said OWNED again. Color and
a glyph carry that faster than any of the three, so the state is now one word with one glyph, `◆ OWNED`
against `◇ OPEN` against `✕ DEAD`, and the taglines are gone. Blocks kept exactly one line of text,
the name of the spare card wedged in the pocket, because that is the only fact she cannot read off the
pocket itself.

**Reasons become fragments, not sentences.** The spotlight's why block used to argue its case in two
or three clauses. Now it states the fact and stops: "Same set and number as a shelved copy." She does
not need to be persuaded, she needs to be told which fact fired. The reason strings also stopped
repeating the set and number, because the thumbnail and the printed number are right there in the row.

**Explanation belongs in the rationale, not the chrome.** Every note block in the mockups is gone,
along with the alert bar's line about the system never blocking a line without her. Those were written
for a reviewer reading the design, and a reviewer is reading this document instead. The three
constraint labels that survived, the two above and A PICTURE, NOT A MAP, survived because they guard
against a wrong action rather than describe a philosophy.

**Line detail is allowed the most words, and still only two boxes.** Each line dropped from three
paragraph boxes to two short ones, typically why the line is capped or blocked and what would close
it. This screen is the emotional center, so it earns more copy than the rest, but it earns it in
labels and prices rather than prose.

No screen gained copy. Density now comes from color, glyph, number, and position, which is what the
pixel language was chosen for in the first place.

**The third pass tested that budget properly.** "Too dense, too much at once" arrived alongside a
request for thumbnails, which is a request to add the single heaviest element on the screen. Those
pull in opposite directions, and the resolution was to spend the recovered space on the image rather
than on getting more rows into view. Cutting text and then adding art nets out to roughly the same
vertical space per row carrying far more recognizable information, because a 52 by 72 scan identifies
a card in a way that no amount of text at that size does. Where something still had to give, the
loser was always a word that duplicated the picture or the number.

---

## 8. Assumptions I made instead of asking

Flagged here per the brief. Each is a design decision, not a system-design change, and each is cheap
to reverse.

**Batch rows for same-action cards inside a band.** The alternative, one row per card, makes the
White group unreadable. If she wants every card individually checkable, the batch row should expand
in place rather than the batching being removed.

**Intake shows no routing preview.** The cascade depends on the whole haul, so a destination guessed
at card 148 can be wrong by card 300, and a wrong guess she has already read is worse than no guess.
Routing happens once, when she stops typing. The running tally is by band for the same reason.

**Decision as overlay rather than route.** Stated above.

**Blocks are absent from the wishlist rather than listed as unbuyable.** Listing them would put
cards she must never buy on a shopping list.

**Line detail scrolls horizontally on phone with snapping,** rather than reflowing to a vertical
stack. Evolution order is directional and the horizontal read preserves it.

**Wishlist totals are split into "everything" and "standard class only."** One ex card is 92% of the
sample total, so a single number would be dominated by the one purchase she is least likely to make
at a show.

**Collections log every claim that beat a line, with a date.** Collection claim is the first rule in
the cascade and therefore the rule most likely to produce a result that looks wrong six weeks later.
This is the audit trail surfaced in the interface.

**Settings exposes exactly three cascade rules as toggles:** artwork-hash duplicate matching, holo
swap, and the viability threshold. Auto-block is shown as a toggle that is off, since "never
auto-block" is a confirmed requirement and showing the switch in its off position communicates the
rule better than hiding it.

**The four decision kinds appear as a queue with a count,** rather than interrupting her mid-stack
one at a time.

**Card art comes from a live URL rather than a local cache.** Covered in section 9. This is the one
assumption in the list that is not cheap to reverse cleanly, so it is the one worth arguing about
first.

---

## 9. Card identity: thumbnails and printed numbers

Three notes drove this revision: show the full collector number, show the thumbnail, and the UX is
not user-friendly enough. The first two are the same problem. A card is identified by its picture and
its printed number, and the design had been showing neither.

**Where art appears: everywhere a card is named.** Worklist rows, the spotlight, evolution slots,
lookup, wishlist, and intake. That was your instruction and it is the right one, because a thumbnail
in only some places trains her to distrust the places that lack one. Four sizes, all holding the real
2.5 by 3.5 card ratio: 34 by 47 for dense lists, 52 by 72 for worklist and wishlist rows, 104 by 145
for evolution slots, 150 by 209 for the spotlight and the lookup answer.

**The licensed-assets override, stated rather than applied quietly.** The brief said not to use
official card images as design assets. You then chose live TCGdex image URLs, which overrides that for
art specifically. The rest of the constraint stands and is still honored: no logos, no official
symbols or set graphics, no official typeface, and no official illustration used as decoration or
chrome. Card scans appear only as the identity of a specific card record, which is the one use the
constraint was never really aimed at. Recording the override here rather than silently applying it is
the point, because the next person to read this file needs to know which half of the rule is still live.

**What it costs.** The files are no longer self-contained. Each face requests
`assets.tcgdex.net/en/<serie>/<set>/<localId>/low.png`, roughly 60KB per card, lazy loaded. Offline,
or if TCGdex is down, every image fails and the generated sigil underneath is what remains, so the
screen degrades to the previous design rather than to empty boxes. That fallback is the reason the
sigil generator was kept. For a real build, cache the scans locally on first fetch: the collection is
finite, the images are immutable, and a stack-sorting session at a desk should not depend on a CDN.

**The printed number is `localId` over `cardCount.official`.** So Charmeleon from Obsidian Flames
reads `OBF · 027/197`, which is what is actually printed on the card. Two details that a naive
implementation gets wrong. First, the denominator is the official set count, not the total number of
cards in the set, so secret rares legitimately exceed it: the sample includes a Charmeleon printed
`110/091`, and that is correct, not a bug. Second, zero padding is not consistent across eras.
Scarlet and Violet and Sword and Shield sets pad to three digits, so `006` and `027`; the older XY and
Sun and Moon sets do not, so Trapinch is `82/160` and not `082/160`. Both the printed number and the
image URL are built from the same stored id, so padding it for display would break the image and
padding it in storage would print a number the card does not have. Store exactly what the API returns.

**One source of truth for numbers.** Neither file hand-writes a collector number into markup. The
prototype computes every one from a twelve-set table; the static mockups carry `data-card` and
`data-num` attributes and a hydrator fills them from a nine-set table at load. Thirty faces and thirty
numbers in the mockups, all derived. That is what makes the numbers checkable by the harness, and it
is why a wrong set code fails loudly instead of sitting in the markup looking plausible.

**Every card in both files is a real card.** The sample data was rebuilt against the TCGdex API rather
than invented, because a design that shows real art cannot show fictional numbers next to it. Twelve
verified sets, and roughly forty printings checked field by field for set, number, rarity, type, stage,
what it evolves from, and illustrator. Section 10 lists what that caught.

---

## 10. Verification

No browser is available in this environment, so visual confirmation is not possible and this is a
gap worth stating plainly. Everything else was checked statically:

**Prototype: 507 assertions, all clean.** The script passes `node --check`. A stub-DOM harness
exercises all four decisions through open, choose, reopen, and choose again, all four evolution lines,
nine lookup terms including an empty string and a no-match, every haul row through select, toggle, and
advance, and every navigation path. No missing element IDs. Data integrity assertions confirm that
every haul row's action, band, decision, and line reference resolves, and the same for every lookup
entry. The copy budget is asserted too: no reason string over 72 characters, no line carrying more
than two info boxes, no info value over 56 characters, no slot carrying more than two meta lines, and
no lookup fact over 56 characters. Card and row counts come out at 74 physical cards across 30 rows
using 9 of 10 bands, which confirms Pink is genuinely empty in the data while still rendering.

**Mockups: 280 assertions, all clean.** The script passes `node --check`. A second harness scrapes
every `data-card` and `data-num` attribute out of the markup and feeds them through the real hydrator,
which is how the derived values get checked rather than trusted. Thirty faces and thirty numbers. Every
set code resolves to the set table; every localId is numeric; every generated image URL matches the
TCGdex path pattern exactly; every face renders both a scan and a sigil fallback; every printed number
matches the `SET · NNN/NNN` form; exactly four faces are dimmed, which is the four not-owned or wedged
cards and no others. All six generated regions render, the front half reserves one Pink row and prints
one scale break at ×3.3 the next band, the back half reserves one Pink row and correctly prints no
break, and the generated markup contains no page or pocket addressing. The three surviving constraint
labels are intact. The wishlist prices sum to the two stated totals, $25.21 and $1.11, with the already
resolved card excluded from both. A blocklist assertion confirms that none of the nineteen fabricated
set references from earlier drafts survives anywhere in the file, and that no terminated line appears
in the backfill back-half walk.

Two of those assertions failed on first run and both were harness bugs rather than file defects: the
attribute scraper was dropping the optional `data-dim`, and the price assertion was adding the already
resolved card into a total it is deliberately excluded from. Worth recording, because a harness that
reports a false failure is one bad habit away from reporting a false pass.

**What the API check caught.** Sixteen collector numbers in the sample data were wrong, and three were
wrong in ways that broke the design rather than merely the trivia. The Charizard ex used to cap the
Fire line was Darkness type, not Fire, which invalidated the entire cap story. The Gardevoir on the
wishlist was Gardevoir **ex**, a specialty-binder card, which cannot legitimately appear as a
general-binder wishlist target. And the block case at the top of a Psychic line was simply false:
around twenty Psychic Dusknoir cards exist, so nothing was blocked. That last one was replaced with a
verified case, Scyther having no Metal printing, and the Duskull chain was recycled as what it
actually is, a healthy open line. Two sets of alternate printings were also invented and had to be
replaced, and one Raichu evolved from "Pikachu ex" rather than Pikachu, which quietly broke the line.

**One finding worth stating rather than papering over.** I wanted a fourth kind of block: a top-of-chain
stage that is impossible in the color its own earlier stages occupy, so a line that visibly cannot
finish. Sixteen-plus candidate chains were checked and the real catalog does not produce one. Type
assignment follows the species family, and a family that changes type changes it at the point of
evolution, which kills every stage above rather than just the last. So every case where a final stage
was missing in a color had the earlier stages missing too. Rather than fabricate an example, the
design carries the three block shapes that do occur: a blocked root that kills a two-stage line, a
blocked root that a three-stage line survives, and a cap where the next stage exists only as a
specialty card. The absent fourth case is a fact about the game, not a gap in the design.

**Defects found and fixed across all three passes.** From the first: a broken pseudo-random step that
emitted zero sigil pixels, two CSS class-name collisions, dead sticky headers caused by an overflow
ancestor with no scroll range, horizontal scroll attached to the wrong element so the binder spine
scrolled away, a mobile spotlight that would have permanently covered half the phone screen, a
non-idempotent alert bar that kept a checkmark after a decision was reopened, and a scale break firing
at a 1.2x lead where it added noise instead of clarity. From the repalette and copy cut: one hex
serving as both the success color and the Grass band, a global background swap that turned the block
tagline invisible, and white pocket text left over from the dark palette which failed against the six
light band fills. From this pass: a number-plate class name that would have restyled the big section
numbers, a hydrator that would have erased its own label because it writes `textContent`, a mobile
grid override that would have mis-placed thumbnails and was replaced with a wrapping flex row, a
number formatter that fabricated a denominator when handed a block slot's non-set string, and a band
dither that never fired because the flag was misspelled in the check.

Recommended next check: open both files at 390px and at 1440px, with the network on and then off, and
confirm the line detail strip, the decision overlay, the binder scale break, and the sigil fallback
behave as described.
