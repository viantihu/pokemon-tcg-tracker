/**
 * UIL-090 — an English line and a Japanese line of one species are DIFFERENT lines, in the same binder
 * and the same band, and the screen says which is which.
 *
 * Karvi: "Regional variants of a pokemon should be tracked separately. This Toedscruel should be able to
 * get placed in the back half." docs/sync-architecture.md L5 already says a JP and an EN printing "are
 * legitimately two different cards with two placements"; UIL-047 partitioned artwork clustering by locale
 * for the same reason. The line key never got it. Three defects, each with its own case here:
 *
 *   D1 the uniqueness key ignored locale, so a Japanese line blocked an English card (her screen);
 *   D2 the chain walk, the candidates and `ownedAt` ignored locale, so a Japanese card was OFFERED an
 *      English line's open slot and could be counted as filling one — the more dangerous direction;
 *   D3 a species was labelled with the SHORTEST name across both locales, so every line of a species with
 *      a Japanese printing read "ノノクラゲ LINE" whatever locale it was. That is what made her screenshot
 *      undiagnosable: the two possible states produced byte-identical output.
 *
 * A line's locale is DERIVED, not stored: `root_dex_id` is a species key both regional variants share, so
 * only the cards at the slots can answer it, and a stored id's namespace IS its locale. Filled copies
 * first, then the lowest target — the same precedence migration 0019 repairs by.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { buildChain, lineLocaleOf, type CatalogCard, type IncomingCard } from "@/lib/engine";
import {
  buildHaulCommitPayload,
  clearCatalogCache,
  commitCardPlacement,
  deriveSpotlightPlacement,
  lineJoinOptionsFromContext,
  loadPlanContext,
  planFromDraft,
  type DraftItem,
} from "@/lib/plan";
import { applyMove } from "@/lib/line";
import { candidateKey } from "@/lib/line/join-options";
import {
  OWNER,
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  seedBinders,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB2 = "b0000000-0000-0000-0000-00000000f001";
const ROOT_DEX = 9481;
const S1_DEX = 9482;
const LINE = "10000000-0000-0000-0000-00000000f001";
const SLOT_ROOT = "50000000-0000-0000-0000-00000000f001";
const SLOT_S1 = "50000000-0000-0000-0000-00000000f002";
const JA_ROOT = "c0000000-0000-0000-0000-00000000f001";
const JA_S1 = "c0000000-0000-0000-0000-00000000f002";
const EN_ROOT = "c0000000-0000-0000-0000-00000000f003";
const EN_S1 = "c0000000-0000-0000-0000-00000000f004";

/** The Toedscruels she is placing: copies her import made, waiting in her haul (UIL-098 part 2). */
const EN_CRUEL: DraftItem = haulRow("d0000000-0000-4000-8000-00000000f0e1", "sv09-089");
const JA_CRUEL: DraftItem = haulRow("d0000000-0000-4000-8000-00000000f0e2", "ja:SV9-089");
const BACK_ORANGE = { kind: "shelf", binderId: KB2, half: "back", band: "orange" } as const;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedBinders(db, [{ id: KB2, type: "general", name: "KB-002" }]);
  // Both regional variants of one species: same dex ids, different namespaces, and — the point of D3 —
  // the Japanese names are SHORTER than the English ones.
  for (const [id, name, dex, stage, from, locale] of [
    ["sv09-088", "Toedscool", ROOT_DEX, "Basic", null, "en"],
    ["sv09-089", "Toedscruel", S1_DEX, "Stage1", "Toedscool", "en"],
    ["ja:SV9-088", "ノノクラゲ", ROOT_DEX, "Basic", null, "ja"],
    ["ja:SV9-089", "ノノクラゲex", S1_DEX, "Stage1", "ノノクラゲ", "ja"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, locale)
         values ($1, $2, $3, '{Fighting}', $4, $5, 'standard', $6)`,
      [id, name, [dex], stage, from, locale],
    );
  }
  await seedHaulRows(db, [EN_CRUEL, JA_CRUEL]);
});
afterEach(async () => {
  await db.close();
});

/** A complete line in KB-002 whose two slots are filled by copies of ONE locale. */
async function seedFilledLine(which: "ja" | "en") {
  const [rootCard, s1Card] =
    which === "ja" ? ["ja:SV9-088", "ja:SV9-089"] : ["sv09-088", "sv09-089"];
  const [rootCopy, s1Copy] = which === "ja" ? [JA_ROOT, JA_S1] : [EN_ROOT, EN_S1];
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'back', 'orange'),
              ($5, $2, $6, 'shelved', $4, 'back', 'orange')`,
    [rootCopy, OWNER, rootCard, KB2, s1Copy, s1Card],
  );
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB2}', 'back', 'complete');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${rootCopy}'),
             ('${SLOT_S1}',  '${OWNER}', '${LINE}', 1, 'Stage1', 'filled', '${s1Copy}');
    update copy set line_slot_id = '${SLOT_ROOT}' where id = '${rootCopy}';
    update copy set line_slot_id = '${SLOT_S1}'   where id = '${s1Copy}';
  `);
}

async function catalog(): Promise<CatalogCard[]> {
  await asOwner(db);
  const pc = await loadPlanContext(pgliteClient(db));
  await asSuperuser(db);
  return pc.ctx.catalog;
}
async function picker(tcgdexId: string) {
  await asOwner(db);
  const pc = await loadPlanContext(pgliteClient(db));
  const opts = lineJoinOptionsFromContext(pc, tcgdexId);
  await asSuperuser(db);
  return opts;
}
async function commit(card: DraftItem) {
  await asOwner(db);
  try {
    return await commitCardPlacement(pgliteClient(db), {
      card,
      override: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
    });
  } finally {
    await asSuperuser(db);
  }
}
async function lines() {
  return (
    await db.query<{ id: string; binder_id: string | null; color_band: string }>(
      `select id, binder_id, color_band from evolution_line order by created_at`,
    )
  ).rows;
}

describe("UIL-090 · D2: the chain walk stays inside one locale", () => {
  it("a chain built from the English Stage1 holds only English printings", async () => {
    const cat = await catalog();
    const en = cat.find((c) => c.tcgdexId === "sv09-089")!;
    const chain = buildChain({ id: "x", card: en, variant: "normal" } as IncomingCard, cat);
    // Pre-fix each node came back with BOTH: cards: ["ja:SV9-088", "sv09-088"].
    expect(chain.flatMap((n) => n.cards.map((c) => c.tcgdexId))).toEqual(["sv09-088", "sv09-089"]);
    // And therefore the label is the English name, not whichever is shorter.
    expect(chain[0].name).toBe("Toedscool");
  });

  it("a chain built from the Japanese Stage1 holds only Japanese printings", async () => {
    const cat = await catalog();
    const ja = cat.find((c) => c.tcgdexId === "ja:SV9-089")!;
    const chain = buildChain({ id: "x", card: ja, variant: "normal" } as IncomingCard, cat);
    expect(chain.flatMap((n) => n.cards.map((c) => c.tcgdexId))).toEqual([
      "ja:SV9-088",
      "ja:SV9-089",
    ]);
    expect(chain[0].name).toBe("ノノクラゲ");
  });

  it("a JAPANESE card is NOT offered an English line's open slot", async () => {
    // An English line with its Stage1 slot open, and a Japanese Toedscruel in hand.
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv09-088', 'shelved', $3, 'back', 'orange')`,
      [EN_ROOT, OWNER, KB2],
    );
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB2}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${EN_ROOT}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('${SLOT_S1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', 'sv09-089');
      update copy set line_slot_id = '${SLOT_ROOT}' where id = '${EN_ROOT}';
    `);
    // Pre-fix this returned the English line's Stage1 slot as a candidate for the Japanese card.
    expect((await picker("ja:SV9-089"))!.joinCandidates).toEqual([]);
    // The ENGLISH Toedscruel is still offered it — the slot is not broken, only locale-scoped.
    expect((await picker("sv09-089"))!.joinCandidates.map((c) => c.slotId)).toEqual([SLOT_S1]);
  });

  it("the candidate index is keyed by locale as well as species", async () => {
    await seedFilledLine("en");
    const opts = (await picker("sv09-089"))!;
    expect(opts.locale).toBe("en");
    expect(candidateKey("ja", S1_DEX)).not.toBe(candidateKey("en", S1_DEX));
  });
});

describe("UIL-090 · D3: a line is labelled in its own locale", () => {
  it("an ENGLISH line reads with the English name, even though the Japanese name is shorter", async () => {
    await seedFilledLine("en");
    const opts = (await picker("sv09-089"))!;
    const block = opts.existingLines.find(
      (l) => l.binderId === KB2 && l.bandKey === "orange" && l.locale === "en",
    )!;
    expect(block.speciesLabel).toBe("TOEDSCOOL LINE"); // pre-fix: "ノノクラゲ LINE"
    expect(block.locale).toBe("en");
  });

  it("a JAPANESE line reads with the Japanese name", async () => {
    await seedFilledLine("ja");
    const opts = (await picker("ja:SV9-089"))!;
    const block = opts.existingLines.find(
      (l) => l.binderId === KB2 && l.bandKey === "orange" && l.locale === "ja",
    )!;
    expect(block.speciesLabel).toBe("ノノクラゲ LINE");
    expect(block.locale).toBe("ja");
  });

  it("the two are no longer INDISTINGUISHABLE, which is why her screenshot could not be diagnosed", async () => {
    await seedFilledLine("ja");
    const withJa = JSON.stringify((await picker("sv09-089"))!);
    await db.exec(`delete from line_slot; delete from evolution_line; delete from copy;`);
    await seedFilledLine("en");
    const withEn = JSON.stringify((await picker("sv09-089"))!);
    // Pre-fix these two were byte-identical: both reported "ノノクラゲ LINE" blocking the English card.
    expect(withJa).not.toBe(withEn);
  });
});

describe("UIL-090 · D1: the uniqueness key includes the locale", () => {
  it("an ENGLISH card starts its own line in a binder whose line for that species is JAPANESE", async () => {
    await seedFilledLine("ja");
    // Pre-fix: refused with "That binder already has a line for this species in this band."
    await commit(EN_CRUEL);
    const rows = await lines();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.binder_id === KB2 && r.color_band === "orange")).toBe(true);
    // And the Japanese line is untouched: its slots still hold its own copies.
    const jaSlots = await db.query<{ copy_id: string | null }>(
      `select copy_id from line_slot where line_id = $1 order by stage_index`,
      [LINE],
    );
    expect(jaSlots.rows.map((r) => r.copy_id)).toEqual([JA_ROOT, JA_S1]);
  });

  it("the JAPANESE direction works too: a ja card starts its line beside an en one", async () => {
    await seedFilledLine("en");
    await commit(JA_CRUEL);
    expect(await lines()).toHaveLength(2);
  });

  it("a SECOND English card now starts its own line too — the rule is gone, not only per locale (UIL-096)", async () => {
    // This used to pin a refusal: a second line of the SAME locale in one binder and band was the case
    // UIL-090's locale scoping deliberately did not unblock. Karvi overruled the rule itself in UIL-096 —
    // "Instead of blocking the creation of an evolution line, I want a warning" — so it lands, and the
    // warning is the Move panel's job. Pinned in this direction so nobody restores the old refusal.
    await seedFilledLine("en");
    await commit(EN_CRUEL);
    const rows = await lines();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.binder_id === KB2 && r.color_band === "orange")).toBe(true);
  });

  it("her actual card: a second EN Toedscruel where the line is EN LANDS in a new line (UIL-096)", async () => {
    // UIL-090 noted this was refused "correctly" under the rule as it stood, and pinned it "so nobody
    // fixes it later by relaxing the rule". Karvi has now relaxed the rule on purpose, for exactly this
    // card: "the Toedscruel issue is still there. I'm not able to create a new line for it." Overruled by
    // the product owner, not relaxed by accident — which is what this sentence is here to say.
    await seedFilledLine("en");
    await commit(EN_CRUEL);
    expect(await lines()).toHaveLength(2);
  });
});

describe("UIL-090 · lineLocaleOf: filled copies win over targets", () => {
  const slot = (stageIndex: number, copyId: string | null, target: string | null) => ({
    id: `s${stageIndex}`,
    stageIndex,
    stage: "Basic",
    state: "placeholder" as const,
    copyId,
    dexId: null,
    targetCatalogCardId: target,
  });
  const cardOf = (id: string) => (id === "c-en" ? "sv09-088" : "ja:SV9-088");

  it("reads the lowest FILLED copy, not the lowest slot, so a foreign target cannot flip the line", () => {
    // Stage 0 is a placeholder wrongly targeting a Japanese card; stage 1 holds an English copy.
    // Deriving from "the lowest slot's card" would call this line Japanese — and migration 0019, built
    // on the same rule, would then release the ENGLISH targets instead of the Japanese one.
    expect(lineLocaleOf([slot(0, null, "ja:SV9-088"), slot(1, "c-en", null)], cardOf)).toBe("en");
  });

  it("falls back to the lowest target only when the line holds no copy at all", () => {
    expect(lineLocaleOf([slot(0, null, "ja:SV9-088"), slot(1, null, null)], cardOf)).toBe("ja");
    expect(lineLocaleOf([slot(0, null, "sv09-088")], cardOf)).toBe("en");
  });

  it("defaults to en for a line with no card anywhere", () => {
    expect(lineLocaleOf([slot(0, null, null)], cardOf)).toBe("en");
  });
});

describe("UIL-090 · D2 through the CASCADE and the Lines screen, not only the picker", () => {
  /** A Japanese Basic she owns, so a Japanese Stage1 is viable on its own. */
  async function seedJaBasicCopy() {
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'ja:SV9-088', 'shelved', $3, 'front', 'orange')`,
      [JA_ROOT, OWNER, KB2],
    );
  }

  it("the cascade does not route a JAPANESE card into an English line's open slot", async () => {
    // An English line with its Stage1 slot OPEN. No override: the CASCADE decides, which is the path
    // `existingLineSlot` governs — the picker cases above never exercise it.
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv09-088', 'shelved', $3, 'back', 'orange')`,
      [EN_ROOT, OWNER, KB2],
    );
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB2}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${EN_ROOT}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('${SLOT_S1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', 'sv09-089');
      update copy set line_slot_id = '${SLOT_ROOT}' where id = '${EN_ROOT}';
    `);
    await seedJaBasicCopy();

    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { card: JA_CRUEL });
    await asSuperuser(db);

    // The English line's slot is untouched — pre-fix the Japanese card filled it.
    const slot = await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [SLOT_S1],
    );
    expect(slot.rows[0]).toEqual({ state: "placeholder", copy_id: null });
  });

  it("a JAPANESE owned copy never fills an English line's slot when the CASCADE creates it", async () => {
    // Only a JAPANESE Basic is owned. Starting an ENGLISH line must leave the Basic stage OPEN rather
    // than claiming the Japanese card fills it.
    //
    // No override, deliberately: an override routes through `buildNewLineJoinOps`, which passes
    // `owned: []` and so never pulls anything — only the cascade's own line-new step consults her
    // collection, which is where `ownedAt` decides.
    await seedJaBasicCopy();

    // The PROPOSAL is where `ownedAt` shows: a slot whose pull she has not confirmed degrades to a
    // placeholder either way (UIL-061), so asserting only on the written slot cannot see this. Pre-fix
    // the Japanese copy was proposed as a pull into the English line.
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(pgliteClient(db), EN_CRUEL);
    await asSuperuser(db);
    expect(placement!.proposedPulls).toEqual([]);

    // And confirming it moves nothing, because the engine never claimed that stage was filled.
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      card: EN_CRUEL,
      confirmedPulls: [JA_ROOT],
    });
    await asSuperuser(db);
    const slots = await db.query<{ stage_index: number; state: string; copy_id: string | null }>(
      `select stage_index, state, copy_id from line_slot order by stage_index`,
    );
    const root = slots.rows.find((r) => r.stage_index === 0)!;
    expect(root.state).not.toBe("filled"); // pre-fix: "filled", naming the Japanese copy
    expect(root.copy_id).toBeNull();
    // The Japanese copy is still where it was, in the front half.
    const ja = await db.query<{ binder_half: string | null; line_slot_id: string | null }>(
      `select binder_half, line_slot_id from copy where id = $1`,
      [JA_ROOT],
    );
    expect(ja.rows[0]).toEqual({ binder_half: "front", line_slot_id: null });
  });

  it("an English line's placeholder targets an ENGLISH printing even when the Japanese one is cheaper", async () => {
    // The ja Stage1 is priced well below the en one, so a locale-blind ranking picks it.
    await db.query(`update catalog_card set price_market = 1.00 where tcgdex_id = 'ja:SV9-089'`);
    await db.query(`update catalog_card set price_market = 9.00 where tcgdex_id = 'sv09-089'`);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv09-088', 'shelved', $3, 'front', 'orange')`,
      [EN_ROOT, OWNER, KB2],
    );
    // Start an English line from the English BASIC, so the Stage1 stage is a placeholder to be targeted.
    const enCool = haulRow("d0000000-0000-4000-8000-00000000f0e3", "sv09-088");
    await seedHaulRows(db, [enCool]);
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      card: enCool,
      override: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
    });
    await asSuperuser(db);
    const ph = await db.query<{ target_catalog_card_id: string | null }>(
      `select target_catalog_card_id from line_slot where state = 'placeholder' order by stage_index`,
    );
    expect(ph.rows.map((r) => r.target_catalog_card_id)).toEqual(["sv09-089"]); // pre-fix: "ja:SV9-089"
  });
});

