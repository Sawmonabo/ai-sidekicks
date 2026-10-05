// Why a run needs recovery: the axis a resume failure and the run-state change projection carry.

import { z } from "zod";

// ---- Recovery conditions ----

/**
 * Why a run needs attention: `recovery-needed` means the person must reconcile it;
 * `reauth-required` means the provider session or credential expired, and recovery may retry once
 * the provider is signed in again. The type and the schema derive from this one list.
 */
export const RECOVERY_CONDITIONS = ["recovery-needed", "reauth-required"] as const;

/** One member of {@link RECOVERY_CONDITIONS}. */
export type RecoveryCondition = (typeof RECOVERY_CONDITIONS)[number];

/**
 * Validates a {@link RecoveryCondition}. Every carrier parses with this schema rather than
 * restating the values: the resume result's `failed` arm and the run-state change in
 * `run/control.ts`.
 */
export const RecoveryConditionSchema: z.ZodType<RecoveryCondition, RecoveryCondition> =
  z.enum(RECOVERY_CONDITIONS);
