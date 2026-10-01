// The `mcp.*` method table, the five governance event payloads and the refusal codes.
// An event payload names a project or local binding by the keyed digest of its folder,
// never the folder itself, because events are kept and signed.
import { z } from "zod";

import {
  McpApplicationGradeSchema,
  McpApprovalModeSchema,
  McpClearToolOverrideRequestSchema,
  McpGetResponseSchema,
  McpKeyedBindingRequestSchema,
  McpKeyedDigestSchema,
  McpListRequestSchema,
  McpListResponseSchema,
  McpMutationResultSchema,
  McpOauthLoginResponseSchema,
  McpOauthLogoutRequestSchema,
  McpOauthLogoutResponseSchema,
  McpReconnectRequestSchema,
  McpReconnectResponseSchema,
  McpRegistrySearchRequestSchema,
  McpRegistrySearchResponseSchema,
  McpRemoveServerResultSchema,
  McpServerBindingRefSchema,
  McpServerNameSchema,
  McpServerStatusSchema,
  McpSetEnabledRequestSchema,
  McpSetToolOverrideRequestSchema,
  McpSetTrustRequestSchema,
  McpToolNameSchema,
  McpToolOverrideMutationResultSchema,
  McpUpsertServerRequestSchema,
  type McpApplicationGrade,
  type McpApprovalMode,
  type McpClearToolOverrideRequest,
  type McpGetResponse,
  type McpKeyedBindingRequest,
  type McpListRequest,
  type McpListResponse,
  type McpMutationResult,
  type McpOauthLoginResponse,
  type McpOauthLogoutRequest,
  type McpOauthLogoutResponse,
  type McpReconnectRequest,
  type McpReconnectResponse,
  type McpRegistrySearchRequest,
  type McpRegistrySearchResponse,
  type McpRemoveServerResult,
  type McpServerBindingRef,
  type McpSetEnabledRequest,
  type McpSetToolOverrideRequest,
  type McpSetTrustRequest,
  type McpToolOverrideMutationResult,
  type McpUpsertServerRequest,
} from "./mcp.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import type { McpServerStatus } from "./provider-driver.js";
import { SessionIdSchema, type SessionId } from "./session.js";

// Governance event payloads

/**
 * A binding's identity inside a kept event: the folder is replaced by its keyed
 * digest, stable for the binding's life and joinable to the inventory entry that
 * serves the same digest.
 */
export type McpServerBindingAuditRef =
  | { provider: ProviderName; scope: "user"; serverName: string }
  | { provider: ProviderName; scope: "project"; scopeRefDigest: string; serverName: string }
  | { provider: ProviderName; scope: "local"; scopeRefDigest: string; serverName: string };

/** The audit-ref union with `extra` members added to each arm, every arm strict. */
const auditAddressed = <Extra extends z.ZodRawShape>(extra: Extra) =>
  z.discriminatedUnion("scope", [
    z
      .object({
        provider: ProviderNameSchema,
        scope: z.literal("user"),
        serverName: McpServerNameSchema,
        ...extra,
      })
      .strict(),
    z
      .object({
        provider: ProviderNameSchema,
        scope: z.literal("project"),
        scopeRefDigest: McpKeyedDigestSchema,
        serverName: McpServerNameSchema,
        ...extra,
      })
      .strict(),
    z
      .object({
        provider: ProviderNameSchema,
        scope: z.literal("local"),
        scopeRefDigest: McpKeyedDigestSchema,
        serverName: McpServerNameSchema,
        ...extra,
      })
      .strict(),
  ]);

const initiatingSessionShape = { initiatingSessionId: SessionIdSchema.optional() };

/**
 * `mcp.server_status_changed`. A `session_feed` observation names the live leg it
 * came from; a `node_probe` observation has no leg and carries no `bindingId`.
 */
