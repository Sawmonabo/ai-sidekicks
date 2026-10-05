// The `mcp.*` method table, the sign-in event payload, the status notice and the refusal codes. A
// payload names a binding by its provider, scope and server name, never its folder.
import { z } from "zod";

import {
  McpBindingScopeSchema,
  McpClearToolOverrideRequestSchema,
  McpGetResponseSchema,
  McpKeyedBindingRequestSchema,
  McpListRequestSchema,
  McpListResponseSchema,
  McpMutationResultSchema,
  McpOauthLoginResponseSchema,
  McpOauthLogoutRequestSchema,
  McpReconnectRequestSchema,
  McpReconnectResponseSchema,
  McpRegistrySearchRequestSchema,
  McpRegistrySearchResponseSchema,
  McpRemoveServerRequestSchema,
  McpRemoveServerResultSchema,
  McpServerBindingRefSchema,
  McpServerNameSchema,
  McpServerStatusSchema,
  McpSetEnabledRequestSchema,
  McpSetToolOverrideRequestSchema,
  McpToolOverrideMutationResultSchema,
  McpUpsertServerRequestSchema,
  type McpBindingScope,
  type McpClearToolOverrideRequest,
  type McpGetResponse,
  type McpKeyedBindingRequest,
  type McpListRequest,
  type McpListResponse,
  type McpMutationResult,
  type McpOauthLoginResponse,
  type McpOauthLogoutRequest,
  type McpReconnectRequest,
  type McpReconnectResponse,
  type McpRegistrySearchRequest,
  type McpRegistrySearchResponse,
  type McpRemoveServerRequest,
  type McpRemoveServerResult,
  type McpServerBindingRef,
  type McpSetEnabledRequest,
  type McpSetToolOverrideRequest,
  type McpToolOverrideMutationResult,
  type McpUpsertServerRequest,
} from "./mcp.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "../method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "../provider/account/account.js";
import type { McpServerStatus } from "../provider/driver/driver.js";
import { SessionIdSchema, type SessionId } from "../session/session.js";

// Governance payloads

/**
 * A binding's identity inside an event or a notice: its provider, scope and server name. The
 * folder a project or local binding lives in is a path on this machine and never enters either.
 */
export interface McpServerBindingAuditRef {
  provider: ProviderName;
  scope: McpBindingScope;
  serverName: string;
}

/** The audit ref with `extra` members added, strict. */
const auditAddressed = <Extra extends z.ZodRawShape>(extra: Extra) =>
  z
    .object({
      provider: ProviderNameSchema,
      scope: McpBindingScopeSchema,
      serverName: McpServerNameSchema,
      ...extra,
    })
    .strict();

const initiatingSessionShape = { initiatingSessionId: SessionIdSchema.optional() };

/**
 * `mcp.server_status_changed`, the live notice of a status change on `mcp.subscribe`, written to
 * no log. A `session_feed` observation names the session and the live leg it came from; a
 * `node_probe` observation has neither.
 */
export type McpServerStatusChangedNotice = McpServerBindingAuditRef & {
  type: "mcp.server_status_changed";
  previousStatus: McpServerStatus;
  status: McpServerStatus;
  failureReason?: string | undefined;
  origin: "session_feed" | "node_probe";
  sessionId?: SessionId | undefined;
  bindingId?: string | undefined;
};
/** Parses an {@link McpServerStatusChangedNotice}. */
export const McpServerStatusChangedNoticeSchema: z.ZodType<McpServerStatusChangedNotice> =
  auditAddressed({
    type: z.literal("mcp.server_status_changed"),
    previousStatus: McpServerStatusSchema,
    status: McpServerStatusSchema,
    failureReason: z.string().optional(),
    origin: z.enum(["session_feed", "node_probe"]),
    sessionId: SessionIdSchema.optional(),
    bindingId: z.string().min(1).optional(),
  }).refine(
    (notice) =>
      notice.origin === "session_feed"
        ? notice.sessionId !== undefined && notice.bindingId !== undefined
        : notice.sessionId === undefined && notice.bindingId === undefined,
    {
      message: "sessionId and bindingId are carried exactly when a session's leg saw the change.",
      path: ["origin"],
    },
  );

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
/**
 * The value of {@link McpServerNotFoundCode}.
 *
 * @consumedBy the handler that returns the `mcp.server_not_found` error
 */
export const MCP_SERVER_NOT_FOUND_CODE: McpServerNotFoundCode = "mcp.server_not_found";

/** The submitted configuration failed validation before anything was written. */
export type McpConfigInvalidCode = "mcp.config_invalid";
/**
 * The value of {@link McpConfigInvalidCode}.
 *
 * @consumedBy the handler that returns the `mcp.config_invalid` error
 */
export const MCP_CONFIG_INVALID_CODE: McpConfigInvalidCode = "mcp.config_invalid";

/**
 * The provider's config file changed under the write: Codex's version check failed
 * twice, or a Codex project file no longer hashes to what the daemon last read.
 */
export type McpConfigWriteConflictCode = "mcp.config_write_conflict";
/**
 * The value of {@link McpConfigWriteConflictCode}.
 *
 * @consumedBy the handler that returns the `mcp.config_write_conflict` error
 */
export const MCP_CONFIG_WRITE_CONFLICT_CODE: McpConfigWriteConflictCode =
  "mcp.config_write_conflict";

/** The sign-in could not be started. A failure after it started arrives as an event. */
export type McpOauthFlowFailedCode = "mcp.oauth_flow_failed";
/**
 * The value of {@link McpOauthFlowFailedCode}.
 *
 * @consumedBy the handler that returns the `mcp.oauth_flow_failed` error
 */
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
    McpRemoveServerRequest,
    McpRemoveServerResult
  >;
  readonly "mcp.setEnabled": MethodDescriptor<
    "mcp.setEnabled",
    McpSetEnabledRequest,
    McpMutationResult
  >;
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
    EmptyPayload
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
    requestSchema: McpRemoveServerRequestSchema,
    responseSchema: McpRemoveServerResultSchema,
  },
  "mcp.setEnabled": {
    method: "mcp.setEnabled",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpSetEnabledRequestSchema,
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
    responseSchema: EmptyPayloadSchema,
  },
  "mcp.reconnect": {
    method: "mcp.reconnect",
    procedureType: "mutation",
    mutating: true,
    requestSchema: McpReconnectRequestSchema,
    responseSchema: McpReconnectResponseSchema,
  },
});
