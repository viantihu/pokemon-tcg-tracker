/**
 * Which deployment is serving the page, for the non-production banner (UIL-129).
 *
 * Read from Vercel's `VERCEL_ENV` system variable on the server: "production" on the `main` deployment,
 * "preview" on Testing (the `develop` branch deployment) and on every PR preview, "development" under
 * `vercel dev`, and unset under a plain `next dev`. Production shows nothing. Everything else is labelled,
 * and any value this does not recognise is labelled too, so a Testing tab can never pass for the live app.
 *
 * The words live here so the branding overhaul changes them in one place. Testing holds Karvi's real
 * collection until go-live, so nothing here may say its data is not real.
 */

export type DeploymentLabel = {
  /** The strip across the top of every page. */
  banner: string;
  /** Prefixed to every browser tab title. */
  tabPrefix: string;
};

const TESTING: DeploymentLabel = { banner: "Testing environment", tabPrefix: "TEST" };
const LOCAL: DeploymentLabel = { banner: "Local", tabPrefix: "LOCAL" };

/** The label for a deployment, or null on Production, which shows none. */
export function deploymentLabel(vercelEnv: string | undefined): DeploymentLabel | null {
  if (vercelEnv === "production") return null;
  if (vercelEnv === undefined || vercelEnv === "" || vercelEnv === "development") return LOCAL;
  return TESTING;
}

/** The root title: a plain string on Production, a prefixing template everywhere else. */
export function rootTitle(
  label: DeploymentLabel | null,
  base: string,
): string | { default: string; template: string } {
  if (!label) return base;
  return { default: `${label.tabPrefix} · ${base}`, template: `${label.tabPrefix} · %s` };
}
