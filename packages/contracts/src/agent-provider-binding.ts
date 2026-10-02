// How a change to an agent's provider binding settles for every client, not only the asker. Every
// change to a running agent's model, effort, speed, provider or account is a switch, acknowledged
// with a disposition (usually `pending`) and later settled by one of two events, applied or failed.
//
// This module imports nothing from the session event union: the union imports the payloads here.
import { z } from "zod";

import {
  AgentIdSchema,
  AgentProviderBindingSchema,
  type AgentId,
  type AgentProviderBinding,
} from "./agent-definition.js";
import {
  ProviderAccountIdSchema,
  ProviderNameSchema,
  type ProviderAccountId,
  type ProviderName,
} from "./provider-account.js";
import { DeclaredLossKindSchema, type DeclaredLossKind } from "./provider-driver-transcript.js";
import { DRIVER_WIRE_TOKEN_MAX_LEN } from "./provider-driver-wire.js";
import {
  SessionIdSchema,
  UserIdSchema,
  wireFreeFormString,
  type SessionId,
  type UserId,
} from "./session.js";

/** The event a deferred switch settles with when it applied. */
export const AGENT_PROVIDER_BINDING_CHANGED_EVENT = "agent.provider_binding_changed" as const;
/** The event a deferred switch settles with when it could not be applied. */
export const AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT =
  "agent.provider_binding_change_failed" as const;

/** The longest switch id the daemon mints. */
export const AGENT_SWITCH_ID_MAX_LEN = 256;

/** The daemon-minted id that correlates a switch's acknowledgment with its settlement. */
const switchIdSchema: z.ZodString = wireFreeFormString(AGENT_SWITCH_ID_MAX_LEN, "switchId");
/** A provider vocabulary token a switch moves to. */
const bindingTokenSchema = (label: string): z.ZodString =>
  wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, label);

// Closed vocabularies

/**
 * How the conversation crossed the switch: `in_place`, the same provider carried it on (an applied
 * switch); or `brief`, a switch across providers that started from a hand-over brief with the old
 * transcript beside it as a file (a degraded switch, never presented as an ordinary success).
 */
export const AGENT_BINDING_CONTINUITIES = ["in_place", "brief"] as const;
/** One of {@link AGENT_BINDING_CONTINUITIES}. */
export type AgentBindingContinuity = (typeof AGENT_BINDING_CONTINUITIES)[number];

/**
 * Why an accepted switch could not be applied: `output_speed_unavailable`, the target driver no
 * longer declares the pended speed; or `account_unavailable`, the account it lands on cannot carry
 * the run. A switch refused before it was accepted is an error on the request instead.
 */
export const AGENT_BINDING_CHANGE_FAILURE_REASONS = [
  "driver_unavailable",
  "model_unavailable",
  "effort_unavailable",
  "account_unavailable",
  "output_speed_unavailable",
  "interrupt_refused",
  "target_unstartable",
] as const;
/** One of {@link AGENT_BINDING_CHANGE_FAILURE_REASONS}. */
export type AgentBindingChangeFailureReason = (typeof AGENT_BINDING_CHANGE_FAILURE_REASONS)[number];

/**
 * Why the account a switch lands on cannot carry the run. Only `reauth_required`
 * offers `Sign in again`. Enumerated in full rather than derived from the account
 * health states, so a new health state cannot silently widen a failure's reasons.
 */
export const AGENT_BINDING_SWITCH_ACCOUNT_STATES = [
  "reauth_required",
  "home_missing",
  "indeterminate",
  "not_registered",
] as const;
/** One of {@link AGENT_BINDING_SWITCH_ACCOUNT_STATES}. */
export type AgentBindingSwitchAccountState = (typeof AGENT_BINDING_SWITCH_ACCOUNT_STATES)[number];

/**
 * Where a pending switch applies, resolved by the daemon against the target driver
 * and never predicted by a client: the next turn or the end of the run in flight. A
 * switch that moves several members takes the widest of their boundaries.
 */
export const AGENT_BINDING_SWITCH_BOUNDARIES = ["turn_boundary", "run_boundary"] as const;
/** One of {@link AGENT_BINDING_SWITCH_BOUNDARIES}. */
export type AgentBindingSwitchBoundary = (typeof AGENT_BINDING_SWITCH_BOUNDARIES)[number];

/**
 * A disposition's four arms. `pending` is the ordinary answer; the other three are
 * reached only when the caller asked to interrupt and switch, which holds the
 * request open until the switch settles.
 */
