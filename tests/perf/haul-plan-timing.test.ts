/**
 * How long the Haul Plan's routing takes at Karvi's real size (UIL-114, the Senior BA's ask before PR 1).
 *
 * PR 1 re-routes the haul in the background after a "Not mine" and when new cards arrive, so the cost of one
 * `runHaulPlan` decides whether presses must be batched (the ruling: batch if a re-route takes more than about
 * 2 s). Her Testing data: about 720 waiting copies over 693 keys, ~50 placed, a ~36k-card catalog (en + ja).
 *
 * Opt-in (`PERF=1`), so CI never pays for it: `PERF=1 pnpm vitest run tests/perf/haul-plan-timing.test.ts`.
 * It times the three parts `runHaulPlan` runs, separately:
 *   - loadPlanContext, cold (the catalog fetched) and warm (the catalog served from its 5-minute cache, which is
 *     what every re-route within a sitting hits);
 *   - planFromDraft, the cascade itself: pure, and the same work on the server as here;
 *   - groupPlan;
 *   - the arrivals check the open page makes every 30 s, when nothing has arrived.
 * The database here is PGlite in-process, so the load figures are a floor: on Supabase each query also pays a
 * network round trip. The cascade figure is not affected by that.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clearCatalogCache,
  groupPlan,
  loadPendingPlacements,
  loadPlanContext,
  planFromDraft,
} from "@/lib/plan";
import { freshRpcDb, OWNER, asOwner, asSuperuser } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPECIES = 1025;
const EN_PER_SPECIES = 23;
const JA_PER_SPECIES = 12;
const WAITING_KEYS = 693;
const WAITING_COPIES = 720;
const PLACED = 50;
const TYPES = [
  "Fire",
  "Water",
  "Grass",
  "Lightning",
  "Psychic",
  "Fighting",
  "Darkness",
  "Metal",
  "Dragon",
  "Colorless",
  "Fairy",
];

describe.skipIf(!process.env.PERF)("UIL-114 · runHaulPlan at her size", () => {
  it("times each part", { timeout: 600_000 }, async () => {
    const db = await freshRpcDb();
    await asSuperuser(db);
    // Families of three (Basic → Stage1 → Stage2), each species printed across sets in both locales.
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, dex_id, types, stage, evolve_from, card_class, locale)
      select
        case when p.ja then 'ja:S' || lpad(p.s::text, 2, '0') || '-' || lpad(p.n::text, 5, '0')
             else 's' || lpad(p.s::text, 2, '0') || '-' || lpad(p.n::text, 5, '0') end,
        'Mon' || p.d,
        case when p.ja then 'ja:S' || lpad(p.s::text, 2, '0') else 's' || lpad(p.s::text, 2, '0') end,
        'Set ' || p.s,
        lpad(p.n::text, 5, '0'),
        array[p.d],
        array[(array[${TYPES.map((t) => `'${t}'`).join(",")}])[1 + (p.d % ${TYPES.length})]],
        (array['Basic','Stage1','Stage2'])[1 + ((p.d - 1) % 3)],
        case when (p.d - 1) % 3 = 0 then null else 'Mon' || (p.d - 1) end,
        'standard',
        case when p.ja then 'ja' else 'en' end
      from (
        select d, k, (k >= ${EN_PER_SPECIES}) as ja,
               1 + (k % 20) as s,
               d * ${EN_PER_SPECIES + JA_PER_SPECIES} + k as n
        from generate_series(1, ${SPECIES}) d, generate_series(0, ${EN_PER_SPECIES + JA_PER_SPECIES - 1}) k
      ) p;
    `);
    await db.exec(
      `
      insert into binder (id, owner_id, name, type) values
        ('b0000000-0000-0000-0000-00000000p001', '${OWNER}', 'KB-001', 'general'),
        ('b0000000-0000-0000-0000-00000000p002', '${OWNER}', 'KB-002', 'general');
    `.replace(/p00/g, "000"),
    );
    // 693 waiting keys over English printings, 27 of them with a second copy: 720 waiting copies.
    const keys = await db.query<{ tcgdex_id: string }>(
      `select tcgdex_id from catalog_card where locale = 'en' order by tcgdex_id limit ${WAITING_KEYS}`,
    );
    const ids: { copy: string; card: string }[] = [];
    let i = 0;
    for (const [n, k] of keys.rows.entries()) {
      const copies = n < WAITING_COPIES - WAITING_KEYS ? 2 : 1;
      for (let c = 0; c < copies; c++) {
        i += 1;
        ids.push({
          copy: `c0000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
          card: k.tcgdex_id,
        });
      }
    }
    await db.exec(`
      insert into presence_group (owner_id, catalog_card_id, dex_variant_raw, desired_count)
        select '${OWNER}', card, 'Normal', count(*) from (values ${ids.map((x) => `('${x.card}')`).join(",")}) v(card)
        group by card;
      insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
        select v.id::uuid, '${OWNER}', v.card, 'normal', 'Normal', g.id, 'haul'
        from (values ${ids.map((x) => `('${x.copy}', '${x.card}')`).join(",")}) v(id, card)
        join presence_group g on g.catalog_card_id = v.card and g.dex_variant_raw = 'Normal';
    `);
    // ~50 already placed, shelved in the front half of KB-001.
    const placed = await db.query<{ tcgdex_id: string }>(
      `select tcgdex_id from catalog_card where locale = 'en' order by tcgdex_id desc limit ${PLACED}`,
    );
    await db.exec(`
      insert into copy (owner_id, catalog_card_id, variant, dex_variant_raw, role, binder_id, binder_half, color_band)
        select '${OWNER}', v.card, 'normal', 'Normal', 'shelved', 'b0000000-0000-0000-0000-000000000001', 'front', 'red'
        from (values ${placed.rows.map((r) => `('${r.tcgdex_id}')`).join(",")}) v(card);
    `);
    await asOwner(db);

    const client = pgliteClient(db);
    const draft = ids.map((x) => ({
      id: x.copy,
      tcgdexId: x.card,
      variant: "normal" as const,
      existingCopyId: x.copy,
    }));
    const time = async <T>(f: () => Promise<T> | T): Promise<[T, number]> => {
      const t = performance.now();
      const out = await f();
      return [out, performance.now() - t];
    };

    clearCatalogCache();
    const [pc, loadCold] = await time(() =>
      loadPlanContext(client, { excludeOwnedCopyIds: draft.map((d) => d.id) }),
    );
    const [, loadWarm] = await time(() =>
      loadPlanContext(client, { excludeOwnedCopyIds: draft.map((d) => d.id) }),
    );
    const [{ items }, cascade] = await time(() => planFromDraft(pc, draft));
    const [, cascadeAgain] = await time(() => planFromDraft(pc, draft));
    const [, group] = await time(() => groupPlan(items, pc.orderedBandKeys));
    // The 30 s arrivals check (UIL-114 part C) when nothing has arrived, which is almost every time.
    const [none, arrivalsNone] = await time(() =>
      loadPendingPlacements(client, { except: new Set(draft.map((d) => d.id)) }),
    );
    expect(none).toEqual([]);

    const catalog = (await db.query<{ n: number }>("select count(*)::int n from catalog_card"))
      .rows[0].n;
    const report = JSON.stringify({
      catalog,
      waitingCopies: draft.length,
      waitingKeys: new Set(draft.map((d) => d.tcgdexId)).size,
      items: items.length,
      ms: {
        loadPlanContextCold: Math.round(loadCold),
        loadPlanContextWarm: Math.round(loadWarm),
        planFromDraft: Math.round(cascade),
        planFromDraftAgain: Math.round(cascadeAgain),
        groupPlan: Math.round(group),
        arrivalsCheckNothingNew: Math.round(arrivalsNone),
        reRouteWarm: Math.round(loadWarm + cascade + group),
      },
    });
    // The project's test config keeps console output quiet, so the figures go to a file to read.
    writeFileSync(process.env.PERF_OUT ?? "/tmp/haul-plan-timing.json", report);
    expect(items).toHaveLength(WAITING_COPIES);
    await db.close();
  });
});
