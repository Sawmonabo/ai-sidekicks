// What the strip's Sidekicks badge reads from the session's child-run counts: hidden while the
// session dispatched nothing, its count the children dispatched, accent while any child waits on
// an approval, and the count dimmed while none is running.

import type { ChildRunCounts } from "@ai-sidekicks/contracts/orchestration";

/** The badge as drawn: absent, or its count with its accent and dimming. */
export type SidekicksBadgeReading =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "shown";
      readonly count: number;
      readonly isWaiting: boolean;
      readonly isCountDimmed: boolean;
    };

/** The badge for `counts`; hidden until the counts are read. */
export function readSidekicksBadge(counts: ChildRunCounts | undefined): SidekicksBadgeReading {
  if (counts === undefined || counts.total === 0) {
    return { kind: "hidden" };
  }
  return {
    kind: "shown",
    count: counts.total,
    isWaiting: counts.waiting > 0,
    isCountDimmed: counts.live === 0,
  };
}
