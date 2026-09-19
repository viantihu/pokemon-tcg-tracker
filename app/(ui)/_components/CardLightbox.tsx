"use client";

/**
 * The card lightbox (design/prototype.html `#lightbox`, ported for UIL-036): the enlarged artwork of
 * one card over a dimmed page, with its name and set/number underneath. Opened by a `zoomable`
 * `CardFace`; closed by a click ANYWHERE or Escape.
 *
 * Deliberately NOT built on `MoveOverlay`'s dialog shell. That shell dismisses only on a true backdrop
 * click (`e.target === e.currentTarget`) because it wraps a form with unsaved choices; CollHub drew the
 * same line for UIL-009 ("this is a form, not a lightbox"). An image viewer has nothing to lose on an
 * accidental close, so the whole overlay — image included — is the close target, exactly as the
 * prototype did it, and the hint says so.
 *
 * Requests `${imageUrl}/high.webp`: TCGdex's image path is a base and takes a quality suffix
 * (lib/catalog/tcgdex.ts); the thumbnail already fetched `low`, this is the same card at `high`.
 */

import { useEffect, useState } from "react";

/** The lightbox caption from what a site knows: "Set · 027/197", either half alone, or null. */
export function cardCaption(
  setName: string | null | undefined,
  number: string | null | undefined,
): string | null {
  const parts = [setName, number].filter((x): x is string => typeof x === "string" && x !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function CardLightbox({
  name,
  imageUrl,
  caption,
  onClose,
}: {
  name: string;
  /** TCGdex base image path; the quality suffix is appended here. */
  imageUrl: string;
  /** Set and/or collector number, e.g. "Obsidian Flames · 027/197". Omitted when unknown. */
  caption?: string | null;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="lightbox on"
      role="dialog"
      aria-modal="true"
      aria-label={`${name}, enlarged`}
      onClick={onClose}
    >
      <div className="lbwrap">
        <div className="lbcard">
          {!loaded ? (
            <div className="load u">{failed ? "IMAGE UNAVAILABLE OFFLINE" : "LOADING…"}</div>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- TCGdex asset, needs onLoad/onError */}
          <img
            src={`${imageUrl}/high.webp`}
            alt={name}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </div>
        <div className="lbcap">
          <span className="nm">{name}</span>
          {caption ? <span className="no">{caption}</span> : null}
        </div>
        <div className="lbhint u">CLICK ANYWHERE OR PRESS ESC TO CLOSE</div>
      </div>
    </div>
  );
}
