// Decodes one `session.event.subscribe` frame into app events, each with the run stamp the daemon
// gave it, whether the daemon marked the stream far behind, and the cursor a re-opened stream
// resumes after, or refuses it. This is the only place that reads fields off the `unknown` the
// bridge delivers. The session read's standing events are narrowed into app events by the same
// projection.
//
// The frame is checked once here with the contract's generated frame check, whose envelope keeps
// an event type as written, so a type newer than this build still reaches the app. The envelope
// does not tie an event's category to its type, and every projector routes on `kind` alone, so
// `projectSessionEvent` checks the pairing against the contracts census.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/category-by-type";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { EventCursor } from "@ai-sidekicks/contracts/session/id";
import {
  validateSessionStreamFrame,
  type SessionStreamFrame,
} from "@ai-sidekicks/contracts/session/methods";
import type { TranscriptRunStamp } from "@ai-sidekicks/contracts/transcript/row";

import type { FilePathRef } from "#shared/preload-api.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { withBytesPlaced } from "../../wire/attachments.js";

/** What one readable frame tells the app. */
export interface SessionStreamFrameReading {
  /** The frame's events the app can hold, in stream order. */
  readonly events: readonly ProjectedSessionEvent[];
  /** The frame's events whose type the census pairs with another category. */
  readonly unreadableEventCount: number;
  /**
   * The daemon marked the stream far behind its head and sent no changes, so the screen takes
   * one read of the daemon's record and carries on from the head cursor.
   */
  readonly isBehind: boolean;
  /**
   * Where this frame leaves the stream: the cursor of its last change, readable or not, or the
   * caught-up frame's newest cursor. A stream opened again after it resumes past this frame.
   */
  readonly resumeCursor: EventCursor;
}

/**
 * Reads one delivered frame, or returns `undefined` when its generated check refuses it.
 *
 * A frame is refused whole for a forbidden member, an event the envelope check refuses, too many
 * changes, or no changes without being the far-behind frame. The check reads each `{"$bytes": n}`
 * member from the delivery's `attachments`, which then take their placeholders' places. Each
 * change's cursor rides on its event, where a link to a message finds it, and the store orders
 * events by `sequence`. Each event keeps the tokens main minted for the paths its payload names.
 */
export function readSessionStreamFrame(
  frame: unknown,
  attachments: readonly Uint8Array[],
  fileRefs: Readonly<Record<string, FilePathRef>> | undefined,
): SessionStreamFrameReading | undefined {
  if (!validateSessionStreamFrame.call({ attachments }, frame)) {
    return undefined;
  }
  const delivered = withBytesPlaced(frame, attachments) as SessionStreamFrame;
  if (delivered.kind === "behind") {
    return {
      events: [],
      unreadableEventCount: 0,
      isBehind: true,
      resumeCursor: delivered.headCursor,
    };
  }
  const events: ProjectedSessionEvent[] = [];
  let unreadableEventCount = 0;
  // The check admits a changes frame only with at least one change.
  let resumeCursor = delivered.changes[0].cursor;
  for (const change of delivered.changes) {
    resumeCursor = change.cursor;
    const event = projectSessionEvent(change.event, change.cursor, change.runStamp);
    if (event === undefined) {
      unreadableEventCount += 1;
      continue;
    }
    const eventFileRefs = fileRefsNamedBy(event.payload, fileRefs);
    events.push(eventFileRefs === undefined ? event : { ...event, fileRefs: eventFileRefs });
  }
  return { events, unreadableEventCount, isBehind: false, resumeCursor };
}

/**
 * Narrows one checked envelope, the cursor it was delivered at and the run stamp it came with into
 * the app's event shape, or `undefined` when its category disagrees with the census for its type.
 *
 * `type` becomes `kind` and `actor` becomes `actorId`; a `null` or absent actor is left unset
 * because the wire does not say whether an id is a user or an agent. `category` is checked but not
 * carried, since no reader uses it. A type the census does not know passes unchanged, which keeps
 * an event type newer than this build readable. The run stamp is carried as the daemon sent it,
 * absent when it sent none.
 */
export function projectSessionEvent(
  envelope: EventEnvelope,
  cursor: string,
  runStamp: TranscriptRunStamp | undefined,
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
    ...(runStamp === undefined ? {} : { runStamp }),
  };
}

/**
 * The frame's tokens whose path one of `payload`'s string members spells, or `undefined` for none:
 * a frame's tokens are keyed by path across its events, and each event keeps only its own.
 */
function fileRefsNamedBy(
  payload: unknown,
  fileRefs: Readonly<Record<string, FilePathRef>> | undefined,
): Readonly<Record<string, FilePathRef>> | undefined {
  if (fileRefs === undefined) {
    return undefined;
  }
  const named: Record<string, FilePathRef> = {};
  for (const text of stringMembersOf(payload)) {
    const ref = Object.hasOwn(fileRefs, text) ? fileRefs[text] : undefined;
    if (ref !== undefined) {
      named[text] = ref;
    }
  }
  return Object.keys(named).length === 0 ? undefined : named;
}

/** Every string `value` holds, at any depth. */
function* stringMembersOf(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const element of value) {
      yield* stringMembersOf(element);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) {
      yield* stringMembersOf(member);
    }
  }
}
