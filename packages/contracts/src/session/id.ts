// The ids a session's contracts carry: the session, the person, and the event cursor with the
// codec that turns a cursor into a log position and back.
//
// Id format: `brandedUuidIdSchema` accepts any RFC 9562 UUID, case-insensitively. Daemon-assigned
// ids are UUID v7, but control-plane rows take PostgreSQL's `gen_random_uuid()`, which emits v4,
// so contracts must accept both and never pin to `z.uuidv7()`.
import { z } from "zod";

import { EventCursorUnresolvableError } from "../error.js";
import { brandedUuidIdSchema } from "../internal/branded.js";

/** Identifies one session. */
export type SessionId = string & { readonly __brand: "SessionId" };
/** Parses a {@link SessionId}. */
export const SessionIdSchema: z.ZodType<SessionId, SessionId> =
  brandedUuidIdSchema<SessionId>("SessionId");

/** Identifies one person. */
export type UserId = string & { readonly __brand: "UserId" };
/** Parses a {@link UserId}. */
export const UserIdSchema: z.ZodType<UserId, UserId> = brandedUuidIdSchema<UserId>("UserId");

/** The longest event cursor accepted; a guard against pathological lengths. */
export const EVENT_CURSOR_MAX_LEN = 256;
/**
 * An opaque position in a session's event log, passed through unchanged. Its format belongs to
 * the daemon, which writes it with {@link encodeEventCursor}, so any non-empty bounded string is
 * accepted here.
 */
export type EventCursor = string & { readonly __brand: "EventCursor" };
/** Parses an {@link EventCursor}; not a UUID, so it brands the string itself. */
export const EventCursorSchema: z.ZodType<EventCursor, EventCursor> = z
  .string()
  .min(1)
  .max(EVENT_CURSOR_MAX_LEN)
  .brand<"EventCursor">() as unknown as z.ZodType<EventCursor, EventCursor>;

/** The log position before a session's first event, where a read of the whole log starts. */
export const START_OF_LOG_POSITION = -1;

// Canonical decimal only, so each position has exactly one spelling: no leading zero, no sign but
// the one on -1, no exponent and no whitespace.
const CANONICAL_EVENT_POSITION = /^(?:-1|0|[1-9][0-9]*)$/u;

/**
 * Writes a log position as an {@link EventCursor}: -1 for the start of the log, otherwise an
 * event's sequence. Throws a `RangeError` for anything but a safe integer of at least -1.
 */
export function encodeEventCursor(position: number): EventCursor {
  if (!Number.isSafeInteger(position) || position < START_OF_LOG_POSITION) {
    throw new RangeError("An event cursor position must be an integer of at least -1.");
  }
  return EventCursorSchema.parse(String(position));
}

/**
 * Reads the log position an {@link EventCursor} names. Accepts only what
 * {@link encodeEventCursor} writes, so `"007"`, `"+1"`, `"1e3"` and `"-0"` are refused, and throws
 * `EventCursorUnresolvableError` for any cursor that names no position.
 */
export function decodeEventCursor(cursor: EventCursor): number {
  const position = CANONICAL_EVENT_POSITION.test(cursor) ? Number(cursor) : Number.NaN;
  // A digit string past the safe-integer range parses to a neighboring position, so it is refused.
  if (!Number.isSafeInteger(position)) {
    throw new EventCursorUnresolvableError(cursor);
  }
  return position;
}
