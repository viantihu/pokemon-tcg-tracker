/**
 * UIL-035 (third site) — the rule the old `catch { setNotFound(true) }` broke, pinned as a function:
 * a failed lookup and an empty lookup are different states, and only the empty one says NO MATCH.
 */
import { describe, expect, it } from "vitest";
import { lookupViewFrom } from "@/app/(ui)/look/lookup-state";
import type { LookupAnswer } from "@/lib/surfaces";

const ANSWER = { card: { name: "Charmeleon" } } as unknown as LookupAnswer;

describe("UIL-035 · failure is not 'not found'", () => {
  it("a failed lookup carries its message and is NOT a miss", () => {
    const v = lookupViewFrom({ ok: false, error: "Could not reach the database" });
    expect(v).toEqual({
      answer: null,
      copies: [],
      notFound: false,
      failed: "Could not reach the database",
    });
  });

  it("an empty successful lookup is the ONLY thing that is a miss", () => {
    expect(lookupViewFrom({ ok: true, answer: null, copies: [] })).toEqual({
      answer: null,
      copies: [],
      notFound: true,
      failed: null,
    });
  });

  it("a found card is neither", () => {
    const copies = [
      {
        copyId: "c1",
        role: "bulk" as const,
        currentLabel: "Bulk box (not shelved)",
      },
    ];
    expect(lookupViewFrom({ ok: true, answer: ANSWER, copies })).toEqual({
      answer: ANSWER,
      copies,
      notFound: false,
      failed: null,
    });
  });
});
