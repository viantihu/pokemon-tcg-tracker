/**
 * `errorMessage` — the thing that stops a failure from reporting itself as "[object Object]".
 *
 * The case that motivated it is the first one below: supabase-js rejects with a `PostgrestError`,
 * which is a plain object rather than an `Error`, so the usual
 * `err instanceof Error ? err.message : String(err)` idiom threw away every DB failure's message
 * across the whole app. A catalog-mirror run really did report
 * `{"ok":false,"error":"[object Object]"}` and left the cause unrecoverable.
 */
import { describe, expect, it } from "vitest";
import { errorMessage } from "@/lib/errors";

describe("errorMessage", () => {
  it("reads a PostgrestError — a plain object, NOT an Error instance", () => {
    const postgrest = {
      message: "function public.apply_write_ops(payload => jsonb) does not exist",
      details: null,
      hint: "No function matches the given name and argument types.",
      code: "42883",
    };
    // The bug this replaces:
    expect(postgrest instanceof Error).toBe(false);
    expect(String(postgrest)).toBe("[object Object]");

    const msg = errorMessage(postgrest);
    expect(msg).toContain("apply_write_ops");
    expect(msg).toContain("42883"); // the code is usually what identifies the fault
    expect(msg).toContain("No function matches");
    expect(msg).not.toContain("[object Object]");
  });

  it("omits absent Postgres detail fields rather than printing empty ones", () => {
    expect(errorMessage({ message: "row-level security policy violation" })).toBe(
      "row-level security policy violation",
    );
    expect(errorMessage({ message: "boom", details: null, hint: "", code: "  " })).toBe("boom");
  });

  it("uses an Error's message, and surfaces a wrapped cause", () => {
    expect(errorMessage(new Error("plain failure"))).toBe("plain failure");
    const wrapped = new Error("upsert failed", {
      cause: { message: "duplicate key", code: "23505" },
    });
    const msg = errorMessage(wrapped);
    expect(msg).toContain("upsert failed");
    expect(msg).toContain("duplicate key");
    expect(msg).toContain("23505");
  });

  it("does not repeat a cause already quoted in the outer message", () => {
    const wrapped = new Error("failed: duplicate key", { cause: new Error("duplicate key") });
    expect(errorMessage(wrapped)).toBe("failed: duplicate key");
  });

  it("falls back to an Error's name when the message is empty", () => {
    expect(errorMessage(new TypeError())).toBe("TypeError");
  });

  it("passes a non-empty string straight through", () => {
    expect(errorMessage("unauthorized")).toBe("unauthorized");
  });

  it("shows the structure of an object with no message rather than [object Object]", () => {
    expect(errorMessage({ status: 502, url: "/api/catalog/sync" })).toBe(
      '{"status":502,"url":"/api/catalog/sync"}',
    );
  });

  it("never throws, and never returns an empty string", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const v of [undefined, null, "", 0, false, circular, Symbol("x"), () => {}]) {
      const msg = errorMessage(v);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toBe("[object Object]");
    }
  });
});
