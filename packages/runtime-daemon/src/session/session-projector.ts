// Session-state projector — pure-functional fold from event stream to
// `DaemonSessionSnapshot`. The projector never touches I/O; the service
// layer (session-service.ts) reads events from SQLite and feeds them in
// `sequence ASC` order.
//
// V1 event coverage (mirrors @ai-sidekicks/contracts §V1 SessionEvent):
//   * session.created       — bootstrap session + owner membership +
//                             main channel (synthesized from defaults)
//   * membership.joined     — append membership row
//   * channel.created       — append channel row
//
// D1 contract: a single `session.created` event MUST yield a snapshot
// with the owner membership row (derived from the envelope's `actor`)
// AND the main channel (synthesized with id "main"). This matches the
// Spec-001 §Acceptance Criteria AC1 invariant — every newly-created
// session has a stable id, an owner membership, and a default channel.
//
// D2/D3 contract: `replay()` consumes events in the exact order it
// receives them. The service layer is responsible for sorting by
// `sequence ASC`; the projector itself trusts the input order. This
// keeps the projector pure and lets the service-layer test (D3) prove
// the sequence-not-monotonic_ns invariant without contaminating
// projector logic.

import type {
  ChannelProjection,
  DaemonSessionSnapshot,
  MembershipProjection,
  StoredEvent,
} from "./types.js";

const MAIN_CHANNEL_ID: string = "main";
const MAIN_CHANNEL_NAME: string = "main";

/**
 * Replay a sequence of events into a snapshot. Returns `null` if no
 * events are provided — there is no such thing as an empty session.
 *
 * The first event MUST be a `session.created`. Subsequent events fold
 * into the snapshot via `projectEvent`.
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
 * Unknown event types are tolerated as a no-op — Plan-001 ships only the
 * 3 V1 variants but the daemon may receive future-spec events during
 * forward-compatible replay (per ADR-018 §Decision #1, MINOR-version
 * additions are non-breaking).
 */
export function projectEvent(snapshot: DaemonSessionSnapshot, event: StoredEvent): DaemonSessionSnapshot {
  switch (event.type) {
    case "session.created":
      throw new Error(
        `projectEvent: 'session.created' may only appear at sequence=0 (got sequence=${String(event.sequence)})`,
      );
    case "membership.joined":
      return applyMembershipJoined(snapshot, event);
    case "channel.created":
      return applyChannelCreated(snapshot, event);
    default:
      // Forward-compatible no-op for unknown event types.
      return { ...snapshot, asOfSequence: event.sequence };
  }
}

// --------------------------------------------------------------------------
// Bootstrap from session.created — synthesizes owner + main channel.
// --------------------------------------------------------------------------

function bootstrapFromCreated(event: StoredEvent): DaemonSessionSnapshot {
  const ownerActor: string | null = event.actor;
  if (ownerActor === null || ownerActor.length === 0) {
    throw new Error(
      `bootstrapFromCreated: session.created event must carry an actor (the owner participant id) at sequence=${String(event.sequence)}`,
    );
  }

  const ownerMembership: MembershipProjection = {
    participantId: ownerActor,
    role: "owner",
    joinedAt: event.occurredAt,
  };

  const mainChannel: ChannelProjection = {
    channelId: MAIN_CHANNEL_ID,
    name: MAIN_CHANNEL_NAME,
    createdAt: event.occurredAt,
  };

  return {
    sessionId: event.sessionId,
    state: "active",
    createdAt: event.occurredAt,
    asOfSequence: event.sequence,
    memberships: [ownerMembership],
    channels: [mainChannel],
  };
}

// --------------------------------------------------------------------------
// membership.joined — appends a member (idempotent on participantId).
// --------------------------------------------------------------------------

function applyMembershipJoined(
  snapshot: DaemonSessionSnapshot,
  event: StoredEvent,
): DaemonSessionSnapshot {
  const participantId: unknown = event.payload["participantId"];
  if (typeof participantId !== "string" || participantId.length === 0) {
    throw new Error(
      `applyMembershipJoined: payload.participantId must be a non-empty string at sequence=${String(event.sequence)}`,
    );
  }
  const alreadyMember: boolean = snapshot.memberships.some(
    (m) => m.participantId === participantId,
  );
  if (alreadyMember) {
    return { ...snapshot, asOfSequence: event.sequence };
  }
  const newMembership: MembershipProjection = {
    participantId,
    role: "member",
    joinedAt: event.occurredAt,
  };
  return {
    ...snapshot,
    asOfSequence: event.sequence,
    memberships: [...snapshot.memberships, newMembership],
  };
}

// --------------------------------------------------------------------------
// channel.created — appends a channel (idempotent on channelId).
// --------------------------------------------------------------------------

function applyChannelCreated(
  snapshot: DaemonSessionSnapshot,
  event: StoredEvent,
): DaemonSessionSnapshot {
  const channelId: unknown = event.payload["channelId"];
  const name: unknown = event.payload["name"];
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error(
      `applyChannelCreated: payload.channelId must be a non-empty string at sequence=${String(event.sequence)}`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `applyChannelCreated: payload.name must be a non-empty string at sequence=${String(event.sequence)}`,
    );
  }
  const alreadyExists: boolean = snapshot.channels.some((c) => c.channelId === channelId);
  if (alreadyExists) {
    return { ...snapshot, asOfSequence: event.sequence };
  }
  const newChannel: ChannelProjection = {
    channelId,
    name,
    createdAt: event.occurredAt,
  };
  return {
    ...snapshot,
    asOfSequence: event.sequence,
    channels: [...snapshot.channels, newChannel],
  };
}
