// Provider-driver shapes for run recovery, usage-limit signals, conversation forks, session goals
// and the authentication probe.

import { z } from "zod";
import {
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DRIVER_BINDING_ID_MAX_LEN,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_FALLBACK_ACTION_MAX_LEN,
  type RunId,
} from "./provider-driver.js";
import { wireFreeFormString, type SessionId } from "./session.js";

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

/**
 * Return of `ProviderDriver.resumeSession()`, parsed from untrusted provider output. Discriminated
 * on `status` so a failed resume cannot pose as a successful one: `failed` carries a
 * `RecoveryCondition`, a `RecoverySpanClassification` and `providerFailureDetail` and has no
 * `bindingId`, and a failed resume must never silently create a replacement provider session under
 * the same run. The `resumed` arm's required `sessionPosition` is the driver's normalized monotonic
 * position (a turn or event ordinal, as in `ForkConversationResult`); the daemon compares it with
 * its recorded position, which catches a provider answering a resume with a fresh session (e.g.
 * Claude on a working-directory mismatch). Timestamps live on `runtime_bindings.updated_at`.
 */
export type DriverResumeResult =
  | { status: "resumed"; bindingId: string; sessionPosition: number }
  | {
      status: "failed";
      recoveryCondition: RecoveryCondition;
      recoverySpanClassification: RecoverySpanClassification;
      providerFailureDetail: string;
    };
/** Validates a {@link DriverResumeResult}; both arms are `.strict()`. */
export const DriverResumeResultSchema: z.ZodType<DriverResumeResult, DriverResumeResult> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("resumed"),
        // Opaque and machine-generated, but persisted into `runtime_bindings`, so the
        // `wireFreeFormString` guards (non-blank, no NUL) defend a stored untrusted value against
        // storage and log-injection hazards. The cap is sized for a short session-binding handle.
        bindingId: wireFreeFormString(DRIVER_BINDING_ID_MAX_LEN, "DriverResumeResult.bindingId"),
        // Shape only (integer >= 0), as in `ForkConversationResultSchema`. Comparing the position
        // with the daemon's recorded one, and reconciling a mismatch, need session state this shape
        // does not carry, so they belong to the daemon.
        sessionPosition: z.number().int().min(0),
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        // References the shared parser so a new condition reaches this carrier by construction.
        recoveryCondition: RecoveryConditionSchema,
        // Required on this live return: a resume failure is produced fresh and never replayed, so
        // no older record needs it optional. A driver that cannot classify the span emits
        // `unclassifiable`, so omission is a schema failure.
        recoverySpanClassification: RecoverySpanClassificationSchema,
        // The cap is generous so a verbose detail (wrapped upstream stack trace or nested-cause
        // chain) is not suppressed. A value past it is pathological; a driver treats a result that
        // fails this schema as a provider failure and surfaces `recovery-needed`, so the signal
        // survives a parse rejection here.
        providerFailureDetail: wireFreeFormString(
          DRIVER_FAILURE_DETAIL_MAX_LEN,
          "DriverResumeResult.providerFailureDetail",
        ),
      })
      .strict(),
  ]);

// ---- Provider usage-limit signal ----

// A driver emits a usage-limit signal only when a structured provider event it can name says the
// allowance is spent. Prose, an exit code or a bare HTTP status are never inputs, since the
// provider may reword or reuse them; an unrecognized shape emits nothing, which reads "not known
// to be limited". There is no capability flag: recognition is required of every driver, like
// `probeAuth`. These types are plain TypeScript because no member is provider-verbatim: `cause`
// and `provenance` are closed literals the driver selects, and `resetsAt` is a timestamp it
// composes.

/**
 * Why a provider refused for spend, on an axis separate from `RecoveryCondition`: every recovery
 * condition needs a human, while a spent usage allowance clears when the provider's window turns
 * over. One member on purpose: only `plan-allowance-exhausted`, the subscription allowance for a
 * rolling window, clears on its own. Excluded because a human must act or the state is not a
 * refused turn: a depleted credit balance (Codex `workspace_owner_credits_depleted` and
 * `workspace_member_credits_depleted`, restored by a purchase), a payment fault (Claude
 * `billing_error`), and a spend-control ceiling (Codex `spendControlReached`, an administrative
 * budget state on a snapshot). A turn refused for any of them settles on the driver's ordinary
 * turn-failure path. Widen the union deliberately; never with a free string.
 */
export type ProviderUsageLimitCause = "plan-allowance-exhausted";

/**
 * Where a reset instant came from: `provider-stated` (the provider named it, for the window it also
 * named as spent) or `runtime-derived` (the daemon computed it from a delay the provider gave). A
 * consumer may schedule on either, but only the first is safe to show as the provider's own answer,
 * and only the second should widen when a retry lands early.
 */
export type ProviderUsageLimitResetProvenance = "provider-stated" | "runtime-derived";

/**
 * A reset instant and its provenance as one object, so an instant without provenance and a
 * provenance without an instant are both unrepresentable.
 */
