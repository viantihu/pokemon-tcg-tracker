/**
 * Collection: a running custom set; membership beats everything in the cascade. system-design §4.
 * Carries a finite/open `mode` column (migration 0005) alongside the active/archived `status`;
 * both flow in through the generic repo's `Row`/`Insert`/`Update` from database.types.ts.
 */
import { createRepo } from "./base";

export const collectionRepo = createRepo("collection");
