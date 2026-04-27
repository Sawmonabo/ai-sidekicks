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
// However, the *vocabulary* of states this snapshot can represent must
// track the canonical wire enum by construction. Round 2 declared
// `state: "provisioning" | "active" | "ended"` — `"ended"` is not a
// member of `SessionState` in any spec, ADR, contract, or domain doc
// (canonical: `provisioning | active | archived | closed | purge_requested
// | purged` per `packages/contracts/src/session.ts:129-135` and
// `docs/architecture/contracts/api-payload-contracts.md` §Shared Enums and
// `docs/domain/session-model.md:61-77`). Round 3 imports `SessionState`
// from contracts so daemon code cannot drift from the wire vocabulary
// (analogous fix to the R1 `MembershipRole` narrowing). The contracts
// dependency was already present in this package's `package.json`; this
// import doesn't add a new edge to the workspace dep graph.
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
// membership.joined -> membership row, channel.created -> channel row.
// PR #4/#5 will widen these as more event variants land.
//
// `MembershipRole` mirrors the canonical contracts enum verbatim
// (`@ai-sidekicks/contracts` §MembershipRole; api-payload-contracts.md
// line 99). The "runtime contributor" string includes the literal space
// — preserved per the contracts source-of-truth. Round 1 narrowed this
// to "owner" | "member" and the projector silently flattened
// `MembershipJoinedEvent.payload.role` into "member"; PR #5's mapping seam
// would have rejected the narrowing at the wire boundary. The projector
// now reads `payload.role` directly.

export type MembershipRole = "owner" | "viewer" | "collaborator" | "runtime contributor";

export interface MembershipProjection {
  readonly participantId: string;
  readonly role: MembershipRole;
  readonly joinedAt: string; // RFC 3339 UTC
}

export interface ChannelProjection {
  readonly channelId: string;
  readonly name: string;
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
// `closed`. The wider union here is deliberate — by tracking the
// canonical wire vocabulary at the daemon-internal layer, future plans
// that add archived/closed/purge handlers can fold directly into this
// snapshot type without a contract-vs-daemon vocabulary reconciliation
// PR. Round 2's fabricated `"ended"` literal has been removed (it does
// not appear in any spec/ADR/contract).

export interface DaemonSessionSnapshot {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly createdAt: string; // RFC 3339 UTC
  readonly asOfSequence: number;
  readonly memberships: ReadonlyArray<MembershipProjection>;
  readonly channels: ReadonlyArray<ChannelProjection>;
}
