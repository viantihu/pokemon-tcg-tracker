// @vitest-environment jsdom
/**
 * UIL-106 (3) — Settings when a change cannot reach the server at all.
 *
 * A server action THROWS when the app was redeployed under an open page or the connection dropped. Settings'
 * handlers reset `busy` in a `finally` but had nothing to catch the throw, so a reorder, a delete or a
 * type-band change that never arrived looked exactly like one that did: no message, and the screen showed
 * the old state with no word why. Driven through the REAL screen in a DOM, each action scripted to reject.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsData } from "@/app/(ui)/settings/settings-types";
import { LOST } from "@/app/(ui)/_components/reach";
import { SettingsScreen } from "@/app/(ui)/settings/SettingsScreen";

const loadSettings = vi.fn();
const saveBinder = vi.fn();
const deleteBinder = vi.fn();
const reorderBands = vi.fn();
const setTypeBand = vi.fn();
vi.mock("@/app/(ui)/settings/actions", () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...a),
  saveBinder: (...a: unknown[]) => saveBinder(...a),
  deleteBinder: (...a: unknown[]) => deleteBinder(...a),
  reorderBands: (...a: unknown[]) => reorderBands(...a),
  setTypeBand: (...a: unknown[]) => setTypeBand(...a),
}));

const LOST_CALL = () => new TypeError("Failed to fetch");

const DATA: SettingsData = {
  binders: [
    {
      id: "kb1",
      name: "KB-001",
      type: "general",
      pages: 40,
      pocketsPerPage: 9,
      backHalfStartPage: 21,
      isActive: true,
    },
  ],
  bands: [
    { band: "red", displayName: "Red", position: 0 },
    { band: "orange", displayName: "Orange", position: 1 },
  ],
  typeMap: [{ cardType: "Fire", band: "red" }],
};

const alerts = () =>
  screen
    .queryAllByRole("alert")
    .map((a) => a.textContent)
    .join(" | ");

async function mount() {
  const user = userEvent.setup();
  render(createElement(SettingsScreen));
  await screen.findByText("KB-001");
  return user;
}

beforeEach(() => {
  for (const f of [loadSettings, saveBinder, deleteBinder, reorderBands, setTypeBand])
    f.mockReset();
  loadSettings.mockResolvedValue(DATA);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UIL-106 · a Settings change that cannot reach the server says so", () => {
  it("reordering the rainbow", async () => {
    reorderBands.mockRejectedValue(LOST_CALL());
    const user = await mount();
    await user.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    // PRE-FIX: `busy` reset, nothing said — the order simply did not change.
    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(
      (screen.getAllByRole("button", { name: "Move down" })[0] as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("deleting a binder", async () => {
    deleteBinder.mockRejectedValue(LOST_CALL());
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "✕" }));
    await waitFor(() => expect(alerts()).toContain(LOST.action));
  });

  it("changing a type's band", async () => {
    setTypeBand.mockRejectedValue(LOST_CALL());
    const user = await mount();
    await user.selectOptions(screen.getByRole("combobox", { name: "Band for Fire" }), "orange");
    await waitFor(() => expect(alerts()).toContain(LOST.action));
  });

  it("an answer the server gives is still shown in its own words", async () => {
    deleteBinder.mockResolvedValue({ ok: false, error: "That binder still holds cards." });
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "✕" }));
    await waitFor(() => expect(alerts()).toContain("That binder still holds cards."));
    expect(alerts()).not.toContain(LOST.action);
  });
});
