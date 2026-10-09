// Pure fold from a session's event stream to a `DaemonSessionRecord`. It does no I/O; the
// caller supplies events in `sequence ASC` order and the projector trusts that order. The
// directory columns come from the same table the event's own write applies to the `sessions` row.
// It reads only members a hydrated envelope and a stored row both carry, so either can be folded.

import { foldDirectoryRow, openDirectoryRow } from "./directory/row.js";
import type { DaemonSessionRecord, SessionDirectoryRow, StoredEvent } from "./records.js";

// The members of one stored event the rebuild reads.
type RebuildEvent = Pick<
  StoredEvent,
  "sessionId" | "sequence" | "occurredAt" | "category" | "type" | "payload"
> & { readonly actor?: string | null | undefined };

/**
 * Folds a session's events into a record, or returns `null` for an empty list, since a
 * session has at least its `session.created` event.
 *
 * Throws when the first event is not a `session.created` at sequence 0: a bootstrap at another
 * sequence means earlier events were lost or the producer broke the contract, and projecting
 * from it would present partial state as complete. Throws for a later `session.created`, which
 * would replace the session mid-stream.
 */
export function rebuildSession(events: ReadonlyArray<RebuildEvent>): DaemonSessionRecord | null {
  if (events.length === 0) {
    return null;
  }
  const first: RebuildEvent = events[0]!;
  if (first.type !== "session.created") {
    throw new Error(
      `rebuildSession: expected first event type 'session.created', ` +
        `got '${first.type}' (sequence=${String(first.sequence)})`,
    );
  }
  if (first.sequence !== 0) {
    throw new Error(
      `rebuildSession: bootstrap 'session.created' must have sequence=0 (got sequence=` +
        `${String(first.sequence)}); a non-zero bootstrap sequence indicates lost/corrupted ` +
        `earlier events or a producer-side bootstrap-contract violation`,
    );
  }
  let row: SessionDirectoryRow = openDirectoryRow(first);
  for (let i = 1; i < events.length; i++) {
    row = foldDirectoryRow(row, events[i]!);
  }
  return {
    ...row,
    asOfSequence: events[events.length - 1]!.sequence,
    ownerActor: ownerActorOf(first),
  };
}

// The owner is the envelope's `actor`. A system-emitted bootstrap has no actor (legal on the
// wire), which stays `null` rather than an invented identity. An empty string is normalized to
// `null` so readers check one absent form.
function ownerActorOf(created: RebuildEvent): string | null {
  return created.actor !== undefined && created.actor !== null && created.actor.length > 0
    ? created.actor
    : null;
}
