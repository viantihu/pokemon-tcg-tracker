/**
 * Artwork identity (docs/dev-spec.md §5 M2; docs/system-design.md §10, resolved).
 *
 * Compute a perceptual hash (difference hash) of the ARTWORK REGION of each card — not the full
 * card — and cluster near-identical images into an `artwork_group_id`. Cropping to the artwork
 * matters: border treatment, set symbol, and holo pattern differ across reprints of identical art
 * and would otherwise push genuine matches apart (§10). Reverse-holo and holo variants of one
 * printing are a single TCGdex card (one source image) → one hash → one group, for free.
 *
 * The RAW hash is stored on the card (0004 migration) so clusters can be recomputed when the
 * threshold is tuned WITHOUT re-downloading 23.5k images. Manual merge/split overrides pin a
 * card's group (see `mergeAssignments` / `splitAssignment`) and the auto-clusterer leaves them be.
 *
 * The hashing + clustering here is pure and deterministic. Only `decodePngToGray` touches an image
 * decoder (pngjs, pure-JS); it is separated so the algorithm is testable without any I/O.
 */
import { PNG } from "pngjs";

/** A single-channel (luminance) image. `data[y * width + x]` is 0..255. */
export interface GrayscaleImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Fractional artwork rectangle within a standard card frame: drop the border, the name bar at the
 * top, and the attack/text box below the illustration. Tuned for the ~portrait TCGdex frame; the
 * raw hash is stored so this can be re-tuned and re-clustered without a re-sync.
 */
export const DEFAULT_ARTWORK_REGION = { left: 0.08, top: 0.13, right: 0.92, bottom: 0.58 } as const;

export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Crop a fractional region out of a grayscale image (no resampling). */
export function cropRegion(
  img: GrayscaleImage,
  region: Region = DEFAULT_ARTWORK_REGION,
): GrayscaleImage {
  const x0 = Math.max(0, Math.floor(region.left * img.width));
  const y0 = Math.max(0, Math.floor(region.top * img.height));
  const x1 = Math.min(img.width, Math.ceil(region.right * img.width));
  const y1 = Math.min(img.height, Math.ceil(region.bottom * img.height));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = img.data[(y0 + y) * img.width + (x0 + x)];
    }
  }
  return { width: w, height: h, data: out };
}

/** Box-average downscale to an exact target size (deterministic, no dependencies). */
export function downscale(img: GrayscaleImage, targetW: number, targetH: number): GrayscaleImage {
  const out = new Uint8Array(targetW * targetH);
  for (let ty = 0; ty < targetH; ty++) {
    const sy0 = Math.floor((ty * img.height) / targetH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * img.height) / targetH));
    for (let tx = 0; tx < targetW; tx++) {
      const sx0 = Math.floor((tx * img.width) / targetW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * img.width) / targetW));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += img.data[sy * img.width + sx];
          n++;
        }
      }
      out[ty * targetW + tx] = n ? Math.round(sum / n) : 0;
    }
  }
  return { width: targetW, height: targetH, data: out };
}

/**
 * Difference hash. Downscale to (size+1) × size, then for each row compare each pixel to its right
 * neighbour → `size × size` bits → hex string. Default size 8 → 64-bit hash → 16 hex chars.
 */
export function dHash(img: GrayscaleImage, size = 8): string {
  const small = downscale(img, size + 1, size);
  let bits = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const left = small.data[y * (size + 1) + x];
      const right = small.data[y * (size + 1) + x + 1];
      bits += left < right ? "1" : "0";
    }
  }
  // Pack the bit string into hex, 4 bits at a time.
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

const HEX_BIT_COUNT = Array.from({ length: 16 }, (_, i) => {
  let c = 0;
  for (let b = i; b; b >>= 1) c += b & 1;
  return c;
});

