/**
 * UIL-097 — the two server halves of a magic-link sign-in that works in any browser.
 *
 * `signIn` must request the link in the IMPLICIT flow, pointed at /auth/confirm, still only for the one
 * allow-listed email, and must turn Supabase's hourly email limit into words she can act on.
 * `completeSignIn` is a Server Function, reachable by a direct POST, so it re-checks everything itself:
 * Supabase validates the tokens, the session's user must be the owner, anything else is signed out — and
 * nothing it returns or logs carries a token.
 *
 * No live Supabase here: both clients are doubles, which is why her iPad test is the verification of the
 * real round trip. What these pin is what this code ASKS Supabase for, and what it does with each answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const otp = vi.fn();
const createJsClient = vi.fn((..._args: unknown[]) => ({ auth: { signInWithOtp: otp } }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...a: unknown[]) => createJsClient(...a),
}));

const calls: string[] = [];
const track =
  (name: string, fn: (...a: unknown[]) => unknown) =>
  (...a: unknown[]) => {
    calls.push(name);
    return fn(...a);
  };
const setSession = vi.fn();
const getUser = vi.fn();
const signOut = vi.fn();
const refreshSession = vi.fn();
const ssr = {
  setSession: track("setSession", setSession),
  getUser: track("getUser", getUser),
  signOut: track("signOut", signOut),
  refreshSession: track("refreshSession", refreshSession),
  signInWithOtp: vi.fn(),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: ssr }) }));

const allowed = vi.fn((email: string | null | undefined) => email === "owner@example.com");
vi.mock("@/lib/auth/allowlist", () => ({ isAllowedEmail: (e: string) => allowed(e) }));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Map([
      ["x-forwarded-host", "pokemon-tcg-tracker-git-develop.vercel.app"],
      ["x-forwarded-proto", "https"],
    ]),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { RATE_LIMITED, signIn } from "@/app/login/actions";
import { completeSignIn } from "@/app/auth/confirm/actions";

const form = (email: string) => {
  const f = new FormData();
  f.set("email", email);
  return f;
};
const AT = "SECRET-ACCESS";
const RT = "SECRET-REFRESH";

const OWNER_USER = { data: { user: { email: "owner@example.com" } } };
const NOBODY = { data: { user: null } };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  otp.mockResolvedValue({ error: null });
  setSession.mockResolvedValue({ error: null });
  // Signed out when the link is opened (the usual case); the owner once the link's session is set.
  getUser.mockReset().mockResolvedValueOnce(NOBODY).mockResolvedValue(OWNER_USER);
  signOut.mockResolvedValue({ error: null });
  refreshSession.mockResolvedValue({ error: null });
});

describe("UIL-097 · signIn requests a link any browser can finish", () => {
  it("uses an IMPLICIT-flow client that keeps no session, not the PKCE SSR client", async () => {
    const res = await signIn({ status: "idle" }, form("owner@example.com"));

    expect(res).toEqual({ status: "sent", email: "owner@example.com" });
    const opts = createJsClient.mock.calls[0][2] as { auth: Record<string, unknown> };
    expect(opts.auth).toMatchObject({
      flowType: "implicit",
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
    // The cookie-bound PKCE client is not the one asking (that is what failed in the Gmail app).
    expect(ssr.signInWithOtp).not.toHaveBeenCalled();
  });

  it("points the link at /auth/confirm on this deployment's own origin", async () => {
    await signIn({ status: "idle" }, form("owner@example.com"));
    expect(otp).toHaveBeenCalledWith({
      email: "owner@example.com",
      options: {
        emailRedirectTo: "https://pokemon-tcg-tracker-git-develop.vercel.app/auth/confirm",
        shouldCreateUser: true,
      },
    });
  });

  it("still sends nothing to an address that is not the owner's", async () => {
    const res = await signIn({ status: "idle" }, form("someone@else.com"));
    expect(res.status).toBe("error");
    expect(otp).not.toHaveBeenCalled();
  });

  it("the hourly email limit reads as words she can act on, not Supabase's message", async () => {
    otp.mockResolvedValue({
      error: {
        status: 429,
        code: "over_email_send_rate_limit",
        message: "email rate limit exceeded",
      },
    });
    expect(await signIn({ status: "idle" }, form("owner@example.com"))).toEqual({
      status: "error",
      message: RATE_LIMITED,
    });
    expect(RATE_LIMITED).toMatch(/resets on the hour/);
  });

  it("…whether Supabase says so by status or only by code", async () => {
    otp.mockResolvedValue({
      error: { status: 400, code: "over_email_send_rate_limit", message: "x" },
    });
    expect((await signIn({ status: "idle" }, form("owner@example.com"))).status).toBe("error");
    expect(await signIn({ status: "idle" }, form("owner@example.com"))).toMatchObject({
      message: RATE_LIMITED,
    });
  });
});

describe("UIL-097 · completeSignIn validates, enforces the owner, and echoes nothing", () => {
  it("hands both tokens to Supabase, checks the owner, ROTATES, and only then reports success", async () => {
    expect(await completeSignIn(AT, RT)).toEqual({ ok: true });
    expect(setSession).toHaveBeenCalledWith({ access_token: AT, refresh_token: RT });
    // R1 (Tech Lead's review): the rotation comes after the allow-list read, before success, so the
    // refresh token that travelled in the URL is burned instead of left live in a browser's history.
    expect(calls).toEqual(["getUser", "setSession", "getUser", "refreshSession"]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("R1: a session that cannot rotate is not kept — signed out, plain auth error", async () => {
    refreshSession.mockResolvedValue({ error: { message: `refresh failed ${RT}` } });
    const res = await completeSignIn(AT, RT);
    expect(res).toEqual({ ok: false, error: "auth" });
    expect(signOut).toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  it("R2: already signed in as the owner, a link touches NOTHING — so a crafted link cannot sign her out", async () => {
    getUser.mockReset().mockResolvedValue(OWNER_USER);
    expect(await completeSignIn(AT, RT)).toEqual({ ok: true });
    expect(calls).toEqual(["getUser"]);
    expect(setSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("R2 is only for the OWNER: another account's session is replaced as before", async () => {
    getUser
      .mockReset()
      .mockResolvedValueOnce({ data: { user: { email: "someone@else.com" } } })
      .mockResolvedValue(OWNER_USER);
    expect(await completeSignIn(AT, RT)).toEqual({ ok: true });
    expect(setSession).toHaveBeenCalled();
  });

  it("a session for anyone but the owner is signed out at once and refused, and never rotated", async () => {
    getUser
      .mockReset()
      .mockResolvedValueOnce(NOBODY)
      .mockResolvedValue({ data: { user: { email: "someone@else.com" } } });
    expect(await completeSignIn(AT, RT)).toEqual({ ok: false, error: "forbidden" });
    expect(signOut).toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("tokens Supabase rejects are a plain auth error, never Supabase's message", async () => {
    setSession.mockResolvedValue({ error: { message: `Invalid JWT ${AT}` } });
    const res = await completeSignIn(AT, RT);
    expect(res).toEqual({ ok: false, error: "auth" });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(calls).toEqual(["getUser", "setSession"]); // the owner check after it never ran
  });

  it("anything but two non-empty strings is refused before Supabase is asked", async () => {
    for (const [a, r] of [
      ["", RT],
      [AT, ""],
      [undefined, RT],
      [AT, { x: 1 }],
    ] as const) {
      expect(await completeSignIn(a, r)).toEqual({ ok: false, error: "auth" });
    }
    expect(setSession).not.toHaveBeenCalled();
  });

  it("writes nothing to the console on any path", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await completeSignIn(AT, RT);
    getUser.mockResolvedValue({ data: { user: { email: "someone@else.com" } } });
    await completeSignIn(AT, RT);
    setSession.mockResolvedValue({ error: { message: "bad" } });
    await completeSignIn(AT, RT);
    setSession.mockResolvedValue({ error: null });
    getUser.mockReset().mockResolvedValueOnce(NOBODY).mockResolvedValue(OWNER_USER);
    refreshSession.mockResolvedValue({ error: { message: "rotate failed" } });
    await completeSignIn(AT, RT);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
