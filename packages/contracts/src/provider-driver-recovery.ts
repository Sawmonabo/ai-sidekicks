// Why a run needs recovery: the axis a resume failure and the run-state change projection carry.

import { z } from "zod";

// ---- Recovery conditions ----

/**
 * Why a run needs attention: `recovery-needed` means the person must reconcile it;
 * `reauth-required` means the provider session or credential expired (detected mid-run from the
 * provider's typed auth-failure signals, or at resume or probe time) and recovery may retry once
 * the provider CLI is re-authenticated on the runtime node. Two conditions, two acts for the
 * person.
 * One list, from which the type and schema derive: `z.ZodType` is covariant in its output, so an
 * enum narrower than the union still satisfies a `z.ZodType<RecoveryCondition>` annotation
 * (measured: widening left `tsc -b --force` clean while narrowing raised TS2375), and a second
 * hand-written list would let a new condition dead-letter at parse at a carrier not updated.
 */
export const RECOVERY_CONDITIONS = ["recovery-needed", "reauth-required"] as const;

/** One member of {@link RECOVERY_CONDITIONS}. */
export type RecoveryCondition = (typeof RECOVERY_CONDITIONS)[number];

/**
 * Validates a {@link RecoveryCondition}. Every carrier references this parser instead of restating
 * the values: the `DriverResumeResult` `failed` arm (required) and the run-state change projection
 * in `run-control.ts` (optional). Annotated `z.ZodType`, not `z.ZodEnum`, because no consumer
 * derives from the enum surface; the value set is `RECOVERY_CONDITIONS`.
 */
export const RecoveryConditionSchema: z.ZodType<RecoveryCondition, RecoveryCondition> =
  z.enum(RECOVERY_CONDITIONS);