/** Population count (number of set bits) of a 32-bit word — the SWAR bit-twiddle, branch-free. */
function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hamming distance between two equal-length hex hashes (number of differing bits). */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`hammingHex: length mismatch (${a.length} vs ${b.length})`);
  }
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    dist += HEX_BIT_COUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return dist;
}

/** Decode a PNG buffer to a luminance image (pngjs, pure-JS; handles interlaced + colormap). */
export function decodePngToGray(bytes: Uint8Array): GrayscaleImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  const data = new Uint8Array(png.width * png.height);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    // Rec. 601 luma. Alpha is ignored: TCGdex art is opaque.
    data[i] = Math.round(0.299 * png.data[p] + 0.587 * png.data[p + 1] + 0.114 * png.data[p + 2]);
  }
  return { width: png.width, height: png.height, data };
}

/** Decode → crop to the artwork region → dHash. The end-to-end hash for a card's PNG image. */
export function hashArtworkPng(bytes: Uint8Array, region: Region = DEFAULT_ARTWORK_REGION): string {
  return dHash(cropRegion(decodePngToGray(bytes), region));
}

/** One card as the clusterer sees it. `lockedGroupId` is a manual merge/split override. */
export interface ArtworkEntry {
  id: string;
  hash: string | null;
  lockedGroupId?: string | null;
}

export interface ClusterOptions {
  /** Max Hamming distance (out of 64) to treat two hashes as the same artwork. */
  threshold?: number;
}

/**
 * Split a hash of `len` hex chars into `bandCount` contiguous, non-overlapping slices covering the
 * whole string (returned as `[start, end)` index pairs). Slices are as even as possible; with
 * `bandCount <= len` every slice is at least one char.
 *
 * Why slices matter (the LSH pigeonhole trick): two hashes at Hamming distance `d` differ in `d`
 * bits, each of which falls in exactly one slice, so at most `d` slices differ. If `bandCount > d`
 * then at least one slice is byte-for-byte identical between them. Choosing `bandCount = threshold
 * + 1` therefore GUARANTEES every pair within `threshold` shares an identical band — see below.
 */
