/**
 * UIL-128 — the `(ui)` layout opens the tutorial by itself exactly when the account has not finished or skipped it,
 * and a failed read never opens it or breaks the page (the app can deploy before 0031 applies). The real layout is
 * rendered with the session and the repo read stubbed.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/plan",
  unstable_rethrow: () => {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "new@example.com" } } }) },
  }),
}));

const tutorialDone = vi.fn();
vi.mock("@/lib/repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo")>()),
  onboardingRepo: { tutorialDone: () => tutorialDone() },
}));

import UiLayout from "@/app/(ui)/layout";

async function page(): Promise<string> {
  const el = (await UiLayout({ children: "screen" } as never)) as ReactElement;
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  tutorialDone.mockReset();
});

describe("UIL-128 · the layout decides whether the tour opens", () => {
  it("an account that has not seen it gets the tour, over the screen", async () => {
    tutorialDone.mockResolvedValue(false);
    const html = await page();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("screen");
  });

  it("an account that has finished or skipped it does not", async () => {
    tutorialDone.mockResolvedValue(true);
    expect(await page()).not.toContain('role="dialog"');
  });

  it("a read that fails counts as done: no tour, and the page still renders", async () => {
    tutorialDone.mockRejectedValue(new Error('relation "onboarding" does not exist'));
    const html = await page();
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("screen");
  });
});
