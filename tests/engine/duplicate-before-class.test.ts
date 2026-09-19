/**
 * UIL-049 — a duplicate goes to bulk even when it is a specialty card.
 *
 * Her rule, verbatim: "All cards, regardless of whether they are specialty or not, must be suggested as
 * 'Bulk' if they are duplicates."
 *
 * The cascade evaluated CARD CLASS (step 2) before DUPLICATE (step 3), so a specialty printing that
 * duplicated an already-shelved copy routed to the specialty binder — the opposite of her rule. This is a
 * deliberate policy change, not a malfunction: the old order was defensible, just not what she wants.
 *
 * `resolveDuplicate` matches on `artworkGroupId` (perceptual-hash cluster) OR the same
 * `(setId, localId)`, so this only fires for a SECOND COPY OF THE SAME specialty printing — a full-art
 * usually has different art from the standard print and so is not a duplicate of it. That narrowness is
 * exactly the case she described, and the tests below pin both sides of it.
 *
 * The interaction that needed checking rather than assuming is the HOLO SWAP, because moving duplicate
 * detection above the class check exposes specialty cards to a branch that never saw them before.
 */
import { describe, expect, it } from "vitest";
import { placeCard, type Binder, type EngineContext } from "@/lib/engine";
import {
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  KEY_FORM_TYPE_COLOR_MAP,
} from "./fixtures";

// Key-form, as production feeds it (UIL-013) — see fixtures.ts.
const MAP = KEY_FORM_TYPE_COLOR_MAP;
const B1: Binder = {
  id: "B1",
  name: "Binder 1",
  type: "general",
  isActive: true,
  freeBackHalf: 20,
};
const SPEC: Binder = { id: "SPEC", name: "Specialty", type: "specialty", isActive: false };
const CATALOG = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
];

function ctx(over: Partial<EngineContext> = {}): EngineContext {
  return {
    typeColorMap: MAP,
    catalog: CATALOG,
    owned: [],
    binders: [B1, SPEC],
    lines: [],
    collections: [],
    now: "2026-09-17T00:00:00.000Z",
    ...over,
  };
}

/** A shelved copy of `card`, living wherever the arguments say. */
function shelved(
  id: string,
  card: (typeof CATALOG)[number],
  over: Partial<EngineContext["owned"][number]> = {},
) {
  return {
    id,
    card,
    variant: "normal" as const,
    role: "shelved" as const,
    binderId: B1.id,
    binderHalf: "front" as const,
    colorBand: "red",
    lineSlotId: null,
    ...over,
  };
}

describe("UIL-049 · a duplicate specialty card goes to BULK, not the specialty binder", () => {
  it("routes a second copy of the same specialty printing to bulk", async () => {
    const owned = [
      // Already shelved in the specialty binder, as a specialty card would be.
      shelved("c1", CHARIZARD_EX_SV035_006, {
        binderId: SPEC.id,
        binderHalf: null,
        colorBand: null,
      }),
    ];
    const res = placeCard(
      { id: "d1", card: CHARIZARD_EX_SV035_006, variant: "normal" },
      ctx({ owned }),
    );

    // Her rule, as one assertion.
    expect(res.target.kind).toBe("bulk");
    expect(res.step).toBe("duplicate");
    expect(res.reason.toLowerCase()).toContain("duplicate");
  });

  it("still sends a NON-duplicate specialty card to the specialty binder", async () => {
    // The class rule is unchanged for everything that is not a duplicate — this is a reordering, not
    // a removal, and without this assertion the fix could pass by breaking specialty routing wholesale.
    const res = placeCard(
      { id: "d1", card: CHARIZARD_EX_SV035_006, variant: "normal" },
      ctx({ owned: [] }),
    );
    expect(res.target.kind).toBe("specialty");
    expect(res.step).toBe("card-class");
  });

  it("does NOT treat a different specialty printing as a duplicate", async () => {
    // 006 and 183 are both Charizard ex specialty prints but different printings with different art;
    // `resolveDuplicate` keys on artwork group or (setId, localId), so these must not collide. This is
    // the narrowness the entry records — without it the fix would bulk every specialty Charizard.
    const owned = [
      shelved("c1", CHARIZARD_EX_SV035_006, {
        binderId: SPEC.id,
        binderHalf: null,
        colorBand: null,
      }),
    ];
    const res = placeCard(
      { id: "d1", card: CHARIZARD_EX_SV035_183, variant: "normal" },
      ctx({ owned }),
    );
    expect(res.target.kind).toBe("specialty");
  });

  it("only considers SHELVED copies — a specialty card already in bulk is not a duplicate", async () => {
    const owned = [
      shelved("c1", CHARIZARD_EX_SV035_006, {
        role: "bulk",
        binderId: null,
        binderHalf: null,
        colorBand: null,
      }),
    ];
    const res = placeCard(
      { id: "d1", card: CHARIZARD_EX_SV035_006, variant: "normal" },
      ctx({ owned }),
    );
    // Unchanged from today: bulk and block copies are invisible to duplicate detection.
    expect(res.target.kind).toBe("specialty");
  });

  it("keeps sending an ordinary duplicate to bulk", async () => {
    // Regression guard on the pre-existing behaviour the reorder must not disturb.
    const owned = [shelved("c1", CHARMANDER_SV03_026)];
    const res = placeCard(
      { id: "d1", card: CHARMANDER_SV03_026, variant: "normal" },
      ctx({ owned }),
    );
    expect(res.target.kind).toBe("bulk");
  });
});

describe("UIL-049 · the holo-swap interaction, which the reorder newly exposes", () => {
  /**
   * Before this change, a specialty card returned at step 2 and never reached the duplicate branch — so
   * the holo-swap path had never seen one. Moving duplicate detection first exposes it, and the swap
   * builds its target from the DISPLACED copy's placement. A specialty copy has no binder half and no
   * colour band, so the question is whether the inherited target is still well-formed.
   *
   * This test exists because the issue entry asserted the interaction was safe. That was worth
   * verifying rather than believing.
   */
  it("a specialty holo over a shelved specialty normal produces a well-formed target", async () => {
    const owned = [
      shelved("c1", CHARIZARD_EX_SV035_006, {
        binderId: SPEC.id,
        binderHalf: null,
        colorBand: null,
      }),
    ];
    const res = placeCard(
      { id: "d1", card: CHARIZARD_EX_SV035_006, variant: "holo" },
      ctx({ owned }),
    );

    // Whatever it decides, it must not invent a front/back half or a colour band inside a specialty
    // binder — that combination is not a placement the write layer can express (`placementForMove`
    // clears half and band for a collection destination).
    if (res.target.kind === "front-half" || res.target.kind === "back-half-line") {
      expect(res.target.binderId).not.toBe(SPEC.id);
    }
    // And the displaced copy, if any, must be named so the commit can move it.
    if (res.swap) expect(res.displacedToBulkCopyId).toBe("c1");
  });

  it("an ordinary holo over a shelved normal still swaps, inheriting the shelf place", async () => {
    const owned = [shelved("c1", CHARMANDER_SV03_026)];
    const res = placeCard({ id: "d1", card: CHARMANDER_SV03_026, variant: "holo" }, ctx({ owned }));
    expect(res.step).toBe("duplicate");
    expect(res.swap).toBeTruthy();
    expect(res.displacedToBulkCopyId).toBe("c1");
    expect(res.target.kind).toBe("front-half");
  });
});
