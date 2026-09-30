// A session's live agents as a client reads and moves them: the live agent list,
// the switch of a running agent's binding, and the `agent.*` method table, which
// also carries the definition verbs of `agent-definition.ts`.
//
// An agent is in its session or it is not: it has no lifecycle state, and no verb
// brings one in or takes one out. A session has one lead, and another agent takes
// part only where the lead or a workflow reaches it.
import { z } from "zod";

import {
  AgentDefinitionCreateRequestSchema,
  AgentDefinitionCreateResponseSchema,
  AgentDefinitionDeleteRequestSchema,
  AgentDefinitionDeleteResponseSchema,
  AgentDefinitionExportRequestSchema,
  AgentDefinitionExportResponseSchema,
  AgentDefinitionImportRequestSchema,
  AgentDefinitionImportResponseSchema,
  AgentDefinitionListRequestSchema,
  AgentDefinitionListResponseSchema,
  AgentDefinitionUpdateRequestSchema,
  AgentDefinitionUpdateResponseSchema,
  AgentIdSchema,
  AgentProviderBindingSchema,
  AgentResolvedConfigurationSchema,
  type AgentDefinitionCreateRequest,
  type AgentDefinitionCreateResponse,
  type AgentDefinitionDeleteRequest,
  type AgentDefinitionDeleteResponse,
  type AgentDefinitionExportRequest,
  type AgentDefinitionExportResponse,
  type AgentDefinitionImportRequest,
  type AgentDefinitionImportResponse,
  type AgentDefinitionListRequest,
  type AgentDefinitionListResponse,
  type AgentDefinitionUpdateRequest,
  type AgentDefinitionUpdateResponse,
  type AgentId,
  type AgentProviderBinding,
  type AgentResolvedConfiguration,
} from "./agent-definition.js";
import {
  AgentBindingSwitchDispositionSchema,
  AgentBindingSwitchPendingSchema,
  type AgentBindingSwitchDisposition,
  type AgentBindingSwitchPending,
} from "./agent-provider-binding.js";
import {
  SubscribeAckResponseSchema,
  SubscriptionIdSchema,
  type SubscribeAckResponse,
} from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import {
  DRIVER_TOOL_NAME_MAX_LEN,
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_TOKEN_MAX_LEN,
  ProviderOutputSpeedStateSchema,
  RunIdSchema,
  type ProviderOutputSpeedState,
  type RunId,
} from "./provider-driver.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

// The session's agent tree

/**
 * The daemon-minted handle of a provider's own helper inside its parent's run.
 * Opaque, and resolved only by the daemon, whose parent-to-child index minted it.
 */
export type ChildHandle = string & { readonly __brand: "ChildHandle" };
/** Parses a {@link ChildHandle}: a non-empty string up to the wire's handle bound. */
export const ChildHandleSchema: z.ZodType<ChildHandle, ChildHandle> = z
  .string()
  .min(1)
  .max(DRIVER_WIRE_HANDLE_MAX_LEN)
  .brand<"ChildHandle">() as unknown as z.ZodType<ChildHandle, ChildHandle>;

/**
 * One agent in the session's tree as the daemon's index names it: an agent with an
 * id (the lead, or an agent a bridge `run` started), or a provider's own helper by
 * the run it runs in and its handle. Per-agent spend and a tree position both key
 * on it.
 */
export type AgentTreeMember =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "providerChild"; runId: RunId; childHandle: ChildHandle };
/** Parses an {@link AgentTreeMember}. */
export const AgentTreeMemberSchema: z.ZodType<AgentTreeMember> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
  z
    .object({
      kind: z.literal("providerChild"),
      runId: RunIdSchema,
      childHandle: ChildHandleSchema,
    })
    .strict(),
]);

// agent.list

/** The session whose agents `agent.list` streams. */
export interface AgentListRequest {
  sessionId: SessionId;
}
/** Parses an {@link AgentListRequest}. */
export const AgentListRequestSchema: z.ZodType<AgentListRequest, AgentListRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

