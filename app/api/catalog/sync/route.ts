/**
 * Catalog mirror trigger (docs/dev-spec.md §5 M2). SERVER-ONLY, SERVICE ROLE.
 *
 * POST /api/catalog/sync                 → mirror the whole catalog (scheduled refresh)
 * POST /api/catalog/sync?set=<setId>     → mirror one set (on new-set release)
 * POST /api/catalog/sync?pass=artwork    → (re)compute artwork hashes + regroup (heavier pass)
 *
 * Writes land as the service role (catalog_card is read-only to the app under RLS), so this must
 * never be reachable from the browser. Two guards: it only ever runs server-side (admin client
 * throws in a browser), and it requires the service-role key as a bearer token so a public POST
 * can't kick off a 23.5k-card sync. Full auth arrives with the app's magic-link gate (later phase);
 * until then this shared-secret check is the interim lock. Runs on the Node runtime (pngjs + fetch).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getServerEnv } from "@/lib/env";
import { createTcgdexClient } from "@/lib/catalog/tcgdex";
import { defaultArtworkHasher, regroupArtwork, syncAll, syncSet } from "@/lib/catalog/mirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const env = getServerEnv();

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const setId = searchParams.get("set");
  const pass = searchParams.get("pass");

  const db = createAdminClient();
  const tcgdex = createTcgdexClient({ baseUrl: env.TCGDEX_BASE_URL });

  try {
    if (pass === "artwork") {
      const result = await regroupArtwork(db, { hasher: defaultArtworkHasher() });
      return Response.json({ ok: true, pass: "artwork", result });
    }
    const result = setId ? await syncSet(db, tcgdex, setId) : await syncAll(db, tcgdex);
    return Response.json({ ok: true, result });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
