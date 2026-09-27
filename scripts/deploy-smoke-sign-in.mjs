/**
 * Post-deploy smoke (UIL-107): CALL the deployed app's sign-in server action and expect its refusal.
 *
 * From 2026-09-25 to 09-26 every server action on every page failed (E352: a "use server" file exported a
 * string, and Next throws when it loads such a file), while the build, the tests and both page checks in
 * deploy.yml's smoke job stayed green: a page renders without loading its actions. Only calling one shows it.
 *
 * The call: POST /login's `signIn` action with one of two probes, chosen by `PROBE`:
 *   - `malformed` (the default): not an address at all. `signIn` validates first and refuses it before any
 *     network call ("Enter a valid email address."): no email, no account, nothing written, allow-list or not.
 *   - `stranger`: a well-formed address that is not the owner's. While sign-up is closed (the single-owner
 *     allow-list, or an invite-only environment) it is refused before any network call ("That email is not
 *     authorised for this binder."): the LIVE, per-deploy proof that strangers are kept out (QA on #405).
 *     deploy.yml runs it only while that environment's `SIGNUP_MODE` is not "open": with sign-up open, this
 *     address would get a real email and a new account on every deploy. The action's id is build-specific, and since #364 /login's HTML no longer carries it (its form
 * action is a client wrapper), so it is read from the page's client chunk, where the bundler emits
 * `createServerReference("<id>", …, "signIn")`.
 *
 * Logs are public (the repo is public): this prints status codes and which chunk held the id, never a body.
 *
 *   APP_URL=https://… node scripts/deploy-smoke-sign-in.mjs
 */

/** The two probes; each is refused before Supabase is called, so neither sends anything. */
export const PROBES = {
  /** Not an address at all (no "@"): `signIn`'s own validation refuses it. */
  malformed: {
    email: "deploy-smoke-not-an-address",
    refusal: "Enter a valid email address.",
    ok: "the sign-in action loaded, ran, and refused the malformed probe address",
    accepted:
      "the MALFORMED probe address was ACCEPTED and a sign-in was attempted: signIn's address check is not running.",
  },
  /** Never the owner's address: a reserved example domain, so a closed sign-up can only refuse it. */
  stranger: {
    email: "deploy-smoke@example.com",
    refusal: "That email is not authorised for this binder.",
    ok: "the sign-in action loaded, ran, and refused a stranger's address",
    accepted:
      "the probe address was ACCEPTED and a sign-in email was sent: the allow-list is not refusing strangers.",
  },
};
/** The default probe, under the names older callers used. */
export const PROBE_EMAIL = PROBES.malformed.email;
export const REFUSAL = PROBES.malformed.refusal;

/** `PROBE` from the environment, defaulting to the malformed address; anything else is an error. */
export function probeFrom(env) {
  const name = (env.PROBE ?? "malformed").trim();
  if (!Object.hasOwn(PROBES, name))
    throw new Error(`unknown PROBE "${name}" (malformed | stranger)`);
  return PROBES[name];
}

/**
 * Every client chunk a page names, in its script tags or in its flight data (where quotes are escaped). Vercel
 * serves them under `static/immutable/chunks/`, `next start` under `static/chunks/`; both are read.
 */
export function chunkPaths(html) {
  const out = new Set();
  for (const m of html.matchAll(
    /(?:\/_next\/)?static\/(?:immutable\/)?chunks\/[A-Za-z0-9._~/-]+?\.js/g,
  )) {
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
export function verdict(status, body, probe = PROBES.malformed) {
  if (status === 200 && body.includes('"status":"error"') && body.includes(probe.refusal)) {
    return { ok: true, why: probe.ok };
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
      why: probe.accepted,
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
  const probe = probeFrom(process.env);
  body.append("_1_email", probe.email);
  body.append("0", JSON.stringify([{ status: "idle" }, "$K1"]));
  const res = await fetchRetrying(`${base}/login`, {
    method: "POST",
    headers: { "Next-Action": id, Origin: base, Accept: "text/x-component" },
    body,
    redirect: "manual",
  });
  console.log(`HTTP ${res.status}`);
  const v = verdict(res.status, await res.text(), probe);
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