export const AGENT_BINDING_SWITCH_STATUSES = ["pending", "applied", "degraded", "failed"] as const;
/** One of {@link AGENT_BINDING_SWITCH_STATUSES}. */
export type AgentBindingSwitchStatus = (typeof AGENT_BINDING_SWITCH_STATUSES)[number];

// The switch's intent and its settlement

/**
 * The binding members a switch moves and the value each moves to; an omitted key is a member this
 * switch does not move. `agent.configUpdate` never sets the account, and an account move sets only
 * the account.
 */
export interface AgentBindingSwitchTarget {
  driverName?: ProviderName | undefined;
  modelId?: string | undefined;
  providerAccountId?: ProviderAccountId | undefined;
  effort?: string | undefined;
  outputSpeed?: string | undefined;
}
/** Parses an {@link AgentBindingSwitchTarget}. */
export const AgentBindingSwitchTargetSchema: z.ZodType<AgentBindingSwitchTarget> = z
  .object({
    driverName: ProviderNameSchema.optional(),
    modelId: bindingTokenSchema("modelId").optional(),
    providerAccountId: ProviderAccountIdSchema.optional(),
    effort: bindingTokenSchema("effort").optional(),
    outputSpeed: bindingTokenSchema("outputSpeed").optional(),
  })
  .strict();

/**
 * A switch the daemon accepted and has not applied: at most one per agent, a later one replacing
 * it. The same record is the acknowledgment, the agent row's stored switch and `agent.list`'s
 * `pendingSwitch`, so `switching to …` survives a reload and reaches another device.
 */
export interface AgentBindingSwitchPending {
  status: "pending";
  switchId: string;
  appliesAt: AgentBindingSwitchBoundary;
  /** Whether the daemon interrupts to reach the boundary; never re-derived from `appliesAt`. */
  interruptRequested: boolean;
  pendingAxes: AgentBindingSwitchTarget;
  /** The earlier pending switch this one displaced, and the only record of it. */
  replacedSwitchId?: string | undefined;
}
const pendingSwitchObject = z
  .object({
    status: z.literal("pending"),
    switchId: switchIdSchema,
    appliesAt: z.enum(AGENT_BINDING_SWITCH_BOUNDARIES),
    interruptRequested: z.boolean(),
    pendingAxes: AgentBindingSwitchTargetSchema,
    replacedSwitchId: switchIdSchema.optional(),
  })
  .strict();
/** Parses an {@link AgentBindingSwitchPending}. */
export const AgentBindingSwitchPendingSchema: z.ZodType<AgentBindingSwitchPending> =
  pendingSwitchObject;

/**
 * A switch that applied: how the conversation arrived and what it lost. `declaredLosses` is empty
 * on `in_place` and, on `brief`, names at least the summarized history and the private reasoning.
 */
export interface AgentBindingSwitchOutcome {
  switchId: string;
  continuity: AgentBindingContinuity;
  /** An empty list claims nothing of the conversation was dropped. */
  declaredLosses: DeclaredLossKind[];
}

/** Refuses a loss list that contradicts its continuity. */
function refineDeclaredLosses(outcome: AgentBindingSwitchOutcome, context: z.RefinementCtx): void {
  const losses = new Set(outcome.declaredLosses);
  switch (outcome.continuity) {
    case "in_place":
      if (losses.size > 0) {
        context.addIssue({
          code: "custom",
          path: ["declaredLosses"],
          message: "An in-place switch rebuilt nothing, so it declares no loss.",
        });
      }
      return;
    case "brief":
      if (
        !losses.has("conversation_history_summarized") ||
        !losses.has("provider_private_reasoning")
      ) {
        context.addIssue({
          code: "custom",
          path: ["declaredLosses"],
          message: "A brief declares the summarized history and the private reasoning.",
        });
      }
      return;
  }
}

const switchOutcomeFields = {
  switchId: switchIdSchema,
  declaredLosses: z.array(DeclaredLossKindSchema),
};

/** Parses an {@link AgentBindingSwitchOutcome}. */
export const AgentBindingSwitchOutcomeSchema: z.ZodType<AgentBindingSwitchOutcome> = z
  .object({ ...switchOutcomeFields, continuity: z.enum(AGENT_BINDING_CONTINUITIES) })
  .strict()
  .superRefine(refineDeclaredLosses);

/**
 * An accepted switch settled on the held-open request as a failure. A result, not an
 * error: the switch was accepted and recorded, and only its application failed.
 * `accountState` is present exactly when the reason is `account_unavailable`.
 */
