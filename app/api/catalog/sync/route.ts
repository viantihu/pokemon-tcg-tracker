/**
 * Catalog mirror trigger (docs/dev-spec.md §5 M2). SERVER-ONLY, SERVICE ROLE.
 *
 * POST /api/catalog/sync                 → mirror the whole catalog (scheduled refresh)
 * POST /api/catalog/sync?set=<setId>     → mirror one set (on new-set release)
 * POST /api/catalog/sync?pass=artwork    → (re)compute artwork hashes + regroup (heavier pass)
 *
 * Writes land with a privileged key (catalog_card is read-only to the app under RLS), so this must
 * never be reachable from the browser. Two guards: it only ever runs server-side (admin client
 * throws in a browser), and it requires that same key as a bearer token so a public POST can't kick
 * off a 23.5k-card sync. Full auth arrives with the app's magic-link gate (later phase); until then
 * this shared-secret check is the interim lock. Runs on the Node runtime (pngjs + fetch).
 *
 * The bearer check below is a plain string compare against our own env var — it is NOT a Supabase
 * credential being presented to Supabase. So it holds whatever the key's format is (legacy JWT
 * `service_role` or the newer `sb_secret_…`); nothing here parses it as a JWT.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getServerEnv } from "@/lib/env";
import { createTcgdexClient } from "@/lib/catalog/tcgdex";
import { defaultArtworkHasher, regroupArtwork, syncAll, syncSet } from "@/lib/catalog/mirror";
import { errorMessage } from "@/lib/errors";
import { isLocale } from "@/lib/catalog/locale";
import { rawQueryParam } from "@/lib/catalog/query";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const env = getServerEnv();

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // `set` is read from the RAW query, not URLSearchParams: TCGdex set ids can contain a literal "+"
  // (SM1+, sm2+, SM3+, SM4+, SM5+), and URLSearchParams decodes a bare "+" as a space per the URL spec,
  // which then reached TCGdex as `/ja/sets/SM1%20` → 404 (UIL-083). decodeURIComponent keeps a literal
  // plus and still decodes a %2B, so both the old and the encoded dispatch forms work.
  const setId = rawQueryParam(request.url, "set");
  const pass = searchParams.get("pass");
  // UIL-047: one locale per call. Absent or `en` is exactly today's behaviour; `ja` mirrors the
  // Japanese catalog into the `ja:` namespace (0016). Anything else is refused, not guessed.
  const localeParam = searchParams.get("locale") ?? "en";
  if (!isLocale(localeParam)) {
    return Response.json(
      { ok: false, error: `unsupported locale ${localeParam}` },
      { status: 400 },
    );
  }
  const locale = localeParam;

  const db = createAdminClient();
  const tcgdex = createTcgdexClient({ baseUrl: env.TCGDEX_BASE_URL, locale });

  try {
    if (pass === "artwork") {
      const result = await regroupArtwork(db, { hasher: defaultArtworkHasher() });
      return Response.json({ ok: true, pass: "artwork", result });
    }
    const result = setId
      ? await syncSet(db, tcgdex, setId, { locale })
      : await syncAll(db, tcgdex, { locale });
    return Response.json({ ok: true, result });
  } catch (err) {
    return Response.json({ ok: false, error: errorMessage(err) }, { status: 502 });
  }
}
