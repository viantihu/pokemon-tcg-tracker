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
  type ArtworkEntry,
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

/**
 * The LSH-banded clusterer must return EXACTLY what the original O(n²) all-pairs scan returned. This
 * reference mirrors the pre-optimization algorithm verbatim (union any pair within `threshold`,
 * union-find with the smaller id as the root → group named by its min member id) so we can assert
 * the optimized `clusterArtwork` produces byte-for-byte identical group assignments on both the real
 * fixtures and larger generated inputs. If the two ever diverge, the optimization changed behavior.
 */
function clusterArtworkNaive(
  entries: ArtworkEntry[],
  { threshold = 10 }: { threshold?: number } = {},
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const hashed = entries.filter((e) => e.hash != null && !e.lockedGroupId);
  for (const e of entries) {
    if (e.lockedGroupId) result.set(e.id, e.lockedGroupId);
    else if (e.hash == null) result.set(e.id, null);
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const e of hashed) parent.set(e.id, e.id);
  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      if (hammingHex(hashed[i].hash!, hashed[j].hash!) <= threshold) {
        union(hashed[i].id, hashed[j].id);
      }
    }
  }
  for (const e of hashed) result.set(e.id, find(e.id));
  return result;
}

/** Assert two group maps are identical (same keys, same values) regardless of insertion order. */
function expectSameGroups(a: Map<string, string | null>, b: Map<string, string | null>) {
  expect(new Set(a.keys())).toEqual(new Set(b.keys()));
  for (const [id, group] of a) expect(b.get(id)).toBe(group);
}

/** Deterministic PRNG (mulberry32) so generated hashes are stable across runs — no flakiness. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = "0123456789abcdef";
function randomHash(rand: () => number, chars = 16): string {
  let h = "";
  for (let i = 0; i < chars; i++) h += HEX[Math.floor(rand() * 16)];
  return h;
}
/** Flip `bits` random bits of a 16-char (64-bit) hex hash — a near-identical reprint of the art. */
function perturb(hash: string, bits: number, rand: () => number): string {
  const arr = hash.split("");
  for (let k = 0; k < bits; k++) {
    const pos = Math.floor(rand() * arr.length);
    const nibble = parseInt(arr[pos], 16) ^ (1 << Math.floor(rand() * 4));
    arr[pos] = nibble.toString(16);
  }
  return arr.join("");
}

describe("clusterArtwork — optimized (LSH banding) matches the naive all-pairs scan", () => {
  it("produces identical groups on the M2 fixtures (default and tuned thresholds)", () => {
    const fixtures: ArtworkEntry[] = [
      { id: "setA-1", hash: "0000000000000000" },
      { id: "setB-9", hash: "0000000000000001" }, // 1 bit off setA-1
      { id: "setC-5", hash: "ffffffffffffffff" }, // far from everything
      { id: "sv03-027", hash: "abcdef0123456789" },
      { id: "grp-lock-2", hash: "0000000000000003", lockedGroupId: "grp-merged" },
      { id: "no-hash", hash: null },
    ];
    for (const threshold of [0, 1, 5, 10, 15]) {
      expectSameGroups(
        clusterArtwork(fixtures, { threshold }),
        clusterArtworkNaive(fixtures, { threshold }),
      );
    }
  });

  it("matches the naive scan on a larger generated catalog with planted reprint clusters", () => {
    const rand = mulberry32(20240917);
    const entries: ArtworkEntry[] = [];
    // 400 distinct base artworks, each with 1–4 near-identical reprints (holo/reverse/reprints).
    for (let g = 0; g < 400; g++) {
      const base = randomHash(rand);
      entries.push({ id: `base-${String(g).padStart(4, "0")}`, hash: base });
      const reprints = Math.floor(rand() * 4);
      for (let r = 0; r < reprints; r++) {
        entries.push({
          id: `rep-${String(g).padStart(4, "0")}-${r}`,
          hash: perturb(base, 1 + Math.floor(rand() * 4), rand), // ≤4 bits off → within threshold
        });
      }
    }
    // A handful of locked overrides (manual merge/split) mixed in — must be honored unchanged.
    entries.push({ id: "locked-a", hash: randomHash(rand), lockedGroupId: "manual-grp" });
    entries.push({ id: "locked-b", hash: randomHash(rand), lockedGroupId: "manual-grp" });
    for (const threshold of [5, 8, 10]) {
      expectSameGroups(
        clusterArtwork(entries, { threshold }),
        clusterArtworkNaive(entries, { threshold }),
      );
    }
  });

  // Explicit vitest timeout, because the DEFAULT (5 s) is below this test's own 10 s
  // bound on `elapsedMs` below — so on a loaded runner vitest killed the test before the
  // assertion the author actually wrote could run. Measured on GitHub-hosted runners: the
  // whole test takes 2.7–3.2 s when green (generating 23.5k hashes is part of that), and on
  // 2026-09-17 it hit the 5 s wall on five of six simultaneous runs, then passed unchanged
  // on re-run. 20 s leaves the in-test 10 s assertion as the operative performance bound.
  it(
    "scale sanity: clusters ~23.5k hashes and still groups planted reprints correctly",
    { timeout: 20_000 },
    () => {
      const rand = mulberry32(511);
      const entries: ArtworkEntry[] = [];
      const expectedPairs: [string, string][] = [];
      for (let g = 0; g < 23500; g++) {
        const id = `c-${String(g).padStart(5, "0")}`;
        const base = randomHash(rand);
        entries.push({ id, hash: base });
        // Every 50th card gets one near-identical reprint we expect to co-group.
        if (g % 50 === 0) {
          const repId = `${id}-rev`;
          entries.push({ id: repId, hash: perturb(base, 3, rand) });
          expectedPairs.push([id, repId]);
        }
      }
      const started = Date.now();
      const groups = clusterArtwork(entries, { threshold: 10 });
      const elapsedMs = Date.now() - started;

      expect(groups.size).toBe(entries.length);
      // Planted reprints land in the same group as their base…
      for (const [a, b] of expectedPairs) expect(groups.get(a)).toBe(groups.get(b));
      // …and random unrelated hashes stay in their own singleton group (id === group).
      expect(groups.get("c-00001")).toBe("c-00001");
      // Banding must avoid the ~276M-pair all-vs-all scan; comfortably under a generous CI bound.
      expect(elapsedMs).toBeLessThan(10000);
    },
  );
});
