/**
 * The notice a screen shows when the account has no binder yet (UIL-127a): what to do, and the way there.
 */

import Link from "next/link";
import { NO_BINDER } from "@/lib/plan/no-binder";

export function NoBinderNotice() {
  return (
    <div className="alertbar" role="status">
      <span>!</span>
      <b style={{ flex: "1 1 16em" }}>{NO_BINDER.notice}</b>
      <Link href="/settings" className="btn u" style={{ marginLeft: "auto", fontSize: 10 }}>
        {NO_BINDER.link}
      </Link>
    </div>
  );
}
