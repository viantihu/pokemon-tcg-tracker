/**
 * Wait until Vercel has published THIS commit, so deploy.yml's smoke checks the new build, not the last one.
 *
 * Vercel's Git integration builds the app in parallel with this workflow and reports each build as a GitHub
 * deployment created by `vercel[bot]` for the commit's SHA ("Preview" for develop). Until that deployment is
 * `success`, the environment's URL may still serve the previous build, and a check that passes against it
 * proves nothing about this one. That gap let a green smoke stand beside a broken build before.
 *
 *   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo SHA=<commit> [TIMEOUT_S=900] node scripts/wait-for-vercel-deploy.mjs
 */

const POLL_MS = 20_000;

/**
 * The state of Vercel's build for a commit, from its deployments' latest statuses: `ready` when any succeeded,
 * `failed` when every one of them ended in failure or error, `pending` otherwise (none yet, or still building).
 */
export function vercelState(latestStates) {
  if (latestStates.includes("success")) return "ready";
  if (latestStates.length > 0 && latestStates.every((s) => s === "failure" || s === "error")) {
    return "failed";
  }
  return "pending";
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path.split("?")[0]} returned HTTP ${res.status}`);
  return res.json();
}

async function latestStates(repo, sha) {
  const deployments = await gh(`/repos/${repo}/deployments?sha=${sha}&per_page=30`);
  const states = [];
  for (const d of deployments.filter((d) => d.creator?.login === "vercel[bot]")) {
    const [latest] = await gh(`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`);
    states.push(latest?.state ?? "pending");
  }
  return states;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.SHA;
  if (!repo || !sha || !process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and SHA must be set");
  }
  const deadline = Date.now() + Number(process.env.TIMEOUT_S ?? 900) * 1000;
  for (;;) {
    const states = await latestStates(repo, sha);
    const state = vercelState(states);
    console.log(
      `Vercel build for ${sha.slice(0, 7)}: ${state} (${states.join(", ") || "not reported yet"})`,
    );
    if (state === "ready") return;
    if (state === "failed")
      throw new Error(`Vercel's build for ${sha.slice(0, 7)} failed, so nothing new is serving`);
    if (Date.now() + POLL_MS > deadline) {
      throw new Error(
        `Vercel reported no ready build for ${sha.slice(0, 7)} in time, so a smoke check would test the ` +
          `previous build. Check the Vercel dashboard for this commit.`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
