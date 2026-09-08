/**
 * Collections + placement picker (dev-spec §5 M8 acceptance: "a collection created in
 * Settings/Collections immediately appears in the intake placement picker").
 */

import { describe, expect, it } from "vitest";
import {
  collectionMode,
  finiteProgress,
  placementCollections,
  placementPickerOptions,
} from "@/lib/surfaces";

describe("collectionMode", () => {
  it("reads the finite/open toggle off status, defaulting legacy rows to open", () => {
    expect(collectionMode("finite")).toBe("finite");
    expect(collectionMode("open")).toBe("open");
    expect(collectionMode("active")).toBe("open"); // legacy seed value
    expect(collectionMode(null)).toBe("open");
  });
});

describe("finiteProgress", () => {
  it("computes owned/total, percent, and the wishlist gap", () => {
    expect(finiteProgress(6, 3)).toEqual({ owned: 3, total: 6, pct: 50, needed: 3 });
    expect(finiteProgress(0, 0)).toEqual({ owned: 0, total: 0, pct: 0, needed: 0 });
    // owned is clamped to total (a stray extra copy can't push it past 100%).
    expect(finiteProgress(2, 5)).toEqual({ owned: 2, total: 2, pct: 100, needed: 0 });
  });
});

describe("placementPickerOptions", () => {
  const binders = [
    { id: "b1", name: "Binder 1", type: "general" },
    { id: "spec", name: "Specialty Binder A", type: "specialty" },
  ];

  it("lists each specialty binder's collections; a new collection surfaces immediately", () => {
    const collections = [
      { id: "a1", name: "Matsuno", current_binder_ids: ["spec"] },
      { id: "a2", name: "Okubo", current_binder_ids: ["spec"] },
    ];
    const options = placementPickerOptions(binders, collections);

    const spec = options.find((o) => o.binderId === "spec")!;
    expect(spec.type).toBe("specialty");
    expect(spec.collections.map((c) => c.name)).toEqual(["Matsuno", "Okubo"]);

    // Simulate saving a brand-new collection into that binder — it appears on the next read.
    const withNew = [...collections, { id: "a3", name: "Cityscape", current_binder_ids: ["spec"] }];
    const after = placementPickerOptions(binders, withNew).find((o) => o.binderId === "spec")!;
    expect(after.collections.map((c) => c.name)).toContain("Cityscape");
  });

  it("a general binder carries no collections", () => {
    const options = placementPickerOptions(binders, [
      { id: "a1", name: "Matsuno", current_binder_ids: ["spec"] },
    ]);
    expect(options.find((o) => o.binderId === "b1")!.collections).toEqual([]);
  });

  it("placementCollections is the flat list of claim targets", () => {
    expect(
      placementCollections([
        { id: "a1", name: "Matsuno", current_binder_ids: ["spec"] },
        { id: "a2", name: "Okubo", current_binder_ids: ["spec"] },
      ]),
    ).toEqual([
      { id: "a1", name: "Matsuno" },
      { id: "a2", name: "Okubo" },
    ]);
  });
});
