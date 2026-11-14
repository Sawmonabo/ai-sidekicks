// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's live agents as a client reads and moves them, and the live agents' method table, which also carries the definition verbs.

import type { SchemaCheck } from "../../schema-check.js";
import {
  validateAgentDefinitionCreateRequest,
  validateAgentDefinitionCreateResponse,
  validateAgentDefinitionDeleteRequest,
  validateAgentDefinitionDeleteResponse,
  validateAgentDefinitionExportRequest,
  validateAgentDefinitionExportResponse,
  validateAgentDefinitionImportRequest,
  validateAgentDefinitionImportResponse,
  validateAgentDefinitionListResponse,
  validateAgentDefinitionUpdateRequest,
  validateAgentDefinitionUpdateResponse,
} from "../checks/agent/definition.js";
import {
  validateAgentConfigUpdateRequest,
  validateAgentConfigUpdateResponse,
  validateAgentSubscribeEntry,
  validateAgentSubscribeRequest,
  validateAgentSubscribeResponse,
} from "../checks/agent/methods.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse, SubscriptionId } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { ObservedProviderOption, ProviderOptionSetting } from "../provider/declaration.js";
import type { ProviderOutputSpeedState } from "../provider/driver/output-speed.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "../session/id.js";
import type {
  AgentDefinitionCreateRequest,
  AgentDefinitionCreateResponse,
  AgentDefinitionDeleteRequest,
  AgentDefinitionDeleteResponse,
  AgentDefinitionExportRequest,
  AgentDefinitionExportResponse,
  AgentDefinitionImportRequest,
  AgentDefinitionImportResponse,
  AgentDefinitionListResponse,
  AgentDefinitionUpdateRequest,
  AgentDefinitionUpdateResponse,
  AgentId,
  AgentProviderBinding,
  AgentResolvedConfiguration,
} from "./definition.js";
import type {
  AgentBindingSwitchDisposition,
  AgentBindingSwitchPending,
} from "./provider-binding.js";
import type { AgentTreeMember } from "./tree.js";

/**
 * The session whose agents `agent.subscribe` streams.
 */
export interface AgentSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One agent in the session.
 */
export interface AgentSubscribeEntry {
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * Its name.
   */
  name: string;
  /**
   * The binding it runs under now, never the pending one.
   */
  binding: AgentProviderBinding;
  /**
   * The speed the provider declared on the live binding; absent until it declares one.
   */
  observedOutputSpeed?: ProviderOutputSpeedState;
  /**
   * The session options as the provider reports them on the live binding; absent where
   * no binding is live or its driver declares none, never read as off.
   *
   * @minItems 1
   */
  observedOptions?: [ObservedProviderOption, ...ObservedProviderOption[]];
  /**
   * Present exactly while a switch waits, so every client learns of it, after a
   * restart too.
   */
  pendingSwitch?: AgentBindingSwitchPending;
  /**
   * Present exactly when the agent started from a saved definition, which names it on
   * screen.
   */
  resolvedConfiguration?: AgentResolvedConfiguration;
  /**
   * From the lead down to this agent's parent; empty for the lead.
   */
  ancestry: AgentTreeMember[];
  /**
   * When it joined the session.
   */
  createdAt: WireInstant;
}
/**
 * `agent.subscribe`'s acknowledgment: the subscription and the session's agents as they stand.
 * Every later emission is one [`AgentSubscribeEntry`] as it changes, so a switch in flight and its
 * settlement reach every window and device.
 */
export interface AgentSubscribeResponse {
  /**
   * The subscription.
   */
  subscriptionId: SubscriptionId;
  /**
   * The session's agents.
   */
  agents: AgentSubscribeEntry[];
}
/**
 * Moves a running agent's model, window, effort, speed, session options or provider: an omitted
 * member is unchanged and at least one moves, settled by the binding events. A provider switch
 * applies at the end of the run in flight; the account is no member, since it follows the
 * provider's current account. A model move names its window.
 */
export interface AgentConfigUpdateRequest {
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The provider.
   */
  providerName?: ProviderId;
  /**
   * The model.
   */
  modelId?: string;
  /**
   * The effort.
   */
  effort?: string;
  /**
   * The speed.
   */
  outputSpeed?: string;
  /**
   * Values of the session options the target driver declares; an option left out keeps its
   * value. The daemon checks each against the driver's declaration: an option the driver does
   * not declare, or a value outside its declaration, is refused `agent.providerAxisInvalid`.
   *
   * @minItems 1
   */
  options?: [ProviderOptionSetting, ...ProviderOptionSetting[]];
  /**
   * The window in tokens, or `null` back to the model's default.
   */
  largerWindow?: number | null;
  /**
   * Interrupt the run first and hold the request open until the switch settles.
   */
  interruptAndSwitch?: boolean;
}
/**
 * The switch the update became, and when the agent row recorded it.
 */