export type McpServerStatusChangedPayload = McpServerBindingAuditRef & {
  previousStatus: McpServerStatus;
  status: McpServerStatus;
  failureReason?: string | undefined;
  origin: "session_feed" | "node_probe";
  bindingId?: string | undefined;
};
/** Parses an {@link McpServerStatusChangedPayload}. */
export const McpServerStatusChangedPayloadSchema: z.ZodType<McpServerStatusChangedPayload> =
  auditAddressed({
    previousStatus: McpServerStatusSchema,
    status: McpServerStatusSchema,
    failureReason: z.string().optional(),
    origin: z.enum(["session_feed", "node_probe"]),
    bindingId: z.string().min(1).optional(),
  }).refine(
    (payload) => (payload.origin === "session_feed") === (payload.bindingId !== undefined),
    {
      message: "bindingId is carried exactly when the observation came from a session's leg.",
      path: ["bindingId"],
    },
  );

const MCP_CONFIG_CHANGE_KIND_VALUES = [
  "added",
  "updated",
  "removed",
  "enabled",
  "disabled",
] as const;

/** What a configuration change did to a binding. */
export type McpConfigChangeKind = (typeof MCP_CONFIG_CHANGE_KIND_VALUES)[number];

/**
 * `mcp.server_config_changed`. A removal has no configuration left to hash, so it
 * carries the hash it had and no new one; an update carries both; every other
 * change carries the new hash.
 */
export type McpServerConfigChangedPayload = McpServerBindingAuditRef & {
  changeKind: McpConfigChangeKind;
  appliedVia: McpApplicationGrade;
  configHash?: string | undefined;
  previousConfigHash?: string | undefined;
  initiatingSessionId?: SessionId | undefined;
};
/** Parses an {@link McpServerConfigChangedPayload}. */
export const McpServerConfigChangedPayloadSchema: z.ZodType<McpServerConfigChangedPayload> =
  auditAddressed({
    changeKind: z.enum(MCP_CONFIG_CHANGE_KIND_VALUES),
    appliedVia: McpApplicationGradeSchema,
    configHash: McpKeyedDigestSchema.optional(),
    previousConfigHash: McpKeyedDigestSchema.optional(),
    ...initiatingSessionShape,
  })
    .refine(
      (payload) => (payload.changeKind === "removed") === (payload.configHash === undefined),
      { message: "configHash is absent on a removal and present on every other change." },
    )
    .refine(
      (payload) =>
        (payload.changeKind !== "removed" && payload.changeKind !== "updated") ||
        payload.previousConfigHash !== undefined,
      { message: "A removal or an update carries previousConfigHash." },
    );

const MCP_TRUST_REASON_VALUES = ["operator_grant", "operator_revoke", "config_drift"] as const;

/** Why trust changed: the person granted or withdrew it, or the configuration drifted. */
export type McpTrustReason = (typeof MCP_TRUST_REASON_VALUES)[number];

/** `mcp.server_trust_changed`. `configHash` is the hash the grant binds to, or the drifted one. */
export type McpServerTrustChangedPayload = McpServerBindingAuditRef & {
  trusted: boolean;
  reason: McpTrustReason;
  configHash: string;
  initiatingSessionId?: SessionId | undefined;
};
/** Parses an {@link McpServerTrustChangedPayload}. */
export const McpServerTrustChangedPayloadSchema: z.ZodType<McpServerTrustChangedPayload> =
  auditAddressed({
    trusted: z.boolean(),
    reason: z.enum(MCP_TRUST_REASON_VALUES),
    configHash: McpKeyedDigestSchema,
    ...initiatingSessionShape,
  });

/** `mcp.tool_override_changed`. A clear by withdrawn trust has no initiating session. */
export type McpToolOverrideChangedPayload = McpServerBindingAuditRef & {
  toolName: string;
  changeKind: "set" | "cleared";
  enabled?: boolean | undefined;
  approvalMode?: McpApprovalMode | undefined;
  idempotencyClass?: "idempotent" | "compensable" | undefined;
  initiatingSessionId?: SessionId | undefined;
};
/** Parses an {@link McpToolOverrideChangedPayload}. */
export const McpToolOverrideChangedPayloadSchema: z.ZodType<McpToolOverrideChangedPayload> =
  auditAddressed({
    toolName: McpToolNameSchema,
    changeKind: z.enum(["set", "cleared"]),
    enabled: z.boolean().optional(),
    approvalMode: McpApprovalModeSchema.optional(),
    idempotencyClass: z.enum(["idempotent", "compensable"]).optional(),
    ...initiatingSessionShape,
  });

