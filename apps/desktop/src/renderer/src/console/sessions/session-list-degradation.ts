// What the destination says, and stops offering, while this window is not following
// the daemon.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list: "while the daemon is
// unreachable the list renders from its last read, labeled as such, and create and
// join are disabled with the cause named". Two claims, and they are separate: the
// list is still worth showing — a stale list a person can read beats an empty one —
// and an ACT is not, because create and join are writes and a write sent into a
// stream this window has lost is a session nobody can watch being made.
//
// WHERE THE FACT COMES FROM. `store/degradation.ts` is the console's one degradation
// vocabulary and every open session store carries a cause from it. The destination
// reads the fold over the open set, which `rows/open-session-rows.ts` performs
// beside the projection it already subscribes to — so nothing here polls, nothing
// here counts, and nothing here decides which of two standing causes wins.
//
// WHY THIS IS NOT THE DIRECTORY'S REFUSAL. The node's `sessionList` read failing is a
// different fact with a different render: the list already says whose count it is
// showing and the absence already distinguishes "nobody asked" from "the node has
// none". Folding a refused directory read into "the daemon is unreachable" would
// report a wire the corpus has not registered as an outage.

import type { SessionDegradedCause } from "../store/index.js";

/**
 * What one standing cause means for a person reading the list.
 *
 * Total over the closed five by construction, so a sixth cause fails to compile here
 * before it can reach a surface that renders it namelessly. Each sentence names what
 * is WRONG rather than what the console did about it: a person deciding whether to
 * trust the list needs the fact, and "retrying" is not one.
 */
const DEGRADED_CAUSE_SENTENCES: Readonly<Record<SessionDegradedCause, string>> = {
  "stream-diverged": "this window could not follow the session stream",
  "sequence-gap": "rows are missing from what this window received",
  "projection-failed": "a row arrived that this window could not apply",
  "subscription-closed": "the session stream closed",
  "read-failed": "a read this window depends on failed",
};

/** What the destination renders, and refuses to offer, for one standing cause. */
export interface SessionListDegradation {
  /** The line above the list. `undefined` while nothing is standing. */
  readonly lastReadSentence: string | undefined;
  /**
   * Why an act is not offered, in words a control can carry. `undefined` while the
   * acts are offered — which is what a caller tests, so a control's disabled state
   * and the sentence explaining it can never disagree.
   */
  readonly blockedActSentence: string | undefined;
}

/** Nothing standing: the list is live and both acts are offered. */
const NOT_DEGRADED: SessionListDegradation = {
  lastReadSentence: undefined,
  blockedActSentence: undefined,
};

/**
 * The two sentences one standing cause produces, or neither.
 *
 * A pure function of the cause rather than a hook, because there is no state here at
 * all: the fold that produces the cause is already a subscription, and a second hook
 * over its result would be a second place the destination could be told about a
 * degradation it is already holding.
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
    blockedActSentence: `Not while ${because}.`,
  };
}
