/**
 * Liveness endpoint for the post-deploy smoke check (docs/devops-strategy.md §8).
 * Intentionally dependency-free so it reflects "the app booted", not "the DB is up".
 * A DB read-path check can be layered on once the schema and a real table exist.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    status: "ok",
    service: "pokemon-tcg-tracker",
    time: new Date().toISOString(),
  });
}
