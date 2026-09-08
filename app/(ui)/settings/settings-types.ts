/**
 * Shared shapes for Settings (dev-spec §5 M8; system-design §4). Serializable data only.
 */

export interface BinderRow {
  id: string;
  name: string;
  type: "general" | "specialty";
  pages: number;
  pocketsPerPage: number;
  backHalfStartPage: number | null;
  isActive: boolean;
}

export interface BandRow {
  band: string;
  displayName: string;
  position: number;
}

export interface TypeMapRow {
  cardType: string;
  band: string;
}

export interface SettingsData {
  binders: BinderRow[];
  /** All ten bands in rainbow order — Pink is present even at zero cards and must never be hidden. */
  bands: BandRow[];
  typeMap: TypeMapRow[];
}

export interface BinderInput {
  id?: string | null;
  name: string;
  type: "general" | "specialty";
  pages: number;
  pocketsPerPage: number;
  backHalfStartPage: number | null;
  isActive: boolean;
}

/** Result of a type_color_map edit: how many stored bands were recomputed. */
export interface RecomputeCounts {
  copies: number;
  lines: number;
}

export type SettingsResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };
