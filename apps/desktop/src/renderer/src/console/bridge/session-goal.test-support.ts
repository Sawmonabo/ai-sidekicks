// The session-goal suites' shared scaffolding: wire-shaped goal events.
//
// Both suites fold the same event shapes, and the fold's whole rule is about ORDER —
// which reading wins when two arrive — so the events have to be built the same way
// in both or the two suites would be ranking different things.

import { type ConsoleSessionEvent } from "../store/index.js";

/**
 * One timeline entry.
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
): ConsoleSessionEvent {
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

export function goalUpdate(
  sequence: number,
  text: string,
  occurredAt?: string,
): ConsoleSessionEvent {
  return event(sequence, "session.goal_updated", { goal: { text } }, occurredAt);
}

export function goalClear(sequence: number, occurredAt?: string): ConsoleSessionEvent {
  return event(sequence, "session.goal_cleared", undefined, occurredAt);
}

/**
 * A goal update carrying the origin keys the accepting daemon stamps on it.
 *
 * `localSequence` is where the event landed on THIS node and `originSeq` is where
 * the origin appended it — the two are independent, which is the entire subject of
 * the cross-node cases below.
 */
export function originGoalUpdate(
  localSequence: number,
  text: string,
  origin: { readonly nodeId: string; readonly originSeq: number },
  occurredAt?: string,
): ConsoleSessionEvent {
  return event(
    localSequence,
    "session.goal_updated",
    { goal: { text }, originNodeId: origin.nodeId, originSeq: origin.originSeq },
    occurredAt,
  );
}

/** The clearing arm with its own origin keys — the taxonomy stamps both kinds. */
export function originGoalClear(
  localSequence: number,
  origin: { readonly nodeId: string; readonly originSeq: number },
  occurredAt?: string,
): ConsoleSessionEvent {
  return event(
    localSequence,
    "session.goal_cleared",
    { originNodeId: origin.nodeId, originSeq: origin.originSeq },
    occurredAt,
  );
}

// The register's winner is the newest READING, not the newest arrival. A relayed
// event takes its local sequence when it lands here, so a delayed one can sit at a
// higher position than the event it preceded. Every case below is one the fold that
// stopped at the newest local position answered wrong.
export const TIED_INSTANT: string = "2026-01-01T00:00:05.000Z";
