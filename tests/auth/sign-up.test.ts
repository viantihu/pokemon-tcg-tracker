/**
 * UIL-127c — who may get a sign-in link, and a new address becoming an account.
 *
 * Karvi's rulings (2026-09-27): Testing is invite-only until go-live ("Yes, invite only"); Production opens sign-up
 * at launch ("It opens to sign ups when it launches"). The Tech Lead's conditions: D1, a bot check in open mode;
 * D2, a malformed address refused before any check, in today's words; D3, an unset or unknown mode is invite.
 *
 * The real allow-list and mode are used here (only Supabase and Next's request plumbing are stubbed), with the
 * environment set per case, so what is tested is what the deployment reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const otp = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signInWithOtp: otp } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {} }) }));
vi.mock("next/headers", () => ({
  headers: async () => new Map([["host", "localhost:3000"]]),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};

/** Load the sign-in action fresh under `env` (the env is parsed once and cached, and publicEnv at load). */
async function signInWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(k, v as string);
  const { signIn } = await import("@/app/login/actions");
  const messages = await import("@/app/login/messages");
  return { signIn, messages };
}

const form = (email: string, token?: string) => {
  const f = new FormData();
  f.set("email", email);
  if (token !== undefined) f.set("cf-turnstile-response", token);
  return f;
};
const idle = { status: "idle" } as const;

beforeEach(() => {
  otp.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UIL-127c · D3: the mode fails closed", () => {
  it("only the exact value 'open' opens sign-up; unset, empty, a typo or another case is invite", async () => {
    const { parseSignupMode } = await import("@/lib/auth/signup-mode");
    expect(parseSignupMode("open")).toBe("open");
    for (const raw of [undefined, "", "invite", "OPEN", "Open", "opne", " open"]) {
      expect(parseSignupMode(raw), String(raw)).toBe("invite");
    }
  });

  it("with SIGNUP_MODE unset, a stranger is refused", async () => {
    const { signIn } = await signInWith({
      SIGNUP_MODE: undefined,
      ALLOWED_OWNER_EMAIL: "owner@example.com",
    });
    expect(await signIn(idle, form("stranger@example.com"))).toEqual({
      status: "error",
      message: "That email is not authorised for this binder.",
    });
    expect(otp).not.toHaveBeenCalled();
  });
});

describe("UIL-127c · invite mode (Testing until go-live)", () => {
  const INVITE = {
    SIGNUP_MODE: "invite",
    ALLOWED_OWNER_EMAIL: "owner@example.com",
    ALLOWED_EMAILS: "spare@example.com, Second@Example.com",
  };

  it("the owner, and every listed address in any case, gets a link that creates the account if it is new", async () => {
    const { signIn } = await signInWith(INVITE);
    for (const email of [
      "owner@example.com",
      "spare@example.com",
      "second@example.com",
      "SPARE@example.com",
    ]) {
      expect(await signIn(idle, form(email))).toEqual({ status: "sent", email });
    }
    for (const [arg] of otp.mock.calls) expect(arg.options.shouldCreateUser).toBe(true);
  });

  it("a stranger is refused in exactly today's words (the deploy smoke's probe), before any Supabase call", async () => {
    const { signIn } = await signInWith(INVITE);
    expect(await signIn(idle, form("stranger@example.com"))).toEqual({
      status: "error",
      message: "That email is not authorised for this binder.",
    });
    expect(otp).not.toHaveBeenCalled();
  });

  it("an empty list with no owner lets no one in", async () => {
    const { signIn } = await signInWith({
      SIGNUP_MODE: "invite",
      ALLOWED_OWNER_EMAIL: "",
      ALLOWED_EMAILS: " , ",
    });
    expect((await signIn(idle, form("owner@example.com"))).status).toBe("error");
    expect(otp).not.toHaveBeenCalled();
  });
});

describe("UIL-127c · open mode (Production at launch)", () => {
  it("any valid address gets a link, and the first one creates the account; the answer does not say which", async () => {
    const { signIn } = await signInWith({
      SIGNUP_MODE: "open",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
    });
    expect(await signIn(idle, form("new.person@example.com"))).toEqual({
      status: "sent",
      email: "new.person@example.com",
    });
    expect(otp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "new.person@example.com",
        options: expect.objectContaining({ shouldCreateUser: true }),
      }),
    );
  });

  it("D2: a malformed address is refused FIRST, in today's words, before the bot check or any Supabase call", async () => {
    const { signIn } = await signInWith({
      SIGNUP_MODE: "open",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key",
    });
    expect(await signIn(idle, form("not-an-email"))).toEqual({
      status: "error",
      message: "Enter a valid email address.",
    });
    expect(otp).not.toHaveBeenCalled();
  });

  it("D1: with the bot check on, no token is refused in her words, and no link is requested", async () => {
    const { signIn, messages } = await signInWith({
      SIGNUP_MODE: "open",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key",
    });
    expect(await signIn(idle, form("new.person@example.com"))).toEqual({
      status: "error",
      message: messages.CAPTCHA_NEEDED,
    });
    expect(otp).not.toHaveBeenCalled();
  });

  it("D1: the token goes to Supabase with the request", async () => {
    const { signIn } = await signInWith({
      SIGNUP_MODE: "open",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key",
    });
    await signIn(idle, form("new.person@example.com", "turnstile-token"));
    expect(otp.mock.calls[0][0].options.captchaToken).toBe("turnstile-token");
  });

  it("D1: when Supabase refuses the check, she reads our words, never Supabase's", async () => {
    otp.mockResolvedValue({
      error: {
        status: 400,
        code: "captcha_failed",
        message: "captcha protection: request disallowed",
      },
    });
    const { signIn, messages } = await signInWith({
      SIGNUP_MODE: "open",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key",
    });
    const res = await signIn(idle, form("new.person@example.com", "stale-token"));
    expect(res).toEqual({ status: "error", message: messages.CAPTCHA_NEEDED });
  });
});
