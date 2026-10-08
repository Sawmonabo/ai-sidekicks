// The envelope of one event in a session's lifecycle, as the session's create, conversion and
// changes append it: a fresh id, the clock's time, and no actor.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { UnsequencedEventEnvelope } from "../events/log-service.js";
import { SESSION_EVENT_VERSION } from "../events/session/version.js";
import { mintUuidV7 } from "../uuid-v7.js";

/** A `session_lifecycle` event of `type` for `sessionId`, ready to append. */
export function sessionLifecycleEvent(event: {
  readonly sessionId: SessionId;
  readonly type: SessionEventType;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}): UnsequencedEventEnvelope {
  return {
    id: mintUuidV7(),
    sessionId: event.sessionId,
    occurredAt: event.occurredAt.toISOString(),
    category: "session_lifecycle",
    type: event.type,
    actor: null,
    payload: event.payload,
    version: SESSION_EVENT_VERSION,
  };
}
