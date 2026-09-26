/**
 * deploy.yml's smoke job CALLS a server action (UIL-107), and only once Vercel has published the commit.
 *
 * The scripts run against the deployed app, so what CI can pin here is their reading of its answers and their
 * wiring. Both were run end-to-end before this landed: against a local production build of develop (the action
 * check passes) and of 695b2ce, the E352 build (it fails with HTTP 500), and the wait against GitHub's real
 * deployment records (a built commit is ready; an unknown one times out).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionIdIn,
  chunkPaths,
  PROBE_EMAIL,
  REFUSAL,
  verdict,
} from "@/scripts/deploy-smoke-sign-in.mjs";
import { vercelState } from "@/scripts/wait-for-vercel-deploy.mjs";

/** Verbatim from a production build's client chunk (Next 16.3.4, Turbopack). */
const CHUNK =
  "ar r=e.i(13448),t=e.i(92328),n=e.i(31999),a=e.i(56936);let i=(0,a.createServerReference)(" +
  '"602de1cf542ba2337089bae30887487368dc0fddab",a.callServer,void 0,a.findSourceMapURL,"signIn");' +
  'let s=(0,a.createServerReference)("00a05ffa8fc2b17a1ae7af86b0d7cbc3d11ca4cd41",a.callServer,void 0,' +
  'a.findSourceMapURL,"signOut");var o=e.i(35803);let l={status:"idle"};';

describe("the action check finds the action in the page's own scripts", () => {
  it("reads a build's id for signIn, and not signOut's beside it", () => {
    expect(actionIdIn(CHUNK, "signIn")).toBe("602de1cf542ba2337089bae30887487368dc0fddab");
    expect(actionIdIn(CHUNK, "signOut")).toBe("00a05ffa8fc2b17a1ae7af86b0d7cbc3d11ca4cd41");
    expect(actionIdIn(CHUNK, "signUp")).toBeNull();
    expect(actionIdIn("no references here", "signIn")).toBeNull();
  });

  it("collects chunks from script tags AND from escaped flight data, once each", () => {
    const html =
      '<script src="/_next/static/chunks/aa11.js" async></script>' +
      '<script>self.__next_f.push([1,"2:I[123,[\\"static/chunks/bb22.js\\",\\"static/chunks/aa11.js\\"],\\"LoginForm\\"]"])</script>' +
      '<link rel="preload" as="script" href="/_next/static/chunks/cc33.js?dpl=dpl_x"/>';
    expect(chunkPaths(html).sort()).toEqual([
      "/_next/static/chunks/aa11.js",
      "/_next/static/chunks/bb22.js",
      "/_next/static/chunks/cc33.js",
    ]);
  });
});

describe("the action check reads the answer strictly", () => {
  const refused = `0:{"a":"$@1"}\n1:{"status":"error","message":"${REFUSAL}"}`;

  it("passes only on the refusal itself", () => {
    expect(verdict(200, refused).ok).toBe(true);
  });

  it("fails on a 500, naming the E352 failure it exists for", () => {
    const v = verdict(500, "0:E{digest}");
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/E352/);
  });

  it("fails LOUDLY if the probe address was accepted and an email sent", () => {
    const v = verdict(200, `1:{"status":"sent","email":"${PROBE_EMAIL}"}`);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/allow-list is not refusing/);
  });

  it("fails on any other refusal, a redirect, or an empty 200", () => {
    expect(verdict(200, '1:{"status":"error","message":"Enter a valid email address."}').ok).toBe(
      false,
    );
    expect(verdict(303, "").ok).toBe(false);
    expect(verdict(200, "").ok).toBe(false);
  });

  it("probes with an address that can never be the owner's", () => {
    expect(PROBE_EMAIL).toMatch(/@example\.com$/);
  });
});

describe("the smoke waits for THIS commit's build", () => {
  it("ready on any success; failed only when every build failed; pending otherwise", () => {
    expect(vercelState(["success"])).toBe("ready");
    expect(vercelState(["failure", "success"])).toBe("ready");
    expect(vercelState(["failure"])).toBe("failed");
    expect(vercelState(["error", "failure"])).toBe("failed");
    expect(vercelState([])).toBe("pending");
    expect(vercelState(["in_progress"])).toBe("pending");
    expect(vercelState(["failure", "queued"])).toBe("pending");
  });
});

describe("deploy.yml runs both, in order, in the smoke job", () => {
  const yml = readFileSync(path.join(process.cwd(), ".github", "workflows", "deploy.yml"), "utf8");
  const smoke = yml.slice(yml.indexOf("\n  smoke:\n"));

  it("waits for Vercel first, then the page checks, then calls the action", () => {
    const at = (s: string) => smoke.indexOf(s);
    expect(at("node scripts/wait-for-vercel-deploy.mjs")).toBeGreaterThan(0);
    expect(at("node scripts/wait-for-vercel-deploy.mjs")).toBeLessThan(at("name: Health check"));
    expect(at("name: Read-path check")).toBeLessThan(at("node scripts/deploy-smoke-sign-in.mjs"));
  });

  it("can read deployment records and nothing more", () => {
    expect(smoke).toMatch(/permissions:\n\s+contents: read\n\s+deployments: read\n/);
  });
});
