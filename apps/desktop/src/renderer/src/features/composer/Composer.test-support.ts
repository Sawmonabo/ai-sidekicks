// What every composer suite shares: a transport nothing calls through, and the row that names the
// session's lead.

import {
  composeSessionCreatedPayload,
  type ScenarioAgent,
} from "#fixtures/data/opening-entries.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SESSION_CREATED_EVENT_KIND } from "#renderer/store/session/standing-events.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";

/** The person who opened every composer suite's session. */
const OPENED_BY_USER_ID = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f";

/** A bridge that answers every call with nothing, for held state that only needs a transport. */
export function inertBridge(): PlatformBridge {
  return bridgeAnswering(async () => undefined).bridge;
}

/**
 * The `session.created` row that makes `lead` the session's lead, as a store keeps it among its
 * standing events. Both ids must be UUIDs: the payload is parsed through its contract.
 */
export function sessionCreatedEvent(sessionId: string, lead: ScenarioAgent): ProjectedSessionEvent {
  const createdAt = "2026-01-01T11:00:00.000Z";
  return {
    id: "event-session-created",
    sessionId,
    sequence: 0,
    cursor: "cursor-at-0",
    kind: SESSION_CREATED_EVENT_KIND,
    occurredAt: createdAt,
    payload: {
      ...composeSessionCreatedPayload({
        sessionId,
        shape: "project",
        openedBy: OPENED_BY_USER_ID,
        lead,
        createdAt,
      }),
    },
  };
}
