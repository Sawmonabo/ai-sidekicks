// Daemon-internal session types. `DaemonSessionRecord` is separate from the wire-facing
// `SessionRecord` in `@ai-sidekicks/contracts`: it carries the owner the bootstrap event names and
// the directory row the sessions list and the session read answer from.

import type { SessionActivity } from "@ai-sidekicks/contracts/session/directory";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

/**
 * One `session_events` row with its columns as stored, the content column left out. `sequence`,
 * not `monotonicNs`, is the order key.
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

/** How a session's most recent run to end its working time left it. */
export type SessionRunOutcome = Extract<SessionActivity, "done" | "failed" | "idle">;

/**
 * The event-derived columns of a session's `sessions` row, exactly as a rebuild from the log
 * produces them. Times are RFC 3339 UTC with milliseconds.
 */
export interface SessionDirectoryRow {
  readonly sessionId: string;
  readonly shape: SessionShape;
  readonly state: SessionState;
  /** `null` while the session is unnamed. */
  readonly name: string | null;
  /** The opening of the first user message, `null` before one. */
  readonly firstMessagePreview: string | null;
  readonly branch: string | null;
  /** When it was pinned, `null` while it is not; pinned sessions sort by it. */
  readonly pinnedAt: string | null;
  /** When it was muted, `null` while it is not. */
  readonly mutedAt: string | null;
  readonly scratchForDefinitionId: string | null;
  readonly parentSessionId: string | null;
  readonly lastRunOutcome: SessionRunOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
}

/** The projector's view of one session: its directory row, last folded sequence and owner. */
export interface DaemonSessionRecord extends SessionDirectoryRow {
  readonly asOfSequence: number;
  /**
   * The session's owner, read off the `session.created` envelope's `actor`; `null` when a
   * system-emitted bootstrap named nobody.
   */
  readonly ownerActor: string | null;
}
