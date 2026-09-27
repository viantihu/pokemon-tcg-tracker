/**
 * The deploy smoke's probes (scripts/deploy-smoke-sign-in.mjs) pass only when the live sign-in action answers
 * with the EXACT refusal each probe expects. Those strings live in the app (app/login/actions.ts), so a wording
 * change there (the multi-user sign-up work is where it would happen) would turn every deploy red without a
 * single unit test noticing: the smoke's own tests read the script's constants. QA on #405. This pins the two
 * files together: each probe's refusal must appear, verbatim, in the sign-in action's source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROBES } from "../../scripts/deploy-smoke-sign-in.mjs";

const signInSource = ["app/login/actions.ts", "app/login/messages.ts"]
  .map((f) => {
    try {
      return readFileSync(join(process.cwd(), f), "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

describe("the deploy smoke's expected refusals are the app's own words (QA on #405)", () => {
  it.each(Object.entries(PROBES))(
    "%s: its refusal appears verbatim in the sign-in action",
    (_, p) => {
      expect(signInSource).toContain(JSON.stringify(p.refusal));
    },
  );
});