describe("UIL-090 · D1 from the LINES screen too, so both write paths agree", () => {
  it("applyMove starts an English line where the binder's line for that species is Japanese", async () => {
    await seedFilledLine("ja");
    // An English Toedscruel shelved in the front half, moved to the back half as a new line.
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv09-089', 'shelved', $3, 'front', 'orange')`,
      [EN_S1, OWNER, KB2],
    );
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      {
        copyId: EN_S1,
        destination: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
      },
      { binderName: () => "KB-002", collectionName: () => null, bandDisplay: (k) => k },
    );
    await asSuperuser(db);
    expect(await lines()).toHaveLength(2); // pre-fix: refused
  });

  it("applyMove starts a SECOND English line in that binder and band — both write paths agree (UIL-096)", async () => {
    // Was a refusal; Karvi overruled the rule in UIL-096, and the Plan and the Lines screen must still agree
    // with each other, which is what this describe block exists to pin.
    await seedFilledLine("en");
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv09-089', 'shelved', $3, 'front', 'orange')`,
      ["c0000000-0000-0000-0000-00000000f009", OWNER, KB2],
    );
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      {
        copyId: "c0000000-0000-0000-0000-00000000f009",
        destination: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
      },
      { binderName: () => "KB-002", collectionName: () => null, bandDisplay: (k) => k },
    );
    await asSuperuser(db);
    expect(await lines()).toHaveLength(2);
  });
});