/**
 * `mcp.server_oauth_completed`: how a sign-in ended. A sign-in that fails after
 * `mcp.oauthLogin` has answered arrives here as `failure`, never as a late error.
 */
export type McpServerOauthCompletedPayload = McpServerBindingAuditRef & {
  outcome: "success" | "failure";
  failureReason?: string | undefined;
  initiatingSessionId?: SessionId | undefined;
};
/** Parses an {@link McpServerOauthCompletedPayload}. */
export const McpServerOauthCompletedPayloadSchema: z.ZodType<McpServerOauthCompletedPayload> =
  auditAddressed({
    outcome: z.enum(["success", "failure"]),
    failureReason: z.string().optional(),
    ...initiatingSessionShape,
  });

// Refusal codes

/** No binding with the requested provider, scope, folder and name exists. */
export type McpServerNotFoundCode = "mcp.server_not_found";
/** The value of {@link McpServerNotFoundCode}. */
export const MCP_SERVER_NOT_FOUND_CODE: McpServerNotFoundCode = "mcp.server_not_found";

/** The submitted configuration failed validation before anything was written. */
export type McpConfigInvalidCode = "mcp.config_invalid";
/** The value of {@link McpConfigInvalidCode}. */
export const MCP_CONFIG_INVALID_CODE: McpConfigInvalidCode = "mcp.config_invalid";

/**
 * The provider's config file changed under the write: Codex's version check failed
 * twice, or a Codex project file no longer hashes to what the daemon last read.
 */
export type McpConfigWriteConflictCode = "mcp.config_write_conflict";
/** The value of {@link McpConfigWriteConflictCode}. */
export const MCP_CONFIG_WRITE_CONFLICT_CODE: McpConfigWriteConflictCode =
  "mcp.config_write_conflict";

/**
 * No mechanism reaches what was asked at this scope: a Codex `enabled` or
 * `approvalMode` tool override on a `project` binding.
 */
export type McpConfigScopeUnsupportedCode = "mcp.config_scope_unsupported";
/** The value of {@link McpConfigScopeUnsupportedCode}. */
export const MCP_CONFIG_SCOPE_UNSUPPORTED_CODE: McpConfigScopeUnsupportedCode =
  "mcp.config_scope_unsupported";

/** The caller does not own this machine. Ownership decides, never the transport. */
export type McpOperatorScopeRequiredCode = "mcp.operator_scope_required";
/** The value of {@link McpOperatorScopeRequiredCode}. */
export const MCP_OPERATOR_SCOPE_REQUIRED_CODE: McpOperatorScopeRequiredCode =
  "mcp.operator_scope_required";

/** The policy denied the governance change, checked before whether the binding exists. */
export type McpGovernanceDeniedCode = "mcp.governance_denied";
/** The value of {@link McpGovernanceDeniedCode}. */
export const MCP_GOVERNANCE_DENIED_CODE: McpGovernanceDeniedCode = "mcp.governance_denied";

/** A tool override would loosen what an untrusted server may do. */
export type McpTrustRequiredCode = "mcp.trust_required";
/** The value of {@link McpTrustRequiredCode}. */
export const MCP_TRUST_REQUIRED_CODE: McpTrustRequiredCode = "mcp.trust_required";

/** The sign-in could not be started. A failure after it started arrives as an event. */
export type McpOauthFlowFailedCode = "mcp.oauth_flow_failed";
/** The value of {@link McpOauthFlowFailedCode}. */
export const MCP_OAUTH_FLOW_FAILED_CODE: McpOauthFlowFailedCode = "mcp.oauth_flow_failed";

// The method table

/**
 * Every `mcp.*` method but `mcp.subscribe`, whose emissions are event envelopes
 * and so are described beside the event union.
 */
