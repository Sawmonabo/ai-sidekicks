// The session-goal fold suites' shared scaffolding: wire-shaped goal events.
//
// Both suites fold the same event shapes, and the fold's whole rule is about ORDER —
// which reading wins when two arrive — so the events have to be built the same way
// in both or the two suites would be ranking different things.

import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/**
 * A single entry on the timeline.
 *
 * `occurredAt` defaults to a single instant so the cases that are only about kind
 * and payload say nothing about time; the cross-node cases pass their own, which is
 * the whole point of those cases.
 */
export function event(
  sequence: number,
  kind: string,
  payload?: Readonly<Record<string, unknown>>,
  occurredAt = "2026-01-01T00:00:00.000Z",
): ProjectedSessionEvent {
  return {
    // The event's own identifier, composed from the position so two rows of one
    // session never share one.
    id: `event-${String(sequence)}`,
    sessionId: "session-one",
    sequence,
    kind,
    occurredAt,
    ...(payload === undefined ? {} : { payload }),
  };
}

/** The session and the agent every goal event below names. */
const GOAL_SESSION_ID = "019b7a11-1100-75e5-8510-ada11a5a0001";
const GOAL_AGENT_ID = "019b7a11-1100-7a6e-8110-d1a4c1150001";

export function goalUpdate(
  sequence: number,
  text: string,
  occurredAt?: string,
): ProjectedSessionEvent {
  return event(
    sequence,
    "session.goal_updated",
    { sessionId: GOAL_SESSION_ID, agentId: GOAL_AGENT_ID, goal: { text }, status: "active" },
    occurredAt,
  );
}

export function goalClear(sequence: number, occurredAt?: string): ProjectedSessionEvent {
  return event(
    sequence,
    "session.goal_cleared",
    { sessionId: GOAL_SESSION_ID, agentId: GOAL_AGENT_ID },
    occurredAt,
  );
}

/**
 * One instant several cases share.
 *
 * A relayed event takes its local sequence when it lands here, so a delayed one can
 * sit at a higher position than the event it preceded; with the instant tied, the
 * order falls to the envelope id under test rather than to time.
 */
export const TIED_INSTANT: string = "2026-01-01T00:00:05.000Z";
