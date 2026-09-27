/**
 * UIL-127c — the sign-in screen says what this environment allows. Rendered for real (static markup), with the
 * environment set per case.
 *
 *   invite (Testing until go-live): today's words, "Owner email", no bot check.
 *   open (Production at launch): "Enter your email to sign in or create an account.", and the Turnstile check
 *   where a site key is set (the Tech Lead's D1), so the token travels with the form.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/app/login/actions", () => ({ signIn: vi.fn() }));
vi.mock("@/app/auth/confirm/actions", () => ({ completeSignIn: vi.fn() }));

async function page(env: Record<string, string>): Promise<string> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { default: LoginPage } = await import("@/app/login/page");
  const el = (await LoginPage({ searchParams: Promise.resolve({}) } as never)) as ReactElement;
  return renderToStaticMarkup(el);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UIL-127c · the sign-in screen, by mode", () => {
  it("invite: today's words, and no bot check even with a site key set", async () => {
    const html = await page({ SIGNUP_MODE: "invite", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key" });
    expect(html).toContain("This binder is private. Enter the owner email");
    expect(html).toContain("Owner email");
    expect(html).not.toContain("cf-turnstile");
  });

  it("open: says an account is created, and labels the field Email", async () => {
    const html = await page({ SIGNUP_MODE: "open", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "" });
    expect(html).toContain("Enter your email to sign in or create an account.");
    expect(html).toContain(">Email<");
    expect(html).not.toContain("cf-turnstile");
  });

  it("open with a site key: the Turnstile check sits in the form, keyed to it", async () => {
    const html = await page({
      SIGNUP_MODE: "open",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAA-site-key",
    });
    expect(html).toMatch(
      /<form[\s\S]*class="cf-turnstile" data-sitekey="0x4AAA-site-key"[\s\S]*<\/form>/,
    );
  });
});
