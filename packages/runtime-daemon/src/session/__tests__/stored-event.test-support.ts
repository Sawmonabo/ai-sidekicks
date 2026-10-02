// Seeds `session_events` rows directly, for tests that need a log without the append path. The
// row takes the caller's `sequence` and bypasses the per-session append lock, which is why only
// tests write this way; `EventLogService.append` is the daemon's one durable writer.

import type { Database } from "better-sqlite3";

import type { StoredEvent } from "../types.js";

/** Inserts one event row as given; throws on a duplicate (session, sequence). */
export function insertStoredEvent(database: Database, event: StoredEvent): void {
  database
    .prepare(
      `INSERT INTO session_events (
         id, session_id, sequence, occurred_at, monotonic_ns,
         category, type, actor, payload,
         correlation_id, causation_id, version
       ) VALUES (
         @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
         @category, @type, @actor, @payload,
         @correlation_id, @causation_id, @version
       )`,
    )
    .run({
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
    });
}
