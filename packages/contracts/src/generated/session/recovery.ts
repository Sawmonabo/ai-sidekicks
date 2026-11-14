// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session whose history is damaged: its refusals' details and the event `Continue from here` appends.

import type { SessionId } from "./id.js";

/**
 * How far a session's history is damaged: after a readable start, or with no readable event;
 * each is a [`DaemonRecoverySessionState`].
 */
export type SessionHistoryDamagedRecovery = "degraded" | "damaged";
/**
 * Why a recovery action was refused: the session's history is not damaged, or no event of it can
 * be read, so there is no point to continue from and only delete applies.
 */
export type SessionRecoveryRefusedReason = "notDamaged" | "noReadableEvent";

/**
 * The `session.history.damaged` refusal's `data.fields`: the session and how far its history is
 * damaged.
 */
export interface SessionHistoryDamagedDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * How far its history is damaged.
   */
  recovery: SessionHistoryDamagedRecovery;
}
/**
 * The `session.rebuilding` refusal's `data.fields`: the session the restart's pass has not rebuilt
 * yet.
 */
export interface SessionRebuildingDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The `session.recovery.refused` refusal's `data.fields`.
 */
export interface SessionRecoveryRefusedDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Why the action was refused.
   */
  reason: SessionRecoveryRefusedReason;
}
/**
 * `session.damagedEvents.skipped`: the session continued from its last good point. Its events
 * from `fromSequence` through `toSequence` are damaged; they stay in the log and every read and
 * rebuild skips them, so the event before `fromSequence` is the session's end until it takes new
 * work.
 */
export interface SessionDamagedEventsSkippedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The first damaged event.
   */
  fromSequence: number;
  /**
   * The last damaged event; at or after `fromSequence`.
   */
  toSequence: number;
}

export { validateSessionDamagedEventsSkippedPayload } from "../checks/session/recovery.js";
