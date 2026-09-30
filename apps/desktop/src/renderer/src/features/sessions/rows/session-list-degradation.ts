// What the destination's header says while this window is not following the daemon: the list
// keeps every row it last read, and the header says only that it could not be refreshed.
//
// The cause comes from `store/session-degradation.ts`, folded over the open stores by
// `hooks/useOpenSessionProjection.ts`, so nothing here polls or picks between causes.

import type { SessionDegradedCause } from "@renderer/store/session-degradation.js";

/** What the destination renders for one standing cause. */
export interface SessionListDegradation {
  /** The line in the list's header. `undefined` while nothing is standing. */
  readonly headerLine: string | undefined;
}

/** Nothing standing: the list is live. */
const NOT_DEGRADED: SessionListDegradation = { headerLine: undefined };

/** Any standing cause: whichever it is, the header names no cause. */
const DEGRADED: SessionListDegradation = { headerLine: "Could not refresh" };

/**
 * The header line one standing cause produces, or none. Pure, since the fold that yields the
 * cause is already a subscription.
 */
export function sessionListDegradation(
  cause: SessionDegradedCause | undefined,
): SessionListDegradation {
  return cause === undefined ? NOT_DEGRADED : DEGRADED;
}
