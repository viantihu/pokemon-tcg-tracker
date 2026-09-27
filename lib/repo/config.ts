/**
 * Configuration: colour bands + type→band map. system-design §4.
 *
 * PER OWNER since 0033 (UIL-127b; Karvi: colour settings are per user). The band KEYS are global: `color_band.band`
 * is the one registry, and the FK target of every stored band, so no stored band changes meaning. What is hers is
 * the ORDER (`owner_band_order`) and the MAP (`owner_type_band`). An account that has never changed either reads the
 * global rows, the defaults every account starts from.
 *
 * THE ONE READ POINT. Every reader of band order or the type map goes through these two functions, which return the
 * same shapes as before (tests/repo/band-reads-one-place.test.ts scans for any other). Both read through the
 * caller's RLS client, so "her rows" means the signed-in owner's. Writes go through apply_write_ops
 * (`set_band_order`, `set_type_band`), so nothing here writes.
 */
import type { DbClient, Row } from "./base";

export const colorBandRepo = {
  /** All ten bands in HER rainbow order (Pink stays even at zero cards). */
  async listOrdered(db: DbClient): Promise<Row<"color_band">[]> {
    const [defaults, mine] = await Promise.all([
      db.from("color_band").select("*").order("position", { ascending: true }),
      db.from("owner_band_order").select("band, position").order("position", { ascending: true }),
    ]);
    if (defaults.error) throw defaults.error;
    if (mine.error) throw mine.error;
    const global = defaults.data ?? [];
    const own = mine.data ?? [];
    if (own.length === 0) return global;
    const byKey = new Map(global.map((b) => [b.band, b]));
    return own.flatMap((o) => {
      const b = byKey.get(o.band);
      return b ? [{ band: o.band, display_name: b.display_name, position: o.position }] : [];
    });
  },
};

export const typeColorMapRepo = {
  /** HER type→band map: her own rows when she has any, else the global defaults. */
  async list(db: DbClient): Promise<Row<"type_color_map">[]> {
    const mine = await db.from("owner_type_band").select("card_type, band");
    if (mine.error) throw mine.error;
    if ((mine.data ?? []).length > 0) return mine.data ?? [];
    const defaults = await db.from("type_color_map").select("card_type, band");
    if (defaults.error) throw defaults.error;
    return defaults.data ?? [];
  },
};
