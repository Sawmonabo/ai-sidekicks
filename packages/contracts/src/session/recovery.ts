// A session whose history is damaged: the refusal its writes meet, the refusal of its two
// actions when they do not apply, and the event `Continue from here` appends. The log is never
// cut or rewritten: the event names the damaged range, and every read and rebuild skips it.
//
// This file imports nothing from the event registry, which imports it.
import { z } from "zod";

import type { DaemonRecoverySessionState } from "../daemon/recovery.js";
import { countSchema } from "../internal/wire-scalars.js";
import { SessionIdSchema, type SessionId } from "./id.js";

/** A write to a session whose history is damaged; nothing is written. */
export type SessionWriteRefusedCode = "session.write_refused";
/**
 * The error code a session with damaged history answers each of its writes with, until it
 * continues from its last good point or is deleted. Every other session takes its writes.
 */
export const SESSION_WRITE_REFUSED_CODE: SessionWriteRefusedCode = "session.write_refused";

/** The refusal's `data.fields`: the session and where its recovery stands. */
export interface SessionWriteRefusedDetails {
  sessionId: SessionId;
  recovery: Extract<DaemonRecoverySessionState, "degraded" | "damaged">;
}

/** `session.recoveryContinue` or `session.recoveryDelete` asked of a session they do not apply to. */
export type SessionRecoveryRefusedCode = "session.recovery_refused";
/** The error code of a recovery action the session does not offer; nothing is written. */
export const SESSION_RECOVERY_REFUSED_CODE: SessionRecoveryRefusedCode = "session.recovery_refused";

/**
 * Why a recovery action was refused: the session's history is not damaged, or no event of it can
 * be read, so there is no point to continue from and only delete applies.
 */
export type SessionRecoveryRefusedReason = "not_damaged" | "no_readable_event";

/** The refusal's `data.fields`. */
export interface SessionRecoveryRefusedDetails {
  sessionId: SessionId;
  reason: SessionRecoveryRefusedReason;
}

/**
 * `recovery.damaged_events_skipped`: the session continued from its last good point. Its events
 * from `fromSequence` through `toSequence` are damaged; they stay in the log and every read and
 * rebuild skips them, so the event before `fromSequence` is the session's end until it takes new
 * work.
 */
export interface RecoveryDamagedEventsSkippedPayload {
  sessionId: SessionId;
  fromSequence: number;
  toSequence: number;
}
/** Parses a {@link RecoveryDamagedEventsSkippedPayload}; the range runs forward. */
export const RecoveryDamagedEventsSkippedPayloadSchema: z.ZodType<RecoveryDamagedEventsSkippedPayload> =
  z
    .object({ sessionId: SessionIdSchema, fromSequence: countSchema, toSequence: countSchema })
    .strict()
    .refine((range) => range.toSequence >= range.fromSequence, {
      message: "A skipped range ends at or after its start.",
    });
