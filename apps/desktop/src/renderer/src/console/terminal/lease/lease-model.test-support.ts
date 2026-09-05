// The two participants and the one transition builder the fold's suites share.
//
// Both suites drive `projectTerminalLease` over an ordering of transitions, so both
// need to author one — and two copies of an event builder is two ideas of what a
// well-formed `pty.control_changed` looks like, which on this fold is exactly the
// distinction under test: the malformed-shape cases are only meaningful against a
// builder whose default IS well formed.

import { TERMINAL_SCENARIO_CAST } from "../../bridge/scenarios/terminal.js";
import type { ConsoleSessionEvent } from "../../store/index.js";
import { TERMINAL_LEASE_EVENT_KIND } from "./lease-transition.js";

/**
 * Two participants, taken from the scenario rather than written down.
 *
 * The fold treats a participant id as an opaque string, so a readable placeholder
 * would pass every case — and would be the one participant id in this family that no
 * daemon could ever emit, sitting beside beats the scenario deliberately moved onto
 * wire-declared UUIDs. Reading them off the join log keeps the family's fixtures saying
 * one thing about what a participant id is.
 */
export const VIEWER: string = TERMINAL_SCENARIO_CAST.owner;
export const OTHER: string = TERMINAL_SCENARIO_CAST.collaborator;

export function transitionEvent(
  sequence: number,
  reason: string,
  holderParticipantId: string | null,
  previousHolderParticipantId: string | null = null,
  actorId: string | undefined = holderParticipantId ?? undefined,
): ConsoleSessionEvent {
  return {
    // Distinct per position, and readable rather than UUID-shaped: the fold reads this
    // member for nothing, so `store/failure-modes.test-support.ts`'s spelling is the
    // one to match. The participant ids above are the opposite case — those reach a
    // surface, which is why they are read off the scenario's wire-declared cast.
    id: `event-${String(sequence)}`,
    sessionId: "session-terminal",
    sequence,
    kind: TERMINAL_LEASE_EVENT_KIND,
    occurredAt: `2026-01-01T16:40:0${String(sequence % 10)}.000Z`,
    ...(actorId === undefined ? {} : { actorId }),
    payload: { holderParticipantId, previousHolderParticipantId, reason },
  };
}