export interface McpMethodDescriptors {
  readonly "mcp.list": MethodDescriptor<"mcp.list", McpListRequest, McpListResponse>;
  readonly "mcp.get": MethodDescriptor<"mcp.get", McpServerBindingRef, McpGetResponse>;
  readonly "mcp.registrySearch": MethodDescriptor<
    "mcp.registrySearch",
    McpRegistrySearchRequest,
    McpRegistrySearchResponse
  >;
  readonly "mcp.upsertServer": MethodDescriptor<
    "mcp.upsertServer",
    McpUpsertServerRequest,
    McpMutationResult
  >;
  readonly "mcp.removeServer": MethodDescriptor<
    "mcp.removeServer",
    McpKeyedBindingRequest,
    McpRemoveServerResult
  >;
  readonly "mcp.setEnabled": MethodDescriptor<
    "mcp.setEnabled",
    McpSetEnabledRequest,
    McpMutationResult
  >;
  readonly "mcp.setTrust": MethodDescriptor<"mcp.setTrust", McpSetTrustRequest, McpMutationResult>;
  readonly "mcp.setToolOverride": MethodDescriptor<
    "mcp.setToolOverride",
    McpSetToolOverrideRequest,
    McpToolOverrideMutationResult
  >;
  readonly "mcp.clearToolOverride": MethodDescriptor<
    "mcp.clearToolOverride",
    McpClearToolOverrideRequest,
    McpToolOverrideMutationResult
  >;
  readonly "mcp.oauthLogin": MethodDescriptor<
    "mcp.oauthLogin",
    McpKeyedBindingRequest,
    McpOauthLoginResponse
  >;
  readonly "mcp.oauthLogout": MethodDescriptor<
    "mcp.oauthLogout",
    McpOauthLogoutRequest,
    McpOauthLogoutResponse
  >;
  readonly "mcp.reconnect": MethodDescriptor<
    "mcp.reconnect",
    McpReconnectRequest,
    McpReconnectResponse
  >;
}

/** The `mcp.*` methods' names, procedure types and shapes. */
export const MCP_METHOD_DESCRIPTORS: McpMethodDescriptors = defineMethodDescriptors({
  "mcp.list": {
    method: "mcp.list",
    procedureType: "query",
    mutating: false,
    requestSchema: McpListRequestSchema,
    responseSchema: McpListResponseSchema,
  },
  "mcp.get": {
    method: "mcp.get",
    procedureType: "query",
    mutating: false,
    requestSchema: McpServerBindingRefSchema,
    responseSchema: McpGetResponseSchema,
  },
  "mcp.registrySearch": {
    method: "mcp.registrySearch",
    procedureType: "query",
    mutating: false,
    requestSchema: McpRegistrySearchRequestSchema,
    responseSchema: McpRegistrySearchResponseSchema,
  },
  "mcp.upsertServer": {
    method: "mcp.upsertServer",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpUpsertServerRequestSchema,
    responseSchema: McpMutationResultSchema,
  },
  "mcp.removeServer": {
    method: "mcp.removeServer",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpKeyedBindingRequestSchema,
    responseSchema: McpRemoveServerResultSchema,
  },
  "mcp.setEnabled": {
    method: "mcp.setEnabled",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpSetEnabledRequestSchema,
    responseSchema: McpMutationResultSchema,
  },
  "mcp.setTrust": {
    method: "mcp.setTrust",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpSetTrustRequestSchema,
    responseSchema: McpMutationResultSchema,
  },
  "mcp.setToolOverride": {
    method: "mcp.setToolOverride",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpSetToolOverrideRequestSchema,
    responseSchema: McpToolOverrideMutationResultSchema,
  },
  "mcp.clearToolOverride": {
    method: "mcp.clearToolOverride",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpClearToolOverrideRequestSchema,
    responseSchema: McpToolOverrideMutationResultSchema,
  },
  "mcp.oauthLogin": {
    method: "mcp.oauthLogin",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpKeyedBindingRequestSchema,
    responseSchema: McpOauthLoginResponseSchema,
  },
  "mcp.oauthLogout": {
    method: "mcp.oauthLogout",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpOauthLogoutRequestSchema,
    responseSchema: McpOauthLogoutResponseSchema,
  },
  "mcp.reconnect": {
    method: "mcp.reconnect",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpReconnectRequestSchema,
    responseSchema: McpReconnectResponseSchema,
  },
});
