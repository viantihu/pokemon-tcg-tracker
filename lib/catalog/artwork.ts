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
 * Cluster entries into `artwork_group_id`s. Deterministic, pure.
 *
 *   * A locked entry keeps its `lockedGroupId` verbatim and is excluded from hash-based merging
 *     (this is what makes a manual merge or split stick across a re-cluster).
 *   * Unlocked entries with a hash are unioned when their Hamming distance ≤ threshold; each
 *     resulting group is named by the lexicographically smallest member id (stable, no randomness).
 *   * An unlocked entry with no hash yet maps to `null` (ungrouped until it is hashed).
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

  // Union-find over the unlocked, hashed entries.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Point the larger id at the smaller so the root is always the min id (deterministic name).
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
