/**
 * UIL-127a — a brand-new account has no binder, and nothing may be shelved in NO binder.
 *
 * Before: with zero binders the cascade routed every shelf target to `binderId: null`, and the commit wrote a
 * shelved copy with no binder at all, silently (0029 accepts a null binder; 0028's slot check treats null = null
 * as equal). The Keep path wrote `""`, an opaque 22P02; the join path said "another binder".
 *
 * What must hold: the real cascade's plan for an account with no binder is refused in her words, naming the card;
 * a binder that is not hers is refused the same way; and (the Tech Lead's C3) a copy the payload does not re-home
 * is never refused for having no binder, so a card left binderless by a deleted binder stays movable.
 */
import { describe, expect, it } from "vitest";
import type { Binder, EngineContext } from "@/lib/engine";
import {
  assertPlacementBindersConfigured,
  buildHaulCommitPayload,
  planFromDraft,
  type DraftItem,
  type PlanContext,
} from "@/lib/plan";
import { NO_BINDER } from "@/lib/plan/no-binder";
import type { Row, WritePayload } from "@/lib/repo";
import { SCYTHER_SV035_123 } from "../engine/fixtures";
import { haulRow } from "../support/pglite-rpc";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const NOT_HERS = "1c000000-0000-0000-0000-00000000dead";
const BANDS = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
];
const TYPE_COLOR_MAP: Record<string, string> = {
  Grass: "green",
  Colorless: "white",
  Trainer: "white",
};
const CARD: DraftItem = haulRow("d0000000-0000-4000-8000-00000000b1d1", SCYTHER_SV035_123.tcgdexId);

function context(binders: Binder[], copies: Partial<Row<"copy">>[] = []): PlanContext {
  const catalogById = new Map([[SCYTHER_SV035_123.tcgdexId, SCYTHER_SV035_123]]);
  const haul = {
    id: CARD.existingCopyId!,
    catalog_card_id: CARD.tcgdexId,
    variant: "normal",
    role: "haul",
    binder_id: null,
    binder_half: null,
    color_band: null,
    line_slot_id: null,
  };
  const copyRowById = new Map([haul, ...copies].map((c) => [c.id!, c as unknown as Row<"copy">]));
  const ctx: EngineContext = {
    typeColorMap: TYPE_COLOR_MAP,
    catalog: [SCYTHER_SV035_123],
    owned: [],
    binders,
    lines: [],
    collections: [],
    now: "2026-09-27T00:00:00.000Z",
  };
  return {
    ctx,
    catalogById,
    copyRowById,
    slotRowsByLine: new Map(),
    orderedBandKeys: BANDS,
    lookups: {
      binderNameById: new Map(binders.map((b) => [b.id, b.name])),
      bandDisplayByKey: new Map(BANDS.map((b) => [b, b])),
      collectionNameById: new Map(),
      imageUrlByTcgdexId: new Map(),
    },
  } as unknown as PlanContext;
}

const GENERAL: Binder = { id: B1, name: "Binder 1", type: "general", isActive: true };

function planned(pc: PlanContext): WritePayload {
  const { planned: p } = planFromDraft(pc, [CARD]);
  return buildHaulCommitPayload(pc, p, { draft: [CARD] }).payload;
}

describe("UIL-127a · an account with no binder cannot shelve a card", () => {
  it("the real cascade's plan, with no binder, is refused in her words, naming the card", () => {
    const pc = context([]);
    const payload = planned(pc);
    // The cascade really does route it to no binder: that is the write this guard exists to stop.
    const shelf = payload.ops.find((o) => o.op === "update_copy" && o.patch.role === "shelved");
    expect(shelf && shelf.op === "update_copy" ? shelf.patch.binder_id : "absent").toBeNull();
    expect(() => assertPlacementBindersConfigured(payload, pc)).toThrow(
      NO_BINDER.refusal(SCYTHER_SV035_123.name),
    );
  });

  it("the same card, once she has a binder, goes through", () => {
    const pc = context([GENERAL]);
    expect(() => assertPlacementBindersConfigured(planned(pc), pc)).not.toThrow();
  });
});

describe("UIL-127a · only binders she has", () => {
  const pc = context(
    [GENERAL],
    [
      {
        id: "c0000000-0000-4000-8000-0000000000c1",
        catalog_card_id: SCYTHER_SV035_123.tcgdexId,
        role: "shelved",
        binder_id: null,
      },
    ],
  );

  it("a copy re-homed to a binder that is not hers is refused", () => {
    const payload: WritePayload = {
      ops: [
        {
          op: "update_copy",
          id: CARD.existingCopyId!,
          patch: { role: "shelved", binder_id: NOT_HERS },
        },
      ],
    };
    expect(() => assertPlacementBindersConfigured(payload, pc)).toThrow(/has no binder to go to/);
  });

  it("a new line in no binder, or one that is not hers, is refused", () => {
    for (const binder_id of [null, NOT_HERS]) {
      const payload: WritePayload = {
        ops: [
          {
            op: "insert_line",
            id: "10000000-0000-4000-8000-000000000001",
            root_dex_id: 123,
            color_band: "green",
            binder_id,
          },
        ],
      };
      expect(() => assertPlacementBindersConfigured(payload, pc)).toThrow(
        /evolution line for dex #123/,
      );
    }
  });

  it("a copy going to bulk needs no binder", () => {
    const payload: WritePayload = {
      ops: [
        { op: "update_copy", id: CARD.existingCopyId!, patch: { role: "bulk", binder_id: null } },
      ],
    };
    expect(() => assertPlacementBindersConfigured(payload, pc)).not.toThrow();
  });

  it("C3: a shelved copy left with no binder (its binder was deleted) is not refused when the payload does not re-home it", () => {
    const payload: WritePayload = {
      ops: [
        {
          op: "update_copy",
          id: "c0000000-0000-4000-8000-0000000000c1",
          patch: { line_slot_id: null },
        },
      ],
    };
    expect(() => assertPlacementBindersConfigured(payload, pc)).not.toThrow();
  });

  it("C3: …and moving it into one of her binders goes through", () => {
    const payload: WritePayload = {
      ops: [
        {
          op: "update_copy",
          id: "c0000000-0000-4000-8000-0000000000c1",
          patch: { binder_id: B1, binder_half: "front" },
        },
      ],
    };
    expect(() => assertPlacementBindersConfigured(payload, pc)).not.toThrow();
  });
});
