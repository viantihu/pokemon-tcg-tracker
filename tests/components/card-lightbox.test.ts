/**
 * UIL-036 — the prototype's card lightbox, ported. Static renders of the two halves:
 *
 *  - `CardFace`: plain by default; with `zoomable` AND real art it becomes the click target (a button
 *    role with an "Enlarge …" label and the `zoomable` class the CSS keys the zoom-in cursor off);
 *    with `zoomable` but NO art it stays a plain thumbnail — the prototype's own guard ("a block has
 *    nothing to enlarge").
 *  - `CardLightbox`: the SAME card at `high` quality, the name, the set/number caption when known, and
 *    the hint that says the whole overlay closes it.
 *
 * `renderToStaticMarkup` runs no events, so the click → open, click-anywhere → close and Escape → close
 * transitions are verified by reading (`CardFace.openZoom`, `CardLightbox`'s root `onClick` and its
 * keydown effect) and by the preview harness at 375 / 1440, not here.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardFace } from "@/app/(ui)/_components/CardFace";
import { CardLightbox } from "@/app/(ui)/_components/CardLightbox";

const ART = "https://assets.tcgdex.net/en/sv/sv03/027";

describe("UIL-036 · CardFace is zoomable only when asked AND there is art", () => {
  it("is the plain thumbnail by default — no zoom class, no button role", () => {
    const html = renderToStaticMarkup(
      createElement(CardFace, { name: "Charmeleon", imageUrl: ART }),
    );
    expect(html).toContain('class="face s"');
    expect(html).not.toContain("zoomable");
    expect(html).not.toContain('role="button"');
    expect(html).toContain(`${ART}/low.webp`);
  });

  it("with zoomable and art: the zoom class, a button role, a tab stop and an Enlarge label", () => {
    const html = renderToStaticMarkup(
      createElement(CardFace, { name: "Charmeleon", imageUrl: ART, size: "m", zoomable: true }),
    );
    expect(html).toContain('class="face m zoomable"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Enlarge Charmeleon"');
    // Closed by default: the lightbox is not on the page until she clicks.
    expect(html).not.toContain("lightbox");
    expect(html).not.toContain("high.webp");
  });

  it("with zoomable but NO art: stays plain — a block has nothing to enlarge", () => {
    const html = renderToStaticMarkup(
      createElement(CardFace, { name: "Basic Energy", imageUrl: null, zoomable: true }),
    );
    expect(html).toContain('class="face s"');
    expect(html).not.toContain("zoomable");
    expect(html).not.toContain('role="button"');
    expect(html).toContain("BE"); // the initials fallback is what renders
  });
});

describe("UIL-036 · CardLightbox shows the same card at high quality, with its caption", () => {
  it("requests high.webp, names the card, shows the set/number, and says how to close", () => {
    const html = renderToStaticMarkup(
      createElement(CardLightbox, {
        name: "Charmeleon",
        imageUrl: ART,
        caption: "Obsidian Flames · 027/197",
        onClose: () => {},
      }),
    );
    expect(html).toContain(`src="${ART}/high.webp"`);
    expect(html).not.toContain("low.webp");
    expect(html).toContain('alt="Charmeleon"');
    expect(html).toContain('class="nm">Charmeleon<');
    expect(html).toContain('class="no">Obsidian Flames · 027/197<');
    expect(html).toContain("CLICK ANYWHERE OR PRESS ESC TO CLOSE");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('class="lightbox on"');
    // Until the image reports itself loaded, the placeholder is visible over it.
    expect(html).toContain("LOADING…");
  });

  it("omits the caption chip when the set/number is unknown", () => {
    const html = renderToStaticMarkup(
      createElement(CardLightbox, { name: "Mystery", imageUrl: ART, onClose: () => {} }),
    );
    expect(html).toContain('class="nm">Mystery<');
    expect(html).not.toContain('class="no"');
  });
});
