// Daemon-internal session types.
//
// `DaemonSessionSnapshot` is intentionally distinct from the wire-facing
// `SessionSnapshot` in `@ai-sidekicks/contracts`: the wire shape is the
// projection returned over IPC (small, intentionally narrow), while the
// daemon's internal projection carries memberships and channels because
// those are what the projector folds over events. The two surfaces will
// be reconciled in Plan-001 PR #5 (client SDK + IPC mapping); for PR #3
// the daemon's projection is purely internal.
//
// `state` reuses `SessionState` from `@ai-sidekicks/contracts` so daemon
// code cannot drift from the wire vocabulary. The canonical enum is
// `provisioning | active | archived | closed | purge_requested | purged`
// per `packages/contracts/src/session.ts:129-135`,
// `docs/architecture/contracts/api-payload-contracts.md` §Shared Enums,
// and `docs/domain/session-model.md:61-77`. The contracts dependency
// was already present in this package's `package.json`; this import
// doesn't add a new edge to the workspace dep graph.
//
// Hash-chain placeholder rationale: see migrations/0001-initial.ts header.
// Plan-006 owns real hash-chain semantics; Plan-001 writes zero-fill bytes
// and real `monotonic_ns` so NOT NULL constraints hold without claiming
// Plan-006 invariants.

import type { SessionState } from "@ai-sidekicks/contracts";

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
// membership.created -> membership row, channel.created -> channel row.
// PR #4/#5 will widen these as more event variants land.
//
// `MembershipRole` mirrors the canonical contracts enum verbatim
// (`@ai-sidekicks/contracts` §MembershipRole; api-payload-contracts.md
// line 99). The "runtime contributor" string includes the literal space
// — preserved per the contracts source-of-truth. The projector reads
// `payload.role` directly so daemon-side narrowing cannot diverge from
// the wire enum.

export type MembershipRole = "owner" | "viewer" | "collaborator" | "runtime contributor";

export interface MembershipProjection {
  readonly participantId: string;
  readonly role: MembershipRole;
  readonly joinedAt: string; // RFC 3339 UTC
}

export interface ChannelProjection {
  readonly channelId: string;
  // `name` is OPTIONAL on the wire — `channelCreatedPayloadSchema` in
  // `packages/contracts/src/event.ts` declares it as
  // `wireFreeFormString(...).optional()` (i.e. the key may be absent /
  // undefined; explicitly NOT nullable). The daemon-internal projection
  // mirrors that shape so the wire-to-daemon coercion stays the identity
  // function. The bootstrap-synthesized "main" channel ALWAYS sets a name
  // (constant `MAIN_CHANNEL_NAME = "main"`), so the only producers of an
  // omitted-name projection are explicit `channel.created` envelopes whose
  // wire payload omitted the optional `name` field.
  //
  // UI fallback (e.g. label-by-channelId for the unnamed case) is the IPC
  // mapping seam's responsibility (Plan-001 PR #5), NOT the projector's.
  // Treating absent-as-absent here keeps the projector honest about the
  // information actually present in the event log.
  readonly name?: string;
  readonly createdAt: string; // RFC 3339 UTC
}

// `state` reuses the canonical `SessionState` from `@ai-sidekicks/contracts`
// (`provisioning | active | archived | closed | purge_requested | purged`).
// Plan-001 PR #3 only emits `provisioning` (Spec-001 line 53: a newly
// created session starts in `provisioning` and transitions to `active`
// once initial membership, storage, and control-plane metadata are
// ready). Spec-006 line 103 enumerates a distinct `session.activated`
// event for the `provisioning -> active` transition; Plan-022 owns
// `purge_requested` / `purged`; Plan-006 / future plans own `archived` /
// `closed`. Carrying the full canonical union at the daemon-internal
// layer lets future plans fold archived/closed/purge handlers directly
// into this snapshot type without a contract-vs-daemon vocabulary
// reconciliation PR.

export interface DaemonSessionSnapshot {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly createdAt: string; // RFC 3339 UTC
  readonly asOfSequence: number;
  readonly memberships: ReadonlyArray<MembershipProjection>;
  readonly channels: ReadonlyArray<ChannelProjection>;
}
