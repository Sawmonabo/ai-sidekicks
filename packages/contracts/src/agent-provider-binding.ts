// How a change to an agent's provider binding settles for every client, not only the
// one that asked for it.
//
// Every change to a running agent's model, effort, speed, provider or account is a
// switch of its binding. The request is acknowledged with a disposition: most often
// `pending`, the switch waiting for the boundary it applies at, and settled at once
// only where the caller asked to interrupt and switch. A switch deferred to a
// boundary settles later, and two events carry that settlement to every client
// watching the session: one when the switch applied, one when it could not be. They
// are two events rather than one because different surfaces wait on them for
// opposite reasons: the applied event is the settlement the agent card and the
// session's switch row draw, and the failed event is the one system message naming
// the switch it tried and why.
//
// This module imports nothing from the session event union: the union imports the
// payload schemas here.
import { z } from "zod";

import {
  AgentIdSchema,
  AgentProviderBindingSchema,
  type AgentId,
  type AgentProviderBinding,
} from "./agent-definition.js";
import { ProviderAccountIdSchema, type ProviderAccountId } from "./provider-account.js";
import {
  DeclaredLossKindSchema,
  DRIVER_WIRE_TOKEN_MAX_LEN,
  type DeclaredLossKind,
} from "./provider-driver.js";
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

// --------------------------------------------------------------------------
// Closed vocabularies
// --------------------------------------------------------------------------

/**
 * Which mechanism carried the conversation across the switch. Four different acts,
 * not degrees of one:
 *
 * - `in_place`: carried on the running process: a per-turn setting, a run-bound
 *   setting the provider takes without a restart, or an account moved at the next
 *   request. Nothing was respawned or rebuilt.
 * - `resumed`: a fresh process of the same provider reopened its own conversation,
 *   in the same credential home or, on an account move's resume path, in the new
 *   account's home after the daemon copied the conversation file there.
 * - `brief`: the new binding started from a hand-over brief, with the old transcript
 *   written beside it as a file the provider reads on demand.
 * - `replayed`: a same-provider reopen did not load, so the transcript was sent as
 *   text and the conversation restarted.
 *
 * `in_place` and `resumed` are applied switches; `brief` and `replayed` are degraded
 * ones and are never presented as an ordinary success.
 */
export const AGENT_BINDING_CONTINUITIES = ["in_place", "resumed", "brief", "replayed"] as const;
/** One of {@link AGENT_BINDING_CONTINUITIES}. */
export type AgentBindingContinuity = (typeof AGENT_BINDING_CONTINUITIES)[number];

/**
 * Why an accepted switch could not be applied. A switch refused before it was
 * accepted, for an unknown axis or an invalid value, is an error on the request and
 * never reaches this vocabulary.
 *
 * - `output_speed_unavailable`: the target driver stopped declaring the speed axis,
 *   or its declared vocabulary no longer carries the pended value.
 * - `account_unavailable`: the account the switch lands on cannot carry the run;
 *   the failure names why in its account state.
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
 * and never predicted by a client: the next turn, the end of the run in flight, or,
 * for an account move on the resume path only, the next tool call. A switch that
 * moves several members takes the widest of their boundaries.
 */
export const AGENT_BINDING_SWITCH_BOUNDARIES = [
  "turn_boundary",
  "run_boundary",
  "next_tool_call",
] as const;
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

// --------------------------------------------------------------------------
// The switch's intent and its settlement
// --------------------------------------------------------------------------

/**
 * The binding members a switch moves and the value each moves to; an omitted key is
 * a member this switch does not move. `agent.configUpdate` never sets the account,
 * which moves on the provider surface, and the account move sets only the account,
 * for a session it moves by the resume path. Nothing clears a member back to a
 * driver default, so there is no third state to encode.
 */
export interface AgentBindingSwitchTarget {
  driverName?: string | undefined;
  modelId?: string | undefined;
  providerAccountId?: ProviderAccountId | undefined;
  effort?: string | undefined;
  outputSpeed?: string | undefined;
}
/** Parses an {@link AgentBindingSwitchTarget}. */
export const AgentBindingSwitchTargetSchema: z.ZodType<AgentBindingSwitchTarget> = z
  .object({
    driverName: bindingTokenSchema("driverName").optional(),
    modelId: bindingTokenSchema("modelId").optional(),
    providerAccountId: ProviderAccountIdSchema.optional(),
    effort: bindingTokenSchema("effort").optional(),
    outputSpeed: bindingTokenSchema("outputSpeed").optional(),
  })
  .strict();

