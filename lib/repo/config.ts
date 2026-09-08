/** Configuration: color bands + type→band map. system-design §4. */
import { createRepo, type DbClient, type Row } from "./base";

export const colorBandRepo = {
  ...createRepo("color_band", "band"),

  /** All ten bands in rainbow order (Pink stays even at zero cards). */
  async listOrdered(db: DbClient): Promise<Row<"color_band">[]> {
    const { data, error } = await db
      .from("color_band")
      .select("*")
      .order("position", { ascending: true });
    if (error) throw error;
    return data ?? [];
  },
};

export const typeColorMapRepo = {
  ...createRepo("type_color_map", "card_type"),

  /** The band a card type maps to, or null if unmapped. */
  async bandForType(db: DbClient, cardType: string): Promise<string | null> {
    const { data, error } = await db
      .from("type_color_map")
      .select("band")
      .eq("card_type", cardType)
      .maybeSingle();
    if (error) throw error;
    return data?.band ?? null;
  },
};
