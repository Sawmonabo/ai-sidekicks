// The ids a session's contracts carry: the session, the person, and the event cursor.
//
// Id format: `brandedUuidIdSchema` accepts any RFC 9562 UUID, case-insensitively. Daemon-assigned
// ids are UUID v7, but control-plane rows take PostgreSQL's `gen_random_uuid()`, which emits v4,
// so contracts must accept both and never pin to `z.uuidv7()`.
import { z } from "zod";

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
 * the daemon, so any non-empty bounded string is accepted.
 */
export type EventCursor = string & { readonly __brand: "EventCursor" };
/** Parses an {@link EventCursor}; not a UUID, so it brands the string itself. */
export const EventCursorSchema: z.ZodType<EventCursor, EventCursor> = z
  .string()
  .min(1)
  .max(EVENT_CURSOR_MAX_LEN)
  .brand<"EventCursor">() as unknown as z.ZodType<EventCursor, EventCursor>;
