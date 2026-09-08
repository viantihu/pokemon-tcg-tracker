/**
 * Shared shapes for the Capacity review (dev-spec §5 M8; system-design §7E). Serializable data only.
 */

import type { Fullness } from "@/lib/surfaces";

export interface CapacitySection {
  binderId: string;
  binderName: string;
  binderType: "general" | "specialty";
  /** "front" | "back" | "single" (specialty binders are one section). */
  half: string;
  capacity: number;
  shelvedCount: number;
  blockPockets: number;
  openPlaceholders: number;
  freePockets: number;
  fullness: Fullness;
}

export interface CapacityData {
  sections: CapacitySection[];
  /** Back halves that can seat a new line, most free first — "which binder has room for a Fire line". */
  roomForLine: { binderId: string; binderName: string; freePockets: number }[];
}
