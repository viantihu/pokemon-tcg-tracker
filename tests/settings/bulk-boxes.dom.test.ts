// @vitest-environment jsdom
/**
 * UIL-130 — Settings · Bulk boxes, driven through the REAL screen in a DOM (the server actions stood in for).
 *
 * Karvi, 2026-09-29: boxes added like binders, each with a name; a card limit or none (a new box starts with none);
 * a box with a limit that is full takes no more; she always has exactly one default box; a box is deleted only with
 * somewhere for its cards to go, never her last one.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsData } from "@/app/(ui)/settings/settings-types";
import { SettingsScreen } from "@/app/(ui)/settings/SettingsScreen";
import { boxLoad } from "@/app/(ui)/settings/BulkBoxes";

const loadSettings = vi.fn();
const saveBulkUnit = vi.fn();
const setDefaultBulkUnit = vi.fn();
const deleteBulkUnit = vi.fn();
vi.mock("@/app/(ui)/settings/actions", () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...a),
  saveBinder: vi.fn(),
  deleteBinder: vi.fn(),
  reorderBands: vi.fn(),
  setTypeBand: vi.fn(),
  saveBulkUnit: (...a: unknown[]) => saveBulkUnit(...a),
  setDefaultBulkUnit: (...a: unknown[]) => setDefaultBulkUnit(...a),
  deleteBulkUnit: (...a: unknown[]) => deleteBulkUnit(...a),
}));

const base = (units: SettingsData["bulkUnits"]): SettingsData => ({
  bulkUnits: units,
  binders: [],
  bands: [{ band: "red", displayName: "Red", position: 0 }],
  typeMap: [],
});
const ONE = base([{ id: "bx1", name: "Bulk box", capacity: null, isDefault: true, held: 54 }]);
const TWO = base([
  { id: "bx1", name: "Bulk box", capacity: null, isDefault: true, held: 54 },
  { id: "bx2", name: "Shoebox", capacity: 60, isDefault: false, held: 50 },
]);

beforeEach(() => {
  for (const f of [loadSettings, saveBulkUnit, setDefaultBulkUnit, deleteBulkUnit]) f.mockReset();
  for (const f of [saveBulkUnit, setDefaultBulkUnit, deleteBulkUnit])
    f.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

async function mount(data: SettingsData) {
  loadSettings.mockResolvedValue(data);
  const user = userEvent.setup();
  render(createElement(SettingsScreen));
  const panel = await screen.findByRole("region", { name: "Bulk boxes" });
  return { user, panel };
}

describe("UIL-130 · her boxes, in Settings", () => {
  it("each box says what it holds and its limit; her default is marked", async () => {
    const { panel } = await mount(TWO);
    expect(within(panel).getByText("DEFAULT")).toBeTruthy();
    expect(within(panel).getByText("54 cards · no limit")).toBeTruthy();
    expect(within(panel).getByText("50 of 60 cards")).toBeTruthy();
  });

  it("a new box starts with no limit, and is saved by name", async () => {
    const { user, panel } = await mount(ONE);
    await user.click(within(panel).getByRole("button", { name: "＋ New box" }));
    const form = within(panel).getByRole("group", { name: "New box" });
    expect((within(form).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await user.type(within(form).getByRole("textbox"), "Shoebox");
    await user.click(within(form).getByRole("button", { name: "Save box" }));
    await waitFor(() =>
      expect(saveBulkUnit).toHaveBeenCalledWith({ id: null, name: "Shoebox", capacity: null }),
    );
  });

  it("a card limit is turned on per box with a number", async () => {
    const { user, panel } = await mount(ONE);
    await user.click(within(panel).getByRole("button", { name: "Edit Bulk box" }));
    const form = within(panel).getByRole("group", { name: "Edit box" });
    await user.click(within(form).getByRole("checkbox"));
    const n = within(form).getByRole("spinbutton");
    await user.clear(n);
    await user.type(n, "200");
    await user.click(within(form).getByRole("button", { name: "Save box" }));
    await waitFor(() =>
      expect(saveBulkUnit).toHaveBeenCalledWith({ id: "bx1", name: "Bulk box", capacity: 200 }),
    );
  });

  it("another box is made her default in one step", async () => {
    const { user, panel } = await mount(TWO);
    await user.click(within(panel).getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(setDefaultBulkUnit).toHaveBeenCalledWith("bx2"));
  });

  it("her only box cannot be deleted, and says why", async () => {
    const { panel } = await mount(ONE);
    expect(
      (within(panel).getByRole("button", { name: "Delete Bulk box" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(panel).getByText(/Your only bulk box can't be deleted/)).toBeTruthy();
  });

  it("delete asks where its cards go; a box without room for them is named and can't be picked to confirm", async () => {
    const { user, panel } = await mount(TWO);
    await user.click(within(panel).getByRole("button", { name: "Delete Bulk box" }));
    const ask = within(panel).getByRole("group", { name: "Delete Bulk box" });
    expect(within(ask).getByText(/Its 54 cards go to/)).toBeTruthy();
    // Shoebox has room for 10, not 54.
    expect(within(ask).getByRole("alert").textContent).toMatch(/Shoebox has room for 10 cards/);
    expect(
      (within(ask).getByRole("button", { name: "Delete Bulk box" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(deleteBulkUnit).not.toHaveBeenCalled();
  });

  it("delete with room: confirmed, its cards go to the box she picked, and her default passes to it", async () => {
    const { user, panel } = await mount(
      base([
        { id: "bx1", name: "Bulk box", capacity: null, isDefault: true, held: 54 },
        { id: "bx2", name: "Shoebox", capacity: null, isDefault: false, held: 0 },
      ]),
    );
    await user.click(within(panel).getByRole("button", { name: "Delete Bulk box" }));
    const ask = within(panel).getByRole("group", { name: "Delete Bulk box" });
    expect(within(ask).getByText("Shoebox becomes your default box.")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Delete Bulk box" }));
    await waitFor(() => expect(deleteBulkUnit).toHaveBeenCalledWith("bx1", "bx2"));
  });

  it("a refusal from the server is shown in her words", async () => {
    saveBulkUnit.mockResolvedValue({ ok: false, error: "A box needs a name." });
    const { user, panel } = await mount(ONE);
    await user.click(within(panel).getByRole("button", { name: "Edit Bulk box" }));
    await user.click(
      within(within(panel).getByRole("group", { name: "Edit box" })).getByRole("button", {
        name: "Save box",
      }),
    );
    expect(await screen.findByText("A box needs a name.")).toBeTruthy();
  });
});

describe("boxLoad", () => {
  it("says the load in her terms", () => {
    expect(boxLoad({ held: 1, capacity: null })).toBe("1 card · no limit");
    expect(boxLoad({ held: 50, capacity: 60 })).toBe("50 of 60 cards");
    expect(boxLoad({ held: 60, capacity: 60 })).toBe("60 of 60 cards · full");
    expect(boxLoad({ held: 72, capacity: 60 })).toBe("72 of 60 cards · 12 over");
  });
});
