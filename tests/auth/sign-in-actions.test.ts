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
/** The throwaway client R2b uses to revoke a link's session (never her cookies). */
const throwaway = {
  setSession: vi.fn(),
  signOut: vi.fn(),
  refreshSession: vi.fn(),
};
const createJsClient = vi.fn((..._args: unknown[]) => ({
  auth: { signInWithOtp: otp, ...throwaway },
}));
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
const getSession = vi.fn();
const ssr = {
  getSession: track("getSession", getSession),
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
/** `after()` runs its callback once the response is sent; here it runs at once, and is awaited by `flush`. */
const scheduled: Promise<unknown>[] = [];
const after = vi.fn((fn: () => unknown) => {
  scheduled.push(Promise.resolve().then(fn));
});
vi.mock("next/server", () => ({ after: (fn: () => unknown) => after(fn) }));
const flush = () => Promise.all(scheduled.splice(0));

import { signIn } from "@/app/login/actions";
import { RATE_LIMITED } from "@/app/login/messages";
import { completeSignIn } from "@/app/auth/confirm/actions";

const form = (email: string) => {
  const f = new FormData();
  f.set("email", email);
  return f;
};
const AT = "SECRET-ACCESS";
const RT = "SECRET-REFRESH";

const OWNER_USER = { data: { user: { email: "owner@example.com" } } };
/** A JWT-shaped access token carrying `session_id` (the payload is all R2b reads). */
const jwt = (sessionId: string) =>
  `h.${Buffer.from(JSON.stringify({ session_id: sessionId, sub: "u" })).toString("base64url")}.sig`;
const HERS = jwt("session-hers");
const SECOND = jwt("session-second-link");
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
  getSession.mockResolvedValue({ data: { session: { access_token: HERS } } });
  throwaway.setSession.mockImplementation(async (s: { access_token: string }) => ({
    data: { session: { access_token: s.access_token } },
    error: null,
  }));
  throwaway.signOut.mockResolvedValue({ error: null });
  throwaway.refreshSession.mockResolvedValue({ error: null });
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

  it("R2: already signed in as the owner, her session is never touched — so a crafted link cannot sign her out", async () => {
    getUser.mockReset().mockResolvedValue(OWNER_USER);
    expect(await completeSignIn(SECOND, RT)).toEqual({ ok: true });
    expect(calls).toEqual(["getUser", "getSession"]);
    expect(setSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("R2b: a SECOND link's session is revoked on a throwaway client, locally, with no refresh", async () => {
    getUser.mockReset().mockResolvedValue(OWNER_USER);
    expect(await completeSignIn(SECOND, RT)).toEqual({ ok: true });
    // Scheduled with after(): her sign-in returned before the revoke ran.
    expect(after).toHaveBeenCalledTimes(1);
    expect(throwaway.signOut).not.toHaveBeenCalled();
    await flush();
    expect(throwaway.setSession).toHaveBeenCalledWith({ access_token: SECOND, refresh_token: RT });
    expect(throwaway.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(throwaway.refreshSession).not.toHaveBeenCalled();
    // A client that keeps nothing: it can only ever hold the link's session.
    const opts = createJsClient.mock.calls.at(-1)![2] as { auth: Record<string, unknown> };
    expect(opts.auth).toMatchObject({ persistSession: false, autoRefreshToken: false });
  });

  it("R2b: a replay of HER OWN link (same session) is left alone — R1 already burned it", async () => {
    getUser.mockReset().mockResolvedValue(OWNER_USER);
    expect(await completeSignIn(HERS, RT)).toEqual({ ok: true });
    await flush();
    expect(createJsClient).not.toHaveBeenCalled();
    expect(throwaway.signOut).not.toHaveBeenCalled();
  });

  it("R2b: when either session id cannot be read, nothing is revoked (it might be hers)", async () => {
    getUser.mockReset().mockResolvedValue(OWNER_USER);
    getSession.mockResolvedValue({ data: { session: null } });
    await completeSignIn(SECOND, RT);
    getSession.mockResolvedValue({ data: { session: { access_token: HERS } } });
    await completeSignIn("not-a-jwt", RT);
    await flush();
    expect(throwaway.signOut).not.toHaveBeenCalled();
  });

  it("R2b: re-checked on the session Supabase hands back — if THAT is hers, nothing is revoked", async () => {
    // The URL claims another session, but the pair Supabase verified or refreshed turns out to be hers.
    getUser.mockReset().mockResolvedValue(OWNER_USER);
    throwaway.setSession.mockResolvedValue({
      data: { session: { access_token: HERS } },
      error: null,
    });
    await completeSignIn(SECOND, RT);
    await flush();
    expect(throwaway.signOut).not.toHaveBeenCalled();
  });

  it("R2b: a link Supabase rejects is not signed out, and her sign-in still stands, silently", async () => {
    getUser.mockReset().mockResolvedValue(OWNER_USER);
    throwaway.setSession.mockResolvedValue({ error: { message: `bad ${SECOND}` } });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    expect(await completeSignIn(SECOND, RT)).toEqual({ ok: true });
    await flush();
    expect(throwaway.signOut).not.toHaveBeenCalled();
    throwaway.setSession.mockRejectedValue(new Error("network"));
    expect(await completeSignIn(SECOND, RT)).toEqual({ ok: true });
    await flush();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
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
