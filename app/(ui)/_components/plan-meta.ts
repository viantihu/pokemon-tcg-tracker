/**
 * Presentation metadata for bands and worklist actions (design/prototype.html · scr-plan).
 *
 * Colours and labels only — the functional band order comes from the DB `color_band.position`
 * column, and the functional action order lives in `lib/plan/action.ts` (`ACTION_ORDER`). This
 * module is pure data, safe to import from client components.
 */

import type { PlanActionKind } from "@/lib/plan";

export interface BandMeta {
  /** DB band key. */
  key: string;
  display: string;
  /** Energy types folded into the band (band header caption). */
  types: string;
  /** Rail / chip colour from the prototype palette. */
  color: string;
  /** Dark swatch (needs light text). */
  dark?: boolean;
  /** Dithered swatch (White). */
  dither?: boolean;
}

/** Keyed by DB `color_band.band`. Colours from the prototype's `BANDS` table. */
export const BAND_META: Record<string, BandMeta> = {
  red: { key: "red", display: "Red", types: "FIRE", color: "#EC6F4D" },
  orange: { key: "orange", display: "Orange", types: "FIGHTING", color: "#C9762B" },
  yellow: { key: "yellow", display: "Yellow", types: "LIGHTNING", color: "#FEDF4F" },
  olive: { key: "olive", display: "Olive", types: "DRAGON", color: "#8F9A3A" },
  green: { key: "green", display: "Green", types: "GRASS", color: "#45C55D" },
  dark_blue: {
    key: "dark_blue",
    display: "Dark blue",
    types: "DARKNESS",
    color: "#3B5687",
    dark: true,
  },
  light_blue: { key: "light_blue", display: "Light blue", types: "WATER", color: "#6FB9DD" },
  purple: { key: "purple", display: "Purple", types: "PSYCHIC", color: "#9D6FB8" },
  pink: { key: "pink", display: "Pink", types: "FAIRY", color: "#FF94A6" },
  white: {
    key: "white",
    display: "White",
    types: "COLORLESS · METAL · TRAINERS",
    color: "#FDF6E6",
    dither: true,
  },
};

/** The confirmed rainbow order (system-design §4; DB `color_band` positions). Fallback when the DB
 * is unreachable. */
export const DEFAULT_BAND_ORDER: readonly string[] = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
];

export function bandMeta(key: string): BandMeta {
  return BAND_META[key] ?? { key, display: key, types: "", color: "#A89D85" };
}

export interface ActionMeta {
  label: string;
  /** The dominant one-line instruction shown in the spotlight. */
  big: string;
  /** Chip background from the prototype's `ACT` table. */
  color: string;
  /** Chip needs light text. */
  dark?: boolean;
}

export const ACTION_META: Record<PlanActionKind, ActionMeta> = {
  PULL: { label: "PULL FROM ANOTHER BINDER", big: "Pull it out, then reshelve", color: "#F9E7C6" },
  FILL: { label: "FILL A PLACEHOLDER", big: "Pull the sticky note, drop it in", color: "#DCEFF8" },
  NEWLINE: { label: "START A NEW LINE", big: "Start a new evolution line", color: "#EDDFF7" },
  SWAP: { label: "SWAP FOR THE NORMAL", big: "Holo in, normal out", color: "#FFD9DF" },
  SPEC: { label: "SPECIALTY BINDER", big: "To the specialty binder", color: "#3C3C3B", dark: true },
  FRONT: { label: "PLACE IN FRONT HALF", big: "Place in the front half", color: "#ADEBB3" },
  BULK: { label: "SEND TO BULK BOX", big: "Into the bulk box", color: "#A89D85" },
};
