/**
 * UIL-137 — the Haul Plan's two banners name a few cards and count a lot of them.
 *
 * Karvi's first import since Sep 26 brought 35 arrivals, and the "joined the plan" banner named every one with
 * its destination: eight lines of text above a list that already shows each card, its New chip and its home.
 */
import { describe, expect, it } from "vitest";
import {
  BANNER_NAMES_MAX,
  joinedBannerText,
  movedBannerText,
  type MovedCard,
} from "@/app/(ui)/plan/reroute";

const cards = (n: number): MovedCard[] =>
  Array.from({ length: n }, (_, i) => ({
    incomingId: `id-${i}`,
    name: `Card${i}`,
    destination: "KB-001 · Front · Red",
  }));

describe("UIL-137 · joinedBannerText", () => {
  it("names one arrival with where it goes, as before", () => {
    expect(joinedBannerText(cards(1))).toBe(
      "1 new card joined the plan: Card0 → KB-001 · Front · Red",
    );
  });

  it("still names up to the cap", () => {
    const text = joinedBannerText(cards(BANNER_NAMES_MAX));
    expect(text).toContain(`${BANNER_NAMES_MAX} new cards joined the plan: `);
    expect(text).toContain("Card0 →");
    expect(text).toContain(`Card${BANNER_NAMES_MAX - 1} →`);
  });

  it("is a count and nothing else past the cap", () => {
    // PRE-FIX: all 35 names and destinations, ~1,700 characters.
    expect(joinedBannerText(cards(35))).toBe("35 new cards joined the plan (marked New below)");
  });
});

describe("UIL-137 · movedBannerText", () => {
  it("names one moved card with its new home, as before", () => {
    expect(movedBannerText(cards(1))).toBe(
      "1 card got a new home after that change: Card0 → KB-001 · Front · Red",
    );
  });

  it("names up to the cap, because a moved card carries no marker in the list", () => {
    expect(movedBannerText(cards(BANNER_NAMES_MAX))).toContain("Card0 →");
  });

  it("is a count and nothing else past the cap", () => {
    expect(movedBannerText(cards(12))).toBe("12 cards got a new home after that change");
  });
});
