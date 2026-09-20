/**
 * UIL-081 — a card with no art shows a pixel SIGIL, not bare initials. Karvi: "a pixelated placeholder
 * image that fits the brand." The prototype's recipe, finally ported: a 6×6 grid mirrored left-to-right,
 * ~62% filled, seeded from the card's name, coloured from the brand's band palette, with the initials
 * kept as a small legend so the name stays legible. Two imageless cards never look identical; the same
 * card always looks the same; a sigil is never zoomable (UIL-036's guard).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fnv1a, SIGIL_PALETTE, SIGIL_SIZE, sigilCells, sigilColor } from "@/lib/catalog/sigil";
import { CardFace } from "@/app/(ui)/_components/CardFace";

describe("the sigil is deterministic, mirrored, and never identical for two different names", () => {
  it("same name → the same cells and colour, every time", () => {
    expect(sigilCells("Charmander")).toEqual(sigilCells("Charmander"));
    expect(sigilColor("Charmander")).toBe(sigilColor("Charmander"));
    expect(fnv1a("Charmander")).toBe(fnv1a("Charmander"));
  });

  it("is mirrored across the vertical axis", () => {
    for (const name of ["Charmander", "Mystery Fossil", "Basic Energy", "リザードン"]) {
      const cells = sigilCells(name);
      const key = (x: number, y: number) => `${x},${y}`;
      const set = new Set(cells.map((c) => key(c.x, c.y)));
      for (const c of cells) expect(set.has(key(SIGIL_SIZE - 1 - c.x, c.y))).toBe(true);
    }
  });

  it("fills roughly the prototype's share of the grid and uses only the brand palette", () => {
    const names = [
      "Charmander",
      "Charmeleon",
      "Charizard",
      "Pikachu",
      "Mystery Fossil",
      "Wedge",
      "Basic Energy",
    ];
    const fills = names.map((n) => sigilCells(n).length / (SIGIL_SIZE * SIGIL_SIZE));
    const mean = fills.reduce((a, b) => a + b, 0) / fills.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.85);
    for (const n of names) expect(SIGIL_PALETTE).toContain(sigilColor(n));
  });

  it("two different names very rarely collide: 50 species names give 50 distinct patterns", () => {
    const names = [
      "Bulbasaur",
      "Ivysaur",
      "Venusaur",
      "Charmander",
      "Charmeleon",
      "Charizard",
      "Squirtle",
      "Wartortle",
      "Blastoise",
      "Caterpie",
      "Metapod",
      "Butterfree",
      "Weedle",
      "Kakuna",
      "Beedrill",
      "Pidgey",
      "Pidgeotto",
      "Pidgeot",
      "Rattata",
      "Raticate",
      "Spearow",
      "Fearow",
      "Ekans",
      "Arbok",
      "Pikachu",
      "Raichu",
      "Sandshrew",
      "Sandslash",
      "Nidoran",
      "Nidorina",
      "Nidoqueen",
      "Nidorino",
      "Nidoking",
      "Clefairy",
      "Clefable",
      "Vulpix",
      "Ninetales",
      "Jigglypuff",
      "Wigglytuff",
      "Zubat",
      "Golbat",
      "Oddish",
      "Gloom",
      "Vileplume",
      "Paras",
      "Parasect",
      "Venonat",
      "Venomoth",
      "Diglett",
      "Dugtrio",
    ];
    const patterns = new Set(names.map((n) => JSON.stringify(sigilCells(n)) + sigilColor(n)));
    expect(patterns.size).toBe(names.length);
  });
});

describe("CardFace with no art renders the sigil, keeps the initials legible, and is never zoomable", () => {
  const html = (name: string, size: "s" | "m" | "l" = "m", zoomable = false) =>
    renderToStaticMarkup(createElement(CardFace, { name, imageUrl: null, size, zoomable }));

  it("an SVG of unit rects inside the fallback, named for assistive tech, plus the initials legend", () => {
    const h = html("Mystery Fossil");
    expect(h).not.toContain("<img");
    expect(h).toContain('class="fallback"');
    expect(h).toContain('aria-label="Mystery Fossil"');
    expect(h).toContain('role="img"');
    expect(h).toMatch(/<svg class="sigil" viewBox="0 0 6 6"/);
    expect((h.match(/<rect /g) ?? []).length).toBe(sigilCells("Mystery Fossil").length);
    expect(h).toContain('class="init u">MF<');
  });

  it("two imageless cards do not look identical", () => {
    expect(html("Charmander")).not.toBe(html("Charmeleon"));
  });

  it("zoomable is ignored without art — a sigil is not artwork", () => {
    const h = html("Basic Energy", "s", true);
    expect(h).not.toContain("zoomable");
    expect(h).not.toContain('role="button"');
    expect(h).toContain("BE");
  });

  it("with art, no sigil: the image renders and the fallback is absent", () => {
    const h = renderToStaticMarkup(
      createElement(CardFace, {
        name: "Charmander",
        imageUrl: "https://assets.tcgdex.net/en/sv/sv03/026",
      }),
    );
    expect(h).toContain("<img");
    expect(h).not.toContain("sigil");
  });
});
