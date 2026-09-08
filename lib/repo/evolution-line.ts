/** EvolutionLine: one line per species chain per color, back half only. system-design §4, §6. */
import { createRepo, type DbClient, type Row } from "./base";

export const evolutionLineRepo = {
  ...createRepo("evolution_line"),

  /** Line uniqueness key: (rootDexId, colorBand). */
  async findByRootAndBand(
    db: DbClient,
    rootDexId: number,
    colorBand: string,
  ): Promise<Row<"evolution_line"> | null> {
    const { data, error } = await db
      .from("evolution_line")
      .select("*")
      .eq("root_dex_id", rootDexId)
      .eq("color_band", colorBand)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  },
};
