// @vitest-environment jsdom
/**
 * UIL-060 Half 1, the form — driven through the REAL MatchOverlay in a DOM (QA's rule for a click path).
 * Under the search grid sits a disclosure: "Not in the catalog? Create a stand-in and match to it." It is
 * prefilled from the entry (name, set name, number), requires a card kind — a Pokémon needs its type or
 * the engine would band it White — and submits ONE input the server turns into one transaction. A twin
 * comes back as a refusal rendered in place, with "match to the existing stand-in instead".
 */
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchOverlay } from "@/app/(ui)/sync/SyncScreen";
import type { QueueEntryView, StandInFormInput, StandInOutcome } from "@/app/(ui)/sync/sync-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(ui)/sync/actions", () => ({
  searchCatalog: vi.fn(async () => []),
  createStandInAndMatch: vi.fn(),
  manualMatchEntry: vi.fn(),
}));

const ENTRY: QueueEntryView = {
  id: "e1",
  dexId: "sv03-999",
  dexName: "Mystery Fossil",
  dexSetName: "Obsidian Flames",
  dexSeries: "SV",
  dexNumber: "999",
  dexVariantRaw: "Normal",
  quantity: 2,
  locale: "English",
  reason: "UNKNOWN_CARD",
  status: "WAITING",
  firstSeenSync: "2026-09-19T00:00:00Z",
  lastRetrySync: null,
  retryCount: 0,
  manualMatchId: null,
  aliasKey: "en:sv03",
} as QueueEntryView;

function mount(outcome: StandInOutcome = { ok: true, standInId: "user:1" }) {
  const onStandIn = vi.fn<(input: StandInFormInput) => Promise<StandInOutcome>>(
    async () => outcome,
  );
  const onPicked = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(MatchOverlay, {
      entry: ENTRY,
      cardTypes: ["Fire", "Water"],
      onClose: () => {},
      onPicked,
      onStandIn,
    }),
  );
  return { onStandIn, onPicked, user };
}

const form = () => within(document.querySelector("details.standin") as HTMLElement);
const submit = () =>
  form().getByRole("button", { name: /Create the stand-in and match/ }) as HTMLButtonElement;
const open = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByText(/Not in the catalog\? Create a stand-in/));

afterEach(cleanup);

describe("UIL-060 · the stand-in disclosure under the search", () => {
  it("is prefilled from the entry, defaults to Pokémon, and will not submit without a type", async () => {
    const { user } = mount();
    await open(user);
    expect((form().getByDisplayValue("Mystery Fossil") as HTMLInputElement).value).toBe(
      "Mystery Fossil",
    );
    expect(form().getByDisplayValue("Obsidian Flames")).toBeTruthy();
    expect(form().getByDisplayValue("999")).toBeTruthy();
    expect(form().getByRole("button", { name: "Pokémon" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(submit().disabled).toBe(true); // no type yet
    await user.selectOptions(form().getByLabelText("Type"), "Fire");
    expect(submit().disabled).toBe(false);
  });

  it("Pokémon + type + stage + Pokédex number → one input with the derived kind; the set id is NOT typed here", async () => {
    const { user, onStandIn } = mount();
    await open(user);
    await user.selectOptions(form().getByLabelText("Type"), "Fire");
    await user.selectOptions(form().getByLabelText("Stage"), "Stage1");
    await user.type(form().getByLabelText("Pokédex number"), "5");
    await user.click(submit());
    expect(onStandIn).toHaveBeenCalledWith({
      name: "Mystery Fossil",
      setName: "Obsidian Flames",
      localId: "999",
      kind: { kind: "pokemon", type: "Fire", stage: "Stage1", dexId: 5 },
    });
    expect(JSON.stringify(onStandIn.mock.calls[0][0])).not.toContain("setId");
  });

  it("Trainer needs no type: submits at once with kind trainer", async () => {
    const { user, onStandIn } = mount();
    await open(user);
    await user.click(form().getByRole("button", { name: "Trainer" }));
    expect(screen.getByText(/files with the white band/)).toBeTruthy();
    expect(submit().disabled).toBe(false);
    await user.click(submit());
    expect(onStandIn.mock.calls[0][0]).toMatchObject({ kind: { kind: "trainer" } });
  });

  it("a twin refusal is shown in place, and 'match to the existing stand-in instead' hands its id to onPicked", async () => {
    const { user, onPicked } = mount({
      ok: false,
      twin: {
        tcgdexId: "user:abc",
        name: "Mystery Fossil",
        setName: "Obsidian Flames",
        localId: "999",
      },
      error: "already exists",
    });
    await open(user);
    await user.click(form().getByRole("button", { name: "Trainer" }));
    await user.click(submit());
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /Match to the existing stand-in instead/ }),
    );
    expect(onPicked).toHaveBeenCalledWith("user:abc");
  });

  it("a plain failure is shown as an alert and the form stays", async () => {
    const { user } = mount({ ok: false, error: "Could not reach the database" });
    await open(user);
    await user.click(form().getByRole("button", { name: "Energy" }));
    await user.click(submit());
    expect(await screen.findByText(/Could not reach the database/)).toBeTruthy();
    expect(submit()).toBeTruthy();
  });
});
