// Daemon-internal session types.
//
// `DaemonSessionSnapshot` is intentionally distinct from the wire-facing
// `SessionSnapshot` in `@ai-sidekicks/contracts`: the wire shape is the
// projection returned over IPC (small, intentionally narrow), while the
// daemon's internal projection carries the owner the bootstrap event names.
//
// `state` reuses `SessionState` from `@ai-sidekicks/contracts` so daemon
// code cannot drift from the wire vocabulary. The canonical enum is
// `provisioning | active | archived | closed | purge_requested | purged`.

import type { SessionState } from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Internal envelope (write-side input to SessionService.append)
// --------------------------------------------------------------------------
//
// Mirrors the canonical `session_events` row shape minus the sealed and
// purge columns the service leaves NULL. `monotonic_ns` is writer-supplied so
// tests can drive non-monotonic values: `sequence` is the canonical replay
// key, not `monotonic_ns`.

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

/**
 * The projector's view of one session: id, lifecycle state, creation time, the
 * last folded sequence and the owner. `state` is the full canonical
 * `SessionState` union, though the projector itself emits only `provisioning`.
 */
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
}
