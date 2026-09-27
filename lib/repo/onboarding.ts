/** Onboarding: whether an account has finished or skipped the first-run tutorial (UIL-128, 0031). */
import { createRepo, type DbClient } from "./base";

export const onboardingRepo = {
  ...createRepo("onboarding", "owner_id"),

  /** True once this account has finished or skipped the tutorial. RLS scopes the read to the caller. */
  async tutorialDone(db: DbClient): Promise<boolean> {
    const { data, error } = await db.from("onboarding").select("owner_id").maybeSingle();
    if (error) throw error;
    return data !== null;
  },

  /** Record the tutorial as done. Idempotent: a replay finished again only moves the timestamp. */
  async markTutorialDone(db: DbClient): Promise<void> {
    const { error } = await db
      .from("onboarding")
      .upsert({ tutorial_done_at: new Date().toISOString() }, { onConflict: "owner_id" });
    if (error) throw error;
  },
};
