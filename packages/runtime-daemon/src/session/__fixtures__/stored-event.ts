// Seeds `session_events` rows directly, for tests that need a log without the append path. The
// row takes the caller's `sequence` and bypasses the per-session append lock, which is why only
// tests write this way; `EventLogService.append` is the daemon's one durable writer.

import type { DatabaseWriter } from "../../database/writer.js";
import type { StoredEvent } from "../records.js";

/** The session every bootstrap fixture belongs to. */
export const SESSION_ID: string = "01J0SE5510NN5J5J5J5J5J5J5J";

/** The actor the bootstrap event records as the session's owner. */
export const OWNER_ACTOR_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

/** When the bootstrap event occurred, and so the session's `createdAt`. */
export const OCCURRED_AT: string = "2026-04-27T12:00:00.000Z";

/** A valid bootstrap `session.created` event at sequence 0. */
export function makeCreatedEvent(): StoredEvent {
  return {
    id: "01J0EV0000NN5J5J5J5J5J5J5J",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: OCCURRED_AT,
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: OWNER_ACTOR_ID,
    payload: {
      sessionId: SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: OCCURRED_AT,
      },
    },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

/**
 * Inserts one event row as given through `writer`, with `contentPayload` as the body its
 * `content_payload` column holds (none by default); rejects on a duplicate (session, sequence).
 */
export async function insertStoredEvent(
  writer: Pick<DatabaseWriter, "write">,
  event: StoredEvent,
  contentPayload: string | null = null,
): Promise<void> {
  await writer.write([
    {
      sql: `INSERT INTO session_events (
              id, session_id, sequence, occurred_at, monotonic_ns,
              category, type, actor, payload,
              correlation_id, causation_id, version, content_payload
            ) VALUES (
              @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
              @category, @type, @actor, @payload,
              @correlation_id, @causation_id, @version, @content_payload
            )`,
      bindings: {
        id: event.id,
        session_id: event.sessionId,
        sequence: event.sequence,
        occurred_at: event.occurredAt,
        monotonic_ns: event.monotonicNs,
        category: event.category,
        type: event.type,
        actor: event.actor,
        payload: JSON.stringify(event.payload),
        correlation_id: event.correlationId,
        causation_id: event.causationId,
        version: event.version,
        content_payload: contentPayload,
      },
    },
  ]);
}
