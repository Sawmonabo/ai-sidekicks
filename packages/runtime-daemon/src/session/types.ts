// Daemon-internal session types.
//
// `DaemonSessionSnapshot` is intentionally distinct from the wire-facing
// `SessionSnapshot` in `@ai-sidekicks/contracts`: the wire shape is the
// projection returned over IPC (small, intentionally narrow), while the
// daemon's internal projection carries the channels the projector folds
// over events plus the owner the bootstrap event names.
//
// `state` reuses `SessionState` from `@ai-sidekicks/contracts` so daemon
// code cannot drift from the wire vocabulary. The canonical enum is
// `provisioning | active | archived | closed | purge_requested | purged`.
// The contracts dependency was already present in this package's
// `package.json`; this import doesn't add a new edge to the workspace dep
// graph.
//
// Hash-chain placeholder rationale: see migrations/0001-initial.ts header.
// The append path writes zero-fill integrity bytes and real `monotonic_ns`
// so the NOT NULL constraints hold without claiming real hash-chain
// semantics.

import type { SessionState } from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Internal envelope (write-side input to SessionService.append)
// --------------------------------------------------------------------------
//
// Mirrors the canonical `session_events` row shape minus the integrity
// columns the service materializes itself (prev_hash/row_hash/signature
// are filled with zero placeholders by the writer). `monotonic_ns` is also
// writer-supplied so tests can drive non-monotonic values: `sequence` is
// the canonical replay key, not `monotonic_ns`.

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
  readonly version: string; // semver "MAJOR.MINOR"
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
// `ChannelProjection` carries only the fields derivable from the session
// event stream: `session.created` bootstraps the session and its main
// channel, `channel.created` appends a channel row.

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
  // mapping seam's responsibility, NOT the projector's. Treating
  // absent-as-absent here keeps the projector honest about the information
  // actually present in the event log.
  readonly name?: string;
  readonly createdAt: string; // RFC 3339 UTC
}

// `state` reuses the canonical `SessionState` from `@ai-sidekicks/contracts`
// (`provisioning | active | archived | closed | purge_requested | purged`).
// The projector only emits `provisioning`: a newly created session starts
// there and transitions to `active` once storage and control-plane metadata
// are ready, announced by a distinct `session.activated` event. Carrying the
// full canonical union at the daemon-internal layer lets the archived /
// closed / purge handlers fold directly into this snapshot type without a
// contract-vs-daemon vocabulary reconciliation.

export interface DaemonSessionSnapshot {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly createdAt: string; // RFC 3339 UTC
  readonly asOfSequence: number;
  // The session's owner, read off the `session.created` envelope's signed
  // `actor` and nothing else. There is exactly one owner and the event log
  // already names them, so the projection carries the identity rather than a
  // list of rows that could disagree with it. `null` when the bootstrap
  // event was system-emitted (`actor: null` is legal on the wire), which is
  // the projector reporting what the log actually holds instead of guessing.
  readonly ownerActor: string | null;
  readonly channels: ReadonlyArray<ChannelProjection>;
}
