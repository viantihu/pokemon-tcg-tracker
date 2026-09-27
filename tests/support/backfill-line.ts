/**
 * Backfill line helpers for tests that run the pure planner without a database (UIL-117 C).
 *
 * `testStageState` is the shared stage-choice rule's fresh state over a fixture catalog, where every copy the
 * planner's `takeCopy` hands out reads as waiting in her haul (Backfill's filler source). `validatedLine` stands in for
 * `validateBackLine`'s derived fields, for a planner-direct test.
 */
import { localeOfId, standInIdFor } from "@/lib/catalog/locale";
import type { CatalogCard } from "@/lib/engine";
import type { StageState } from "@/lib/line/stage-choice";
import type { BackLineCommit, BackLineStageInfo, ValidatedBackLine } from "@/lib/backfill";

export function testStageState(catalog: readonly CatalogCard[], newId: () => string): StageState {
  const byId = new Map(catalog.map((c) => [c.tcgdexId, c]));
  return {
    card: (id) => {
      const c = byId.get(id);
      return c
        ? {
            tcgdexId: c.tcgdexId,
            name: c.name,
            dexId: c.dexId,
            cardClass: c.cardClass,
            setName: c.setName ?? null,
            localId: c.localId,
            locale: localeOfId(c.tcgdexId),
          }
        : null;
    },
    copy: (id) => ({ id, role: "haul" }),
    standIns: [],
    mirrorCandidates: () => [],
    newId,
    newStandInId: (language) => standInIdFor(language),
  };
}

/** A line as `validateBackLine` returns it: the chain's stage names, the band's type, the line's language. */
export function validatedLine(
  input: BackLineCommit,
  names: readonly string[],
  extra: { requiredType?: string | null } = {},
): ValidatedBackLine {
  const chain: BackLineStageInfo[] = input.stages.map((s, i) => ({
    stageIndex: s.stageIndex,
    stage: s.stage,
    dexId: s.dexId,
    name: names[i] ?? s.stage,
    sameColorPrintingExists: true,
    specialtyOnly: false,
    suggestedTargetId: null,
    alternateTargetIds: [],
  }));
  const have = input.stages.find((s) => s.choice?.kind === "have");
  return {
    ...input,
    requiredType: extra.requiredType ?? "Fire",
    lineLocale: have?.choice?.kind === "have" ? localeOfId(have.choice.tcgdexId) : "en",
    chain,
  };
}
