// @vitest-environment jsdom
/**
 * UIL-108, the click paths — the stand-in form asks for the card's language, pre-filled from the Dex row, and
 * a stand-in's language is shown wherever it appears.
 *
 * Driven through the REAL MatchOverlay and the REAL search grid and face in a DOM (QA's rule for a click
 * path). Dex writes "International" for English and "Japanese" for Japanese (the Senior BA's read); anything
 * else pre-fills nothing, and the form will not submit until she picks.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchOverlay } from "@/app/(ui)/sync/SyncScreen";
import { CardFace } from "@/app/(ui)/_components/CardFace";
import { CardResultsGrid } from "@/app/(ui)/_components/CardResultsGrid";
import type { LookupCard } from "@/app/(ui)/plan/plan-types";
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

const UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const entry = (locale: string): QueueEntryView =>
  ({
    id: "e1",
    dexId: "sv03-999",
    dexName: "Mystery Fossil",
    dexSetName: "Obsidian Flames",
    dexSeries: "SV",
    dexNumber: "999",
    dexVariantRaw: "Normal",
    quantity: 1,
    locale,
    reason: "UNKNOWN_CARD",
    status: "WAITING",
    firstSeenSync: "2026-09-26T00:00:00Z",
    lastRetrySync: null,
    retryCount: 0,
    manualMatchId: null,
    aliasKey: "en:sv03",
  }) as QueueEntryView;

function mount(
  locale: string,
  outcome: StandInOutcome = { ok: true, standInId: `user:en:${UUID}` },
) {
  const onStandIn = vi.fn<(input: StandInFormInput) => Promise<StandInOutcome>>(
    async () => outcome,
  );
  const user = userEvent.setup();
  render(
    createElement(MatchOverlay, {
      entry: entry(locale),
      cardTypes: ["Fire"],
      onClose: () => {},
      onPicked: vi.fn(),
      onStandIn,
    }),
  );
  return { onStandIn, user };
}
const form = () => within(document.querySelector("details.standin") as HTMLElement);
const language = () => form().getByLabelText("Language") as HTMLSelectElement;
const submit = () =>
  form().getByRole("button", { name: /Create the stand-in and match/ }) as HTMLButtonElement;
async function openAsTrainer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/Not in the catalog\? Create a stand-in/));
  await user.click(form().getByRole("button", { name: "Trainer" })); // needs no type, so only language gates
}

afterEach(cleanup);

describe("UIL-108 · the stand-in form asks for the language", () => {
  it("offers every language TCGdex publishes", async () => {
    const { user } = mount("International");
    await openAsTrainer(user);
    const names = [...language().options].map((o) => o.textContent);
    expect(names).toContain("French");
    expect(names).toContain("Chinese (Traditional)");
    expect(language().options).toHaveLength(18); // 17 languages and the "pick" prompt
  });

  it("International pre-fills English, and the input carries it", async () => {
    const { user, onStandIn } = mount("International");
    await openAsTrainer(user);
    expect(language().value).toBe("en");
    await user.click(submit());
    expect(onStandIn.mock.calls[0][0]).toMatchObject({ language: "en" });
  });

  it("Japanese pre-fills Japanese", async () => {
    const { user } = mount("Japanese");
    await openAsTrainer(user);
    expect(language().value).toBe("ja");
  });

  it("anything else pre-fills nothing, and it will not submit until she picks", async () => {
    const { user, onStandIn } = mount("Klingon");
    await openAsTrainer(user);
    expect(language().value).toBe("");
    expect(submit().disabled).toBe(true);
    await user.selectOptions(language(), "fr");
    expect(submit().disabled).toBe(false);
    await user.click(submit());
    expect(onStandIn.mock.calls[0][0]).toMatchObject({ language: "fr" });
  });

  it("a twin refusal names the twin's language", async () => {
    const { user } = mount("International", {
      ok: false,
      twin: {
        tcgdexId: `user:fr:${UUID}`,
        name: "Mystery Fossil",
        setName: "Obsidian Flames",
        localId: "999",
      },
      error: "already exists",
    });
    await openAsTrainer(user);
    await user.click(submit());
    await waitFor(() => expect(form().getByText(/\(French\) already exists/)).toBeTruthy());
  });
});

describe("UIL-108 · a stand-in's language is shown wherever it appears", () => {
  it("its face (always the sigil: a stand-in has no art) is badged with the language, and says so", () => {
    render(
      createElement(CardFace, {
        name: "Mystery Fossil",
        imageUrl: null,
        tcgdexId: `user:fr:${UUID}`,
      }),
    );
    expect(document.querySelector(".fallback .lang")?.textContent).toBe("FR");
    expect(screen.getByRole("img", { name: "Mystery Fossil, your stand-in, French" })).toBeTruthy();
  });

  it("a catalog card's face carries no badge; a stand-in made before UIL-108 says its language is not recorded", () => {
    render(createElement(CardFace, { name: "Charmeleon", imageUrl: null, tcgdexId: "sv03-027" }));
    expect(document.querySelector(".fallback .lang")).toBeNull();
    cleanup();
    render(createElement(CardFace, { name: "Old", imageUrl: null, tcgdexId: `user:${UUID}` }));
    expect(document.querySelector(".fallback .lang")).toBeNull();
    expect(
      screen.getByRole("img", { name: "Old, your stand-in, language not recorded" }),
    ).toBeTruthy();
  });

  it("the match search lists a stand-in as one, with its language, so she can match to it rather than make a twin", async () => {
    const standIn = {
      tcgdexId: `user:ja:${UUID}`,
      name: "Mystery Fossil",
      setId: "ja:SV3",
      setName: "Obsidian Flames",
      localId: "999",
      setCardCountOfficial: null,
      stage: "Basic",
      types: ["Fire"],
      imageUrl: null,
    } as unknown as LookupCard;
    const user = userEvent.setup();
    render(createElement(CardResultsGrid, { search: async () => [standIn], onPick: vi.fn() }));
    await user.type(screen.getByRole("textbox"), "Fossil");
    await waitFor(() => expect(screen.getByText(/Obsidian Flames · Stand-in · JA/)).toBeTruthy());
    // One tag, not "JA" as a Japanese printing and again as a stand-in.
    expect(document.body.textContent).not.toMatch(/JA · Stand-in|Stand-in · JA · JA/);
  });
});
