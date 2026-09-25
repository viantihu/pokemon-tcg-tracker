/**
 * UIL-097 — the two pages a magic link can land on. The login page names a used or expired link in its
 * own words and carries the safety net (`FragmentSignIn`, left alone when there is nothing to finish);
 * /auth/confirm treats a missing fragment as a failed link. Static render: the island's behaviour is
 * pinned in tests/auth/fragment-sign-in.dom.test.ts; this pins that each page mounts it the right way.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/app/login/actions", () => ({ signIn: vi.fn() }));
vi.mock("@/app/auth/confirm/actions", () => ({ completeSignIn: vi.fn() }));

import LoginPage from "@/app/login/page";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("UIL-097 · the pages a magic link lands on", () => {
  it("the login page says a used or expired link in its own words", async () => {
    const html = renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({ error: "expired" }) } as never),
    );
    expect(html).toContain("That sign-in link has already been used or has expired.");
  });

  it("the login page mounts the safety net, and it ignores a page with nothing to finish", () => {
    expect(src("app/login/page.tsx")).toContain('<FragmentSignIn onEmpty="ignore" />');
  });

  it("/auth/confirm mounts it failing closed: no fragment is a failed link", () => {
    expect(src("app/auth/confirm/page.tsx")).toContain('<FragmentSignIn onEmpty="fail" />');
  });
});
