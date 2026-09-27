/**
 * The server's check of a Backfill line before anything is written (UIL-117 PR 5; the Tech Lead's outline, the
 * Senior BA's rulings).
 *
 * A line arrives from the browser as her decisions, stage by stage. None of it is trusted: the chain is resolved
 * again here from the card she picked the species by, against the same mirror, and every stage is checked against
 * it. A refusal names the stage and comes before any write, so a refused save changes nothing.
 *
 *   - the binder must exist and be a general binder (a specialty binder has no back half); an INACTIVE one is
 *     allowed, since she may be transcribing a shelved binder (the Senior BA's Q2);
 *   - the band must be one that is set up;
 *   - the root and the stages must be the resolved chain's, exactly, in order;
 *   - every stage needs HER decision. A placeholder must say `hunt`: true is a wishlist hunt, false is "Leave
 *     empty". A stage goes on her wishlist only when she adds it (UIL-119, Karvi's ruling);
 *   - a hunt needs a same-colour printing to hunt, and a TERMINATED line hunts nothing (the Senior BA's Q1: a
 *     terminated line offers no slot to fill);
 *   - a filled stage's card, and a placeholder's wishlist target and alternates, must be that stage's species;
 *   - a block needs its material, its card when it is a repurposed duplicate, and at least one pocket.
 *
 * Whether a card is WAITING in her haul is checked next, by the executor (./waiting), as before. What the server
 * derives it does not take from the browser: `specialtyOnly` (and so a capped status) comes from the resolved
 * chain, and the wishlist's `requiredType` from the band.
 *
 * Pure, over a loaded context.
 */

import { NOT_A_LINE } from "@/lib/line/popup";
import { resolveBackLineFromContext, type BackfillContext } from "./context";
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

/**
 * The line as the server will write it, or a refusal. Returns her input with what the server derives put back:
 * the resolved root, `requiredType` from the band, and each placeholder's `specialtyOnly` from the chain.
 */
export function validateBackLine(ctx: BackfillContext, input: BackLineCommit): BackLineCommit {
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

  const terminated = input.terminated === true;
  const bandName = ctx.bandDisplayByKey.get(input.bandKey) ?? input.bandKey;
  return {
    ...input,
    rootDexId: resolved.rootDexId,
    requiredType: resolved.requiredType,
    terminated,
    stages: got.map((s, i) => checkStage(ctx, s, want[i], terminated, bandName)),
  };
}

function checkStage(
  ctx: BackfillContext,
  s: BackLineStageInput,
  info: BackLineStageInfo,
  terminated: boolean,
  bandName: string,
): BackLineStageInput {
  const where = `the ${stageLabel(info.stage)} stage (${info.name})`;
  const nameOf = (id: string) => ctx.catalogById.get(id)?.name ?? "That card";
  const isThisSpecies = (id: string) => (ctx.catalogById.get(id)?.dexId ?? []).includes(info.dexId);

  switch (s.decision) {
    case "filled": {
      const id = s.filledTcgdexId;
      if (!id || typeof s.filledDexVariantRaw !== "string") {
        refuse(`Pick the card you own for ${where}, or choose another option for it.`);
      }
      if (!isThisSpecies(id)) {
        refuse(`${nameOf(id)} is not a ${info.name}. Pick the ${info.name} you own for ${where}.`);
      }
      return s;
    }
    case "placeholder": {
      if (typeof s.hunt !== "boolean") {
        refuse(`Choose Wishlist hunt or Leave empty for ${where}.`);
      }
      if (s.hunt && terminated) {
        refuse(`A terminated line has no stage to hunt. Choose Leave empty or Block for ${where}.`);
      }
      if (s.hunt && !info.sameColorPrintingExists) {
        refuse(
          `There is no ${bandName} ${info.name} to hunt for ${where}. Choose Leave empty or Block.`,
        );
      }
      for (const id of [s.targetCatalogCardId, ...(s.alternateCatalogCardIds ?? [])]) {
        if (id && !isThisSpecies(id)) {
          refuse(`The wishlist card for ${where} is not a ${info.name} — ${RELOAD}`);
        }
      }
      return { ...s, specialtyOnly: info.specialtyOnly };
    }
    case "block": {
      if (s.blockMaterial !== "basicEnergy" && s.blockMaterial !== "repurposedDuplicate") {
        refuse(`Choose what fills the block for ${where}: basic energy or a repurposed duplicate.`);
      }
      if (
        s.blockMaterial === "repurposedDuplicate" &&
        (!s.blockCopyTcgdexId || typeof s.blockCopyDexVariantRaw !== "string")
      ) {
        refuse(`Pick which duplicate was repurposed for ${where}.`);
      }
      const pockets = s.pocketCount;
      if (typeof pockets !== "number" || !Number.isInteger(pockets) || pockets < 1) {
        refuse(`The block for ${where} needs at least one pocket.`);
      }
      return s;
    }
    default:
      refuse(`Decide ${where} before saving: Filled, Wishlist hunt, Leave empty or Block.`);
  }
}
