// The degradation ladder: which cause a session store carries when more than one
// is standing.
//
// Its own module because it is the one rule every writer of `degradedCause` obeys,
// and there is more than one writer: the apply chokepoint raises causes it observed
// in a batch, and `markDegraded` raises one the wire reported (a closed
// subscription, a failed read). Two writers with one rule means one implementation
// — a second, "simpler" assignment somewhere would silently downgrade a store that
// could not follow the stream at all into one that merely failed a read.

/**
 * Why a store is degraded, worst first. Rendered; never silently absorbed.
 *
 * The ORDER is load-bearing rather than incidental, which is why this is a tuple
 * and the union below is derived from it: a store can have more than one cause
 * standing at once and the banner states one fact, so the cause that survives is
 * the worst standing one. `stream-diverged` says the store could not follow the
 * stream at all; `sequence-gap` that named rows are missing from it;
 * `projection-failed` that a row landed and its entity contribution did not; the
 * last two are raised for a wire that stopped rather than for anything an apply
 * saw. Every one of them is cleared by the same completed re-pull, and by nothing
 * else — so a later, milder fact never downgrades an earlier one.
 */
export const SESSION_DEGRADED_CAUSES = [
  "stream-diverged",
  "sequence-gap",
  "projection-failed",
  "subscription-closed",
  "read-failed",
] as const;

/** One degraded cause, derived from the ordered enumeration above. */
export type SessionDegradedCause = (typeof SESSION_DEGRADED_CAUSES)[number];

/**
 * The worst of the causes supplied, or `undefined` when none of them is standing.
 *
 * Taking the worst rather than the newest is what keeps the flag honest. Only a
 * re-pull clears it, so a store that could not follow the stream and then took an
 * ordinary one-row hole has not become less broken — reporting the hole would
 * describe a repair that never happened. The same holds for a cause that arrives
 * from outside the apply path: a `stream-diverged` store whose repair read then
 * rejects is not a `read-failed` store, and a store with a sequence gap whose
 * subscription later closes has not stopped missing the rows it is missing.
 *
 * `undefined` entries are ignored rather than treated as a cause, so a caller can
 * pass the state it already holds without testing it first.
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
