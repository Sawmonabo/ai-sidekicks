// The degradation ladder: which cause a session store carries when more than one is standing.
// Every writer of `degradedCause` (the apply path and `markDegraded`) goes through it, so a
// simpler assignment elsewhere cannot downgrade a store that lost the stream.

/**
 * Why a store is degraded, worst first; the order is load-bearing, so the union is derived
 * from this tuple. The banner states one fact, so the worst standing cause wins, and only a
 * completed re-pull clears any of them.
 *
 * `stream-diverged`: the store lost its stream and a read is asked for. `sequence-gap`: named
 * rows are missing and a read is asked for. `sequence-diverged`: a row's sequence could not be
 * reconciled with the store's run. `projection-failed`: a row landed but its entity contribution
 * did not. The last two are raised for a wire that stopped.
 */
export const SESSION_DEGRADED_CAUSES = [
  "stream-diverged",
  "sequence-gap",
  "sequence-diverged",
  "projection-failed",
  "subscription-closed",
  "read-failed",
] as const;

/** One degraded cause, derived from the ordered enumeration above. */
export type SessionDegradedCause = (typeof SESSION_DEGRADED_CAUSES)[number];

/**
 * Whether a replay of the same log raises this cause again: the row that raised it comes again
 * and fails the same way. No read is asked for such a cause until a person asks for one, and the
 * line says it could not catch up rather than that it is catching up.
 */
export function isRaisedAgainOnReplay(cause: SessionDegradedCause): boolean {
  return cause === "sequence-diverged" || cause === "projection-failed";
}

/**
 * The worst of the causes supplied, or `undefined` when none is standing.
 *
 * The worst wins over the newest: a diverged store that then takes a one-row hole is not less
 * broken. `undefined` entries are ignored, so a caller can pass the state it holds untested.
 */
export function worstDegradedCause(
  ...candidates: readonly (SessionDegradedCause | undefined)[]
): SessionDegradedCause | undefined {
  let worst: SessionDegradedCause | undefined;
  let worstRank: number = SESSION_DEGRADED_CAUSES.length;
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    const rank = SESSION_DEGRADED_CAUSES.indexOf(candidate);
    if (rank < worstRank) {
      worst = candidate;
      worstRank = rank;
    }
  }
  return worst;
}