/**
 * One agent in the session.
 *
 * - `binding` is the effective binding it runs under now, never the pending one;
 *   every member a switch can move is read back here once it applies.
 * - `observedOutputSpeed` is what the provider declared, beside the requested
 *   `binding.outputSpeed`, read from the agent's most recently established live
 *   binding. Absent means nothing has been read yet or the driver declares no
 *   speed, never that the mode is off.
 * - `pendingSwitch` is present exactly while a switch waits, so a client that did
 *   not ask for it learns of it, including after a daemon restart.
 * - `resolvedConfiguration` is present exactly when the agent was started from a
 *   saved definition, and its `resolvedFromDefinitionId` is the one home of that
 *   fact; the screen takes the agent's name, icon and color from it.
 * - `ancestry` runs from the lead down to this agent's parent; empty for the lead.
 */
export interface AgentListEntry {
  agentId: AgentId;
  name: string;
  binding: AgentProviderBinding;
  observedOutputSpeed?: ProviderOutputSpeedState | undefined;
  pendingSwitch?: AgentBindingSwitchPending | undefined;
  resolvedConfiguration?: AgentResolvedConfiguration | undefined;
  ancestry: AgentTreeMember[];
  createdAt: string;
}
/** Parses an {@link AgentListEntry}. */
export const AgentListEntrySchema: z.ZodType<AgentListEntry> = z
  .object({
    agentId: AgentIdSchema,
    name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "AgentListEntry.name"),
    binding: AgentProviderBindingSchema,
    observedOutputSpeed: ProviderOutputSpeedStateSchema.optional(),
    pendingSwitch: AgentBindingSwitchPendingSchema.optional(),
    resolvedConfiguration: AgentResolvedConfigurationSchema.optional(),
    ancestry: z.array(AgentTreeMemberSchema),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * `agent.list`'s acknowledgment: the subscription and the session's agents as they
 * stand. Every later emission is one {@link AgentListEntry} as it changes, so a
 * switch in flight and its settlement reach every window and device.
 */
export interface AgentListAck extends SubscribeAckResponse {
  readonly agents: AgentListEntry[];
}
/** Parses an {@link AgentListAck}. */
export const AgentListAckSchema: z.ZodType<AgentListAck> = z
  .object({ subscriptionId: SubscriptionIdSchema, agents: z.array(AgentListEntrySchema) })
  .strict();

// agent.configUpdate

/** A binding member a running agent's switch may name. */
const switchMemberSchema = (label: string): z.ZodString =>
  wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, label);

/**
 * Move a running agent's model, effort, speed or provider. An omitted member is
 * unchanged, never reset, and at least one moves: every accepted update is a switch
 * of the binding, settled by the binding events. A change of model, effort or speed
 * alone settles in place; a provider switch applies at the end of the run in flight.
 *
 * The account is not a member: it moves on the provider surface for every session
 * that follows it, and a request naming one is refused, since a per-session account
 * beside the provider's current account would let the two disagree.
 *
 * `interruptAndSwitch` interrupts the run first and holds the request open until the
 * switch settles; a refused interrupt refuses the switch rather than leaving the
 * agent half moved. It says when a switch lands, not what it lands on, so it is not
 * one of the binding's members.
 */
export interface AgentConfigUpdateRequest {
  agentId: AgentId;
  driverName?: string | undefined;
  modelId?: string | undefined;
  effort?: string | undefined;
  outputSpeed?: string | undefined;
  interruptAndSwitch?: boolean | undefined;
}
/** Parses an {@link AgentConfigUpdateRequest}; it moves at least one member. */
export const AgentConfigUpdateRequestSchema: z.ZodType<
  AgentConfigUpdateRequest,
  AgentConfigUpdateRequest
> = z
  .object({
    agentId: AgentIdSchema,
    driverName: switchMemberSchema("driverName").optional(),
    modelId: switchMemberSchema("modelId").optional(),
    effort: switchMemberSchema("effort").optional(),
    outputSpeed: switchMemberSchema("outputSpeed").optional(),
    interruptAndSwitch: z.boolean().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const movesAMember =
      request.driverName !== undefined ||
      request.modelId !== undefined ||
      request.effort !== undefined ||
      request.outputSpeed !== undefined;
    if (!movesAMember) {
      context.addIssue({
        code: "custom",
        message: "An update moves at least one of driverName, modelId, effort or outputSpeed.",
      });
    }
  });

