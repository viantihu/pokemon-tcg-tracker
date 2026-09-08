import { describe, expect, it } from "vitest";

import { isDuplicateCard, resolveDuplicate } from "@/lib/engine/duplicate";
import type { OwnedCopy } from "@/lib/engine/types";
import {
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARMELEON_SV035_005,
  VIBRAVA_XY3_75,
  VIBRAVA_XY5_109,
} from "./fixtures";

function copy(over: Partial<OwnedCopy> & Pick<OwnedCopy, "id" | "card">): OwnedCopy {
  return {
    variant: "normal",
    role: "shelved",
    binderId: "B1",
    binderHalf: "front",
    colorBand: "Red",
    lineSlotId: null,
    ...over,
  };
}

describe("duplicate: the duplicate key (system-design §3)", () => {
  it("matches on shared artworkGroupId even across different printings", () => {
    // artworkGroupId is M2-derived; two records carrying the same group are the same art.
    const a = { ...CHARMELEON_SV03_027, artworkGroupId: "shared-art" };
    const b = { ...CHARMELEON_SV035_005, artworkGroupId: "shared-art" };
    expect(isDuplicateCard(a, b)).toBe(true);
  });

  it("matches on the same (setId, localId) printing", () => {
    const holo = { ...CHARMANDER_SV03_026 };
    const normal = { ...CHARMANDER_SV03_026, artworkGroupId: "different" };
    expect(isDuplicateCard(holo, normal)).toBe(true); // same sv03 / 026
  });

  it("treats two different printings with different art as NOT duplicates", () => {
    expect(isDuplicateCard(CHARMELEON_SV03_027, CHARMELEON_SV035_005)).toBe(false);
    expect(isDuplicateCard(VIBRAVA_XY5_109, VIBRAVA_XY3_75)).toBe(false);
  });
});

describe("duplicate: checked against SHELVED copies only, never bulk", () => {
  it("ignores a matching copy that is already in the bulk box", () => {
    const owned = [copy({ id: "c1", card: CHARMANDER_SV03_026, role: "bulk" })];
    const out = resolveDuplicate(CHARMANDER_SV03_026, "normal", owned);
    expect(out.kind).toBe("not-duplicate");
  });

  it("ignores a matching copy sitting in a binder block", () => {
    const owned = [copy({ id: "c1", card: CHARMANDER_SV03_026, role: "block" })];
    const out = resolveDuplicate(CHARMANDER_SV03_026, "normal", owned);
    expect(out.kind).toBe("not-duplicate");
  });
});

describe("duplicate: holo-swap (cascade step 3)", () => {
  it("a holo arriving over a shelved normal makes the holo inherit the whole role, incl. line slot", () => {
    const owned = [
      copy({
        id: "normal-copy",
        card: CHARMANDER_SV03_026,
        variant: "normal",
        role: "shelved",
        binderId: "B2",
        binderHalf: "back",
        colorBand: "Red",
        lineSlotId: "slot-charmander",
      }),
    ];
    const out = resolveDuplicate(CHARMANDER_SV03_026, "holo", owned);
    expect(out.kind).toBe("holo-swap");
    if (out.kind !== "holo-swap") return;
    expect(out.swap.incomingInherits).toEqual({
      binderId: "B2",
      binderHalf: "back",
      colorBand: "Red",
      lineSlotId: "slot-charmander", // inherits the line slot too
    });
    expect(out.swap.displacedCopyId).toBe("normal-copy"); // the normal is displaced (→ bulk)
  });

  it("a non-holo duplicate goes to bulk, and offers a block repurpose when a need is open", () => {
    const owned = [copy({ id: "normal-copy", card: CHARMANDER_SV03_026, variant: "normal" })];

    const plain = resolveDuplicate(CHARMANDER_SV03_026, "reverse", owned);
    expect(plain.kind).toBe("bulk");
    if (plain.kind === "bulk") expect(plain.offerBlockRepurpose).toBe(false);

    const withNeed = resolveDuplicate(CHARMANDER_SV03_026, "reverse", owned, 1);
    if (withNeed.kind === "bulk") expect(withNeed.offerBlockRepurpose).toBe(true);
  });

  it("does not swap a holo when the shelved copy is also a holo (no normal to displace)", () => {
    const owned = [copy({ id: "holo-copy", card: CHARMANDER_SV03_026, variant: "holo" })];
    const out = resolveDuplicate(CHARMANDER_SV03_026, "holo", owned);
    expect(out.kind).toBe("bulk");
  });
});
