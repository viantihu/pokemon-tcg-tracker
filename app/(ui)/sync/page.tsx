/**
 * Sync route (dev-spec §5 M9; sync-ui-spec §A + §B). The server host loads the initial queue + undo
 * status (owner-scoped, like the other screens' pages), then hands the client screen its interaction
 * surface. Preview / apply / undo / queue mutations all run through the ./actions server actions.
 */

import { loadSyncState } from "./actions";
import { SyncScreen } from "./SyncScreen";

export const metadata = { title: "Sync · Binder Ops" };
export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const initialState = await loadSyncState();
  return <SyncScreen initialState={initialState} />;
}
