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

import type {
  EventEnvelope,
  HydratedSessionEvent,
  HydratedSessionEventContent,
} from "@ai-sidekicks/contracts";
import { CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_TRUNCATED_PAYLOAD_KEY } from "@ai-sidekicks/contracts";

/**
 * One stored row, as the caller read it. `contentPayload` is `unknown` because it arrives straight
 * from SQLite, where a cast would be an assumption.
 */
export interface StoredEventContentRow {
  /** The event as already projected from the `payload` column. */
  readonly envelope: EventEnvelope;
  /** `session_events.content_payload`, verbatim. */
  readonly contentPayload: unknown;
}

function readPayloadMember(envelope: EventEnvelope, key: string): unknown {
  const payload: unknown = envelope.payload;
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

/**
 * Pairs one stored row with its body. Throws when the column holds something other than text or
 * NULL, which only a write outside the append path can leave.
 */
export function hydrateStoredEvent(row: StoredEventContentRow): HydratedSessionEvent {
  return { event: row.envelope, content: readContent(row) };
}

function readContent(row: StoredEventContentRow): HydratedSessionEventContent {
  if (row.contentPayload == null) {
    return { status: "unavailable", reason: "absent" };
  }
  if (typeof row.contentPayload !== "string") {
    throw new Error(
      `session_events.content_payload for event ${row.envelope.id} holds a value of type ` +
        `${typeof row.contentPayload}, not text: the append path writes text or NULL, so the row ` +
        "was written outside it.",
    );
  }
  // Echoed from the stored payload, not recomputed from the body: a recomputed length would
  // equal the truncated length and hide that anything was cut.
  const storedLength: unknown = readPayloadMember(row.envelope, CONTENT_LENGTH_PAYLOAD_KEY);
  const storedTruncated: unknown = readPayloadMember(row.envelope, CONTENT_TRUNCATED_PAYLOAD_KEY);
  return {
    status: "available",
    body: row.contentPayload,
    ...(typeof storedLength === "number" ? { contentLength: storedLength } : {}),
    ...(storedTruncated === true ? { contentTruncated: true as const } : {}),
  };
}