export interface ProviderUsageLimitResetBoundary {
  // RFC 3339 UTC.
  resetsAt: string;
  provenance: ProviderUsageLimitResetProvenance;
}

/**
 * A recognized provider usage-limit refusal. The cause is required and the boundary optional: a
 * recognized refusal parks the run whether or not a window was reported, and a missing boundary
 * only means no resume is scheduled. Absent means no reset instant is known from what was
 * observed, not that the provider publishes none.
 */
export interface ProviderUsageLimitSignal {
  cause: ProviderUsageLimitCause;
  resetBoundary?: ProviderUsageLimitResetBoundary | undefined;
}

// ---- Conversation fork ----

/**
 * Params of `forkConversation` (gated on `rollback`): fork the provider conversation at a recorded
 * `position` (the driver's normalized monotonic session position, a turn or event ordinal) into a
 * new provider session; touches no files. `bindingId` is the leg key: a run has many bindings (a
 * capped or posture relaunch mints a new one), so `sessionId` cannot name the target leg. The
 * daemon resolves the run's live binding at dispatch; clients address the run, not the leg.
 */
export interface ForkConversationParams {
  sessionId: SessionId;
  position: number;
  bindingId: string;
}

/**
 * Return of `ProviderDriver.forkConversation()`, parsed from untrusted provider output.
 * Discriminated on `status` like `DriverResumeResult`: `sessionPosition` is required on `applied`
 * and absent from `degraded`, so a fork without a confirmed position is unrepresentable. The schema
 * bounds shape only (integer >= 0); domain checks need session state and belong to the daemon.
 * `bindingId` is the binding the fork minted (Claude `--resume-session-at` with `--fork-session`;
 * Codex `thread/fork`), a store-minted surrogate and never a resume handle.
 */
export type ForkConversationResult =
  | { status: "applied"; sessionPosition: number; bindingId?: string | undefined }
  | { status: "degraded"; fallbackAction?: string | undefined };
/** Validates a {@link ForkConversationResult}; both arms are `.strict()`. */
export const ForkConversationResultSchema: z.ZodType<
  ForkConversationResult,
  ForkConversationResult
> = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      sessionPosition: z.number().int().min(0),
      bindingId: wireFreeFormString(
        DRIVER_BINDING_ID_MAX_LEN,
        "ForkConversationResult.bindingId",
      ).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("degraded"),
      fallbackAction: wireFreeFormString(
        DRIVER_FALLBACK_ACTION_MAX_LEN,
        "ForkConversationResult.fallbackAction",
      ).optional(),
    })
    .strict(),
]);

// ---- Session goals ----

/**
 * Params of `setSessionGoal` (gated on `session_goals`). `goalText` is the daemon-rendered text of
 * the session's structured goal, so the driver never sees the structure and cannot diverge from it.
 * Durable truth is the `session.goal_updated` and `session.goal_cleared` events and the daemon
 * re-pushes the goal on resume, so driver-held state is never the recovery source and neither
 * operation returns the goal it applied. `bindingId` is the leg key, as on
 * `ForkConversationParams`: goal delivery fans out per live binding. `runId` rides along for
 * context and telemetry.
 */
export interface SetSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
  goalText: string;
}

/** Params of `clearSessionGoal` (gated on `session_goals`); addresses one live binding. */
export interface ClearSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
}

// ---- Authentication probe ----

/**
 * Return of the zero-turn `probeAuth` (not capability-gated), parsed from untrusted provider
 * output. `indeterminate` (probe surface unavailable or unparseable) counts as not authenticated
 * for admission (fail closed) yet stays distinguishable from `unauthenticated`, so operators can
 * tell probe health from credential state; a boolean would lose that. Run admission against a
 * driver not probing `authenticated` refuses as `driver.not_authenticated` before any turn is
 * spent. Mid-run credential expiry is a different surface: typed auth-failure signals map to the
 * `reauth-required` recovery condition.
 */
export interface DriverAuthProbeResult {
  status: "authenticated" | "unauthenticated" | "indeterminate";
  // Knowingly PII-bearing: a provider-reported account or plan descriptor whose observed shape is
  // a plan name plus a seat email. Transient operator-facing diagnostics only: never persist it or
  // carry it on an event without a PII classification and the erasure that obliges. Admission
  // reads `status` for the decision and this field only to tell an operator why, so dropping it
  // loses diagnostics, never correctness.
  detail?: string | undefined;
}
/** Validates a {@link DriverAuthProbeResult}; strict. */
export const DriverAuthProbeResultSchema: z.ZodType<DriverAuthProbeResult, DriverAuthProbeResult> =
  z
    .object({
      status: z.enum(["authenticated", "unauthenticated", "indeterminate"]),
      detail: wireFreeFormString(
        DRIVER_AUTH_DETAIL_MAX_LEN,
        "DriverAuthProbeResult.detail",
      ).optional(),
    })
    .strict();
