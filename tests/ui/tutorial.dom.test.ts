// @vitest-environment jsdom
/**
 * UIL-128 — the first-run tutorial, driven the way she drives it.
 *
 * Karvi's ruling (2026-09-27), on the steps: "That is sufficient." What must hold:
 *   - it opens by itself only when the account has not finished or skipped it, and steps with Next / Back;
 *   - each step points at its nav tab in the real top bar;
 *   - Skip, Escape and Finish each close it AND record it done (so it never opens by itself again);
 *   - Finish takes her to the first thing her account still needs (a binder, then an import);
 *   - Settings' Replay opens it again at the first step;
 *   - a call that never reaches the server neither traps her in the tour nor shows her an error.
 */
import { createElement, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/plan",
  unstable_rethrow: () => {},
}));

const finishTutorial = vi.fn();
const loadTutorialNext = vi.fn();
vi.mock("@/app/(ui)/_components/tutorial/actions", () => ({
  finishTutorial: () => finishTutorial(),
  loadTutorialNext: () => loadTutorialNext(),
}));

import { TutorialProvider, ReplayTutorialButton } from "@/app/(ui)/_components/tutorial/Tutorial";
import { TUTORIAL_STEPS } from "@/app/(ui)/_components/tutorial/steps";
import { TopBar } from "@/app/(ui)/_components/TopBar";

function app(startOpen: boolean, extra?: ReactNode) {
  // Children go as arguments (react/no-children-prop); the cast only satisfies the required `children` prop type.
  const props = { startOpen } as { startOpen: boolean; children: ReactNode };
  return render(
    createElement(
      TutorialProvider,
      props,
      createElement(TopBar),
      createElement("main", null, extra ?? null),
    ),
  );
}

const card = () => screen.queryByRole("dialog");
const pointed = () =>
  [...document.querySelectorAll("nav .tab.tour-target")].map((a) => a.getAttribute("href"));

beforeEach(() => {
  push.mockReset();
  finishTutorial.mockReset().mockResolvedValue({ ok: true });
  loadTutorialNext.mockReset().mockResolvedValue("binder");
  window.scrollTo = vi.fn();
});
afterEach(cleanup);

describe("UIL-128 · when the tour opens", () => {
  it("opens by itself for an account that has not seen it, at the welcome", () => {
    app(true);
    expect(within(card()!).getByText(TUTORIAL_STEPS[0].title)).toBeTruthy();
    expect(card()!.textContent).toContain(`Step 1 of ${TUTORIAL_STEPS.length}`);
  });

  it("stays closed for an account that has finished or skipped it", () => {
    app(false);
    expect(card()).toBeNull();
    expect(pointed()).toEqual([]);
  });
});

