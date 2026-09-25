/**
 * UIL-080 — Backfill's front-half row derives a card's colour band with the engine's canonical `band()`,
 * not its own copy. The old local `bandKeyForCard(types, map)` took `types[0]` (or "Colorless") and
 * looked it straight up, with a hard-coded "white" fallback. The canonical function goes through
 * `effectiveType` first — a Trainer resolves to its `trainerType` or "Trainer", not "Colorless" — and falls
 * back to the map's OWN white key (UIL-012). For a Pokémon the two agree; for a Trainer or Energy they
 * agree only while `map.Trainer === map.Colorless`, which the map does not promise and which is editable.
 *
 * Static render of the exported row with a map where the two readings differ, so a local re-derivation
 * creeping back fails here.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FrontRowItem } from "@/app/(ui)/backfill/BackfillScreen";
import type { LookupCard } from "@/app/(ui)/plan/plan-types";
import type { WaitingCard } from "@/app/(ui)/backfill/backfill-types";

const card = (over: Partial<LookupCard>): LookupCard => ({
  tcgdexId: "sv03-186",
  name: "Arven",
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "186",
  setCardCountOfficial: 197,
  stage: null,
  types: [],
  category: "Trainer",
  trainerType: null,
  cardClass: "standard",
  imageUrl: null,
  variants: ["normal"],
  ...over,
});

/** A map where Trainer and Colorless do NOT share a band, so the two derivations must disagree. */
const MAP: Record<string, string> = {
  Fire: "red",
  Colorless: "white",
  Trainer: "purple",
  Supporter: "pink",
  white: "white",
};

/** A front row is a card waiting in her haul (UIL-098). */
const waiting = (c: LookupCard): WaitingCard => ({
  ...c,
  dexVariantRaw: "Normal",
  waiting: 1,
  badge: "Normal · 1 waiting",
});

const render = (c: LookupCard, map = MAP) =>
  renderToStaticMarkup(
    createElement(FrontRowItem, {
      row: { id: "r1", card: waiting(c) },
      typeColorMap: map,
      onRemove: () => {},
    }),
  );

describe("UIL-080 · the front-half row uses the engine's band(), not a local copy", () => {
  it("a Trainer with no types gets the TRAINER band, not Colorless's", () => {
    const html = render(card({}));
    expect(html).toContain('title="Purple"');
    expect(html).not.toContain('title="White"');
  });

  it("a Trainer with a trainerType gets that type's band", () => {
    const html = render(card({ trainerType: "Supporter" }));
    expect(html).toContain('title="Pink"');
  });

  it("an Energy card resolves to Colorless — White here, as the engine says", () => {
    const html = render(card({ name: "Basic Fire Energy", category: "Energy" }));
    expect(html).toContain('title="White"');
  });

  it("a Pokémon still takes its first type's band — the case the two readings always agreed on", () => {
    const html = render(card({ name: "Charmander", types: ["Fire"], category: "Pokemon" }));
    expect(html).toContain('title="Red"');
  });

  it("an unmapped type falls back to the map's own white key, not a literal", () => {
    // Every white-absorbed name resolves to a real band that is NOT literally "white", so whichever of
    // them whiteKey() consults first, the canonical fallback is Olive — and a hard-coded "white" is not.
    const map = {
      Fire: "red",
      Colorless: "olive",
      Metal: "olive",
      Trainer: "olive",
      Supporter: "olive",
      Item: "olive",
    };
    const html = render(card({ name: "Mewtwo", types: ["Psychic"], category: "Pokemon" }), map);
    expect(html).toContain('title="Olive"');
    expect(html).not.toContain('title="White"');
  });
});
