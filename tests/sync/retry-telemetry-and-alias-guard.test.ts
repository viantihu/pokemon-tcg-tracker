/**
 * UIL-046 — a retry sweep records that it happened, even when nothing resolves.
 * UIL-047 C3 — a manual match never teaches a set alias across locales.
 *
 * Two separate fixes, one file, because both are about the sync queue telling her the truth.
 *
 * UIL-046 was never a broken self-heal. An entry that becomes resolvable IS promoted, on the retry path
 * and on a full import. What was missing was the EVIDENCE: nothing stamped `last_retry_sync` or bumped
 * `retry_count` on a row that stayed waiting, so the queue promised "self-heals when the catalog catches
 * up" while showing every waiting row as never retried, forever. Kept promise, absent evidence — from her
 * side indistinguishable from a dead feature.
 *
 * UIL-047 C3 is the dangerous one. `catalog_card` has NO locale column and the mirror is English-only, so
 * every card the picker can offer is an English printing. Learning `ja:<jp code> → <english set>` points a
 * Japanese set code at an English set BY CONSTRUCTION, and every later Japanese row of that set then
 * resolves to whichever English card shares the collector number — a confident wrong MATCH, not a miss.
 * It has already happened on her data (`ja:m6 → swshp`), and with no delete path for `set_alias` one
 * uncertain match is permanent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const EXEC = readFileSync(path.join(process.cwd(), "lib/sync/exec.ts"), "utf8");
const ACTIONS = readFileSync(path.join(process.cwd(), "app/(ui)/sync/actions.ts"), "utf8");

describe("UIL-047 C3 · the alias guard", () => {
  it("refuses to learn an alias for a non-English entry", () => {
    // The guard is a positive check on `locale !== "en"`, ahead of the upsert.
    expect(EXEC).toContain('if (locale !== "en")');
    const guardIdx = EXEC.indexOf('if (locale !== "en")');
    const upsertIdx = EXEC.indexOf('op: "upsert_set_alias"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(-1);
    // The guard precedes the upsert, so a non-English entry can never reach it.
    expect(guardIdx).toBeLessThan(upsertIdx);
  });

  it("still resolves the entry — the pin is her decision and is always honoured", () => {
    // The skip is scoped to the ALIAS only; nothing about it aborts the match.
    const block = EXEC.slice(
      EXEC.indexOf('if (locale !== "en")'),
      EXEC.indexOf("} else if (rawCode"),
    );
    expect(block).not.toContain("throw");
    expect(block).not.toContain("return");
  });

  it("tells her the set was not learned, rather than silently learning nothing", () => {
    // Without this she sees "one match drains the set" not happen and reads it as a broken retry.
    expect(EXEC).toContain("aliasSkippedReason");
    expect(EXEC).toContain("was not learned");
    expect(EXEC).toContain("return { learnedAlias, aliasSkippedReason, created: qty }");
  });

  it("keeps learning aliases for English entries, which is the case that works", () => {
    // A guard that blocked everything would 'fix' this by removing the feature.
    expect(EXEC).toContain("} else if (rawCode && card.set_id) {");
    expect(EXEC).toContain('source: "manual"');
  });
});

describe("UIL-046 · the retry sweep is recorded", () => {
  it("stamps entries that did NOT resolve, including when nothing resolved at all", () => {
    // The old code returned early on `promoted === 0` without writing anything — that exact early
    // return is what this asserts is gone.
    expect(ACTIONS).not.toMatch(
      /if \(promoted === 0\) return \{ ok: true, promoted: 0, applied: false \};/,
    );
    expect(ACTIONS).toContain("stampRetrySweep");
    expect(ACTIONS).toContain("last_retry_sync");
    expect(ACTIONS).toContain("retry_count: e.retry_count + 1");
  });

  it("reads the waiting set BEFORE applying, or the promoted rows could not be excluded", () => {
    const fn = ACTIONS.slice(
      ACTIONS.indexOf("export async function retryUnresolvedNow"),
      ACTIONS.indexOf("async function stampRetrySweep"),
    );
    const readIdx = fn.indexOf("listWaiting");
    const applyIdx = fn.indexOf("executeApply");
    expect(readIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(-1);
    // Applying archives the promoted entries; reading afterwards would lose the distinction.
    expect(readIdx).toBeLessThan(applyIdx);
  });

  it("excludes the promoted entries from the stamp", () => {
    // Stamping a row that just resolved would record a failed retry against a success.
    expect(ACTIONS).toContain("promotedIds");
    expect(ACTIONS).toContain("!promotedIds.has(e.id)");
  });

  it("keeps the stamp as its own write, so telemetry cannot fail a real promotion", () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf("async function stampRetrySweep"));
    expect(fn).toContain("applyWriteOps");
    // And it is called after the apply, not folded into its payload.
    const outer = ACTIONS.slice(ACTIONS.indexOf("export async function retryUnresolvedNow"));
    expect(outer.indexOf("executeApply")).toBeLessThan(outer.indexOf("stampRetrySweep(db"));
  });

  it("reports how many it stamped, so the screen can say something happened", () => {
    expect(ACTIONS).toContain("stamped: number");
    expect(ACTIONS).toContain("applied: promoted > 0");
  });
});
