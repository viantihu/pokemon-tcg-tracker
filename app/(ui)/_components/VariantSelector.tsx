"use client";

/**
 * Pick the physical variant for a card (system-design §4 Copy.variant; haul intake §7B step 2 —
 * "Variant picked per card"). Choices are the printing's available variants (from the mirror). Pure
 * presentational client control — reused by intake and (later) backfill.
 */

import type { Variant } from "@/lib/engine";

const LABEL: Record<Variant, string> = {
  normal: "Normal",
  holo: "Holo",
  reverse: "Reverse",
  firstEdition: "1st Ed",
  wPromo: "Promo",
};

export function VariantSelector({
  variants,
  value,
  onChange,
}: {
  variants: Variant[];
  value: Variant;
  onChange: (v: Variant) => void;
}) {
  return (
    <div className="variants" role="group" aria-label="Variant">
      {variants.map((v) => (
        <button
          key={v}
          type="button"
          className={value === v ? "on" : ""}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {LABEL[v]}
        </button>
      ))}
    </div>
  );
}
