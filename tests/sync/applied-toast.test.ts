/**
 * UIL-102 follow-up — the toast after an apply says how many variant flags it corrected, in the preview's
 * own words, and points back at the preview's list (where the cards to check are named). Pure.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(ui)/sync/actions", () => ({}));

import { appliedToast } from "@/app/(ui)/sync/SyncScreen";

const base = { added: 1, removed: 0, variantChanges: 0 };

describe("UIL-102 · the apply toast names corrected flags", () => {
  it("says how many were corrected, in the preview's words, and where to look", () => {
    expect(appliedToast({ ...base, flagFixes: 3 })).toBe(
      "Applied · 1 added · 0 removed · 0 variant changes · 3 variant flags corrected (check the pockets " +
        "listed in the preview). Undo available.",
    );
    expect(appliedToast({ ...base, flagFixes: 1 })).toContain("1 variant flag corrected");
  });

  it("with nothing corrected it reads exactly as it did before", () => {
    expect(appliedToast({ ...base, flagFixes: 0 })).toBe(
      "Applied · 1 added · 0 removed · 0 variant changes. Undo available.",
    );
  });
});
