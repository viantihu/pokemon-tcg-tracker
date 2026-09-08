"use client";

/**
 * A card thumbnail (design/prototype.html · `.face`). Shows the live TCGdex artwork over a text
 * fallback so a card is still identifiable when the image cannot load (offline / catalog gap). The
 * stored `image_url` is a TCGdex base path; the quality + extension are appended here.
 *
 * Presentational client component (needs the image `onError` fallback). Reused across intake, plan,
 * lookup, and line detail.
 */

import { useState } from "react";

export type FaceSize = "s" | "m" | "l";

function initials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z ]/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function CardFace({
  name,
  imageUrl,
  size = "s",
}: {
  name: string;
  imageUrl: string | null;
  size?: FaceSize;
}) {
  const [errored, setErrored] = useState(false);
  const src = imageUrl ? `${imageUrl}/low.webp` : null;
  return (
    <span className={`face ${size}`}>
      {src && !errored ? (
        // eslint-disable-next-line @next/next/no-img-element -- fallback needs onError; not a hot path
        <img src={src} alt={name} onError={() => setErrored(true)} />
      ) : (
        <span className="fallback u">{initials(name)}</span>
      )}
    </span>
  );
}
