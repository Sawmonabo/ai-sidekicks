// A read refreshed on its own (a push, focus, a reconnect) that fails the same way it already
// failed has nothing new to say, so the refusal on screen stands as it is and a screen reader is
// not told it again. A refusal answering a person's own ask is a new attempt, even in the same
// words.

import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { RefreshReason } from "./scheduler.js";

/**
 * The refusal a failed refresh settles with: `standing` where it says the same as `next` and no
 * person asked for this read, else `next`. Keeping the object keeps its identity, which is what a
 * line keys a repeat announcement on.
 */
export function keepStandingRefusal<TRefusal extends Refusal & { readonly reason?: string }>(
  standing: TRefusal | undefined,
  next: TRefusal,
  reasons: readonly RefreshReason[],
): TRefusal {
  if (standing === undefined || reasons.includes("user-request")) {
    return next;
  }
  const isSameRefusal =
    standing.code === next.code &&
    standing.detail === next.detail &&
    standing.origin === next.origin &&
    standing.reason === next.reason;
  return isSameRefusal ? standing : next;
}
