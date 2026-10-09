// A session's live agents as a client reads and moves them: the live agent list,
// the switch of a running agent's binding, and the `agent.*` method table, which
// also carries the definition verbs of `agent/definition.ts`.
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
  providerTokenSchema,
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
} from "./definition.js";
import {
  AgentBindingSwitchDispositionSchema,
  AgentBindingSwitchPendingSchema,
  refineModelMoveNamesWindow,
  type AgentBindingSwitchDisposition,
  type AgentBindingSwitchPending,
} from "./provider-binding.js";
import { AgentTreeMemberSchema, type AgentTreeMember } from "./tree.js";
import {
  SubscribeAckResponseSchema,
  SubscriptionIdSchema,
  type SubscribeAckResponse,
} from "../jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "../method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "../provider/name.js";
import { DRIVER_TOOL_NAME_MAX_LEN } from "../provider/driver/length-limits.js";
import {
  ProviderOutputSpeedStateSchema,
  type ProviderOutputSpeedState,
} from "../provider/driver/output-speed.js";
import { wireFreeFormString } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { isoDateTimeSchema } from "../internal/wire-scalars.js";

// agent.list

/** The session whose agents `agent.list` streams. */
export interface AgentListRequest {
  sessionId: SessionId;
}
/** Parses an {@link AgentListRequest}. */
export const AgentListRequestSchema: z.ZodType<AgentListRequest, AgentListRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

/** One agent in the session. */
export interface AgentListEntry {
  agentId: AgentId;
  name: string;
  /** The binding it runs under now, never the pending one. */
  binding: AgentProviderBinding;
  /**
   * The speed the provider declared on the live binding; absent until the provider declares one.
   */
  observedOutputSpeed?: ProviderOutputSpeedState | undefined;
  /** Present exactly while a switch waits, so every client learns of it, after a restart too. */
  pendingSwitch?: AgentBindingSwitchPending | undefined;
  /** Present exactly when the agent started from a saved definition, which names it on screen. */
  resolvedConfiguration?: AgentResolvedConfiguration | undefined;
  /** From the lead down to this agent's parent; empty for the lead. */
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
    createdAt: isoDateTimeSchema,
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

/**
 * Move a running agent's model, window, effort, speed or provider: an omitted member is unchanged
 * and at least one moves, settled by the binding events. A provider switch applies at the end of
 * the run in flight. The account is not a member: it follows the provider's current account.
 * `largerWindow` as a number moves to that larger window in tokens and `null` back to the model's
 * default; a `modelId` move names one of the two, so an omitted `largerWindow` always leaves the
 * window unchanged.
 */
export interface AgentConfigUpdateRequest {
  agentId: AgentId;
  driverName?: ProviderName | undefined;
  modelId?: string | undefined;
  effort?: string | undefined;
  outputSpeed?: string | undefined;
  largerWindow?: number | null | undefined;
  /** Interrupt the run first and hold the request open until the switch settles. */
  interruptAndSwitch?: boolean | undefined;
}
/** Parses an {@link AgentConfigUpdateRequest}; it moves at least one member. */
export const AgentConfigUpdateRequestSchema: z.ZodType<
  AgentConfigUpdateRequest,
  AgentConfigUpdateRequest
> = z
  .object({
    agentId: AgentIdSchema,
    driverName: ProviderNameSchema.optional(),
    modelId: providerTokenSchema("modelId").optional(),
    effort: providerTokenSchema("effort").optional(),
    outputSpeed: providerTokenSchema("outputSpeed").optional(),
    largerWindow: z.number().int().positive().nullable().optional(),
    interruptAndSwitch: z.boolean().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const movesAMember =
      request.driverName !== undefined ||
      request.modelId !== undefined ||
      request.effort !== undefined ||
      request.outputSpeed !== undefined ||
      request.largerWindow !== undefined;
    if (!movesAMember) {
      context.addIssue({
        code: "custom",
        message:
          "An update moves at least one of driverName, modelId, largerWindow, effort or outputSpeed.",
      });
    }
    refineModelMoveNamesWindow(request, context);
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
    updatedAt: isoDateTimeSchema,
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

/**
 * The `agent.*` method table.
 *
 * @consumedBy the daemon's `agent.*` handlers
 */
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
