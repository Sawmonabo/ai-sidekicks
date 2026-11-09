// The codec that writes a position in a session's event log as a cursor and reads it back, and the
// error for a cursor that names no position.
import {
  SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE,
  START_OF_LOG_POSITION,
  type EventCursor,
} from "../generated/session/id.js";

/**
 * Thrown when an `EventCursor` names no log position: it is not a canonical decimal integer of at
 * least -1. The service's refusal for such a cursor carries no fields, so neither does this.
 */
export class EventCursorUnresolvableError extends Error {
  readonly code: typeof SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE =
    SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE;
  constructor() {
    super("The event cursor does not name a position in the session's log.");
    this.name = "EventCursorUnresolvableError";
  }
}

// Canonical decimal only, so each position has exactly one spelling: no leading zero, no sign but
// the one on -1, no exponent and no whitespace.
const CANONICAL_EVENT_POSITION = /^(?:-1|0|[1-9][0-9]*)$/u;

/**
 * Writes a log position as an `EventCursor`: -1 for the start of the log, otherwise an event's
 * sequence. Throws a `RangeError` for anything but a safe integer of at least -1.
 */
export function encodeEventCursor(position: number): EventCursor {
  if (!Number.isSafeInteger(position) || position < START_OF_LOG_POSITION) {
    throw new RangeError("An event cursor position must be an integer of at least -1.");
  }
  return String(position) as EventCursor;
}

/**
 * Reads the log position an `EventCursor` names. Accepts only what {@link encodeEventCursor}
 * writes, so `"007"`, `"+1"`, `"1e3"` and `"-0"` are refused, and throws
 * {@link EventCursorUnresolvableError} for any cursor that names no position.
 */
export function decodeEventCursor(cursor: EventCursor): number {
  const position = CANONICAL_EVENT_POSITION.test(cursor) ? Number(cursor) : Number.NaN;
  // A digit string past the safe-integer range parses to a neighboring position, so it is refused.
  if (!Number.isSafeInteger(position)) {
    throw new EventCursorUnresolvableError();
  }
  return position;
}
