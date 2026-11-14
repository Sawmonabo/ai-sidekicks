// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The ids a session's contracts carry: the session, the person, and the event cursor, with the cursor's refusal code and the position before a session's first event.

/** The refusal for an event cursor that names no position in its session's log. */
export const SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE = "session.event.cursorUnresolvable" as const;

/** The log position before a session's first event, where a read of the whole log starts. */
export const START_OF_LOG_POSITION = -1 as const;

/**
 * Identifies one session.
 */
export type SessionId = string & { readonly __brand: "SessionId" };
/**
 * Identifies one person.
 */
export type UserId = string & { readonly __brand: "UserId" };
/**
 * An opaque position in a session's event log, passed through unchanged. Its format belongs
 * to the daemon, which writes it with `encode_event_cursor`.
 */
export type EventCursor = string & { readonly __brand: "EventCursor" };

export { validateEventCursor, validateSessionId, validateUserId } from "../checks/session/id.js";
