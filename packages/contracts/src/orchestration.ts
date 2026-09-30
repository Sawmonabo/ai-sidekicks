// The session's agent tree as a client reads it, run admission under an agent, and
// the `orchestration.*` method table.
//
// The daemon builds one parent-to-child index per session from the provider stream
// and persists it, because neither provider lists its children back on a resume.
// That index is the one source of the child tree, of every fan-out count the screen
// shows and of each agent's spend; `orchestration.childRunLinkRead` is a read of it,
// and no other verb exposes the index. How a child was reached is kept in the index
// and never sent: the screen draws the tree, the provider and model, and which agent
// was asked, and never a mechanism word.
import { z } from "zod";

import {
  AgentDefinitionIdSchema,
  AgentIdSchema,
  type AgentDefinitionId,
  type AgentId,
} from "./agent-definition.js";
import {
  AgentTreeMemberSchema,
  ChildHandleSchema,
  type AgentTreeMember,
  type ChildHandle,
} from "./agent.js";
import { countSchema } from "./internal/wire-scalars.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import {
  DRIVER_TOOL_NAME_MAX_LEN,
  DRIVER_WIRE_REASON_MAX_LEN,
  DRIVER_WIRE_TOKEN_MAX_LEN,
  RunIdSchema,
  type RunId,
} from "./provider-driver.js";
import { RunStateSchema, type RunState } from "./run-control.js";
import {
  OrchestrationBudgetReadRequestSchema,
  OrchestrationBudgetStateSchema,
  SessionCostReceiptRequestSchema,
  SessionCostReceiptSchema,
  UsdMicrosSchema,
  type OrchestrationBudgetReadRequest,
  type OrchestrationBudgetState,
  type SessionCostReceipt,
  type SessionCostReceiptRequest,
} from "./session-cost.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

// --------------------------------------------------------------------------
// orchestration.runCreate
// --------------------------------------------------------------------------

/**
 * Admit a run under an agent. No console control calls it: its callers are the
 * daemon's own paths (the bridge's `run` verb and a workflow's run-an-agent step)
 * and the SDK. Nothing counts against admission: a refusal is the provider's own, or
 * a target that does not resolve. A child may create a child of its own to any depth.
 *
 * The target is either an agent already in the session, or a saved definition with
 * no live agent yet, which the daemon resolves at the queue insert and records on
 * the queued run.
 */
export type OrchestrationRunCreateRequest =
  | {
      sessionId: SessionId;
      targetAgentId: AgentId;
      parentRunId?: RunId | undefined;
      internalHelper?: boolean | undefined;
    }
  | {
      sessionId: SessionId;
      targetDefinitionId: AgentDefinitionId;
      parentRunId?: RunId | undefined;
      internalHelper?: boolean | undefined;
    };

const runCreateCommonFields = {
  sessionId: SessionIdSchema,
  parentRunId: RunIdSchema.optional(),
  internalHelper: z.boolean().optional(),
};

/** Parses an {@link OrchestrationRunCreateRequest}; it names exactly one target. */
export const OrchestrationRunCreateRequestSchema: z.ZodType<
  OrchestrationRunCreateRequest,
  OrchestrationRunCreateRequest
> = z.union([
  z.object({ ...runCreateCommonFields, targetAgentId: AgentIdSchema }).strict(),
  z.object({ ...runCreateCommonFields, targetDefinitionId: AgentDefinitionIdSchema }).strict(),
]);

/**
 * The admitted run. `internalHelper` echoes the durable flag that marks a run no
 * person started, which the tree de-emphasizes and never hides.
 */
export interface OrchestrationRunCreateResponse {
  runId: RunId;
  state: RunState;
  parentRunId?: RunId | undefined;
  internalHelper: boolean;
}
/** Parses an {@link OrchestrationRunCreateResponse}. */
export const OrchestrationRunCreateResponseSchema: z.ZodType<OrchestrationRunCreateResponse> = z
  .object({
    runId: RunIdSchema,
    state: RunStateSchema,
    parentRunId: RunIdSchema.optional(),
    internalHelper: z.boolean(),
  })
  .strict();

// --------------------------------------------------------------------------
// orchestration.childRunLinkRead
// --------------------------------------------------------------------------

/** The session whose whole tree `orchestration.childRunLinkRead` reads. */
export interface ChildRunLinkReadRequest {
  sessionId: SessionId;
}
/** Parses a {@link ChildRunLinkReadRequest}. */
export const ChildRunLinkReadRequestSchema: z.ZodType<
  ChildRunLinkReadRequest,
  ChildRunLinkReadRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * What a child's head reads after its name: the model, the effort as one word, the
 * agent that was asked where the child was a peer call, its tokens and spend, when it
 * started, and its ancestry from the lead down to its parent.
 */
export interface ChildRunHead {
  modelId: string;
  effort?: string | undefined;
  viaAgentName?: string | undefined;
  tokens: number;
  spendUsdMicros: number;
  startedAt: string;
  ancestry: AgentTreeMember[];
}
/** Parses a {@link ChildRunHead}. */
export const ChildRunHeadSchema: z.ZodType<ChildRunHead> = z
  .object({
    modelId: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ChildRunHead.modelId"),
    effort: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ChildRunHead.effort").optional(),
    viaAgentName: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "viaAgentName").optional(),
    tokens: z.number().int().nonnegative(),
    spendUsdMicros: UsdMicrosSchema,
    startedAt: z.iso.datetime({ offset: true }),
    ancestry: z.array(AgentTreeMemberSchema).min(1),
  })
  .strict();

