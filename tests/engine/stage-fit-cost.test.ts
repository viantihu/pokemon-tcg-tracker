/**
 * The cost of the ONE stage rule (`stageFit`), which the cascade and the line-join index ask for every card × line ×
 * open stage (the TL's review): a chain is a scan of the whole catalog (`buildChain` filters it by locale), so it is
 * built once per catalog slice and card (`chainFor`), never per call. Pinned by counting the catalog scans.
 */
import { describe, expect, it } from "vitest";
import {
  placeCard,
  stageFit,
  type CatalogCard,
  type EngineContext,
  type EvolutionLine,
} from "@/lib/engine";
import { EEVEE_SV035_133, KEY_FORM_TYPE_COLOR_MAP, VAPOREON_SV035_134 } from "./fixtures";

/** The catalog, counting how many times it is scanned (every chain built is one `filter`). */
function counted(cards: CatalogCard[]) {
  let scans = 0;
  const catalog = new Proxy([...cards], {
    get(target, key, receiver) {
      if (key === "filter") scans += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { catalog, scans: () => scans };
}

describe("stageFit builds each chain once per catalog slice, not per call", () => {
  it("200 asks about the same card and line scan the catalog a handful of times, not hundreds", () => {
    const { catalog, scans } = counted([EEVEE_SV035_133, VAPOREON_SV035_134]);
    for (let i = 0; i < 200; i++) {
      expect(
        stageFit(VAPOREON_SV035_134, catalog, {
          rootDexId: 133,
          stageIndex: 1,
          before: EEVEE_SV035_133,
          seed: EEVEE_SV035_133,
        }),
      ).toBe("fits");
    }
    // Two chains (the Vaporeon's, the Eevee's): PRE-FIX (a chain per call) this was 400.
    expect(scans()).toBeLessThanOrEqual(2);
  });

  it("the cascade routing a haul of Vaporeons against many Eevee lines with an open Stage 1 does not rescan per line", () => {
    const LINES = 30;
    const lines: EvolutionLine[] = Array.from({ length: LINES }, (_, i) => ({
      id: `L${i}`,
      rootDexId: 133,
      colorBand: "light_blue",
      binderId: "B1",
      status: "open",
      slots: [
        {
          id: `L${i}-0`,
          stageIndex: 0,
          stage: "Basic",
          state: "filled",
          copyId: `eevee-${i}`,
          dexId: 133,
          targetCatalogCardId: null,
        },
        {
          id: `L${i}-1`,
          stageIndex: 1,
          stage: "Stage1",
          state: "placeholder",
          copyId: null,
          dexId: null,
          targetCatalogCardId: null,
        },
      ],
    }));
    const { catalog, scans } = counted([EEVEE_SV035_133, VAPOREON_SV035_134]);
    const ctx: EngineContext = {
      typeColorMap: KEY_FORM_TYPE_COLOR_MAP,
      catalog,
      owned: lines.map((l, i) => ({
        id: `eevee-${i}`,
        card: EEVEE_SV035_133,
        variant: "normal",
        role: "shelved",
        binderId: "B1",
        binderHalf: "back",
        colorBand: "light_blue",
        lineSlotId: l.slots[0].id,
      })) as EngineContext["owned"],
      binders: [{ id: "B1", type: "general", name: "KB-001", isActive: true }],
      lines,
      collections: [],
      now: "2026-09-27T00:00:00.000Z",
    };
    const before = scans();
    for (let i = 0; i < 20; i++) {
      const r = placeCard({ id: `in-${i}`, card: VAPOREON_SV035_134, variant: "normal" }, ctx);
      expect(r.step).toBe("line-existing");
    }
    // Uncached, the unnamed-stage match alone would build 3 chains per card per line: 20 × 30 × 3 = 1,800 scans.
    expect(scans() - before).toBeLessThan(60);
  });
});
