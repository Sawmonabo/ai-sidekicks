// Session-state projector — pure-functional fold from event stream to
// `DaemonSessionSnapshot`. The projector never touches I/O; the service
// layer (session-service.ts) reads events from SQLite and feeds them in
// `sequence ASC` order.
//
// Event coverage:
//   * session.created — bootstrap the session, record its owner, and
//                       synthesize the main channel (a projected
//                       structural invariant; see below)
//   * channel.created — append a channel row
//
// Bootstrap contract: a single `session.created` event MUST yield a
// snapshot naming the owner (read off the envelope's `actor`) AND carrying
// the bootstrap main channel, whose id is derived via the shared
// `deriveMainChannelId` from `@ai-sidekicks/contracts` (RFC 9562 §5.8
// UUIDv8). Every newly-created session therefore has a stable id, a known
// owner, and a default channel from its first event onward — the projector
// synthesizes the channel rather than waiting for a separate
// `channel.created` envelope. The main channel is a PROJECTED STRUCTURAL
// INVARIANT (1:1 with the session), NOT an event-sourced row.
//
// Ordering contract: `replay()` consumes events in the exact order it
// receives them. The service layer is responsible for sorting by
// `sequence ASC`; the projector itself trusts the input order. This keeps
// the projector pure and lets the service-layer tests prove the
// sequence-not-monotonic_ns invariant without contaminating projector
// logic.

import { deriveMainChannelId, MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import type { ChannelProjection, DaemonSessionSnapshot, StoredEvent } from "./types.js";

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
 * Unknown event types are tolerated as a no-op — the projector folds only
 * the two variants below, but the daemon may receive later event types
 * during forward-compatible replay, where MINOR-version additions to the
 * event union are non-breaking by construction.
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
    case "channel.created":
      return applyChannelCreated(snapshot, event);
    default:
      // Forward-compatible no-op for unknown event types.
      // TODO: bump an unknown_event_type_skipped counter so the
      // observability surface sees forward-compat skips at runtime instead
      // of swallowing them silently.
      return { ...snapshot, asOfSequence: event.sequence };
  }
}

// --------------------------------------------------------------------------
// Bootstrap from session.created — records the owner, synthesizes the main
// channel.
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

  const mainChannel: ChannelProjection = {
    channelId: deriveMainChannelId(event.sessionId),
    name: MAIN_CHANNEL_NAME,
    createdAt: event.occurredAt,
  };

  return {
    sessionId: event.sessionId,
    // A newly created session starts in `provisioning` and transitions to
    // `active` once storage and control-plane metadata are ready, announced
    // by a distinct `session.activated` event. The full canonical lifecycle
    // is provisioning → active → archived/closed → purge_requested →
    // purged; the wire enum is `SessionState` in
    // `packages/contracts/src/session.ts`.
    // TODO: handle `session.activated` and transition to `active`.
    state: "provisioning",
    createdAt: event.occurredAt,
    asOfSequence: event.sequence,
    ownerActor,
    channels: [mainChannel],
  };
}

// --------------------------------------------------------------------------
// channel.created — appends a channel (idempotent on channelId).
// --------------------------------------------------------------------------

function applyChannelCreated(
  snapshot: DaemonSessionSnapshot,
  event: StoredEvent,
): DaemonSessionSnapshot {
  // Step 1: validate channelId. `channelId` is REQUIRED on the wire
  // (`ChannelIdSchema` is non-optional in `channelCreatedPayloadSchema`),
  // so a missing/empty value is a producer bug at any sequence.
  const channelId: unknown = event.payload["channelId"];
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error(
      `applyChannelCreated: payload.channelId must be a non-empty string at sequence=${String(event.sequence)}`,
    );
  }

  // Step 2: idempotent no-op for already-known channels. This guard is
  // LOAD-BEARING and runs BEFORE optional-field validation so that a
  // duplicate-main-channel event (which the audit-log consolidation may
  // legitimately emit when bootstrap becomes a real event) survives
  // even if it omits the wire-optional `name`. Without the early return,
  // a perfectly-valid duplicate envelope with the wire-permissible
  // omitted `name` would crash projection in the next step.
  // TODO: when `channel.created` becomes the authoritative source for the
  // main channel, the bootstrap synthesis here should be gated on whether
  // the event log already contains an explicit
  // `channel.created` for the derived main-channel id.
  const alreadyExists: boolean = snapshot.channels.some((c) => c.channelId === channelId);
  if (alreadyExists) {
    return { ...snapshot, asOfSequence: event.sequence };
  }

  // Step 3: validate `name` IF PRESENT. The wire schema (per
  // `channelCreatedPayloadSchema` in `packages/contracts/src/event.ts`)
  // declares `name` as `wireFreeFormString(...).optional()` — the key
  // may be absent/undefined. We mirror that on the daemon side: omitted
  // is fine, but a present-but-non-string or present-but-empty value is
  // a producer bug (mirrors `wireFreeFormString`'s whitespace-rejection
  // stance). The check is intentionally typeof-guard + length, NOT a
  // `==` against undefined, because `payload.name === undefined` is
  // indistinguishable from a missing key on a JSON-derived object.
  const rawName: unknown = event.payload["name"];
  let name: string | undefined;
  if (rawName === undefined) {
    name = undefined;
  } else if (typeof rawName === "string" && rawName.length > 0) {
    name = rawName;
  } else {
    throw new Error(
      `applyChannelCreated: payload.name must be a non-empty string when present at sequence=${String(event.sequence)} (got ${typeof rawName === "string" ? "''" : typeof rawName})`,
    );
  }

  // Step 4: append. `name` is omitted from the projection literal when
  // undefined (the `name?: string` shape on `ChannelProjection` matches
  // the wire optionality semantics). `exactOptionalPropertyTypes` is on
  // for the daemon, so we conditionally spread rather than assign
  // `name: undefined` — assigning undefined to an optional field is a
  // type error under that flag.
  const newChannel: ChannelProjection = {
    channelId,
    ...(name !== undefined ? { name } : {}),
    createdAt: event.occurredAt,
  };
  return {
    ...snapshot,
    asOfSequence: event.sequence,
    channels: [...snapshot.channels, newChannel],
  };
}
