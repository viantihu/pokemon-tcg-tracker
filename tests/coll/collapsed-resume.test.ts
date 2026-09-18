/**
 * UIL-059 — "If the user left the collections page expanded, it must stay expanded."
 *
 * The collapsed-ids Set is restored from sessionStorage in `CollectionsView`'s `useState` lazy
 * initializer (UIL-034's fold, now persisted). Exercised through the real component, against a
 * `sessionStorage` stub, exactly as `plan-resume-collapse.test.ts` does for the Plan screen's resume:
 * `useEffect` never runs under `renderToStaticMarkup`, so this only proves the READ side (restoring
 * on mount). The write side is a plain `JSON.stringify` + `setItem`, symmetric with the untouched,
 * equally-unexercised-in-isolation `writeResume` this mirrors.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectionsView } from "@/app/(ui)/coll/CollHub";
import type { CollectionView, CollHubData } from "@/app/(ui)/coll/coll-types";

const KEY = "binderops.coll-collapsed.v1";
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function collection(id: string, name: string): CollectionView {
  return {
    id,
    name,
    mode: "finite",
    binderIds: ["b1"],
    binderNames: ["Specialty A"],
    cards: [],
    ownedCount: 0,
    totalCount: 0,
    incomplete: false,
  };
}

function data(...cols: CollectionView[]): CollHubData {
  return {
    collections: cols,
    specialtyBinders: [],
    wishlist: { groups: [], entries: [] },
    moveOptions: { binders: [], collectionsByBinder: {}, bands: [] },
  };
}

function render(d: CollHubData): string {
  return renderToStaticMarkup(
    createElement(CollectionsView, {
      data: d,
      busy: false,
      onNew: () => {},
      onEdit: () => {},
      onMode: () => {},
      onDelete: () => {},
      onLog: () => {},
      onWishlist: () => {},
      onRemove: () => {},
    }),
  );
}

describe("UIL-059 · collapsed collections resume from sessionStorage", () => {
  it("first-ever visit (nothing stored) still folds every collection, unchanged from before", () => {
    const html = render(data(collection("col-1", "Matsuno"), collection("col-2", "Kagemaru")));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-expanded="true"');
  });

  it("restores exactly what was left expanded last time, not everything", () => {
    store.set(KEY, JSON.stringify(["col-1"])); // col-1 left collapsed; col-2 left expanded
    const html = render(data(collection("col-1", "Matsuno"), collection("col-2", "Kagemaru")));

    const col1 = html.slice(html.indexOf("Matsuno") - 400, html.indexOf("Matsuno"));
    const col2 = html.slice(html.indexOf("Kagemaru") - 400, html.indexOf("Kagemaru"));
    expect(col1).toContain('aria-expanded="false"');
    expect(col2).toContain('aria-expanded="true"');
  });

  it("a brand-new collection absent from an old stored set still opens expanded", () => {
    // Stored BEFORE "col-3" existed — it was never collapsed because it didn't exist to collapse.
    store.set(KEY, JSON.stringify(["col-1"]));
    const html = render(data(collection("col-1", "Matsuno"), collection("col-3", "Just created")));
    const col3 = html.slice(html.indexOf("Just created") - 400, html.indexOf("Just created"));
    expect(col3).toContain('aria-expanded="true"');
  });

  it("a stale id for a since-deleted collection is harmless", () => {
    store.set(KEY, JSON.stringify(["col-1", "col-deleted-long-ago"]));
    const html = render(data(collection("col-1", "Matsuno")));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("col-deleted-long-ago");
  });

  it("a corrupt stored value falls back to the old all-collapsed default, not a crash", () => {
    store.set(KEY, "{not json");
    const html = render(data(collection("col-1", "Matsuno")));
    expect(html).toContain('aria-expanded="false"');
  });
});
