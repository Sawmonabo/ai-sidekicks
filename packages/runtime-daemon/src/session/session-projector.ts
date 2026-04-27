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
// AND the main channel (synthesized with deterministic UUIDv5 id). This
// matches the Spec-001 §Acceptance Criteria AC1 invariant — every newly-
// created session has a stable id, an owner membership, and a default
// channel. Per Plan-001 plan-line-129 the bootstrap is "single
// SessionCreated event yields snapshot with owner membership and main
// channel" — the projector synthesizes both rather than waiting for a
// separate `channel.created` envelope.
//
// D2/D3 contract: `replay()` consumes events in the exact order it
// receives them. The service layer is responsible for sorting by
// `sequence ASC`; the projector itself trusts the input order. This
// keeps the projector pure and lets the service-layer test (D3) prove
// the sequence-not-monotonic_ns invariant without contaminating
// projector logic.

import { createHash } from "node:crypto";

import type {
  ChannelProjection,
  DaemonSessionSnapshot,
  MembershipProjection,
  MembershipRole,
  StoredEvent,
} from "./types.js";

// --------------------------------------------------------------------------
// Main-channel id derivation
// --------------------------------------------------------------------------
//
// Every newly-created session has an implicit "main" channel. The wire-
// layer `ChannelIdSchema` from `@ai-sidekicks/contracts` brands a
// `z.uuid()` — Round 1 used the literal string "main" which would be
// rejected at the PR #5 mapping seam.
//
// The id is derived deterministically as UUIDv5 over a daemon-local
// namespace + the session id. This guarantees:
//   * same session_id → same channel_id across all daemon processes
//     (the snapshot is reproducible — D2/D4 stay green),
//   * the id is a valid UUID (passes `z.uuid()` validation),
//   * no DB write is needed at session-create time to mint a channel id
//     (preserving the "single event yields bootstrap" Plan-001 invariant
//     — see plan-line-129 D1).
//
// The namespace UUID is a one-time mint, frozen here. Changing it
// invalidates every existing main-channel id, so it lives as a const.
//
// Per Plan-001 PR #3 scope: this derivation is daemon-internal. PR #5
// will reconcile with the contracts brand at the IPC mapping layer; until
// then the daemon's `ChannelProjection.channelId: string` is the surface.

const MAIN_CHANNEL_NAMESPACE: string = "5b8c3f0a-7e2d-4b41-9b7c-1f6c0a5b2d3e";
const MAIN_CHANNEL_NAME: string = "main";

/**
 * Derive the deterministic UUIDv5 channel id for the implicit "main"
 * channel of a session. Same `sessionId` → byte-identical UUID across
 * processes / restarts.
 *
 * Implements RFC 9562 §5.5 directly (Node has no built-in `uuidv5`):
 *   1. SHA-1 over (namespace bytes || name bytes)
 *   2. Take the first 16 bytes
 *   3. Set version nibble = 5 (high nibble of byte 6)
 *   4. Set variant bits = 10 (high two bits of byte 8)
 *   5. Format as 8-4-4-4-12 lowercase hex
 *
 * Exported for unit-testability: D6 (deterministic UUIDv5 derivation)
 * pins this exact derivation across calls with the same input.
 */
export function deriveMainChannelId(sessionId: string): string {
  const namespaceBytes: Buffer = uuidStringToBytes(MAIN_CHANNEL_NAMESPACE);
  const nameBytes: Buffer = Buffer.from(`${sessionId}:${MAIN_CHANNEL_NAME}`, "utf8");
  const hash: Buffer = createHash("sha1")
    .update(namespaceBytes)
    .update(nameBytes)
    .digest();
  const bytes: Buffer = hash.subarray(0, 16);
  // Version 5: clear high 4 bits of byte 6, set them to 0101.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant 10 (RFC 4122 / RFC 9562): clear high 2 bits of byte 8, set them to 10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function uuidStringToBytes(uuid: string): Buffer {
  // 36-char canonical form: 8-4-4-4-12 with hyphens. Strip hyphens and
  // hex-decode. The namespace const above is well-formed by construction;
  // this helper does no defensive validation because there is no
  // user-supplied UUID input on the call path.
  const hex: string = uuid.replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex: string = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// --------------------------------------------------------------------------
// Replay
// --------------------------------------------------------------------------

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
      // TODO(Plan-013): bump unknown_event_type_skipped counter so the
      // observability surface (per Spec-013 + Plan-013 telemetry plan)
      // sees forward-compat skips at runtime instead of swallowing them
      // silently.
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
    channelId: deriveMainChannelId(event.sessionId),
    name: MAIN_CHANNEL_NAME,
    createdAt: event.occurredAt,
  };

  return {
    sessionId: event.sessionId,
    // Spec-001 line 53: a newly created session starts in `provisioning`
    // and transitions to `active` once initial membership, storage, and
    // control-plane metadata are ready. Spec-006 line 103 enumerates a
    // distinct `session.activated` event for that transition.
    // TODO(Plan-006): handle `session.activated` and transition to `active`.
    state: "provisioning",
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
  const role: MembershipRole = readRoleFromPayload(event);
  const alreadyMember: boolean = snapshot.memberships.some(
    (m) => m.participantId === participantId,
  );
  if (alreadyMember) {
    return { ...snapshot, asOfSequence: event.sequence };
  }
  const newMembership: MembershipProjection = {
    participantId,
    role,
    joinedAt: event.occurredAt,
  };
  return {
    ...snapshot,
    asOfSequence: event.sequence,
    memberships: [...snapshot.memberships, newMembership],
  };
}

// `MembershipJoinedEvent.payload.role` is required and validated by the
// contracts schema (`MembershipRoleSchema = z.enum(["owner", "viewer",
// "collaborator", "runtime contributor"])`). Plan-001 PR #3 is upstream
// of the IPC mapping seam (PR #5), so events arriving here originate from
// in-process callers — the projector validates structurally rather than
// trusting the contract was already enforced.
const VALID_MEMBERSHIP_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  "owner",
  "viewer",
  "collaborator",
  "runtime contributor",
]);

function readRoleFromPayload(event: StoredEvent): MembershipRole {
  const role: unknown = event.payload["role"];
  if (typeof role !== "string" || !VALID_MEMBERSHIP_ROLES.has(role as MembershipRole)) {
    throw new Error(
      `applyMembershipJoined: payload.role must be one of ${[...VALID_MEMBERSHIP_ROLES].join("|")} at sequence=${String(event.sequence)} (got ${typeof role === "string" ? `'${role}'` : typeof role})`,
    );
  }
  return role as MembershipRole;
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
  // The `alreadyExists` no-op is LOAD-BEARING. It is the seam that lets
  // the bootstrap-synthesized "main" channel coexist with any future
  // explicit `channel.created` envelope carrying the same derived id —
  // which Plan-006's event-driven session-creation flow may legitimately
  // emit when consolidating bootstrap into real audit-log events.
  // Without this guard, double-projection (synthesized + explicit) would
  // produce duplicate channel rows.
  // TODO(Plan-006): when `channel.created` becomes the authoritative
  // source for the main channel, the bootstrap synthesis here should be
  // gated on whether the event log already contains an explicit
  // `channel.created` for the derived main-channel id.
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