function bandRanges(len: number, bandCount: number): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  for (let b = 0; b < bandCount; b++) {
    const end = Math.round(((b + 1) * len) / bandCount);
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

/**
 * Cluster entries into `artwork_group_id`s. Deterministic, pure.
 *
 *   * A locked entry keeps its `lockedGroupId` verbatim and is excluded from hash-based merging
 *     (this is what makes a manual merge or split stick across a re-cluster).
 *   * Unlocked entries with a hash are unioned when their Hamming distance ≤ threshold; each
 *     resulting group is named by the lexicographically smallest member id (stable, no randomness).
 *   * An unlocked entry with no hash yet maps to `null` (ungrouped until it is hashed).
 *
 * Near-duplicate discovery uses LSH banding + union-find instead of an all-pairs O(n²) scan, so it
 * scales toward the full ~23.5k catalog. Each hash is split into `threshold + 1` contiguous bands;
 * by the pigeonhole principle any two hashes within `threshold` bits share ≥1 byte-identical band,
 * so bucketing by (band index, band value) and comparing only same-bucket pairs finds EVERY pair
 * the all-pairs scan would (each verified with the exact Hamming distance). The connected components
 * — and thus the group assignments — are therefore identical to the naive scan; banding only skips
 * pairs that provably could never be within `threshold`. (Group naming is likewise unchanged: union
 * always keeps the smaller id as the root, so a group is named by its min member id regardless of
 * the order pairs are discovered.)
 */
export function clusterArtwork(
  entries: ArtworkEntry[],
  { threshold = 10 }: ClusterOptions = {},
): Map<string, string | null> {
  const result = new Map<string, string | null>();

  const hashed = entries.filter((e) => e.hash != null && !e.lockedGroupId);
  for (const e of entries) {
    if (e.lockedGroupId) result.set(e.id, e.lockedGroupId);
    else if (e.hash == null) result.set(e.id, null);
  }

  const n = hashed.length;
  const len = n > 0 ? hashed[0].hash!.length : 0;

  // Union-find over the unlocked, hashed entries, indexed by position in `hashed` (0..n-1). An
  // Int32Array root is far cheaper than a string-keyed Map at catalog scale. Group naming is kept
  // identical to the original: a merge keeps as root whichever side's id string is lexicographically
  // smaller, so `hashed[find(i)].id` is always the component's minimum member id (stable, no random).
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (hashed[ra].id < hashed[rb].id) parent[rb] = ra;
    else parent[ra] = rb;
  };

  // Pack each hash into 32-bit words once, so the hot loop can use a popcount Hamming (word XOR +
  // popcount) instead of the per-char `parseInt` in `hammingHex`. Same distance, much cheaper/call.
  const wordsPerHash = Math.max(1, Math.ceil(len / 8));
  const packed = new Uint32Array(n * wordsPerHash);
  for (let i = 0; i < n; i++) {
    const h = hashed[i].hash!;
    const base = i * wordsPerHash;
    for (let w = 0; w < wordsPerHash; w++) {
      packed[base + w] = parseInt(h.slice(w * 8, w * 8 + 8), 16) >>> 0 || 0;
    }
  }
  const distance = (i: number, j: number): number => {
    let d = 0;
    const bi = i * wordsPerHash;
    const bj = j * wordsPerHash;
    for (let w = 0; w < wordsPerHash; w++) d += popcount32(packed[bi + w] ^ packed[bj + w]);
    return d;
  };
  // Union i and j if within threshold. The find() guard skips a pair already merged (e.g. an exact
  // duplicate that collides in every band) before paying for the distance — the only de-duplication
  // needed, so there is no per-pair Set to blow past its size limit at catalog scale.
  const consider = (i: number, j: number) => {
    if (find(i) === find(j)) return;
    if (distance(i, j) <= threshold) union(i, j);
  };

  const bandCount = threshold + 1;
  if (threshold >= 0 && bandCount <= len) {
    // LSH-banded near-duplicate detection (exact for this threshold; see the doc comment above).
    const ranges = bandRanges(len, bandCount);
    for (const [start, end] of ranges) {
      const buckets = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const key = hashed[i].hash!.slice(start, end);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(i);
        else buckets.set(key, [i]);
      }
      for (const idxs of buckets.values()) {
        for (let a = 0; a < idxs.length; a++) {
          for (let b = a + 1; b < idxs.length; b++) consider(idxs[a], idxs[b]);
        }
      }
    }
  } else if (threshold >= 0) {
    // Degenerate: `threshold + 1` exceeds the hash length, so banding at hex-char granularity can't
    // guarantee a shared band (it would need more bands than the hash has chars). Fall back to the
    // exact all-pairs scan so groupings never change. Only reachable for a very loose threshold
    // (≥ 16 for the default 64-bit hash), which already collapses nearly everything into one group.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) consider(i, j);
    }
  }
  // threshold < 0: no pair can be within a negative distance, so every hashed entry stays its own
  // group (matches the naive scan, whose `<= threshold` guard is likewise never satisfied).

  for (let i = 0; i < n; i++) result.set(hashed[i].id, hashed[find(i)].id);

  return result;
}

/** Persistable rows for a manual MERGE: pin every id to one group and lock it. */
export function mergeAssignments(
  ids: string[],
  groupId: string,
): { tcgdex_id: string; artwork_group_id: string; artwork_group_locked: true }[] {
  return ids.map((id) => ({
    tcgdex_id: id,
    artwork_group_id: groupId,
    artwork_group_locked: true,
  }));
}

/** Persistable row for a manual SPLIT: pin one card to its own group (defaults to its id) and lock it. */
export function splitAssignment(
  id: string,
  groupId: string = id,
): { tcgdex_id: string; artwork_group_id: string; artwork_group_locked: true } {
  return { tcgdex_id: id, artwork_group_id: groupId, artwork_group_locked: true };
}
