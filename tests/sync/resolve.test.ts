import { describe, it, expect } from "vitest";
import {
  detectLocale,
  parseDexId,
  zeroPad3,
  stripPad,
  localIdCandidates,
  resolveSetId,
  resolveDexId,
} from "@/lib/sync/resolve";

// Every case below is drawn from the VERIFIED evidence in
// docs/sync-architecture.md §1.3 + Appendix (checked against the live TCGdex API).

describe("detectLocale", () => {
  it("maps Japanese rows to the ja locale, everything else to en", () => {
    expect(detectLocale({ Locale: "Japanese" })).toBe("ja");
    expect(detectLocale({ Locale: "English" })).toBe("en");
    expect(detectLocale({ Locale: "" })).toBe("en");
  });
});

describe("parseDexId", () => {
  it("splits set code from localId and strips the jpn_ prefix", () => {
    expect(parseDexId("sv10-103")).toEqual({ rawCode: "sv10", localId: "103" });
    expect(parseDexId("me2-112")).toEqual({ rawCode: "me2", localId: "112" });
    expect(parseDexId("jpn_sv11w-2")).toEqual({ rawCode: "sv11w", localId: "2" });
    expect(parseDexId("jpn_mc-201")).toEqual({ rawCode: "mc", localId: "201" });
  });
});

describe("localId padding helpers", () => {
  it("zero-pads numeric localIds to 3 digits", () => {
    expect(zeroPad3("2")).toBe("002");
    expect(zeroPad3("87")).toBe("087");
    expect(zeroPad3("103")).toBe("103");
    expect(zeroPad3("136")).toBe("136"); // secret rare, left as-is
  });

  it("strips leading zeros", () => {
    expect(stripPad("002")).toBe("2");
    expect(stripPad("087")).toBe("87");
  });

  it("produces ordered, de-duplicated candidates", () => {
    // mep-87 -> tcgdex mep-087 (verified 404 vs 200)
    expect(localIdCandidates("87")).toEqual(["87", "087"]);
    // jpn_sv11w-2 -> ja sv11w-002 (verified)
    expect(localIdCandidates("2")).toEqual(["2", "002"]);
    // already-padded input still yields the stripped variant
    expect(localIdCandidates("087")).toEqual(["087", "87"]);
    // no dupes when all forms coincide
    expect(localIdCandidates("103")).toEqual(["103"]);
  });
});

describe("resolveSetId", () => {
  it("applies the verified me* set-code drift", () => {
    expect(resolveSetId("en", "me2")).toEqual({ setId: "me02", aliased: true });
    // me25 -> me02.5 is a DECIMAL, not a zero-pad. The single most important alias.
    expect(resolveSetId("en", "me25")).toEqual({ setId: "me02.5", aliased: true });
  });

  it("passes unknown set codes through unchanged for name-based resolution", () => {
    expect(resolveSetId("en", "sv10")).toEqual({ setId: "sv10", aliased: false });
    // UIL-047: a Japanese passthrough is namespaced into the ja catalog space (0016).
    expect(resolveSetId("ja", "mc")).toEqual({ setId: "ja:mc", aliased: false });
  });
});

describe("resolveDexId (end-to-end deterministic resolve)", () => {
  it("resolves an English collection row", () => {
    expect(resolveDexId({ Id: "sv10-103", Locale: "English" })).toEqual({
      locale: "en",
      // The code as her export wrote it, which is what a learned alias is keyed on (UIL-086).
      rawCode: "sv10",
      setId: "sv10",
      aliased: false,
      localIdCandidates: ["103"],
    });
  });

  it("handles the me25 -> me02.5 Ascended Heroes case", () => {
    expect(resolveDexId({ Id: "me25-20", Locale: "English" })).toEqual({
      locale: "en",
      rawCode: "me25",
      setId: "me02.5",
      aliased: true,
      localIdCandidates: ["20", "020"],
    });
  });

  it("resolves a Japanese row to the ja locale with padded candidate", () => {
    expect(resolveDexId({ Id: "jpn_sv11w-2", Locale: "Japanese" })).toEqual({
      locale: "ja",
      // `jpn_` stripped and NOT namespaced — the alias table is keyed on this, not on `ja:sv11w`.
      rawCode: "sv11w",
      setId: "ja:sv11w", // UIL-047: the ja catalog space, never the English `sv11w`
      aliased: false,
      localIdCandidates: ["2", "002"],
    });
  });

  it("handles the me2-112 set-code drift", () => {
    // me2-112 404s against TCGdex; the card lives at me02-112.
    expect(resolveDexId({ Id: "me2-112", Locale: "English" })).toEqual({
      locale: "en",
      rawCode: "me2",
      setId: "me02",
      aliased: true,
      localIdCandidates: ["112"],
    });
  });
});
