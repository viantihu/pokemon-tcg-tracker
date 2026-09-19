// @vitest-environment jsdom
/**
 * UIL-073 — the card lightbox's dismissal, driven through a REAL DOM: clicks and a keypress dispatched
 * at the rendered component, not read off the source.
 *
 * Why this file exists: `renderToStaticMarkup` cannot fire an event, so until now every click path in
 * the app was verified by reading. QA showed on #232 that swapping this overlay's click handler for
 * MoveOverlay's `target === currentTarget` guard left every render test green; #241 answered by
 * exporting the policy as pure functions (tests/components/card-lightbox.test.ts pins those). What
 * that still could not pin is that the component WIRES them to the events — which is exactly what a
 * mutation on the wiring would break and what this file catches.
 *
 * The harness (opt-in, per file — the other files keep vitest's node default):
 *   - the `@vitest-environment jsdom` pragma on line 1 gives this file a DOM;
 *   - the `*.dom.test.ts` name says so at a glance; vitest's `tests/**\/*.test.ts` glob still matches;
 *   - Testing Library's auto-cleanup does NOT register here (it needs a global `afterEach`, and this
 *     repo does not enable vitest globals), so `cleanup` is called explicitly below.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardLightbox } from "@/app/(ui)/_components/CardLightbox";

const ART = "https://assets.tcgdex.net/en/sv/sv03/027";
const CAPTION = "Obsidian Flames · 027/197";

function open() {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(CardLightbox, { name: "Charmeleon", imageUrl: ART, caption: CAPTION, onClose }),
  );
  return { onClose, user };
}

afterEach(cleanup);

describe("UIL-073 · CardLightbox closes on a click ANYWHERE — the opposite of MoveOverlay's backdrop-only guard", () => {
  it("a click on the image closes it, once", async () => {
    const { onClose, user } = open();
    await user.click(screen.getByRole("img", { name: "Charmeleon" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click on the caption closes it", async () => {
    const { onClose, user } = open();
    await user.click(screen.getByText(CAPTION));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click on the backdrop — the dialog element itself — closes it", async () => {
    const { onClose, user } = open();
    await user.click(screen.getByRole("dialog", { name: "Charmeleon, enlarged" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click deep inside the content does not stop it: the hint text is as good a close target as the backdrop", async () => {
    const { onClose, user } = open();
    await user.click(screen.getByText("CLICK ANYWHERE OR PRESS ESC TO CLOSE"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("UIL-073 · Escape closes it; no other key does; the listener leaves with the component", () => {
  it("Escape closes it, once", async () => {
    const { onClose, user } = open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter, Space, Tab and a letter do nothing", async () => {
    const { onClose, user } = open();
    await user.keyboard("{Enter} {Tab}a");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("after unmount, Escape no longer reaches the old onClose (the document listener is removed)", async () => {
    const { onClose, user } = open();
    cleanup();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});
