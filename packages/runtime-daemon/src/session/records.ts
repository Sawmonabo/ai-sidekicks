// Daemon-internal session types. `DaemonSessionRecord` is separate from the wire-facing
// `SessionRecord` in `@ai-sidekicks/contracts`: it carries the owner the bootstrap event names.

/**
 * One `session_events` row as `SessionService.readEvents` returns it to the projector. The content
 * column is left out. `sequence`, not `monotonicNs`, is the rebuild key.
 */
export interface StoredEvent {
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

/** The projector's view of one session: id, creation time, the last folded sequence, the owner. */
export interface DaemonSessionRecord {
  readonly sessionId: string;
  readonly createdAt: string; // RFC 3339 UTC
  readonly asOfSequence: number;
  /**
   * The session's owner, read off the `session.created` envelope's `actor`; `null` when a
   * system-emitted bootstrap named nobody.
   */
  readonly ownerActor: string | null;
}