describe("UIL-090 · two cards, one payload, two locales — the in-pass key is per locale too", () => {
  /**
   * `buildHaulCommitPayload` carries a `passLines` mirror so a later card in the SAME payload joins a
   * line an earlier card just created instead of duplicating it. That key has to include the locale, or
   * an English and a Japanese card sent to one binder and band would collapse into whichever came first.
   * `commitCardPlacement` sends one card per payload, so this drives the exported builder — the same
   * reasoning as UIL-084's binder case.
   */
  it("gives each regional variant its own new line instead of folding the second into the first", async () => {
    const cards: DraftItem[] = [EN_CRUEL, JA_CRUEL];
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db), {
      excludeOwnedCopyIds: cards.map((c) => c.id),
    });
    await asSuperuser(db);
    const { planned } = planFromDraft(pc, cards);
    const built = buildHaulCommitPayload(pc, planned, {
      draft: cards,
      overrides: {
        [EN_CRUEL.id]: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
        [JA_CRUEL.id]: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
      },
    });
    // Pre-fix the second card's key collided with the first and the commit refused it.
    expect(built.payload.ops.filter((o) => o.op === "insert_line")).toHaveLength(2);

    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);
    expect(await lines()).toHaveLength(2);
  });

  it("two cards of the SAME locale in one payload each get their own line when she asks (UIL-096)", async () => {
    // Was a refusal of the second card. With the rule gone, each explicit "new line" is honoured — the
    // in-pass key now only keeps the bookkeeping straight, it no longer decides anything.
    // Built, not applied, so the second copy needs no row — only the id that makes it a haul copy.
    const second = haulRow("d0000000-0000-4000-8000-00000000f0e4", "sv09-089");
    const cards: DraftItem[] = [EN_CRUEL, second];
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db), {
      excludeOwnedCopyIds: cards.map((c) => c.id),
    });
    await asSuperuser(db);
    const { planned } = planFromDraft(pc, cards);
    const { payload } = buildHaulCommitPayload(pc, planned, {
      draft: cards,
      overrides: {
        [EN_CRUEL.id]: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
        [second.id]: { ...BACK_ORANGE, lineJoin: { mode: "new" } },
      },
    });
    expect(payload.ops.filter((o) => o.op === "insert_line")).toHaveLength(2);
  });
});
