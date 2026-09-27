/**
 * The first-run tutorial's words and the nav tabs each step points at (UIL-128). Karvi approved this order on
 * 2026-09-27 ("That is sufficient"): it follows the order a new account has to work in, since nothing can be
 * placed until a binder exists and a collection is imported. All of the tutorial's text lives here, so the
 * branding overhaul changes it in one place.
 */

export interface TutorialStep {
  title: string;
  body: string;
  /** Nav tab hrefs this step points at (highlighted in the top bar). Empty for the welcome and the finish. */
  targets: readonly string[];
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    title: "Welcome to Binder Ops",
    body:
      "This app tells you where every card goes: which binder, which half, and which evolution line. " +
      "This tour shows you each part of the app.",
    targets: [],
  },
  {
    title: "Start with your binder",
    body:
      "Add each binder you own in Settings: how many pages, how many pockets per page, and where the back " +
      "half starts. Cards can't be placed until a binder exists.",
    targets: ["/settings"],
  },
  {
    title: "Import your collection",
    body:
      "Export your collection from Dex as a CSV and import it on Sync. You see what will change before " +
      "anything does, and you can undo an import.",
    targets: ["/sync"],
  },
  {
    title: "Place new cards",
    body:
      "After an import, Haul Plan lists every card waiting to be shelved and where each one goes. Check " +
      "them off as you put them in the binder.",
    targets: ["/plan"],
  },
  {
    title: "Find any card",
    body:
      "Search for a card on Lookup to see where your copies are, and whether it is in a line, a " +
      "collection or on your wishlist.",
    targets: ["/look"],
  },
  {
    title: "Follow your evolution lines",
    body:
      "The back half of a binder holds evolution lines. Lines shows how far along each one is, which " +
      "slots are still empty, and anything waiting on your decision.",
    targets: ["/line"],
  },
  {
    title: "Collections and binders",
    body:
      "Collections tracks the sets you are completing and your wishlist. Binders shows how full each " +
      "binder is and whether there is room for a new line.",
    targets: ["/coll", "/binders"],
  },
  {
    title: "You're ready",
    body: "You can replay this tour any time from Settings.",
    targets: [],
  },
];

/** Where the finish button takes her: the first thing her account still needs. */
export type TutorialNext = "binder" | "import" | "plan";

export const TUTORIAL_NEXT: Record<TutorialNext, { lead: string; button: string; href: string }> = {
  binder: { lead: "Next: add your first binder.", button: "Add a binder", href: "/settings" },
  import: { lead: "Next: import your collection.", button: "Import", href: "/sync" },
  plan: {
    lead: "Your binders and collection are set up.",
    button: "Go to Haul Plan",
    href: "/plan",
  },
};

export const TUTORIAL_BUTTONS = {
  back: "Back",
  next: "Next",
  skip: "Skip tour",
  /** The finish button before her next step is known (or when it could not be read). */
  done: "Done",
  replay: "Replay tutorial",
} as const;

/** "Step 2 of 8". */
export function tutorialCounter(step: number, total: number): string {
  return `Step ${step + 1} of ${total}`;
}
