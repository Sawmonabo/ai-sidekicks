// Session-state projector — pure-functional fold from event stream to
// `DaemonSessionSnapshot`. The projector never touches I/O; the service
// layer (session-service.ts) reads events from SQLite and feeds them in
// `sequence ASC` order.
//
// Event coverage: `session.created` bootstraps the session and records its
// owner; every other event type only advances `asOfSequence` (a second
// `session.created` throws).
//
// Bootstrap contract: a single `session.created` event MUST yield a
// snapshot naming the owner (read off the envelope's `actor`), so every
// newly-created session has a stable id and a known owner from its first
// event onward.
//
// Ordering contract: `replay()` consumes events in the exact order it
// receives them. The service layer is responsible for sorting by
// `sequence ASC`; the projector itself trusts the input order. This keeps
// the projector pure and lets the service-layer tests prove the
// sequence-not-monotonic_ns invariant without contaminating projector
// logic.

import type { DaemonSessionSnapshot, StoredEvent } from "./types.js";

// --------------------------------------------------------------------------
// Replay
// --------------------------------------------------------------------------

/**
 * Replay a sequence of events into a snapshot. Returns `null` if no
 * events are provided — there is no such thing as an empty session.
 *
 * The first event MUST be a `session.created` AT sequence=0. The
 * sequence-0 anchor is the same invariant `projectEvent` enforces for a
 * second `session.created` (see the `case "session.created"` block
 * below): if the first event in the log carries a non-zero sequence,
 * either an earlier event was lost / corrupted (most dangerous case —
 * silent partial replay would project incomplete state as canonical) or
 * the producer violated the bootstrap contract (also a bug, but a
 * recoverable one once surfaced). Either way, throwing here keeps
 * `replay()`'s bootstrap path consistent with `projectEvent`'s in-stream
 * guard and prevents a `session.created` at sequence > 0 from being
 * silently treated as a valid bootstrap.
 *
 * Subsequent events fold into the snapshot via `projectEvent`.
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
 * Apply a single event to the running snapshot. Pure: returns a new
 * snapshot, does not mutate the input.
 *
 * Every type other than `session.created` is a no-op that advances
 * `asOfSequence`: the daemon may receive later event types during
 * forward-compatible replay, where MINOR-version additions to the event
 * union are non-breaking by construction.
 */
export function projectEvent(
  snapshot: DaemonSessionSnapshot,
  event: StoredEvent,
): DaemonSessionSnapshot {
  switch (event.type) {
    case "session.created":
      // Daemon-internal authorial choice (not contract guarantee): the
      // projector treats `session.created` as a sequence-0 anchor and
      // rejects any later occurrence. The storage schema only references
      // `sequence = 0` in the prev_hash zero-fill rule and does not
      // explicitly prohibit `session.created` at sequence > 0. The
      // bootstrap is anchored at sequence=0 here because `replay()` uses
      // the first event for bootstrap and the service layer reads in
      // `sequence ASC`, so any non-zero `session.created` would either
      // re-bootstrap mid-stream (silent state replacement) or be a
      // duplicate of the bootstrap event (caller bug). A future
      // session-restate event should land as a distinct variant (e.g.
      // `session.snapshot_restored`) rather than re-using
      // `session.created`.
      throw new Error(
        `projectEvent: 'session.created' may only appear at sequence=0 (got sequence=${String(event.sequence)})`,
      );
    default:
      // Forward-compatible no-op for every other event type.
      // TODO: bump an unknown_event_type_skipped counter so the
      // observability surface sees forward-compat skips at runtime instead
      // of swallowing them silently.
      return { ...snapshot, asOfSequence: event.sequence };
  }
}

// --------------------------------------------------------------------------
// Bootstrap from session.created — records the owner.
// --------------------------------------------------------------------------

function bootstrapFromCreated(event: StoredEvent): DaemonSessionSnapshot {
  // Owner derivation — the envelope's `actor` is the whole of it.
  //
  // The wire `SessionEventSchema` accepts `actor: null` for every variant
  // (per the shared `actor` field in `buildCommonShape()`, spread into every
  // variant), so a system-emitted bootstrap legitimately names nobody. The
  // projector reports that as `ownerActor: null` rather than inventing an
  // identity: `actor` is inside the canonical bytes the row's signature
  // covers, so an owner read off it is as trustworthy as the row, and an
  // owner read off anything else would not be.
  //
  // An empty-string `actor` is normalized to `null` for the same reason the
  // wire schema rejects blank identifiers — an empty owner is an absent
  // owner, and leaving the two distinguishable would make every reader
  // check both.
  const rawOwnerActor: string | null = event.actor;
  const ownerActor: string | null =
    rawOwnerActor !== null && rawOwnerActor.length > 0 ? rawOwnerActor : null;

  return {
    sessionId: event.sessionId,
    // A newly created session starts in `provisioning` and transitions to
    // `active` once its storage is ready, announced by a distinct
    // `session.activated` event. The full canonical lifecycle is provisioning →
    // active → archived/closed → purge_requested → purged; the wire enum is
    // `SessionState` in `packages/contracts/src/session.ts`.
    // TODO: handle `session.activated` and transition to `active`.
    state: "provisioning",
    createdAt: event.occurredAt,
    asOfSequence: event.sequence,
    ownerActor,
  };
}
