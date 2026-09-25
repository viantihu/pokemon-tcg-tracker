/** UIL-097 R2b — reading a token's `session_id` only to compare it. */
import { describe, expect, it } from "vitest";
import { sessionIdOf } from "@/lib/auth/session-id";

const jwt = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("sessionIdOf", () => {
  it("reads the claim", () => {
    expect(sessionIdOf(jwt({ session_id: "abc", sub: "u" }))).toBe("abc");
  });
  it("is null for anything it cannot read, never a guess", () => {
    for (const t of [
      null,
      undefined,
      "",
      "not-a-jwt",
      "h..s",
      "h.%%%.s",
      jwt({}),
      jwt({ session_id: "" }),
      jwt({ session_id: 7 }),
      jwt(null),
    ]) {
      expect(sessionIdOf(t as string)).toBeNull();
    }
  });
});