/**
 * A switch the daemon accepted and has not applied: at most one per agent, a later
 * switch replacing it rather than queuing. The same record is the acknowledgment,
 * the agent row's durable slot and `agent.list`'s `pendingSwitch`, so `switching to
 * …` survives a reload and reaches another device.
 *
 * `interruptRequested` says whether reaching the boundary needs an interrupt the
 * daemon dispatches; it is never re-derived from `appliesAt`, since a deferred switch
 * and an interrupted one can both apply at a turn boundary. `replacedSwitchId` names
 * the earlier pending switch this one displaced, and is the only record of it.
 */
export interface AgentBindingSwitchPending {
  status: "pending";
  switchId: string;
  appliesAt: AgentBindingSwitchBoundary;
  interruptRequested: boolean;
  pendingAxes: AgentBindingSwitchTarget;
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
 * A switch that applied: how the conversation arrived and what it lost.
 *
 * `declaredLosses` is required, and an empty list is a claim that nothing was
 * dropped. It is empty on `in_place` and `resumed`; on `brief` it names at least the
 * summarized history and the provider's private reasoning; on `replayed` it is never
 * empty. It speaks about the conversation only: whether a requested setting took
 * effect on the new binding is read back on the agent, never reported as a loss.
 */
export interface AgentBindingSwitchOutcome {
  switchId: string;
  continuity: AgentBindingContinuity;
  declaredLosses: DeclaredLossKind[];
}

/** Refuses a loss list that contradicts its continuity. */
function refineDeclaredLosses(outcome: AgentBindingSwitchOutcome, context: z.RefinementCtx): void {
  const losses = new Set(outcome.declaredLosses);
  switch (outcome.continuity) {
    case "in_place":
    case "resumed":
      if (losses.size > 0) {
        context.addIssue({
          code: "custom",
          path: ["declaredLosses"],
          message: `A ${outcome.continuity} switch rebuilt nothing, so it declares no loss.`,
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
    case "replayed":
      if (losses.size === 0) {
        context.addIssue({
          code: "custom",
          path: ["declaredLosses"],
          message: "A replayed switch restarted the conversation, so it declares a loss.",
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
 * What `agent.configUpdate` answers with. `applied` is exactly a conversation that
 * arrived whole (`in_place`, `resumed`) and `degraded` exactly one that did not
 * (`brief`, `replayed`), so no client re-derives the honest-degrade rule from
 * `continuity`.
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
        continuity: z.enum(["in_place", "resumed"]),
      })
      .strict()
      .superRefine(refineDeclaredLosses),
    z
      .object({
        status: z.literal("degraded"),
        ...switchOutcomeFields,
        continuity: z.enum(["brief", "replayed"]),
      })
      .strict()
      .superRefine(refineDeclaredLosses),
    z
      .object({ status: z.literal("failed"), ...switchFailureFields })
      .strict()
      .superRefine(refineAccountState),
  ]);

// --------------------------------------------------------------------------
// The two settlement events
// --------------------------------------------------------------------------

/**
 * The payload of {@link AGENT_PROVIDER_BINDING_CHANGED_EVENT}: a switch that applied.
 * A change of model, effort or speed alone settles `in_place` and draws no
 * transcript row; a provider or account switch draws the switch row from `from`,
 * `to`, the landed account, the continuity and the losses.
 *
 * - `actor` is the person who admitted the switch, recorded when it was accepted, so
 *   a switch that settles after a restart still names who asked for it.
 * - `landedProviderAccountId` is the account the run actually landed on, kept apart
 *   from `to.providerAccountId` so an agent that follows the current account is
 *   never silently pinned to the account it happened to land on.
 * - `turnContinued` is true only on an account move's resume path, where the turn in
 *   flight was stopped at a tool call and told to continue; an in-place switch
 *   interrupts nothing.
 */
export interface AgentProviderBindingChangedPayload extends AgentBindingSwitchOutcome {
  sessionId: SessionId;
  agentId: AgentId;
  actor: UserId;
  from: AgentProviderBinding;
  to: AgentProviderBinding;
  landedProviderAccountId: ProviderAccountId;
  turnContinued: boolean;
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
      turnContinued: z.boolean(),
    })
    .strict()
    .superRefine(refineDeclaredLosses);

/**
 * The payload of {@link AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT}: an accepted switch
 * that could not be applied. The agent stays on `from`, and the session gains one
 * system message naming what was `attempted` and why. Emitted on both arms: the
 * pending slot is cleared by a settlement event, never by a reply, so exactly one of
 * the two events ends every switch that is not replaced.
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
