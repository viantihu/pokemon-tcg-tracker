/**
 * cardClass derivation (dev-spec §5 M2). Fixtures are REAL cards, verified against the live TCGdex
 * API on 2026-09-07 (id · name · rarity). No fabricated data (project rule).
 */
import { describe, expect, it } from "vitest";
import { classifyCard, hasSpecialtyNameToken } from "@/lib/catalog/classify";

// { id, name, rarity } exactly as TCGdex returns them.
const STANDARD = [
  { id: "sv03-027", name: "Charmeleon", rarity: "Uncommon" },
  { id: "xy2-1", name: "Caterpie", rarity: "Common" },
  { id: "base1-4", name: "Charizard", rarity: "Rare" }, // famous holo, but no ex/V token & plain rarity
  { id: "swsh12-018", name: "Ninetales", rarity: "Uncommon" },
];

const SPECIALTY_BY_NAME = [
  { id: "sv03-125", name: "Charizard ex", rarity: "Double rare" },
  { id: "swsh1-138", name: "Zacian V", rarity: "Holo Rare V" },
  { id: "swsh9-123", name: "Arceus VSTAR", rarity: "Holo Rare VSTAR" },
  { id: "swsh10.5-011", name: "Radiant Charizard", rarity: "Radiant Rare" },
];

// Plain species names — MUST be caught by rarity alone (the name carries no ex/V/… token).
const SPECIALTY_BY_RARITY = [
  { id: "sv01-201", name: "Toedscool", rarity: "Illustration rare" },
  { id: "sm12-247", name: "Steelix", rarity: "Secret Rare" },
  { id: "sv03-217", name: "Pidgeot ex", rarity: "Ultra Rare" },
];

describe("classifyCard", () => {
  it.each(STANDARD)("$id ($name, $rarity) → standard", (card) => {
    expect(classifyCard(card)).toBe("standard");
  });

  it.each(SPECIALTY_BY_NAME)("$id ($name, $rarity) → specialty (name token)", (card) => {
    expect(classifyCard(card)).toBe("specialty");
  });

  it.each(SPECIALTY_BY_RARITY)("$id ($name, $rarity) → specialty (rarity)", (card) => {
    expect(classifyCard(card)).toBe("specialty");
  });

  it("uses rarity even when the printed name has no token (Toedscool = Illustration rare)", () => {
    expect(hasSpecialtyNameToken("Toedscool")).toBe(false);
    expect(classifyCard({ name: "Toedscool", rarity: "Illustration rare" })).toBe("specialty");
  });

  it("stays standard when rarity is missing and the name has no token", () => {
    expect(classifyCard({ name: "Charmeleon" })).toBe("standard");
    expect(classifyCard({ name: "Charmeleon", rarity: null })).toBe("standard");
  });
});

describe("hasSpecialtyNameToken", () => {
  it.each([
    "Charizard ex",
    "Pidgeot ex",
    "Mewtwo-GX",
    "M Rayquaza EX",
    "Zacian V",
    "Arceus VSTAR",
    "Radiant Greninja",
  ])("'%s' → true", (name) => expect(hasSpecialtyNameToken(name)).toBe(true));

  it.each(["Charmeleon", "Toedscool", "Feraligatr", "Ho-Oh", "Porygon-Z", "Type: Null", ""])(
    "'%s' → false (no false positive on trailing letters)",
    (name) => expect(hasSpecialtyNameToken(name)).toBe(false),
  );
});
