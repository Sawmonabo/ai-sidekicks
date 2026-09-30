// Daemon-internal session types. `DaemonSessionSnapshot` is separate from the wire-facing
// `SessionSnapshot` in `@ai-sidekicks/contracts`: it carries the owner the bootstrap event names,
// and `state` reuses the contracts' `SessionState` so daemon code stays on the wire vocabulary.

import type { SessionState } from "@ai-sidekicks/contracts";

/**
 * The input to `SessionService.append`: a `session_events` row minus the sealed and purge
 * columns, which the service leaves NULL. `monotonicNs` is supplied by the writer so tests can
 * drive non-monotonic values; `sequence`, not `monotonicNs`, is the replay key.
 */
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

/** An event as `SessionService.readEvents` returns it and the projector consumes it. */
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

/**
 * The projector's view of one session: id, lifecycle state, creation time, the last folded
 * sequence and the owner. `state` is the full `SessionState` union, though the projector only
 * emits `provisioning`.
 */
export interface DaemonSessionSnapshot {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly createdAt: string; // RFC 3339 UTC
  readonly asOfSequence: number;
  /**
   * The session's owner, read off the `session.created` envelope's `actor`; `null` when a
   * system-emitted bootstrap named nobody.
   */
  readonly ownerActor: string | null;
}
