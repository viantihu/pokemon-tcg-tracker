/**
 * Post-deploy smoke (UIL-107): CALL the deployed app's sign-in server action and expect its refusal.
 *
 * From 2026-09-25 to 09-26 every server action on every page failed (E352: a "use server" file exported a
 * string, and Next throws when it loads such a file), while the build, the tests and both page checks in
 * deploy.yml's smoke job stayed green: a page renders without loading its actions. Only calling one shows it.
 *
 * The call: POST /login's `signIn` action with an address that is NOT on the allow-list. `signIn` refuses it
 * before any network call ("That email is not authorised for this binder."), so no email is sent and nothing
 * is written. The action's id is build-specific, and since #364 /login's HTML no longer carries it (its form
 * action is a client wrapper), so it is read from the page's client chunk, where the bundler emits
 * `createServerReference("<id>", …, "signIn")`.
 *
 * Logs are public (the repo is public): this prints status codes and which chunk held the id, never a body.
 *
 *   APP_URL=https://… node scripts/deploy-smoke-sign-in.mjs
 */

/** Never the owner's address: a reserved example domain, so the allow-list can only refuse it. */
export const PROBE_EMAIL = "deploy-smoke@example.com";
export const REFUSAL = "That email is not authorised for this binder.";

/** Every client chunk a page names, in its script tags or in its flight data (where quotes are escaped). */
export function chunkPaths(html) {
  const out = new Set();
  for (const m of html.matchAll(/(?:\/_next\/)?static\/chunks\/[A-Za-z0-9._~/-]+?\.js/g)) {
    out.add(`/_next/${m[0].replace(/^\/_next\//, "")}`);
  }
  return [...out];
}

/** The id this build gave the action `name`, from a chunk's `createServerReference("<id>", a, b, c, "<name>")`. */
export function actionIdIn(js, name) {
  const re = new RegExp(
    `createServerReference\\)\\("([0-9a-f]{40,})",[^,()]+,[^,()]+,[^,()]+,"${name}"\\)`,
  );
  return re.exec(js)?.[1] ?? null;
}

/** What the action's answer means. `ok` only for the refusal itself. */
export function verdict(status, body) {
  if (status === 200 && body.includes('"status":"error"') && body.includes(REFUSAL)) {
    return { ok: true, why: "the sign-in action loaded, ran, and refused the probe address" };
  }
  if (status >= 500) {
    return {
      ok: false,
      why:
        `the sign-in action FAILED (HTTP ${status}). The page renders but its actions do not run. A ` +
        `"use server" module that cannot load (E352, UIL-107) answers exactly this; the Vercel runtime log ` +
        `for this deployment names the error.`,
    };
  }
  if (status === 200 && body.includes('"status":"sent"')) {
    return {
      ok: false,
      why: `the probe address was ACCEPTED and a sign-in email was sent: the allow-list is not refusing strangers.`,
    };
  }
  return { ok: false, why: `unexpected answer from the sign-in action: HTTP ${status}` };
}

async function fetchRetrying(url, init = {}, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function main() {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("APP_URL is not set");

  const page = await fetchRetrying(`${base}/login`);
  if (page.status !== 200) throw new Error(`/login returned HTTP ${page.status} (expected 200)`);
  const chunks = chunkPaths(await page.text());

  let id = null;
  let where = null;
  for (const chunk of chunks) {
    const res = await fetchRetrying(`${base}${chunk}`);
    if (res.status !== 200) continue;
    id = actionIdIn(await res.text(), "signIn");
    if (id) {
      where = chunk;
      break;
    }
  }
  if (!id) {
    throw new Error(
      `could not find the signIn action in any of the ${chunks.length} scripts /login names. If the bundler's ` +
        `output changed shape, update actionIdIn() in scripts/deploy-smoke-sign-in.mjs.`,
    );
  }
  console.log(`Found the signIn action in ${where}.`);

  // React encodes (prevState, formData) as a root part "0" naming the FormData as "$K1", whose fields are
  // "_1_<name>". The root part goes LAST, as React sends it: the server resolves it on arrival.
  const body = new FormData();
  body.append("_1_email", PROBE_EMAIL);
  body.append("0", JSON.stringify([{ status: "idle" }, "$K1"]));
  const res = await fetchRetrying(`${base}/login`, {
    method: "POST",
    headers: { "Next-Action": id, Origin: base, Accept: "text/x-component" },
    body,
    redirect: "manual",
  });
  console.log(`HTTP ${res.status}`);
  const v = verdict(res.status, await res.text());
  if (!v.ok) throw new Error(v.why);
  console.log(`Action check OK: ${v.why}.`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
