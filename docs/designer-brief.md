# Prompt for the UI/UX Cowork chat

Paste everything below the line into a fresh Cowork chat. It is written to stand alone, so it
repeats the parts of the system design that actually drive layout.

---

You are a senior product designer specializing in tools for collectors and hobbyists. I need
mockups and a clickable prototype for a personal Pokemon TCG binder management system. A system
design already exists and is settled. Your job is the interface, not the data model.

If you have access to the folder, read `Code Projects/Pokemon TCG Tracker/system-design.md` first
for full detail. Everything you strictly need is below.

## What the product is

It is not a collection tracker. An app called Dex already tracks what she owns.

This tool answers a different question: given a stack of several hundred common and uncommon
cards pulled from bulk bins, where does each card physically go, and what is still missing from
each evolution line?

The user is one person managing her own binders. Single user, no accounts, no sharing, no trading,
no portfolio value. She sorts at a desk after a haul, and looks cards up on her phone at card
shows.

## The three concepts you must understand to design this

**1. Location is deliberately coarse.** A card's location is binder, then half of that binder,
then color band. That is it. No page numbers, no pocket numbers. She explicitly rejected finer
tracking. Never design a pocket grid or a page spread view that implies exact positions.

**2. The routing cascade.** Every card in a haul is assigned a destination by one ordered rule
set. First match wins:

1. **Collection claim** — belongs to a running custom set, goes to the specialty binder, and this
   beats everything else
2. **Card class** — ex, V, full art, Radiant, illustration rare, goes to the specialty binder
3. **Duplicate** — same artwork or same set-plus-number as a shelved card, goes to the bulk box.
   Exception: an incoming holo displaces a shelved normal, and the normal goes to bulk
4. **Line participation** — a Stage 1 or Stage 2 either fills an open slot in an existing
   evolution line, or starts a new line in the back half of a binder
5. **Basic with no line** — front half
6. **Trainer, supporter, item** — front half, White band

**3. Evolution lines are the heart of it.** The back half of each general binder holds evolution
lines. A line is one species chain in one color. Each stage of a line is a slot in one of three
states:

- **filled** — she owns the card and it is in the binder
- **placeholder** — the card exists but she does not own it yet. Today this is a physical sticky
  note in the binder. In the app it is a real record with a chosen target card and a ranked list
  of cheaper alternate printings
- **block** — no card can ever fill this slot, because no card of that species exists in this
  color. Physically this is a spare card wedged in the pocket

A line can also be **capped**, which is a state you need to represent visually. It means the next
stage only exists as an ex or full art card, so it will live in a different binder and this line
will never be visually complete.

## Color bands

Ten bands, in this exact order. This is the physical sort order and it resets between the front
and back half of every binder.

Red (Fire), Orange (Fighting), Yellow (Lightning), Olive (Dragon), Green (Grass), Dark blue
(Darkness), Light blue (Water), Purple (Psychic), Pink (Fairy), White (Colorless, Metal, and all
trainers, supporters, items).

Two design consequences. **Pink is currently empty** and will likely stay empty for a long time,
because Fairy cards stopped being printed. Do not hide or collapse it, its position reserves
physical space. And **White will be enormous**, since it absorbs every trainer and item, so any
capacity visualization has to survive one band dwarfing the rest.

## Screens to design

In priority order. The first three matter most and should be the clickable part.

1. **Haul plan / worklist** — the primary desktop screen. After she enters a haul, the system
   outputs an ordered plan. Grouped by color band in rainbow order, then basics versus non-basics
   inside each band, then by action. She works it top to bottom while physically handling cards,
   checking items off. Actions include: place in front half, place in back half filling a
   placeholder, start a new line, pull this card out of another binder, send to bulk, swap this
   holo for the shelved normal.
2. **Decision card** — the confirm-or-override moment. The system never auto-blocks a line and
   never silently resolves a conflict. Each decision needs to show its evidence: what the card
   catalog says exists, what she already owns, and why the system is proposing what it proposes.
   The four kinds are: terminate a line with a block, cap a line because only an ex exists,
   block a missing root stage, and resolve a collection-versus-line conflict where a card she
   needed for a line has to go to the specialty binder instead.
3. **Line detail** — the ordered stages of one evolution line. Filled, placeholder, and block
   states side by side.
4. **Card lookup** — mobile first, one search field, answer above the fold. "Where is my
   Charmeleon." Response is binder, half, band, plus whether it is wishlisted, whether it would
   complete a line, and whether it belongs to a collection. This is the card-show screen and it
   needs to be answerable in about three seconds.
5. **Binder view** — sections, capacity, lines, blocks.
6. **Wishlist** — every open placeholder, grouped by line and binder, with priced alternates and
   an export.
7. **Haul intake** — high volume repetitive entry, hundreds of cards, keyboard driven.
8. **Collections** — which custom sets are running and which binder each occupies.
9. **Settings** — binders, page counts, pockets per page, where the back half starts, band order.
10. **Backfill wizard** — a one-time flow to load the existing collection binder by binder. Front
    halves entered as a flat ordered sequence, back halves entered line by line.

## Design direction

**The line detail view is the emotional center of the product.** It is the thing she is actually
building toward. If it reads as a table, the whole app becomes inventory software. It should feel
like looking at the binder page. Give it real visual treatment and let the three slot states carry
genuine visual weight, especially the difference between "I am still hunting this" and "this can
never be filled."

**The haul plan is a volume screen.** Scan-ability and keyboard speed beat polish. She is holding
cards in both hands. Large hit areas, obvious progress, no hunting.

**Do not use official Pokemon branding, logos, or card images as design assets.** This is a
personal tool. Build an original visual language. The ten color bands are your natural palette,
and they come from the domain rather than from a template, so lean on them.

**Avoid the default dashboard look.** No KPI cards across the top, no generic sidebar plus table
layout. This is a working tool for one person doing a physical task, not an analytics product.

## Sample data to use

Use real card names so the mockups read honestly. This example is verified: Charmeleon, Obsidian
Flames, card 027, Uncommon, Fire type, Stage 1, evolves from Charmander, illustrated by Ryota
Murayama. It sits in a Fire line whose Charizard slot can only be filled by an ex card, so the
line is capped. That single case exercises most of the interesting states at once.

Other useful cases: a Vaporeon that cannot form a line at all because no Water Eevee exists and
Vaporeon does not evolve, so it lands in the front half. A duplicate Growlithe headed for the bulk
box. A holo Litwick displacing a shelved normal. Treat set numbers other than the Charmeleon
above as illustrative.

## What to deliver

1. A **clickable HTML prototype** covering screens 1, 2, 3, and 4 end to end, so I can walk a
   whole haul from plan to decision to line to lookup. Self-contained single file, realistic
   sample data, works on both desktop and phone widths.
2. **Static mockups** for the remaining screens.
3. A short **rationale** covering your visual language, the three slot states, and how you handled
   the empty Pink band and the oversized White band.

Ask me only the questions that would actually change a layout. For anything else, make a decision,
build it, and flag the assumption in your rationale.
