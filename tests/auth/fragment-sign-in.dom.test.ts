// @vitest-environment jsdom
/**
 * UIL-097 — finishing a magic-link sign-in in any browser, driven through the real `FragmentSignIn` in a
 * DOM. The Senior BA's conditions, each pinned here:
 *   - the fragment is WIPED from the address bar BEFORE any network call (the server action is the only
 *     one this component makes; there is no analytics in the app, and a fragment is never in a request);
 *   - nothing logs, displays or reports a token;
 *   - only a fragment carrying BOTH tokens, or a Supabase error, is acted on; anything else is left alone.
 */
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const replace = vi.fn((to: string) => calls.push(`navigate ${to}`));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const completeSignIn = vi.fn();
vi.mock("@/app/auth/confirm/actions", () => ({
  completeSignIn: (...args: unknown[]) => {
    calls.push("network completeSignIn");
    return completeSignIn(...args);
  },
}));

import { FragmentSignIn } from "@/app/auth/confirm/FragmentSignIn";

const AT = "eyJhbGciOiJIUzI1NiJ9.SECRET-ACCESS.sig";
const RT = "SECRET-REFRESH-7c1d";
const SESSION = `#access_token=${AT}&refresh_token=${RT}&expires_in=3600&token_type=bearer&type=magiclink`;

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  calls.length = 0;
  replace.mockClear();
  completeSignIn.mockReset();
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Land on `path` with `hash`, as the verify redirect does, and only THEN start recording `replaceState`, so
 * the one recorded call is the component's wipe.
 */
let wipeSpy: { mockRestore: () => void } | null = null;
function land(path: string, hash: string) {
  wipeSpy?.mockRestore();
  window.history.replaceState(null, "", `${path}${hash}`);
  const real = window.history.replaceState.bind(window.history);
  wipeSpy = vi.spyOn(window.history, "replaceState").mockImplementation((...args) => {
    calls.push(`wipe -> ${String(args[2])}`);
    real(...args);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("UIL-097 · a magic link finishes in any browser", () => {
  it("wipes the fragment BEFORE the network call, then signs in and goes to the app", async () => {
    completeSignIn.mockResolvedValue({ ok: true });
    land("/auth/confirm", SESSION);
    render(createElement(FragmentSignIn, { onEmpty: "fail" }));
    await settle();

    expect(calls).toEqual(["wipe -> /auth/confirm", "network completeSignIn", "navigate /plan"]);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("SECRET");
    expect(completeSignIn).toHaveBeenCalledWith(AT, RT);
  });

  it("a session the server refuses goes to /login with a fixed code, and no token anywhere", async () => {
    completeSignIn.mockResolvedValue({ ok: false, error: "forbidden" });
    land("/auth/confirm", SESSION);
    const { container } = render(createElement(FragmentSignIn, { onEmpty: "fail" }));
    await settle();

    expect(replace).toHaveBeenCalledWith("/login?error=forbidden");
    expect(container.innerHTML).not.toContain("SECRET");
    expect(replace.mock.calls.flat().join(" ")).not.toContain("SECRET");
  });

  it("a network failure is a plain auth error — the error text is never shown or sent on", async () => {
    completeSignIn.mockRejectedValue(new Error(`boom ${AT}`));
    land("/auth/confirm", SESSION);
    render(createElement(FragmentSignIn, { onEmpty: "fail" }));
    await settle();
    expect(replace).toHaveBeenCalledWith("/login?error=auth");
  });

  it("Supabase's error (a used or expired link) is wiped and read as 'expired', with no network call", async () => {
    land("/auth/confirm", "#error=access_denied&error_code=otp_expired&error_description=gone");
    render(createElement(FragmentSignIn, { onEmpty: "fail" }));
    await settle();
    expect(calls).toEqual(["wipe -> /auth/confirm", "navigate /login?error=expired"]);
  });

  it("on /auth/confirm, no fragment at all is a failed link", async () => {
    land("/auth/confirm", "");
    render(createElement(FragmentSignIn, { onEmpty: "fail" }));
    await settle();
    expect(calls).toEqual(["navigate /login?error=auth"]);
  });

  it("the login-page safety net finishes a link that fell back to the Site URL", async () => {
    completeSignIn.mockResolvedValue({ ok: true });
    land("/login", SESSION);
    render(createElement(FragmentSignIn, { onEmpty: "ignore" }));
    await settle();
    expect(calls).toEqual(["wipe -> /login", "network completeSignIn", "navigate /plan"]);
  });

  it("…and leaves every other fragment ALONE: one token only, or an ordinary anchor", async () => {
    for (const hash of [`#access_token=${AT}`, "#section-2", ""]) {
      calls.length = 0;
      land("/login", hash);
      render(createElement(FragmentSignIn, { onEmpty: "ignore" }));
      await settle();
      cleanup();
      expect(calls).toEqual([]);
    }
    expect(completeSignIn).not.toHaveBeenCalled();
  });

  it("nothing is ever written to the console", async () => {
    completeSignIn.mockResolvedValue({ ok: false, error: "auth" });
    land("/auth/confirm", SESSION);
    render(createElement(FragmentSignIn, { onEmpty: "fail" }));
    await settle();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