/**
 * One child in the tree: a run of its own under an agent (`run`), linked to exactly
 * one parent run, or a provider's own helper inside its parent's run
 * (`providerChild`), addressed by its handle. `internalHelper` is carried from the
 * run's durable flag and never dropped on the way to the screen.
 */
export type ChildRunLink =
  | {
      kind: "run";
      childRunId: RunId;
      parentRunId: RunId;
      agentId: AgentId;
      internalHelper: boolean;
      state: RunState;
      head: ChildRunHead;
    }
  | {
      kind: "providerChild";
      runId: RunId;
      childHandle: ChildHandle;
      parentChildHandle?: ChildHandle | undefined;
      state: RunState;
      head: ChildRunHead;
    };
/** Parses a {@link ChildRunLink}; no run is its own parent. */
export const ChildRunLinkSchema: z.ZodType<ChildRunLink> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("run"),
      childRunId: RunIdSchema,
      parentRunId: RunIdSchema,
      agentId: AgentIdSchema,
      internalHelper: z.boolean(),
      state: RunStateSchema,
      head: ChildRunHeadSchema,
    })
    .strict()
    .refine((link) => link.childRunId !== link.parentRunId, {
      path: ["parentRunId"],
      message: "No run is its own parent.",
    }),
  z
    .object({
      kind: z.literal("providerChild"),
      runId: RunIdSchema,
      childHandle: ChildHandleSchema,
      parentChildHandle: ChildHandleSchema.optional(),
      state: RunStateSchema,
      head: ChildRunHeadSchema,
    })
    .strict(),
]);

/**
 * A child run the daemon refused to create, folded from the session's refusal
 * events. A refusal leaves no run, queue item or link, so this fold is the only
 * record of work that was asked for and denied. `reason` is the refusing error code.
 */
export interface ChildRunRejection {
  parentRunId: RunId;
  targetAgentId?: AgentId | undefined;
  targetDefinitionId?: AgentDefinitionId | undefined;
  reason: string;
  detail?: string | undefined;
  occurredAt: string;
}
/** Parses a {@link ChildRunRejection}. */
export const ChildRunRejectionSchema: z.ZodType<ChildRunRejection> = z
  .object({
    parentRunId: RunIdSchema,
    targetAgentId: AgentIdSchema.optional(),
    targetDefinitionId: AgentDefinitionIdSchema.optional(),
    reason: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ChildRunRejection.reason"),
    detail: wireFreeFormString(DRIVER_WIRE_REASON_MAX_LEN, "ChildRunRejection.detail").optional(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * The Sidekicks badge's figures, supplied by the daemon because the screen may hold
 * only part of the list: the children running now, the children dispatched in all,
 * and the children waiting on an approval.
 */
export interface ChildRunCounts {
  live: number;
  total: number;
  waiting: number;
}

/** The whole tree, the badge's figures, and the refused creates. */
export interface ChildRunLinkReadResponse {
  children: ChildRunLink[];
  counts: ChildRunCounts;
  rejectedCreates: ChildRunRejection[];
}
/** Parses a {@link ChildRunLinkReadResponse}. */
export const ChildRunLinkReadResponseSchema: z.ZodType<ChildRunLinkReadResponse> = z
  .object({
    children: z.array(ChildRunLinkSchema),
    counts: z
      .object({ live: countSchema, total: countSchema, waiting: countSchema })
      .strict()
      .refine((counts) => counts.live <= counts.total && counts.waiting <= counts.total, {
        message: "Neither the live nor the waiting count exceeds the total.",
      }),
    rejectedCreates: z.array(ChildRunRejectionSchema),
  })
  .strict();

// --------------------------------------------------------------------------
// The orchestration.* method table
// --------------------------------------------------------------------------

/**
 * The `orchestration.*` methods. The client re-reads the tree on each child started
 * or completed, run queued, create refused and run state change.
 */
export interface OrchestrationMethodDescriptors {
  readonly "orchestration.runCreate": MethodDescriptor<
    "orchestration.runCreate",
    OrchestrationRunCreateRequest,
    OrchestrationRunCreateResponse
  >;
  readonly "orchestration.childRunLinkRead": MethodDescriptor<
    "orchestration.childRunLinkRead",
    ChildRunLinkReadRequest,
    ChildRunLinkReadResponse
  >;
  readonly "orchestration.budgetRead": MethodDescriptor<
    "orchestration.budgetRead",
    OrchestrationBudgetReadRequest,
    OrchestrationBudgetState
  >;
  readonly "orchestration.costReceiptRead": MethodDescriptor<
    "orchestration.costReceiptRead",
    SessionCostReceiptRequest,
    SessionCostReceipt
  >;
}

/** The `orchestration.*` method table. */
export const ORCHESTRATION_METHOD_DESCRIPTORS: OrchestrationMethodDescriptors =
  defineMethodDescriptors({
    "orchestration.runCreate": {
      method: "orchestration.runCreate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: OrchestrationRunCreateRequestSchema,
      responseSchema: OrchestrationRunCreateResponseSchema,
    },
    "orchestration.childRunLinkRead": {
      method: "orchestration.childRunLinkRead",
      procedureType: "query",
      mutating: false,
      requestSchema: ChildRunLinkReadRequestSchema,
      responseSchema: ChildRunLinkReadResponseSchema,
    },
    "orchestration.budgetRead": {
      method: "orchestration.budgetRead",
      procedureType: "query",
      mutating: false,
      requestSchema: OrchestrationBudgetReadRequestSchema,
      responseSchema: OrchestrationBudgetStateSchema,
    },
    "orchestration.costReceiptRead": {
      method: "orchestration.costReceiptRead",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionCostReceiptRequestSchema,
      responseSchema: SessionCostReceiptSchema,
    },
  });
