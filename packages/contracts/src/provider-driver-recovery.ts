// Why a run needs recovery and what its halted span holds: the two axes a resume failure and the
// run-state change projection both carry.

import { z } from "zod";

// ---- Recovery conditions ----

/**
 * Why a run needs attention: `recovery-needed` means an operator must reconcile it;
 * `reauth-required` means the provider session or credential expired (detected mid-run from the
 * provider's typed auth-failure signals, or at resume or probe time) and recovery may retry once
 * the provider CLI is re-authenticated on the runtime node. Two conditions, two operator actions.
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

/**
 * What the halted or diverged span contains, so policy can tier on blast radius. Orthogonal to
 * `RecoveryCondition`, which says why the run needs an operator, so it is not a widening of that
 * union. Audit metadata only: every divergence still halts for human action, and `unclassifiable`
 * must be handled exactly as `irreversible`, the fail-closed default that keeps a driver from using
 * it as a free pass. Const-array-derived because the exported parser and its carriers read it.
 */
export const RECOVERY_SPAN_CLASSIFICATIONS = [
  "read_only",
  "idempotent_write",
  "irreversible",
  "unclassifiable",
] as const;

/** One member of {@link RECOVERY_SPAN_CLASSIFICATIONS}. */
export type RecoverySpanClassification = (typeof RECOVERY_SPAN_CLASSIFICATIONS)[number];

/**
 * Validates a {@link RecoverySpanClassification}; carried by the same surfaces as
 * `RecoveryConditionSchema`. `unclassifiable` is a member rather than an absence, so a driver that
 * cannot classify the span still parses; treating it as `irreversible` is the consumer's duty,
 * which a value set cannot enforce.
 */
export const RecoverySpanClassificationSchema: z.ZodType<
  RecoverySpanClassification,
  RecoverySpanClassification
> = z.enum(RECOVERY_SPAN_CLASSIFICATIONS);
