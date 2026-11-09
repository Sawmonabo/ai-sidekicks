// Wire-shaped approval events the contract's generated payload checks accept, built one by one.

import { type ProjectedSessionEvent } from "../entities/vocabulary.js";

/** The session id every event here carries. */
export const SESSION_ID = "019b7a33-3300-75e0-8110-d1a4c1150500";

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
    cursor: `cursor-at-${String(options.sequence)}`,
    kind: options.kind,
    occurredAt: "2026-01-01T13:30:00.000Z",
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  };
}
