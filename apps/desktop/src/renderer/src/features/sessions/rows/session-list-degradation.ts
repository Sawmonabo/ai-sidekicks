// What the destination says while this window is not following the daemon: the list renders
// from its last read, labeled as such, because a stale list a person can read beats an empty one.
//
// The cause comes from `store/session-degradation.ts`, folded over the open stores by
// `hooks/useOpenSessionProjection.ts`, so nothing here polls or picks between causes.

import type { SessionDegradedCause } from "@renderer/store/session-degradation.js";

/**
 * What one standing cause means for a person reading the list. Total over the causes, so a new
 * one fails to compile here. Each sentence names what is wrong, not what the console did about it.
 */
const DEGRADED_CAUSE_SENTENCES: Readonly<Record<SessionDegradedCause, string>> = {
  "stream-diverged": "this window could not follow the session stream",
  "sequence-gap": "rows are missing from what this window received",
  "projection-failed": "a row arrived that this window could not apply",
  "subscription-closed": "the session stream closed",
  "read-failed": "a read this window depends on failed",
};

/** What the destination renders for one standing cause. */
export interface SessionListDegradation {
  /** The line above the list. `undefined` while nothing is standing. */
  readonly lastReadSentence: string | undefined;
}

/** Nothing standing: the list is live. */
const NOT_DEGRADED: SessionListDegradation = { lastReadSentence: undefined };

/**
 * The sentence one standing cause produces, or none. Pure, since the fold that yields the cause
 * is already a subscription.
 */
export function sessionListDegradation(
  cause: SessionDegradedCause | undefined,
): SessionListDegradation {
  if (cause === undefined) {
    return NOT_DEGRADED;
  }
  const because = DEGRADED_CAUSE_SENTENCES[cause];
  return {
    lastReadSentence: `This is the last read — ${because}. Nothing below is being kept current.`,
  };
}
