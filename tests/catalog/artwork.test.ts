/**
 * Artwork perceptual-hash + clustering (dev-spec §5 M2; system-design §10).
 *
 * Acceptance covered here:
 *   * Holo and reverse-holo of the same printing land in the SAME artwork_group_id (they are ONE
 *     TCGdex card / one source image → one hash → one group).
 *   * Near-identical art clusters together; genuinely different art does not.
 *   * Manual merge/split overrides pin a card's group across a re-cluster.
 *
 * Pixel buffers here are synthetic (they are not card facts — the real-cards rule is about catalog
 * data, not luminance test vectors). The PNG decode is exercised on real PNG bytes.
 */
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  clusterArtwork,
  cropRegion,
  dHash,
  decodePngToGray,
  hammingHex,
  hashArtworkPng,
  mergeAssignments,
  splitAssignment,
  type GrayscaleImage,
} from "@/lib/catalog/artwork";

/** A `w×h` image whose luminance is a left→right ramp (deterministic, easy to reason about). */
function ramp(w: number, h: number, invert = false): GrayscaleImage {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      data[y * w + x] = invert ? 255 - v : v;
    }
  }
  return { width: w, height: h, data };
}

describe("dHash", () => {
  it("is deterministic and 16 hex chars (64 bits)", () => {
    const img = ramp(64, 64);
    const h = dHash(img);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(dHash(img)).toBe(h);
  });

  it("identical images → distance 0; inverted ramp → far apart", () => {
    const a = dHash(ramp(64, 64));
    const b = dHash(ramp(64, 64));
    const c = dHash(ramp(64, 64, true));
    expect(hammingHex(a, b)).toBe(0);
    expect(hammingHex(a, c)).toBeGreaterThan(20);
  });

  it("a small local perturbation stays close", () => {
    const base = ramp(64, 64);
    const noisy = { ...base, data: Uint8Array.from(base.data) };
    // Nudge a few pixels — a holo-overlay-style local change, not a different illustration.
    for (let i = 0; i < noisy.data.length; i += 997)
      noisy.data[i] = Math.min(255, noisy.data[i] + 8);
    expect(hammingHex(dHash(base), dHash(noisy))).toBeLessThanOrEqual(4);
  });
});

describe("cropRegion", () => {
  it("returns a sub-image strictly smaller than the source", () => {
    const img = ramp(100, 100);
    const cropped = cropRegion(img);
    expect(cropped.width).toBeLessThan(img.width);
    expect(cropped.height).toBeLessThan(img.height);
    expect(cropped.data.length).toBe(cropped.width * cropped.height);
  });
});

describe("hammingHex", () => {
  it("counts differing bits", () => {
    expect(hammingHex("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingHex("0", "f")).toBe(4);
  });
  it("throws on length mismatch", () => {
    expect(() => hammingHex("00", "0")).toThrow();
  });
});

describe("PNG decode", () => {
  it("decodes real PNG bytes to luminance and hashes them", () => {
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 8 * 8; i++) {
      const p = i * 4;
      const white = i % 8 >= 4; // right half white, left half black
      png.data[p] = png.data[p + 1] = png.data[p + 2] = white ? 255 : 0;
      png.data[p + 3] = 255;
    }
    const bytes = new Uint8Array(PNG.sync.write(png));
    const gray = decodePngToGray(bytes);
    expect(gray.width).toBe(8);
    expect(gray.height).toBe(8);
    expect(gray.data[0]).toBe(0); // top-left black
    expect(gray.data[7]).toBe(255); // top-right white
    expect(hashArtworkPng(bytes)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("clusterArtwork", () => {
  it("holo/reverse of one printing (a single id) form one group named by that id", () => {
    // In TCGdex, holo & reverse are variant flags on ONE card id → one row → one hash.
    const groups = clusterArtwork([{ id: "sv03-027", hash: "abcdef0123456789" }]);
    expect(groups.get("sv03-027")).toBe("sv03-027");
  });

  it("near-identical hashes cluster; distinct art stays separate", () => {
    const groups = clusterArtwork(
      [
        { id: "setA-1", hash: "0000000000000000" },
        { id: "setB-9", hash: "0000000000000001" }, // 1 bit off → a reprint of the same art
        { id: "setC-5", hash: "ffffffffffffffff" }, // different illustration
      ],
      { threshold: 5 },
    );
    expect(groups.get("setA-1")).toBe(groups.get("setB-9"));
    expect(groups.get("setA-1")).toBe("setA-1"); // canonical = smallest member id
    expect(groups.get("setC-5")).toBe("setC-5");
    expect(groups.get("setC-5")).not.toBe(groups.get("setA-1"));
  });

  it("a card with no hash yet is ungrouped (null)", () => {
    const groups = clusterArtwork([{ id: "x-1", hash: null }]);
    expect(groups.get("x-1")).toBeNull();
  });

  it("manual MERGE pins cards to one group across a re-cluster", () => {
    const merge = mergeAssignments(["setA-1", "setC-5"], "grp-merged");
    const entries = merge.map((m) => ({
      id: m.tcgdex_id,
      hash: m.tcgdex_id === "setA-1" ? "0000000000000000" : "ffffffffffffffff",
      lockedGroupId: m.artwork_group_id,
    }));
    const groups = clusterArtwork(entries, { threshold: 5 });
    expect(groups.get("setA-1")).toBe("grp-merged");
    expect(groups.get("setC-5")).toBe("grp-merged"); // stays merged despite far-apart hashes
  });

  it("manual SPLIT keeps a card out of an otherwise-matching cluster", () => {
    const split = splitAssignment("setB-9", "solo");
    const groups = clusterArtwork(
      [
        { id: "setA-1", hash: "0000000000000000" },
        { id: split.tcgdex_id, hash: "0000000000000001", lockedGroupId: split.artwork_group_id },
      ],
      { threshold: 5 },
    );
    expect(groups.get("setB-9")).toBe("solo"); // not merged with setA-1
    expect(groups.get("setA-1")).toBe("setA-1");
  });
});
