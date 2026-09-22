/** EvolutionLine: one line per species chain per color, back half only. system-design §4, §6. */
import { createRepo, type DbClient, type Row } from "./base";

export const evolutionLineRepo = {
  ...createRepo("evolution_line"),

  /**
   * Line uniqueness key: (binderId, rootDexId, colorBand) — one line per species per band per BINDER
   * (UIL-084). It was (rootDexId, colorBand), which made a line in ANY binder own that species-and-band
   * everywhere: Karvi, deliberately filling a second binder, could not start a line there for a species
   * her first binder already had, and the refusal's remedy ("join it instead") named an action that did
   * not exist when that line's matching stage was already filled.
   *
   * `binderId` is nullable on the row, so a null binder is matched with `is`, not `eq` — `eq(null)`
   * matches nothing in PostgREST and would have read as "no line here" for exactly the rows a line
   * without a binder occupies.
   *
   * NOT `.maybeSingle()`, deliberately. Nothing in the schema enforces this key
   * (`evolution_line_root_band_idx` is a plain index), so duplicates are possible — from data that
   * predates this rule, or a race — and `maybeSingle()` answers two rows by THROWING
   * ("JSON object requested, multiple (or no) rows returned"), turning a clean refusal into a raw
   * error the screen cannot explain. Verified against PGlite. Taking the first row keeps the check
   * answering the question it was asked: does a line already live here.
   */
  async findAllByRootBandAndBinder(
    db: DbClient,
    rootDexId: number,
    colorBand: string,
    binderId: string | null,
  ): Promise<Row<"evolution_line">[]> {
    const base = db
      .from("evolution_line")
      .select("*")
      .eq("root_dex_id", rootDexId)
      .eq("color_band", colorBand);
    const { data, error } = await (binderId === null
      ? base.is("binder_id", null)
      : base.eq("binder_id", binderId));
    if (error) throw error;
    /**
     * EVERY match, not the first (UIL-090). One binder and band can now legitimately hold two lines for
     * a species — an English one and a Japanese one — and which of them occupies the caller's key can
     * only be judged from each line's SLOTS, because `root_dex_id` is a species key shared by both
     * regional variants. So the caller derives each candidate's locale; this returns the shortlist.
     * Normally zero or one row.
     */
    return data ?? [];
  },
};
