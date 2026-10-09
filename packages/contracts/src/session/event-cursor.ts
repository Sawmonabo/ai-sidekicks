// The event cursor's codec: a position in a session's event log written as an `EventCursor` and
// read back, and the error for a cursor that names no position. The cursor's brand and schema sit
// with the session's ids; this module builds no schema, so code that only reads and writes
// cursors loads no schema library.

import type { EventCursor } from "./id.js";

/** Type of {@link EVENT_CURSOR_UNRESOLVABLE_CODE}. */
export type EventCursorUnresolvableCode = "event.cursor_unresolvable";
/**
 * Error code for an `EventCursor` that cannot be resolved to a log position; the daemon raises it
 * and the desktop classifies on it.
 */
export const EVENT_CURSOR_UNRESOLVABLE_CODE: EventCursorUnresolvableCode =
  "event.cursor_unresolvable";

/**
 * Thrown when an `EventCursor` names no log position: it is not a canonical decimal integer of at
 * least -1. `cursor` holds the refused value so the refusal can name it.
 */
export class EventCursorUnresolvableError extends Error {
  readonly code: EventCursorUnresolvableCode = EVENT_CURSOR_UNRESOLVABLE_CODE;
  readonly cursor: string;
  constructor(cursor: string) {
    super("The event cursor does not name a position in the session's log.");
    this.name = "EventCursorUnresolvableError";
    this.cursor = cursor;
  }
}

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
  // A safe integer of at least -1 is at most 16 digits, inside the cursor schema's bound.
  return String(position) as EventCursor;
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
