/**
 * The server's check of a Backfill line before anything is written (UIL-117 PR 5; the Tech Lead's outline, the
 * Senior BA's rulings; UIL-121's choices in C).
 *
 * A line arrives from the browser as her decisions, stage by stage. None of it is trusted: the chain is resolved
 * again here from the card she picked the species by, against the same mirror, and every stage is checked against
 * it. A refusal names the stage and comes before any write, so a refused save changes nothing.
 *
 *   - the binder must exist and be a general binder (a specialty binder has no back half); an INACTIVE one is
 *     allowed, since she may be transcribing a shelved binder (the Senior BA's Q2);
 *   - the band must be one that is set up;
 *   - the root and the stages must be the resolved chain's, exactly, in order;
 *   - every stage needs HER choice: the card she has (waiting in her haul), or one of the shared choices (chase,
 *     leave empty, a filler). The shared ones are checked by the shared rule (lib/line/stage-choice.ts) when the
 *     line is planned, still before any write;
 *   - a card she has must be that stage's species;
 *   - a line whose cards are in more than one language needs her explicit OK, and reads as its lowest card's
 *     language (UIL-090; the Senior BA's ruling).
 *
 * Whether a card is WAITING in her haul is checked next, by the executor (./waiting), as before. What the server
 * derives it does not take from the browser: the line's language, and the wishlist's `requiredType` from the band.
 *
 * Pure, over a loaded context.
 */

import { localeOfId } from "@/lib/catalog/locale";
import { STAGE_REFUSAL } from "@/lib/line/stage-choice";
import type { Locale } from "@/lib/sync/types";
import { NOT_A_LINE } from "@/lib/line/popup";
import { resolveBackLineFromContext, type BackfillContext } from "./context";
import { mixedLanguageNote } from "./language";
import type { BackLineCommit, BackLineStageInfo, BackLineStageInput } from "./types";

/** A Backfill line the server will not write. Its message is hers to read, and names the stage. */
export class BackLineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackLineRefused";
  }
}

function refuse(message: string): never {
  throw new BackLineRefused(message);
}

const RELOAD = "reload Backfill and start the line again.";

/** "Stage 1" for TCGdex's "Stage1". */
export function stageLabel(stage: string): string {
  return stage.replace(/^Stage(\d)$/, "Stage $1");
}

/** A line as the server will write it: her input, plus what the server derived. */
export interface ValidatedBackLine extends BackLineCommit {
  /** The line colour's representative type: the wishlist's `required_type`, and a new placeholder card's type. */
  requiredType: string | null;
  /** The line's language: its lowest card's (UIL-090), else the card she picked the species by. */
  lineLocale: Locale;
  /** The resolved chain's stages, in order, for the shared rule's targets. */
  chain: readonly BackLineStageInfo[];
}

/** The locale of each card she has, lowest stage first. */
function haveLocales(stages: readonly BackLineStageInput[]): Locale[] {
  return [...stages]
    .sort((a, b) => a.stageIndex - b.stageIndex)
    .flatMap((s) => (s.choice?.kind === "have" ? [localeOfId(s.choice.tcgdexId)] : []));
}

/**
 * The line as the server will write it, or a refusal. The shared stage choices are checked again by the shared rule
 * when the line is planned (lib/backfill/plan.ts), which needs the waiting copies a filler takes.
 */
export function validateBackLine(ctx: BackfillContext, input: BackLineCommit): ValidatedBackLine {
  const binder = ctx.binders.find((b) => b.id === input.binderId);
  if (!binder) refuse(`That binder no longer exists — ${RELOAD}`);
  if (binder.type !== "general") {
    refuse(`${binder.name} is a specialty binder, which has no back half. Pick a general binder.`);
  }
  if (!ctx.bands.some((b) => b.key === input.bandKey)) {
    refuse(`That colour band is not set up — ${RELOAD}`);
  }

  const resolved = resolveBackLineFromContext(ctx, input.seedTcgdexId, input.bandKey);
  if (!resolved) refuse(`The card this line was started from is not in the catalog — ${RELOAD}`);
  // A species with no evolutions is never a line (Karvi's ruling, 2026-09-27).
  if (resolved.stages.length < 2) refuse(NOT_A_LINE);
  if (input.rootDexId !== resolved.rootDexId) {
    refuse(`That line is not the ${resolved.speciesName} line it was started as — ${RELOAD}`);
  }
  const want = resolved.stages;
  const got = Array.isArray(input.stages) ? input.stages : [];
  const sameChain =
    got.length === want.length &&
    got.every(
      (s, i) =>
        s.stageIndex === want[i].stageIndex &&
        s.stage === want[i].stage &&
        s.dexId === want[i].dexId,
    );
  if (!sameChain) {
    refuse(`That line's stages are not the ${resolved.speciesName} line's — ${RELOAD}`);
  }

  got.forEach((s, i) => checkStage(ctx, s, want[i]));

  const locales = haveLocales(got);
  const lineLocale = locales[0] ?? localeOfId(input.seedTcgdexId);
  const mixed = mixedLanguageNote(locales, lineLocale);
  if (mixed && input.mixedLanguageOk !== true) refuse(`${mixed} Confirm that to save it.`);

  return {
    ...input,
    rootDexId: resolved.rootDexId,
    requiredType: resolved.requiredType,
    lineLocale,
    chain: want,
  };
}

function checkStage(ctx: BackfillContext, s: BackLineStageInput, info: BackLineStageInfo): void {
  const choice = s.choice;
  switch (choice?.kind) {
    case "have": {
      const where = `the ${stageLabel(info.stage)} stage (${info.name})`;
      if (!choice.tcgdexId || typeof choice.dexVariantRaw !== "string") {
        refuse(`Pick the card you have for ${where}, or choose another option for it.`);
      }
      const card = ctx.catalogById.get(choice.tcgdexId);
      if (!(card?.dexId ?? []).includes(info.dexId)) {
        refuse(
          `${card?.name ?? "That card"} is not a ${info.name}. Pick the ${info.name} you have for ${where}.`,
        );
      }
      return;
    }
    case "chase":
    case "empty":
    case "filler":
      return; // the shared rule, when the line is planned
    default:
      refuse(STAGE_REFUSAL.missing(info.stage));
  }
}