describe("UIL-128 · stepping through", () => {
  it("Next and Back move one step, and each step points at its tab in the top bar", async () => {
    const user = userEvent.setup();
    app(true);
    expect(pointed()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(card()!.textContent).toContain(TUTORIAL_STEPS[1].title);
    expect(pointed()).toEqual(["/settings"]);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(pointed()).toEqual(["/sync"]);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(card()!.textContent).toContain(TUTORIAL_STEPS[1].title);
    expect(pointed()).toEqual(["/settings"]);
  });

  it("walks the approved order: welcome, Settings, Sync, Haul Plan, Lookup, Lines, Collections + Binders, finish", async () => {
    const user = userEvent.setup();
    app(true);
    const seen: (string | null)[][] = [pointed()];
    for (let i = 1; i < TUTORIAL_STEPS.length; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
      seen.push(pointed());
    }
    expect(seen).toEqual([
      [],
      ["/settings"],
      ["/sync"],
      ["/plan"],
      ["/look"],
      ["/line"],
      ["/coll", "/binders"],
      [],
    ]);
  });

  it("the tour does not block the page under it", async () => {
    const user = userEvent.setup();
    const clicked = vi.fn();
    app(true, createElement("button", { onClick: clicked }, "page button"));
    await user.click(screen.getByRole("button", { name: "page button" }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(card()).not.toBeNull();
  });
});

describe("UIL-128 · leaving the tour records it done", () => {
  it("Skip closes it and records it", async () => {
    const user = userEvent.setup();
    app(true);
    await user.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(card()).toBeNull();
    expect(pointed()).toEqual([]);
    expect(finishTutorial).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it("Escape skips it the same way", async () => {
    const user = userEvent.setup();
    app(true);
    await user.keyboard("{Escape}");
    expect(card()).toBeNull();
    expect(finishTutorial).toHaveBeenCalledOnce();
  });

  it.each([
    ["binder", "Next: add your first binder.", "Add a binder", "/settings"],
    ["import", "Next: import your collection.", "Import", "/sync"],
    ["plan", "Your binders and collection are set up.", "Go to Haul Plan", "/plan"],
  ] as const)(
    "Finish, account needing %s: says so, records it done, and goes there",
    async (next, lead, button, href) => {
      loadTutorialNext.mockResolvedValue(next);
      const user = userEvent.setup();
      app(true);
      for (let i = 1; i < TUTORIAL_STEPS.length; i++) {
        await user.click(screen.getByRole("button", { name: "Next" }));
      }
      expect(card()!.textContent).toContain(lead);
      expect(screen.queryByRole("button", { name: "Skip tour" })).toBeNull();
      await user.click(screen.getByRole("button", { name: button }));
      expect(card()).toBeNull();
      expect(finishTutorial).toHaveBeenCalledOnce();
      expect(push).toHaveBeenCalledWith(href);
    },
  );
});

describe("UIL-128 · Replay from Settings", () => {
  it("opens the tour again at the first step, after it was done", async () => {
    const user = userEvent.setup();
    app(false, createElement(ReplayTutorialButton));
    expect(card()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Replay tutorial" }));
    expect(card()!.textContent).toContain(TUTORIAL_STEPS[0].title);
    expect(finishTutorial).not.toHaveBeenCalled();
  });
});

describe("UIL-128 · a call that never reaches the server", () => {
  it("if her next step cannot be read, Finish is a plain Done that closes the tour in place", async () => {
    loadTutorialNext.mockRejectedValue(new Error("Failed to fetch"));
    const user = userEvent.setup();
    app(true);
    for (let i = 1; i < TUTORIAL_STEPS.length; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(card()).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("if recording it done fails, the tour still closes and nothing is shown", async () => {
    finishTutorial.mockRejectedValue(new Error("Failed to fetch"));
    const user = userEvent.setup();
    app(true);
    await user.click(screen.getByRole("button", { name: "Skip tour" }));
    await Promise.resolve();
    expect(card()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("UIL-128 · never in the way (the UX Dev's review of #414)", () => {
  it("Hide folds the tour to one line that opens the same step again, and records nothing", async () => {
    const user = userEvent.setup();
    app(true);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(card()).toBeNull();
    const pill = screen.getByRole("button", {
      name: `Tour · Step 2 of ${TUTORIAL_STEPS.length} ▸`,
    });
    expect(document.activeElement).toBe(pill);
    expect(pointed()).toEqual(["/settings"]);
    expect(finishTutorial).not.toHaveBeenCalled();

    await user.click(pill);
    expect(card()!.textContent).toContain(TUTORIAL_STEPS[1].title);
  });

  it("while it is open the page is told its height, so its bottom padding clears it; closing takes both away", async () => {
    const user = userEvent.setup();
    const root = document.documentElement;
    app(true);
    expect(root.classList.contains("tour-open")).toBe(true);
    expect(root.style.getPropertyValue("--tour-h")).toMatch(/^\d+px$/);

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(root.classList.contains("tour-open")).toBe(true);

    await user.keyboard("{Escape}");
    expect(root.classList.contains("tour-open")).toBe(false);
    expect(root.style.getPropertyValue("--tour-h")).toBe("");
  });

  it("the welcome says it can be hidden, and replayed from Settings after a skip", () => {
    app(true);
    expect(card()!.textContent).toMatch(/Hide it while you work/);
    expect(card()!.textContent).toMatch(/replay it any time from Settings/);
  });
});