export interface AgentConfigUpdateResponse {
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * When the row recorded it.
   */
  updatedAt: WireInstant;
  /**
   * The switch.
   */
  switch: AgentBindingSwitchDisposition;
}

export {
  validateAgentConfigUpdateRequest,
  validateAgentConfigUpdateResponse,
  validateAgentSubscribeEntry,
  validateAgentSubscribeRequest,
  validateAgentSubscribeResponse,
} from "../checks/agent/methods.js";

/** The methods of {@link AGENT_METHOD_DESCRIPTORS}, each with its checks. */
export interface AgentMethodDescriptors {
  readonly "agent.subscribe": {
    readonly method: "agent.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentSubscribeRequest>;
    readonly responseCheck: SchemaCheck<AgentSubscribeResponse>;
    readonly emissionCheck: SchemaCheck<AgentSubscribeEntry>;
  };
  readonly "agent.config.update": {
    readonly method: "agent.config.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentConfigUpdateRequest>;
    readonly responseCheck: SchemaCheck<AgentConfigUpdateResponse>;
  };
  readonly "agent.definition.list": {
    readonly method: "agent.definition.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<AgentDefinitionListResponse>;
  };
  readonly "agent.definition.subscribe": {
    readonly method: "agent.definition.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<AgentDefinitionListResponse>;
  };
  readonly "agent.definition.create": {
    readonly method: "agent.definition.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentDefinitionCreateRequest>;
    readonly responseCheck: SchemaCheck<AgentDefinitionCreateResponse>;
  };
  readonly "agent.definition.update": {
    readonly method: "agent.definition.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentDefinitionUpdateRequest>;
    readonly responseCheck: SchemaCheck<AgentDefinitionUpdateResponse>;
  };
  readonly "agent.definition.delete": {
    readonly method: "agent.definition.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentDefinitionDeleteRequest>;
    readonly responseCheck: SchemaCheck<AgentDefinitionDeleteResponse>;
  };
  readonly "agent.definition.export": {
    readonly method: "agent.definition.export";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentDefinitionExportRequest>;
    readonly responseCheck: SchemaCheck<AgentDefinitionExportResponse>;
  };
  readonly "agent.definition.import": {
    readonly method: "agent.definition.import";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentDefinitionImportRequest>;
    readonly responseCheck: SchemaCheck<AgentDefinitionImportResponse>;
  };
}
/**
 * The live agents' methods and the definition verbs. `agent.definition.subscribe` resends
 * the whole `agent.definition.list` reply on each change to the registry.
 */
export const AGENT_METHOD_DESCRIPTORS: AgentMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "agent.subscribe": /* @__PURE__ */ Object.freeze({
    method: "agent.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAgentSubscribeRequest,
    responseCheck: validateAgentSubscribeResponse,
    emissionCheck: validateAgentSubscribeEntry,
  }),
  "agent.config.update": /* @__PURE__ */ Object.freeze({
    method: "agent.config.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentConfigUpdateRequest,
    responseCheck: validateAgentConfigUpdateResponse,
  }),
  "agent.definition.list": /* @__PURE__ */ Object.freeze({
    method: "agent.definition.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateAgentDefinitionListResponse,
  }),
  "agent.definition.subscribe": /* @__PURE__ */ Object.freeze({
    method: "agent.definition.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateAgentDefinitionListResponse,
  }),
  "agent.definition.create": /* @__PURE__ */ Object.freeze({
    method: "agent.definition.create",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentDefinitionCreateRequest,
    responseCheck: validateAgentDefinitionCreateResponse,
  }),
  "agent.definition.update": /* @__PURE__ */ Object.freeze({
    method: "agent.definition.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentDefinitionUpdateRequest,
    responseCheck: validateAgentDefinitionUpdateResponse,
  }),
  "agent.definition.delete": /* @__PURE__ */ Object.freeze({
    method: "agent.definition.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentDefinitionDeleteRequest,
    responseCheck: validateAgentDefinitionDeleteResponse,
  }),
  "agent.definition.export": /* @__PURE__ */ Object.freeze({
    method: "agent.definition.export",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentDefinitionExportRequest,
    responseCheck: validateAgentDefinitionExportResponse,
  }),
  "agent.definition.import": /* @__PURE__ */ Object.freeze({
    method: "agent.definition.import",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentDefinitionImportRequest,
    responseCheck: validateAgentDefinitionImportResponse,
  }),
});
