/**
 * UIL-097 — what a magic link's fragment is allowed to make the app do. The Senior BA's ruling: act ONLY on
 * a fragment carrying BOTH tokens, or a Supabase error; leave anything else alone; keep an error's code,
 * never its text.
 */
import { describe, expect, it } from "vitest";
import { parseAuthFragment } from "@/lib/auth/fragment";

describe("parseAuthFragment", () => {
  it("a session needs BOTH tokens", () => {
    expect(
      parseAuthFragment("#access_token=AT&refresh_token=RT&expires_in=3600&type=magiclink"),
    ).toEqual({
      kind: "session",
      accessToken: "AT",
      refreshToken: "RT",
    });
    expect(parseAuthFragment("#access_token=AT")).toEqual({ kind: "none" });
    expect(parseAuthFragment("#refresh_token=RT")).toEqual({ kind: "none" });
    expect(parseAuthFragment("#access_token=&refresh_token=RT")).toEqual({ kind: "none" });
  });

  it("Supabase's error keeps its code and drops its description", () => {
    const f = parseAuthFragment(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid",
    );
    expect(f).toEqual({ kind: "error", code: "otp_expired" });
    expect(JSON.stringify(f)).not.toContain("Email");
    expect(parseAuthFragment("#error=access_denied")).toEqual({
      kind: "error",
      code: "access_denied",
    });
  });

  it("anything else is left alone — an ordinary anchor, an empty hash, no hash", () => {
    expect(parseAuthFragment("#section-2")).toEqual({ kind: "none" });
    expect(parseAuthFragment("#")).toEqual({ kind: "none" });
    expect(parseAuthFragment("")).toEqual({ kind: "none" });
  });
});
