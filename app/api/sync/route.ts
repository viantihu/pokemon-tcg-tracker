/**
 * Dex CSV reconciliation PREVIEW endpoint (docs/dev-spec.md §5 M4 + M9; sync-architecture §1.7;
 * sync-ui-spec §B.1–§B.2).
 *
 * POST /api/sync — body is the raw Dex export (UTF-16LE bytes) or a multipart form with a `file`
 * field. Runs the pipeline (parse → scope filter → resolve → catalog lookup → auto-retry → reconcile)
 * and returns a PREVIEW. It mutates nothing: apply / undo / queue writes are the gated M9 surface
 * (the `/(ui)/sync` server actions), and per sync-ui-spec §B.4 the undo snapshot is written at APPLY,
 * not preview. This handler is the programmatic mirror of the screen's `previewSync` action.
 *
 * Auth: routed through the owner seam (`getOwnerContext` — RLS-scoped client on `auth.uid()`), now
 * that magic-link auth has landed. Node runtime (the catalog lookup does DB I/O).
 */
import { getServerEnv } from "@/lib/env";
import { getOwnerContext } from "@/lib/plan";
import { runSyncPipeline } from "@/lib/sync";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Fail fast if the server env contract is unmet (keeps a misconfig from looking like bad data).
  getServerEnv();

  let bytes: Uint8Array;
  try {
    bytes = await readCsvBytes(request);
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "could not read upload" },
      { status: 400 },
    );
  }

  try {
    const { db } = await getOwnerContext();
    const { preview, bundle } = await runSyncPipeline(db, bytes);
    // The preview is the diff/preview contract; the bundle is what an apply call would consume.
    return Response.json({ ok: true, preview, bundle });
  } catch (err) {
    return Response.json({ ok: false, error: errorMessage(err) }, { status: 500 });
  }
}

/** Read the upload as bytes from either a multipart `file` field or the raw request body. */
async function readCsvBytes(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error('multipart upload missing a "file" field');
    return new Uint8Array(await file.arrayBuffer());
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) throw new Error("empty request body");
  return new Uint8Array(buf);
}
