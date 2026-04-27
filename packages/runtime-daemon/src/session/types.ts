// Daemon-internal session types.
//
// These types intentionally do NOT import from `@ai-sidekicks/contracts`.
// The wire-facing `SessionSnapshot` in contracts is the *projection
// returned over IPC* — small, intentionally narrow. The daemon's internal
// projection carries memberships and channels because those are what the
// projector needs to fold over events. The two surfaces will be reconciled
// in Plan-001 PR #5 (client SDK + IPC mapping); for PR #3 the daemon's
// projection is purely internal.
//
// Hash-chain placeholder rationale: see migrations/0001-initial.sql
// header. Plan-006 owns real hash-chain semantics; Plan-001 writes
// zero-fill bytes and real `monotonic_ns` so NOT NULL constraints hold
// without claiming Plan-006 invariants.

// --------------------------------------------------------------------------
// Internal envelope (write-side input to SessionService.append)
// --------------------------------------------------------------------------
//
// Mirrors the canonical `session_events` row shape minus the integrity
// columns the service materializes itself (prev_hash/row_hash/signature
// are filled with zero placeholders by the writer per Plan-001 §Cross-
// Plan Forward-Declared Schema). `monotonic_ns` is also writer-supplied
// so tests can drive non-monotonic values to exercise D3 (sequence is the
// canonical replay key, not monotonic_ns).

export interface AppendableEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly occurredAt: string; // RFC 3339 UTC
  readonly monotonicNs: bigint;
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly version: string; // semver "MAJOR.MINOR" per ADR-018 §Decision #1
}

// --------------------------------------------------------------------------
// Internal stored-row shape (read-side output from SessionService.replay)
// --------------------------------------------------------------------------
//
// The projector consumes these (not raw DB rows) so the read path stays
// decoupled from the SQLite-row column ordering quirks.

export interface StoredEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly monotonicNs: bigint;
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly version: string;
}

// --------------------------------------------------------------------------
// Daemon session snapshot — projector output
// --------------------------------------------------------------------------
//
// `MembershipProjection` and `ChannelProjection` carry only the fields
// derivable from V1 SessionEvents (see contracts/src/event.ts §V1 union):
// session.created -> bootstrap session + owner membership + main channel,
// membership.joined -> membership row, channel.created -> channel row.
// PR #4/#5 will widen these as more event variants land.

export interface MembershipProjection {
  readonly participantId: string;
  readonly role: "owner" | "member";
  readonly joinedAt: string; // RFC 3339 UTC
}

export interface ChannelProjection {
  readonly channelId: string;
  readonly name: string;
  readonly createdAt: string; // RFC 3339 UTC
}

export interface DaemonSessionSnapshot {
  readonly sessionId: string;
  readonly state: "active" | "ended";
  readonly createdAt: string; // RFC 3339 UTC
  readonly asOfSequence: number;
  readonly memberships: ReadonlyArray<MembershipProjection>;
  readonly channels: ReadonlyArray<ChannelProjection>;
}
