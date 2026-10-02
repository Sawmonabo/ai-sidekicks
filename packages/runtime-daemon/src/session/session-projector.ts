// Pure fold from a session's event stream to a `DaemonSessionSnapshot`. It does no I/O; the
// caller supplies events in `sequence ASC` order and the projector trusts that order.

import type { DaemonSessionSnapshot, StoredEvent } from "./types.js";

/**
 * Folds a session's events into a snapshot, or returns `null` for an empty list, since a
 * session has at least its `session.created` event.
 *
 * Throws when the first event is not a `session.created` at sequence 0: a bootstrap at another
 * sequence means earlier events were lost or the producer broke the contract, and projecting
 * from it would present partial state as complete.
 */
export function replay(events: ReadonlyArray<StoredEvent>): DaemonSessionSnapshot | null {
  if (events.length === 0) {
    return null;
  }
  const first: StoredEvent = events[0]!;
  if (first.type !== "session.created") {
    throw new Error(
      `replay: expected first event type 'session.created', got '${first.type}' (sequence=${String(first.sequence)})`,
    );
  }
  if (first.sequence !== 0) {
    throw new Error(
      `replay: bootstrap 'session.created' must have sequence=0 (got sequence=${String(first.sequence)}); a non-zero bootstrap sequence indicates lost/corrupted earlier events or a producer-side bootstrap-contract violation`,
    );
  }
  let snapshot: DaemonSessionSnapshot = bootstrapFromCreated(first);
  for (let i = 1; i < events.length; i++) {
    snapshot = projectEvent(snapshot, events[i]!);
  }
  return snapshot;
}

/**
 * Applies one event to a snapshot and returns the new snapshot without mutating the input.
 * Every type except `session.created` only advances `asOfSequence`; a `session.created` here
 * throws.
 */
export function projectEvent(
  snapshot: DaemonSessionSnapshot,
  event: StoredEvent,
): DaemonSessionSnapshot {
  switch (event.type) {
    case "session.created":
      // A second `session.created` would replace the session's state mid-stream or duplicate
      // the bootstrap. The storage schema would accept one at a later sequence, so the
      // projector refuses it.
      throw new Error(
        `projectEvent: 'session.created' may only appear at sequence=0 (got sequence=${String(event.sequence)})`,
      );
    default:
      // Every other event type only advances the sequence.
      return { ...snapshot, asOfSequence: event.sequence };
  }
}

function bootstrapFromCreated(event: StoredEvent): DaemonSessionSnapshot {
  // The owner is the envelope's `actor`. A system-emitted bootstrap has `actor: null` (legal
  // on the wire), which stays `null` rather than an invented identity. An empty string is
  // normalized to `null` so readers check one absent form.
  const rawOwnerActor: string | null = event.actor;
  const ownerActor: string | null =
    rawOwnerActor !== null && rawOwnerActor.length > 0 ? rawOwnerActor : null;

  return {
    sessionId: event.sessionId,
    createdAt: event.occurredAt,
    asOfSequence: event.sequence,
    ownerActor,
  };
}
