// Decodes one `session.subscribe` frame into app events, the daemon's drop mark and the cursor a
// re-opened stream resumes after, or refuses it. This is the only place that reads fields off the
// `unknown` the bridge delivers.
//
// The frame is parsed once here with the contract's frame builder over the tolerant
// `EventEnvelope`, so a higher-minor event type still reaches the app. The tolerant layer does
// not check that an event's category matches its type, and every projector routes on `kind` alone,
// so `projectSessionEvent` checks the pairing against the contracts census.

import { EventEnvelopeSchema, type EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session-event";
import {
  SessionStreamFrameSchema,
  type EventCursor,
} from "@ai-sidekicks/contracts/session/session";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** What one readable frame tells the app. */
export interface SessionStreamFrameReading {
  /** The frame's events the app can hold, in stream order. */
  readonly events: readonly ProjectedSessionEvent[];
  /** The frame's events whose type the census pairs with another category. */
  readonly unreadableEventCount: number;
  /**
   * The daemon dropped changes for this connection before this frame, so the
   * screen is behind and repairs from the daemon's record.
   */
  readonly dropped: boolean;
  /**
   * Where this frame leaves the stream: the cursor of its last change, readable or not, or the
   * caught-up frame's newest cursor. A stream opened again after it resumes past this frame.
   */
  readonly resumeCursor: EventCursor;
}

/**
 * The `session.subscribe` frame over the tolerant envelope, so an event type this app does not
 * know yet still parses.
 */
const SESSION_STREAM_FRAME_SCHEMA = SessionStreamFrameSchema(EventEnvelopeSchema);

/**
 * Reads one delivered frame, or returns `undefined` when it is not the registered shape.
 *
 * A frame is refused whole for a forbidden member, an event the envelope rejects, too many
 * changes, or no changes without being the caught-up drop frame. Each change's cursor rides on
 * its event, where a link to a message finds it; a drop is still repaired by re-reading the
 * session, and the store orders events by `sequence`.
 */
export function readSessionStreamFrame(delivered: unknown): SessionStreamFrameReading | undefined {
  const parsed = SESSION_STREAM_FRAME_SCHEMA.safeParse(delivered);
  if (!parsed.success) {
    return undefined;
  }
  const events: ProjectedSessionEvent[] = [];
  let unreadableEventCount = 0;
  for (const change of parsed.data.changes) {
    const event = projectSessionEvent(change.event, change.cursor);
    if (event === undefined) {
      unreadableEventCount += 1;
    } else {
      events.push(event);
    }
  }
  // The schema admits a frame only with a change or with the newest cursor.
  const resumeCursor = parsed.data.changes.at(-1)?.cursor ?? (parsed.data.cursor as EventCursor);
  return {
    events,
    unreadableEventCount,
    dropped: parsed.data.dropped === true,
    resumeCursor,
  };
}

/**
 * Narrows one parsed envelope and the cursor it was delivered at into the app's event shape, or
 * `undefined` when its category disagrees with the census for its type.
 *
 * `type` becomes `kind` and `actor` becomes `actorId`; a `null` or absent actor is left unset
 * because the wire does not say whether an id is a user or an agent. `category` is checked but not
 * carried, since no reader uses it. A type the census does not know passes unchanged, which keeps
 * higher-minor events readable.
 */
function projectSessionEvent(
  envelope: EventEnvelope,
  cursor: string,
): ProjectedSessionEvent | undefined {
  // The envelope's `type` is a free-form string; a `ReadonlyMap` returns `undefined` for an
  // unregistered key, including prototype-chain names, which is the "unknown type" case.
  const registeredCategory = SESSION_EVENT_CATEGORY_BY_TYPE.get(envelope.type as SessionEventType);
  if (registeredCategory !== undefined && envelope.category !== registeredCategory) {
    return undefined;
  }
  return {
    id: envelope.id,
    sessionId: envelope.sessionId,
    sequence: envelope.sequence,
    cursor,
    kind: envelope.type,
    occurredAt: envelope.occurredAt,
    ...(envelope.actor === undefined || envelope.actor === null ? {} : { actorId: envelope.actor }),
    payload: envelope.payload,
  };
}
