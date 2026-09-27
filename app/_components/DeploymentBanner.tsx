/**
 * The strip across the top of every page on any deployment that is not Production (UIL-129). Rendered by
 * the root layout, so the sign-in screen carries it too. Server component: no state, no script.
 */

import type { DeploymentLabel } from "@/lib/deployment";

export function DeploymentBanner({ label }: { label: DeploymentLabel | null }) {
  if (!label) return null;
  return (
    <div className="deploy-banner u" role="note" aria-label="Environment">
      {label.banner}
    </div>
  );
}
