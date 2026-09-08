/**
 * M1 acceptance criteria (dev-spec §5), verified against a running local Supabase.
 *
 *   1. RLS denies an UNAUTHENTICATED read on every domain table (and the binder_section view).
 *   2. color_band holds all 10 bands including the empty Pink, in rainbow order.
 *   3. type_color_map matches the confirmed table (system-design §4) exactly.
 *
 * The suite auto-detects the local stack via `supabase status -o env` and SKIPS when none is
 * running, so the merge gate (`pnpm test`) stays green without Docker. To run it for real:
 *
 *   supabase start && supabase db reset   # apply 0001+0002, load seed.sql
 *   pnpm test
 */
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/repo/database.types";
import { colorBandRepo, typeColorMapRepo } from "@/lib/repo";

function localEnv(): { url: string; anonKey: string; serviceKey: string } | null {
  try {
    const out = execSync("supabase status -o env", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const get = (k: string) => out.match(new RegExp(`^${k}="?([^"\\n]+)"?`, "m"))?.[1] ?? "";
    const url = get("API_URL");
    const anonKey = get("ANON_KEY");
    const serviceKey = get("SERVICE_ROLE_KEY");
    return url && anonKey && serviceKey ? { url, anonKey, serviceKey } : null;
  } catch {
    return null;
  }
}

// Every table that ships with RLS in 0002, plus the derived view — all must deny anon reads.
const RLS_RELATIONS = [
  "color_band",
  "type_color_map",
  "catalog_card",
  "haul",
  "binder",
  "collection",
  "evolution_line",
  "presence_group",
  "copy",
  "line_slot",
  "wishlist_item",
  "binder_block",
  "placement_decision",
  "unresolved_entry",
  "set_alias",
  "last_sync_snapshot",
  "binder_section",
] as const;

// The confirmed energy-type → band map (system-design §4). White absorbs the last five.
const EXPECTED_TYPE_COLOR_MAP: Record<string, string> = {
  Fire: "red",
  Fighting: "orange",
  Lightning: "yellow",
  Dragon: "olive",
  Grass: "green",
  Darkness: "dark_blue",
  Water: "light_blue",
  Psychic: "purple",
  Fairy: "pink",
  Colorless: "white",
  Metal: "white",
  Trainer: "white",
  Supporter: "white",
  Item: "white",
};

const EXPECTED_BANDS_IN_ORDER = [
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

const env = localEnv();
// Safe fallback so the suite body (which Vitest still evaluates at collection time even when
// skipped) never dereferences null. The dummy URL is a valid format, so no client throws; a
// skipped suite makes zero requests.
const e = env ?? { url: "http://127.0.0.1:54321", anonKey: "anon", serviceKey: "service" };

describe.skipIf(env === null)("M1 acceptance — local Supabase", () => {
  const service = createClient<Database>(e.url, e.serviceKey);
  // Untyped view for the RLS loop: .from() cannot take a Tables∪Views union under the typed client.
  const anonAny: SupabaseClient = createClient(e.url, e.anonKey);

  describe("RLS denies unauthenticated reads", () => {
    it.each(RLS_RELATIONS)("anon cannot read %s", async (relation) => {
      // Anon has no policy → PostgREST returns either an empty set or a permission error; both
      // are "denied". A non-empty result would be the failure.
      const { data } = await anonAny.from(relation).select("*");
      expect(data ?? []).toHaveLength(0);
    });

    it("service role DOES see seeded data (proves RLS is filtering, not empty tables)", async () => {
      const bands = await service.from("color_band").select("band");
      expect(bands.data ?? []).toHaveLength(10);
      const cards = await service.from("catalog_card").select("tcgdex_id");
      expect((cards.data ?? []).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("color bands", () => {
    it("holds all 10 bands in rainbow order, Pink present at position 9", async () => {
      const bands = await colorBandRepo.listOrdered(service);
      expect(bands.map((b) => b.band)).toEqual(EXPECTED_BANDS_IN_ORDER);
      expect(bands.map((b) => b.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const pink = bands.find((b) => b.band === "pink");
      expect(pink).toBeDefined();
      expect(pink!.position).toBe(9);
      expect(pink!.display_name).toBe("Pink");

      // Pink is genuinely empty: no copy or line carries it (its slot is reserved anyway).
      const pinkCopies = await service.from("copy").select("id").eq("color_band", "pink");
      expect(pinkCopies.data ?? []).toHaveLength(0);
    });
  });

  describe("type→color map", () => {
    it("matches the confirmed table exactly", async () => {
      const rows = await typeColorMapRepo.list(service);
      const actual = Object.fromEntries(rows.map((r) => [r.card_type, r.band]));
      expect(actual).toEqual(EXPECTED_TYPE_COLOR_MAP);
    });
  });
});