/** The switch the update became, and when the agent row recorded it. */
export interface AgentConfigUpdateResponse {
  agentId: AgentId;
  updatedAt: string;
  switch: AgentBindingSwitchDisposition;
}
/** Parses an {@link AgentConfigUpdateResponse}. */
export const AgentConfigUpdateResponseSchema: z.ZodType<AgentConfigUpdateResponse> = z
  .object({
    agentId: AgentIdSchema,
    updatedAt: z.iso.datetime({ offset: true }),
    switch: AgentBindingSwitchDispositionSchema,
  })
  .strict();

// The agent.* method table

/**
 * The `agent.*` methods. `agent.definitionSubscribe` resends the whole
 * `agent.definitionList` reply on each change to the registry: a save, a delete or
 * an import from any window, a provider's file changed on disk, a plugin landing or
 * leaving.
 */
export interface AgentMethodDescriptors {
  readonly "agent.list": SubscriptionMethodDescriptor<
    "agent.list",
    AgentListRequest,
    AgentListAck,
    AgentListEntry
  >;
  readonly "agent.configUpdate": MethodDescriptor<
    "agent.configUpdate",
    AgentConfigUpdateRequest,
    AgentConfigUpdateResponse
  >;
  readonly "agent.definitionList": MethodDescriptor<
    "agent.definitionList",
    AgentDefinitionListRequest,
    AgentDefinitionListResponse
  >;
  readonly "agent.definitionSubscribe": SubscriptionMethodDescriptor<
    "agent.definitionSubscribe",
    AgentDefinitionListRequest,
    SubscribeAckResponse,
    AgentDefinitionListResponse
  >;
  readonly "agent.definitionCreate": MethodDescriptor<
    "agent.definitionCreate",
    AgentDefinitionCreateRequest,
    AgentDefinitionCreateResponse
  >;
  readonly "agent.definitionUpdate": MethodDescriptor<
    "agent.definitionUpdate",
    AgentDefinitionUpdateRequest,
    AgentDefinitionUpdateResponse
  >;
  readonly "agent.definitionDelete": MethodDescriptor<
    "agent.definitionDelete",
    AgentDefinitionDeleteRequest,
    AgentDefinitionDeleteResponse
  >;
  readonly "agent.definitionExport": MethodDescriptor<
    "agent.definitionExport",
    AgentDefinitionExportRequest,
    AgentDefinitionExportResponse
  >;
  readonly "agent.definitionImport": MethodDescriptor<
    "agent.definitionImport",
    AgentDefinitionImportRequest,
    AgentDefinitionImportResponse
  >;
}

/** The `agent.*` method table. */
export const AGENT_METHOD_DESCRIPTORS: AgentMethodDescriptors = defineMethodDescriptors({
  "agent.list": {
    method: "agent.list",
    procedureType: "subscription",
    mutating: false,
    requestSchema: AgentListRequestSchema,
    responseSchema: AgentListAckSchema,
    emissionSchema: AgentListEntrySchema,
  },
  "agent.configUpdate": {
    method: "agent.configUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AgentConfigUpdateRequestSchema,
    responseSchema: AgentConfigUpdateResponseSchema,
  },
  "agent.definitionList": {
    method: "agent.definitionList",
    procedureType: "query",
    mutating: false,
    requestSchema: AgentDefinitionListRequestSchema,
    responseSchema: AgentDefinitionListResponseSchema,
  },
  "agent.definitionSubscribe": {
    method: "agent.definitionSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: AgentDefinitionListRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: AgentDefinitionListResponseSchema,
  },
  "agent.definitionCreate": {
    method: "agent.definitionCreate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AgentDefinitionCreateRequestSchema,
    responseSchema: AgentDefinitionCreateResponseSchema,
  },
  "agent.definitionUpdate": {
    method: "agent.definitionUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AgentDefinitionUpdateRequestSchema,
    responseSchema: AgentDefinitionUpdateResponseSchema,
  },
  "agent.definitionDelete": {
    method: "agent.definitionDelete",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AgentDefinitionDeleteRequestSchema,
    responseSchema: AgentDefinitionDeleteResponseSchema,
  },
  "agent.definitionExport": {
    method: "agent.definitionExport",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AgentDefinitionExportRequestSchema,
    responseSchema: AgentDefinitionExportResponseSchema,
  },
  "agent.definitionImport": {
    method: "agent.definitionImport",
    procedureType: "mutation",
    mutating: true,
    requestSchema: AgentDefinitionImportRequestSchema,
    responseSchema: AgentDefinitionImportResponseSchema,
  },
});
