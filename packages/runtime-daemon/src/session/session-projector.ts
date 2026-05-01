// Session-state projector — pure-functional fold from event stream to
// `DaemonSessionSnapshot`. The projector never touches I/O; the service
// layer (session-service.ts) reads events from SQLite and feeds them in
// `sequence ASC` order.
//
// V1 event coverage (mirrors @ai-sidekicks/contracts §V1 SessionEvent):
//   * session.created       — bootstrap session + owner membership +
//                             main channel (synthesized from defaults)
//   * membership.created     — append membership row
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
// `z.uuid()`, so the channel id MUST be a valid UUID by the time it
// crosses the IPC seam (Plan-001 PR #5).
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
  const hash: Buffer = createHash("sha1").update(namespaceBytes).update(nameBytes).digest();
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
 * Unknown event types are tolerated as a no-op — Plan-001 ships only the
 * 3 V1 variants but the daemon may receive future-spec events during
 * forward-compatible replay (per ADR-018 §Decision #1, MINOR-version
 * additions are non-breaking).
 */
export function projectEvent(
  snapshot: DaemonSessionSnapshot,
  event: StoredEvent,
): DaemonSessionSnapshot {
  switch (event.type) {
    case "session.created":
      // Daemon-internal authorial choice (not contract guarantee): the
      // projector treats `session.created` as a sequence-0 anchor and
      // rejects any later occurrence. The wire schema doc (per
      // `docs/architecture/schemas/local-sqlite-schema.md`) only
      // references `sequence = 0` in the prev_hash zero-fill rule and
      // does not explicitly prohibit `session.created` at sequence > 0.
      // Plan-001 anchors the bootstrap at sequence=0 because `replay()`
      // uses the first event for bootstrap and the service layer reads
      // in `sequence ASC`, so any non-zero `session.created` would
      // either re-bootstrap mid-stream (silent state replacement) or
      // be a duplicate of the bootstrap event (caller bug). A future
      // session-restate event should land as a distinct variant (e.g.
      // `session.snapshot_restored`) rather than re-using
      // `session.created`.
      throw new Error(
        `projectEvent: 'session.created' may only appear at sequence=0 (got sequence=${String(event.sequence)})`,
      );
    case "membership.created":
      return applyMembershipCreated(snapshot, event);
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
  // Owner-membership synthesis policy — wire-contract reconciliation.
  //
  // The wire `SessionEventSchema` accepts `actor: null` for every variant
  // (per `packages/contracts/src/event.ts:239`), and the canonical
  // `session.created` payload comment at
  // `packages/contracts/src/event.ts:289-301` is explicit:
  //   "The owner participant is conveyed via the membership.created event
  //    that follows."
  // i.e. on the wire, `session.created.actor` may legitimately be null
  // (system-emitted) and the owner's identity arrives in the `membership.
  // joined` event.
  //
  // Plan-001 plan-line-129 D1 says "Single SessionCreated event yields
  // snapshot with owner membership and main channel". The only way to
  // honor that within Plan-001 PR #3's pre-IPC, in-process callers is to
  // let the caller stuff the owner participant id into `actor` as a
  // shortcut. PR #5 introduces the wire seam at which point the
  // `actor: null` branch is the steady state.
  //
  // So: when `actor` is a non-empty string, synthesize the owner row (the
  // Plan-001 pre-IPC shortcut). When `actor` is null or empty, return
  // memberships=[] — the subsequent `membership.created` event populates
  // owner identity. This keeps the projector correct against the wire
  // contract today AND keeps the D1 fixture path (which sets `actor:
  // OWNER_ID`) working as Plan-001 intends.
  const ownerActor: string | null = event.actor;
  const memberships: ReadonlyArray<MembershipProjection> =
    ownerActor !== null && ownerActor.length > 0
      ? [
          {
            participantId: ownerActor,
            role: "owner",
            joinedAt: event.occurredAt,
          },
        ]
      : [];

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
    // distinct `session.activated` event for that transition. The full
    // canonical lifecycle (provisioning → active → archived/closed →
    // purge_requested → purged) lives in
    // `docs/domain/session-model.md:61-77`; the wire enum is
    // `SessionState` in `packages/contracts/src/session.ts:129-135`.
    // TODO(Plan-006): handle `session.activated` and transition to `active`.
    state: "provisioning",
    createdAt: event.occurredAt,
    asOfSequence: event.sequence,
    memberships,
    channels: [mainChannel],
  };
}

// --------------------------------------------------------------------------
// membership.created — appends a member (idempotent on participantId).
// --------------------------------------------------------------------------

function applyMembershipCreated(
  snapshot: DaemonSessionSnapshot,
  event: StoredEvent,
): DaemonSessionSnapshot {
  const participantId: unknown = event.payload["participantId"];
  if (typeof participantId !== "string" || participantId.length === 0) {
    throw new Error(
      `applyMembershipCreated: payload.participantId must be a non-empty string at sequence=${String(event.sequence)}`,
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

// `MembershipCreatedEvent.payload.role` is required and validated by the
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
      `applyMembershipCreated: payload.role must be one of ${[...VALID_MEMBERSHIP_ROLES].join("|")} at sequence=${String(event.sequence)} (got ${typeof role === "string" ? `'${role}'` : typeof role})`,
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
  // duplicate-main-channel event (which Plan-006 may legitimately emit
  // when consolidating bootstrap into real audit-log events) survives
  // even if it omits the wire-optional `name`. Without the early return,
  // a perfectly-valid duplicate envelope with the wire-permissible
  // omitted `name` would crash projection in the next step.
  // TODO(Plan-006): when `channel.created` becomes the authoritative
  // source for the main channel, the bootstrap synthesis here should be
  // gated on whether the event log already contains an explicit
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
