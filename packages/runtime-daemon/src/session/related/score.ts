// How related two sessions are: personalized PageRank from one session, cut at two steps. A link's
// weight is its kind's, grown with its use count and halved for every 30 days since its last use;
// a pair's links add up, each walk step goes to a neighbor in proportion to the pair's weight, and
// a two-step walk counts half of a direct one.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionLinkKind } from "@ai-sidekicks/contracts/session/links";

/** Each link kind's weight before its use count and age are applied. */
export const SESSION_LINK_KIND_WEIGHT: Readonly<Record<SessionLinkKind, number>> = {
  copied_from: 1.0,
  started: 0.9,
  related: 0.9,
  messaged: 0.5,
  asked: 0.4,
  mentioned: 0.3,
};

const HALVING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
// What a walk that took a second step keeps of the first step's share.
const SECOND_STEP_FACTOR = 0.5;

/** One link as either of its two sessions sees it. */
export interface SessionLinkEnd {
  readonly otherSessionId: SessionId;
  readonly kind: SessionLinkKind;
  readonly isSource: boolean;
  readonly useCount: number;
  /** RFC 3339 UTC: when the link was last used. */
  readonly lastAt: string;
}

/**
 * A link's weight at `nowMs`: its kind's weight times `1 + log2(useCount)`, halved every 30 days
 * since its last use. A last use in the future counts as now.
 */
export function sessionLinkWeight(link: SessionLinkEnd, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - Date.parse(link.lastAt));
  const halving = 0.5 ** (ageMs / HALVING_PERIOD_MS);
  return SESSION_LINK_KIND_WEIGHT[link.kind] * (1 + Math.log2(link.useCount)) * halving;
}

// Each neighbor's share of the session's walk: its pair weight over the session's total.
function stepShares(
  links: readonly SessionLinkEnd[],
  sessionId: SessionId,
  nowMs: number,
): Map<SessionId, number> {
  const weights = new Map<SessionId, number>();
  let total = 0;
  for (const link of links) {
    if (link.otherSessionId === sessionId) {
      continue;
    }
    const weight = sessionLinkWeight(link, nowMs);
    weights.set(link.otherSessionId, (weights.get(link.otherSessionId) ?? 0) + weight);
    total += weight;
  }
  if (total > 0) {
    for (const [otherSessionId, weight] of weights) {
      weights.set(otherSessionId, weight / total);
    }
  }
  return weights;
}

/**
 * Scores every session within two steps of `sessionId`, the session itself left out. `linksOf`
 * answers a session's links as that session sees them.
 */
export function scoreRelatedSessions(
  sessionId: SessionId,
  linksOf: (sessionId: SessionId) => readonly SessionLinkEnd[],
  nowMs: number,
): Map<SessionId, number> {
  const scores = stepShares(linksOf(sessionId), sessionId, nowMs);
  for (const [neighborId, firstShare] of [...scores]) {
    for (const [secondId, secondShare] of stepShares(linksOf(neighborId), neighborId, nowMs)) {
      if (secondId === sessionId) {
        continue;
      }
      scores.set(
        secondId,
        (scores.get(secondId) ?? 0) + SECOND_STEP_FACTOR * firstShare * secondShare,
      );
    }
  }
  return scores;
}
