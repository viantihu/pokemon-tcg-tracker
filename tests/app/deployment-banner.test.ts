/**
 * UIL-129 — a banner on every deployment that is not Production, and a prefix on every tab title.
 * Karvi's ruling (2026-09-27): "TESTING ENVIRONMENT" on Testing, "LOCAL" on a developer's machine, nothing on
 * Production. The root layout is rendered for real (fonts stubbed), with VERCEL_ENV set per case, so the
 * wiring is checked and not only the label function.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentLabel, rootTitle } from "@/lib/deployment";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-sans" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
}));

const BASE = "Binder Ops · Pokémon TCG Binder";

/** Import the root layout fresh under a given VERCEL_ENV (it reads the variable once, at load). */
async function loadLayout(vercelEnv: string | undefined) {
  vi.resetModules();
  if (vercelEnv === undefined) vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
  else vi.stubEnv("VERCEL_ENV", vercelEnv);
  return import("@/app/layout");
}

async function renderPage(vercelEnv: string | undefined) {
  const mod = await loadLayout(vercelEnv);
  const Layout = mod.default as (props: { children: ReactElement }) => ReactElement;
  const html = renderToStaticMarkup(
    Layout({ children: createElement("main", { id: "page" }, "page") }),
  );
  return { html, title: mod.metadata.title };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UIL-129 · which deployment gets a banner", () => {
  it("Production: no banner, tab titles untouched", async () => {
    const { html, title } = await renderPage("production");
    expect(html).not.toContain("deploy-banner");
    expect(title).toBe(BASE);
  });

  it("Testing (Vercel preview: the develop deployment and every PR preview)", async () => {
    const { html, title } = await renderPage("preview");
    expect(html).toContain('class="deploy-banner u"');
    expect(html).toContain("Testing environment");
    expect(title).toEqual({ default: `TEST · ${BASE}`, template: "TEST · %s" });
  });

  it("local: a plain `next dev` (unset) and `vercel dev` (development)", async () => {
    for (const env of [undefined, "", "development"]) {
      const { html, title } = await renderPage(env);
      expect(html).toContain(">Local</div>");
      expect(title).toEqual({ default: `LOCAL · ${BASE}`, template: "LOCAL · %s" });
    }
  });

  it("an unrecognised value is labelled, never passed off as Production", () => {
    expect(deploymentLabel("staging")?.banner).toBe("Testing environment");
    expect(deploymentLabel("PRODUCTION")?.banner).toBe("Testing environment");
  });

  it("the banner sits above the page, so the sign-in screen carries it too", async () => {
    const { html } = await renderPage("preview");
    const bannerAt = html.indexOf("deploy-banner");
    expect(bannerAt).toBeGreaterThanOrEqual(0);
    expect(bannerAt).toBeLessThan(html.indexOf('id="page"'));
  });

  it("a child page title gets the prefix through the template", () => {
    const title = rootTitle(deploymentLabel("preview"), BASE);
    expect(typeof title === "object" && title.template.replace("%s", "Sync · Binder Ops")).toBe(
      "TEST · Sync · Binder Ops",
    );
  });

  it("no label says the data is not real: Testing holds her real collection until go-live", () => {
    for (const env of ["preview", "development", undefined]) {
      const label = deploymentLabel(env);
      expect(`${label?.banner} ${label?.tabPrefix}`).not.toMatch(
        /not real|fake|dummy|sample|demo/i,
      );
    }
  });
});