export interface AgentBindingSwitchFailed {
  status: "failed";
  switchId: string;
  reason: AgentBindingChangeFailureReason;
  accountState?: AgentBindingSwitchAccountState | undefined;
}

/** Refuses an account state that does not match an account failure. */
function refineAccountState(
  failure: { reason: AgentBindingChangeFailureReason; accountState?: unknown },
  context: z.RefinementCtx,
): void {
  if ((failure.reason === "account_unavailable") !== (failure.accountState !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["accountState"],
      message: "accountState is present exactly when the reason is account_unavailable.",
    });
  }
}

const switchFailureFields = {
  switchId: switchIdSchema,
  reason: z.enum(AGENT_BINDING_CHANGE_FAILURE_REASONS),
  accountState: z.enum(AGENT_BINDING_SWITCH_ACCOUNT_STATES).optional(),
};

/**
 * What `agent.configUpdate` answers with. `applied` is exactly a conversation that arrived whole
 * (`in_place`) and `degraded` exactly one that did not (`brief`), so no client re-derives the
 * honest-degrade rule from `continuity`.
 */
export type AgentBindingSwitchDisposition =
  | AgentBindingSwitchPending
  | ({ status: "applied" } & AgentBindingSwitchOutcome)
  | ({ status: "degraded" } & AgentBindingSwitchOutcome)
  | AgentBindingSwitchFailed;
/** Parses an {@link AgentBindingSwitchDisposition}. */
export const AgentBindingSwitchDispositionSchema: z.ZodType<AgentBindingSwitchDisposition> =
  z.discriminatedUnion("status", [
    pendingSwitchObject,
    z
      .object({
        status: z.literal("applied"),
        ...switchOutcomeFields,
        continuity: z.literal("in_place"),
      })
      .strict()
      .superRefine(refineDeclaredLosses),
    z
      .object({
        status: z.literal("degraded"),
        ...switchOutcomeFields,
        continuity: z.literal("brief"),
      })
      .strict()
      .superRefine(refineDeclaredLosses),
    z
      .object({ status: z.literal("failed"), ...switchFailureFields })
      .strict()
      .superRefine(refineAccountState),
  ]);

// The two settlement events

/**
 * The payload of {@link AGENT_PROVIDER_BINDING_CHANGED_EVENT}: a switch that applied. Only a
 * provider or account switch draws a transcript row. `landedProviderAccountId` is kept apart from
 * `to.providerAccountId`, so an agent that follows the current account is never pinned to it.
 */
export interface AgentProviderBindingChangedPayload extends AgentBindingSwitchOutcome {
  sessionId: SessionId;
  agentId: AgentId;
  /** Who asked, recorded at acceptance so a settlement after a restart names them. */
  actor: UserId;
  from: AgentProviderBinding;
  to: AgentProviderBinding;
  landedProviderAccountId: ProviderAccountId;
}
/** Parses an {@link AgentProviderBindingChangedPayload}. */
export const AgentProviderBindingChangedPayloadSchema: z.ZodType<AgentProviderBindingChangedPayload> =
  z
    .object({
      ...switchOutcomeFields,
      continuity: z.enum(AGENT_BINDING_CONTINUITIES),
      sessionId: SessionIdSchema,
      agentId: AgentIdSchema,
      actor: UserIdSchema,
      from: AgentProviderBindingSchema,
      to: AgentProviderBindingSchema,
      landedProviderAccountId: ProviderAccountIdSchema,
    })
    .strict()
    .superRefine(refineDeclaredLosses);

/**
 * The payload of {@link AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT}: an accepted switch that could
 * not be applied. The agent stays on `from`; exactly one of the two settlement events ends every
 * switch that is not replaced.
 */
export interface AgentProviderBindingChangeFailedPayload {
  sessionId: SessionId;
  agentId: AgentId;
  switchId: string;
  actor: UserId;
  from: AgentProviderBinding;
  attempted: AgentBindingSwitchTarget;
  reason: AgentBindingChangeFailureReason;
  accountState?: AgentBindingSwitchAccountState | undefined;
}
/** Parses an {@link AgentProviderBindingChangeFailedPayload}. */
export const AgentProviderBindingChangeFailedPayloadSchema: z.ZodType<AgentProviderBindingChangeFailedPayload> =
  z
    .object({
      ...switchFailureFields,
      sessionId: SessionIdSchema,
      agentId: AgentIdSchema,
      actor: UserIdSchema,
      from: AgentProviderBindingSchema,
      attempted: AgentBindingSwitchTargetSchema,
    })
    .strict()
    .superRefine(refineAccountState);
