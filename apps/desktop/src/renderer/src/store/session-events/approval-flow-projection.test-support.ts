// Wire-shaped approval events the contract's payload schemas accept, for the payload shapes the
// approval scenario does not play.

import { APPROVAL_REQUEST_SCENARIO } from "../../../../../fixtures/scenarios/approval-request.js";
import { type ProjectedSessionEvent } from "../session/entities/entities.js";

/** The session id the scenario's events carry. */
export const SESSION_ID: string = APPROVAL_REQUEST_SCENARIO.sessionId;

/** One hand-built beat, for the payload shapes no scenario has a reason to play. */
export function approvalEvent(options: {
  readonly kind: string;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>> | undefined;
  readonly actorId?: string;
}): ProjectedSessionEvent {
  return {
    id: `event-${String(options.sequence)}`,
    sessionId: SESSION_ID,
    sequence: options.sequence,
    kind: options.kind,
    occurredAt: "2026-01-01T13:30:00.000Z",
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  };
}
