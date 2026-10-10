/**
 * The read projection for machine-authored prose: pairs a stored event with the body its
 * `session_events.content_payload` column holds, without altering the event.
 *
 * - The body is never merged into `payload`: it is excluded from the canonical bytes, and a
 *   caller must be able to tell what the daemon stored from what a read added. The projection
 *   is a pair ({@link HydratedSessionEvent}), and this module returns a fresh object.
 * - A row with no body is reported on the `unavailable` arm, never as
 *   `{ status: "available", body: "" }`: an empty body claims the assistant said nothing.
 * - `content_payload` is node-local, so a row carried in from a peer reads as `absent`.
 */

import type { EventEnvelope, HydratedSessionEvent } from "@ai-sidekicks/contracts/event/envelope";
import { storedBodyContentOf } from "@ai-sidekicks/contracts/transcript/content";

/**
 * One stored row, as the caller read it. `contentPayload` is text or `null`: the column is `TEXT`
 * in a `STRICT` table, so SQLite refuses any other value at write.
 */
export interface StoredEventContentRow {
  /** The event as already projected from the `payload` column. */
  readonly envelope: EventEnvelope;
  /** `session_events.content_payload`, verbatim. */
  readonly contentPayload: string | null;
}

/** Pairs one stored row with its body. */
export function hydrateStoredEvent(row: StoredEventContentRow): HydratedSessionEvent {
  return {
    event: row.envelope,
    content: storedBodyContentOf(row.envelope.payload, row.contentPayload ?? undefined),
  };
}
