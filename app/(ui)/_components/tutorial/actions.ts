"use server";

/**
 * The first-run tutorial's two server actions (UIL-128). Both are scoped to the signed-in account by RLS; neither
 * takes an id from the browser. A "use server" file exports only async functions (E352, 2026-09-26), so the
 * tutorial's words and types live in ./steps.
 */

import { getOwnerContext } from "@/lib/plan";
import { binderRepo, copyRepo, dexImportRepo, onboardingRepo } from "@/lib/repo";
import type { TutorialNext } from "./steps";

/** Record the tutorial as done (finished or skipped), so it does not open by itself again. */
export async function finishTutorial(): Promise<{ ok: true } | { ok: false }> {
  try {
    const { db } = await getOwnerContext();
    await onboardingRepo.markTutorialDone(db);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * What her account still needs first, for the finish step's button: a binder, then an import, else Haul Plan.
 * Null when it cannot be read; the finish step then shows a plain Done.
 */
export async function loadTutorialNext(): Promise<TutorialNext | null> {
  try {
    const { db } = await getOwnerContext();
    const [binders, copies, dexImport] = await Promise.all([
      binderRepo.count(db),
      copyRepo.count(db),
      dexImportRepo.get(db),
    ]);
    if (binders === 0) return "binder";
    if (copies === 0 && dexImport === null) return "import";
    return "plan";
  } catch {
    return null;
  }
}
