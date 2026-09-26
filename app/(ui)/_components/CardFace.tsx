"use client";

/**
 * A card thumbnail (design/prototype.html · `.face`). Shows the live TCGdex artwork over a fallback so
 * a card is still identifiable when the image cannot load (offline / catalog gap / a stand-in). The
 * stored `image_url` is a TCGdex base path; the quality + extension are appended here.
 *
 * The fallback (UIL-081) is the prototype's pixel SIGIL — a deterministic, mirrored 6×6 pattern seeded
 * from the card's name in a brand band colour (lib/catalog/sigil.ts) — with the initials kept as a
 * small legend underneath so the name stays legible. Two imageless cards never look identical; the same
 * card always looks the same. A sigil is not artwork, so it is never zoomable (UIL-036's guard).
 *
 * Presentational client component (needs the image `onError` fallback). Reused across intake, plan,
 * lookup, and line detail.
 *
 * `zoomable` (UIL-036, the prototype's lightbox, finally ported): clicking the thumbnail — or Enter /
 * Space on it — opens `CardLightbox` with the same card at `high` quality. Gated the way the prototype
 * gated it: "only a card with real art is zoomable; a block has nothing to enlarge" — no `imageUrl`,
 * or an image that failed to load, and the face is the plain thumbnail it always was. The click is
 * stopped at the face, so a face inside a clickable row (the Haul Plan worklist) zooms without also
 * selecting the row — the prototype's capture-handler behaviour.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { CardLightbox } from "./CardLightbox";
import { SIGIL_DARK, SIGIL_SIZE, sigilCells, sigilColor } from "@/lib/catalog/sigil";
import { languageName, languageOfId, isStandInId } from "@/lib/catalog/locale";

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
  tcgdexId = null,
  size = "s",
  zoomable = false,
  caption = null,
}: {
  name: string;
  imageUrl: string | null;
  /**
   * The card's stored id. A STAND-IN has no artwork, so its face is always the sigil, and the sigil is the
   * one place every screen shows it: the id's language is badged there (UIL-108), so a French stand-in
   * and an English one never look alike.
   */
  tcgdexId?: string | null;
  size?: FaceSize;
  /** Open the lightbox on click (UIL-036). Ignored when there is no art to enlarge. */
  zoomable?: boolean;
  /** Set and/or collector number for the lightbox caption, e.g. "Obsidian Flames · 027/197". */
  caption?: string | null;
}) {
  const [errored, setErrored] = useState(false);
  const [open, setOpen] = useState(false);
  const src = imageUrl ? `${imageUrl}/low.webp` : null;
  const canZoom = zoomable && imageUrl !== null && !errored;
  const standIn = tcgdexId !== null && isStandInId(tcgdexId);
  const language = standIn ? languageOfId(tcgdexId) : null;
  const faceLabel = standIn
    ? `${name}, your stand-in${language ? `, ${languageName(language)}` : ", language not recorded"}`
    : name;

  function openZoom(e: { preventDefault: () => void; stopPropagation: () => void }) {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  }

  return (
    <>
      <span
        className={`face ${size}${canZoom ? " zoomable" : ""}`}
        {...(canZoom
          ? {
              role: "button",
              tabIndex: 0,
              "aria-label": `Enlarge ${name}`,
              onClick: openZoom,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") openZoom(e);
              },
            }
          : {})}
      >
        {src && !errored ? (
          // Deferred, not eager (UIL-016): the haul-plan worklist mounts one face per card, and at
          // Karvi's 702-card scale an eager fetch is 702 requests on first paint for maybe 12 rows she
          // can actually see. `loading="lazy"` leaves the browser to fetch what scrolls into view.
          // eslint-disable-next-line @next/next/no-img-element -- fallback needs onError; not a hot path
          <img
            src={src}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={() => setErrored(true)}
          />
        ) : (
          <span className="fallback" title={faceLabel} aria-label={faceLabel} role="img">
            <svg
              className="sigil"
              viewBox={`0 0 ${SIGIL_SIZE} ${SIGIL_SIZE}`}
              shapeRendering="crispEdges"
              aria-hidden="true"
              focusable="false"
            >
              {sigilCells(name).map((c) => (
                <rect
                  key={`${c.x}-${c.y}`}
                  x={c.x}
                  y={c.y}
                  width={1}
                  height={1}
                  fill={c.shade === "dark" ? SIGIL_DARK : sigilColor(name)}
                />
              ))}
            </svg>
            <span className="init u">{initials(name)}</span>
            {language ? (
              <span className="lang u" aria-hidden="true">
                {language.toUpperCase()}
              </span>
            ) : null}
          </span>
        )}
      </span>
      {open && imageUrl && typeof document !== "undefined"
        ? createPortal(
            <CardLightbox
              name={name}
              imageUrl={imageUrl}
              caption={caption}
              onClose={() => setOpen(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}
