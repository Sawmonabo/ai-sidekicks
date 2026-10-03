// MCP server governance shapes: what a server binding is, what the daemon reports about it, and
// what a mutation did to the live sessions behind it, plus each `mcp.*` method's request and reply.
// The method table, event payloads and refusal codes are in `mcp-governance.ts`.
//
// No read-back shape carries a configuration value. Credential-bearing input values are
// write-only, and the redacted view carries names (`envVarNames`, `headerNames`,
// `urlQueryParamNames`) where the wire carries values, so a client rendering every read-back
// still cannot render an environment-variable value, a header value or a token.
//
// Every governance mutation carries a `clientIdempotencyKey` that the caller mints: a retry of
// one press must reuse it, and a key minted per call would make every retry a new
// operation. `mcp.reconnect` alone carries none, because it is unreceipted and there is no
// replay for a key to describe.
import { z } from "zod";

import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import {
  DRIVER_BINDING_ID_MAX_LEN,
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  MCP_SERVER_STATUS_SEVERITY_ORDER,
  type McpServerStatus,
} from "./provider-driver.js";
import {
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
} from "./session.js";
import { isoDateTimeSchema } from "./internal/wire-scalars.js";

/** A server's name as a binding and an event carry it. */
export const McpServerNameSchema: z.ZodString = wireFreeFormString(
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  "McpServerBindingRef.serverName",
);

const MCP_APPLICATION_GRADE_VALUES = [
  "live_reconcile",
  "user_config_write",
  "next_run",
  "daemon_enforced",
] as const;

/**
 * When and where a mutation took effect: in the live sessions now, in the provider's
 * config store for later runs, in the next run's composed config, or at the daemon's
 * decision layer at once. Always stated, never silent.
 */
export type McpApplicationGrade = (typeof MCP_APPLICATION_GRADE_VALUES)[number];
/** Every {@link McpApplicationGrade}, in the order above. */
export const MCP_APPLICATION_GRADES: readonly McpApplicationGrade[] = MCP_APPLICATION_GRADE_VALUES;

const MCP_APPROVAL_MODE_VALUES = ["auto", "prompt", "writes", "approve"] as const;

/** The normalized approval vocabulary a tool override may pin. */
export type McpApprovalMode = (typeof MCP_APPROVAL_MODE_VALUES)[number];
/** Every {@link McpApprovalMode}. */
export const MCP_APPROVAL_MODES: readonly McpApprovalMode[] = MCP_APPROVAL_MODE_VALUES;
/** Parses an {@link McpApprovalMode}. */
export const McpApprovalModeSchema: z.ZodType<McpApprovalMode, McpApprovalMode> =
  z.enum(MCP_APPROVAL_MODE_VALUES);

const MCP_CONFIG_SCOPE_VALUES = ["user", "project", "local"] as const;

/**
 * Where a server binding applies: `user` on this machine in every project,
 * `project` in one project and saved with its repository, `local` in one project
 * on this machine only. Every scope exists on both providers; Codex has no private
 * per-project layer, so the daemon emulates `local` there with a user entry that
 * is off by default and switched on in that project's sessions.
 */
export type McpConfigScope = (typeof MCP_CONFIG_SCOPE_VALUES)[number];
/** Every {@link McpConfigScope}, in the order above. */
export const MCP_CONFIG_SCOPES: readonly McpConfigScope[] = MCP_CONFIG_SCOPE_VALUES;
/** Parses an {@link McpConfigScope}. */
export const McpConfigScopeSchema: z.ZodType<McpConfigScope, McpConfigScope> =
  z.enum(MCP_CONFIG_SCOPE_VALUES);

/**
 * The scope-qualified identity of one server binding. A union on `scope`, so `user` carries no
 * `scopeRef` and `project` and `local` require one (the project's root folder), and same-named
 * servers in two scopes stay two rows.
 */
export type McpServerBindingRef =
  | { provider: ProviderName; scope: "user"; serverName: string }
  | { provider: ProviderName; scope: "project"; scopeRef: string; serverName: string }
  | { provider: ProviderName; scope: "local"; scopeRef: string; serverName: string };

const userBindingShape = {
  provider: ProviderNameSchema,
  scope: z.literal("user"),
  serverName: McpServerNameSchema,
};
const projectBindingShape = {
  provider: ProviderNameSchema,
  scope: z.literal("project"),
  scopeRef: z.string().min(1).max(FILE_PATH_MAX_LEN),
  serverName: McpServerNameSchema,
};
const localBindingShape = {
  provider: ProviderNameSchema,
  scope: z.literal("local"),
  scopeRef: z.string().min(1).max(FILE_PATH_MAX_LEN),
  serverName: McpServerNameSchema,
};

/**
 * The binding union with `extra` members added to each arm, every arm strict. A
 * request addressed to a binding is built here so the scope rules hold on it too.
 */
const bindingAddressed = <Extra extends z.ZodRawShape>(extra: Extra) =>
  z.discriminatedUnion("scope", [
    z.object({ ...userBindingShape, ...extra }).strict(),
    z.object({ ...projectBindingShape, ...extra }).strict(),
    z.object({ ...localBindingShape, ...extra }).strict(),
  ]);

/** Parses an {@link McpServerBindingRef}; a shape outside the three arms is refused. */
export const McpServerBindingRefSchema: z.ZodType<McpServerBindingRef, McpServerBindingRef> =
  bindingAddressed({});

/**
 * The live notice `mcp.subscribe` sends after each edit to a binding, from this machine or a
 * linked device: an add, a change, a switch on or off, a tool override or a removal. A page
 * showing the binding reads it again with `mcp.get`; a removed one answers
 * `mcp.server_not_found`. The notice is sent live only and is written to no session's log.
 */
export type McpServerConfigChangedNotice = McpServerBindingRef & {
  type: "mcp.server_config_changed";
};
/** Parses an {@link McpServerConfigChangedNotice}. */
export const McpServerConfigChangedNoticeSchema: z.ZodType<
  McpServerConfigChangedNotice,
  McpServerConfigChangedNotice
> = bindingAddressed({ type: z.literal("mcp.server_config_changed") });

/** Turns one binding on or off. A retry of one press reuses its key. */
export type McpSetEnabledRequest = McpServerBindingRef & {
  clientIdempotencyKey: string;
  enabled: boolean;
};
/** Parses an {@link McpSetEnabledRequest}; a request without a UUID key is refused. */
export const McpSetEnabledRequestSchema: z.ZodType<McpSetEnabledRequest, McpSetEnabledRequest> =
  bindingAddressed({ clientIdempotencyKey: z.uuid(), enabled: z.boolean() });

/**
 * The redacted read-back of a binding's declaration, by transport. The env map, header map and
 * URL query arrive as keys only, since their values are credentials; the daemon strips the URL's
 * query and any user name or password from it, and a client shows it verbatim.
 */
export type McpServerConfigView =
  | {
      transport: "stdio";
      command: string;
      args?: string[] | undefined;
      envVarNames?: string[] | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    }
  | {
      transport: "http" | "sse";
      url: string;
      urlQueryParamNames?: string[] | undefined;
      headerNames?: string[] | undefined;
      bearerTokenEnvVar?: string | undefined;
      envHttpHeaders?: Record<string, string> | undefined;
      oauthScopes?: string[] | undefined;
      oauthResource?: string | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    };

/**
 * One live session's observation of one binding, kept per session because two sessions'
 * connections to one binding can disagree, and one verdict would hide a partial outage.
 */
export interface McpServerLegStatus {
  sessionId: SessionId;
  /** The runtime binding the observation came from, not the config binding. */
  bindingId: string;
  status: McpServerStatus;
  observedAt?: string | undefined;
}

const MCP_SERVER_FAILED_REASON_VALUES = ["commandNotRunnable"] as const;

/** Why a server reads `failed`, where the daemon knows. See {@link McpServerInventoryEntry}. */
export type McpServerFailedReason = (typeof MCP_SERVER_FAILED_REASON_VALUES)[number];

/**
 * One tool's override, by facet; at least one facet is present. An absent facet inherits, and a
 * client shows it as absent, never as a default it picked (the daemon's fallback for an absent
 * `idempotencyClass` is the manual-reconcile floor that crash recovery depends on).
 */
export interface McpToolOverride {
  toolName: string;
  enabled?: boolean | undefined;
  approvalMode?: McpApprovalMode | undefined;
  idempotencyClass?: "idempotent" | "compensable" | undefined;
}

/**
 * What an inventory entry carries whether or not the binding store answered. `status` is the
 * daemon's aggregate over `legs`.
 */
interface McpServerInventoryFacts {
  config: McpServerConfigView;
  status: McpServerStatus;
  legs?: McpServerLegStatus[] | undefined;
  observedAt?: string | undefined;
  requiredServer?: boolean | undefined;
  /**
   * Why a `failed` server failed, where the daemon knows a reason the person can
   * act on. `commandNotRunnable`: after the service moved between Windows and a WSL
   * distribution, the command or its arguments name a program on the side it
   * left. Carried only on a `failed` entry; the five status words stay five.
   */
  failedReason?: McpServerFailedReason | undefined;
}

/**
 * One inventory row: the binding and what is known about it. While `bindingStoreUnavailable`, the
 * members that need the binding store are absent, not `false`, `unknown` or an empty list, so no
 * made-up verdict exists; a client renders the absence.
 */
export type McpServerInventoryEntry = McpServerBindingRef &
  McpServerInventoryFacts &
  (
    | {
        bindingStoreUnavailable?: undefined;
        enabled: boolean;
        toolOverrides: McpToolOverride[];
      }
    | {
        bindingStoreUnavailable: true;
        enabled?: boolean | undefined;
      }
  );

/**
 * One live session's outcome after a mutation that touched it. A mutation that committed and
 * failed on one session still answers served and reports that session here.
 */
export interface McpLiveApplicationResult {
  sessionId: SessionId;
  bindingId: string;
  outcome: "applied" | "failed";
  errorCode?: string | undefined;
  detail?: string | undefined;
}

/**
 * What a governance mutation answers with: the row as it now stands, where the change took effect,
 * and each live session's outcome. `liveResults` is absent, not empty, where none was touched.
 */
export interface McpMutationResult {
  server: McpServerInventoryEntry;
  applied: McpApplicationGrade;
  liveResults?: McpLiveApplicationResult[] | undefined;
}

/** One tool's override result, per facet it touched. See {@link McpToolOverride}. */
export interface McpToolOverrideApplication {
  enabled?: McpApplicationGrade | undefined;
  approvalMode?: McpApplicationGrade | undefined;
  /** An interrupted-call class is always enforced at the daemon, at once. */
  idempotencyClass?: "daemon_enforced" | undefined;
}

/**
 * What setting or clearing a tool override answers with. A Codex `enabled` or
 * `approvalMode` facet is written into the provider's own config, so each facet
 * carries its own grade.
 */
export interface McpToolOverrideMutationResult {
  server: McpServerInventoryEntry;
  applied: McpToolOverrideApplication;
}

/** What removing a binding answers with. There is no row left to return. */
export interface McpRemoveServerResult {
  applied: McpApplicationGrade;
  liveResults?: McpLiveApplicationResult[] | undefined;
}

// The configuration a person submits

/**
 * The longest command, argument, name, value, address or search text an `mcp.*`
 * request carries.
 */
export const MCP_REQUEST_TEXT_MAX_LEN = 8192;

const mcpRequestText = (fieldLabel: string): z.ZodString =>
  wireFreeFormString(MCP_REQUEST_TEXT_MAX_LEN, fieldLabel);

// An `http:` or `https:` address; `http:` is legal because a server may listen on loopback.
const mcpHttpAddressSchema = z.url({ protocol: /^https?$/u });

/** An `http:` or `https:` address, taken as typed, a user name or password in it included. */
const mcpServerAddressSchema = mcpHttpAddressSchema.max(MCP_REQUEST_TEXT_MAX_LEN);

const mcpTimeoutSecondsSchema = z.number().positive();

/**
 * A server's declaration as the person submits it, by transport. Environment and header values are
 * write-only, handed to the provider's write path and never served back; unset members keep the
 * provider's values.
 */
export type McpServerConfigInput =
  | {
      transport: "stdio";
      command: string;
      args?: string[] | undefined;
      env?: Record<string, string> | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    }
  | {
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string> | undefined;
      bearerTokenEnvVar?: string | undefined;
      /** A header name mapped to the name of the environment variable holding its value. */
      envHttpHeaders?: Record<string, string> | undefined;
      oauthScopes?: string[] | undefined;
      oauthResource?: string | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    };

// The settings every transport carries, the same on a submitted declaration and its read-back.
const serverSettingsShape = {
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  startupTimeoutSec: mcpTimeoutSecondsSchema.optional(),
  toolTimeoutSec: mcpTimeoutSecondsSchema.optional(),
};

const mcpTextMap = (fieldLabel: string) =>
  z.record(mcpRequestText(`${fieldLabel} name`), z.string().max(MCP_REQUEST_TEXT_MAX_LEN));

const McpServerConfigInputSchema: z.ZodType<McpServerConfigInput, McpServerConfigInput> =
  z.discriminatedUnion("transport", [
    z
      .object({
        transport: z.literal("stdio"),
        command: mcpRequestText("McpServerConfigInput.command"),
        args: z.array(z.string().max(MCP_REQUEST_TEXT_MAX_LEN)).optional(),
        env: mcpTextMap("McpServerConfigInput.env").optional(),
        ...serverSettingsShape,
      })
      .strict(),
    z
      .object({
        transport: z.enum(["http", "sse"]),
        url: mcpServerAddressSchema,
        headers: mcpTextMap("McpServerConfigInput.headers").optional(),
        bearerTokenEnvVar: mcpRequestText("McpServerConfigInput.bearerTokenEnvVar").optional(),
        envHttpHeaders: mcpTextMap("McpServerConfigInput.envHttpHeaders").optional(),
        oauthScopes: z.array(mcpRequestText("McpServerConfigInput.oauthScopes")).optional(),
        oauthResource: mcpRequestText("McpServerConfigInput.oauthResource").optional(),
        ...serverSettingsShape,
      })
      .strict(),
  ]);

// ---- Requests ----

/** Reads the whole inventory; `refresh` asks the daemon to probe before answering. */
export interface McpListRequest {
  refresh?: boolean | undefined;
}
/** Parses an {@link McpListRequest}. */
export const McpListRequestSchema: z.ZodType<McpListRequest, McpListRequest> = z
  .object({ refresh: z.boolean().optional() })
  .strict();

/** Opens the stream of governance events. Opened before the list is read. */
export type McpSubscribeRequest = Record<string, never>;
/** Parses an {@link McpSubscribeRequest}: an empty object. */
export const McpSubscribeRequestSchema: z.ZodType<McpSubscribeRequest, McpSubscribeRequest> = z
  .object({})
  .strict();

/**
 * Adds a binding or changes its declaration, at any scope on either provider. Every scope takes
 * what the person typed, values included, written in that provider's own file format.
 */
export type McpUpsertServerRequest = McpServerBindingRef & {
  clientIdempotencyKey: string;
  config: McpServerConfigInput;
};
/** Parses an {@link McpUpsertServerRequest}. */
export const McpUpsertServerRequestSchema: z.ZodType<
  McpUpsertServerRequest,
  McpUpsertServerRequest
> = bindingAddressed({
  clientIdempotencyKey: z.uuid(),
  config: McpServerConfigInputSchema,
});

/**
 * A keyed command on one binding with nothing else to say: removing it, or
 * starting the daemon's sign-in for it.
 */
export type McpKeyedBindingRequest = McpServerBindingRef & { clientIdempotencyKey: string };
/** Parses an {@link McpKeyedBindingRequest}. */
export const McpKeyedBindingRequestSchema: z.ZodType<
  McpKeyedBindingRequest,
  McpKeyedBindingRequest
> = bindingAddressed({ clientIdempotencyKey: z.uuid() });

/** A tool's name as an override and an event carry it. */
export const McpToolNameSchema: z.ZodString = wireFreeFormString(
  DRIVER_TOOL_NAME_MAX_LEN,
  "McpToolOverride.toolName",
);

/** Parses an {@link McpToolOverride}; an override that sets no facet is refused. */
export const McpToolOverrideSchema: z.ZodType<McpToolOverride, McpToolOverride> = z
  .object({
    toolName: McpToolNameSchema,
    enabled: z.boolean().optional(),
    approvalMode: McpApprovalModeSchema.optional(),
    idempotencyClass: z.enum(["idempotent", "compensable"]).optional(),
  })
  .strict()
  .refine(
    (override) =>
      override.enabled !== undefined ||
      override.approvalMode !== undefined ||
      override.idempotencyClass !== undefined,
    { message: "A tool override sets at least one of enabled, approvalMode or idempotencyClass." },
  );

/** Sets one tool's override on a binding. */
export type McpSetToolOverrideRequest = McpServerBindingRef & {
  clientIdempotencyKey: string;
  override: McpToolOverride;
};
/** Parses an {@link McpSetToolOverrideRequest}. */
export const McpSetToolOverrideRequestSchema: z.ZodType<
  McpSetToolOverrideRequest,
  McpSetToolOverrideRequest
> = bindingAddressed({ clientIdempotencyKey: z.uuid(), override: McpToolOverrideSchema });

/** Clears one tool's override, returning every facet to the server's own value. */
export type McpClearToolOverrideRequest = McpServerBindingRef & {
  clientIdempotencyKey: string;
  toolName: string;
};
/** Parses an {@link McpClearToolOverrideRequest}. */
export const McpClearToolOverrideRequestSchema: z.ZodType<
  McpClearToolOverrideRequest,
  McpClearToolOverrideRequest
> = bindingAddressed({ clientIdempotencyKey: z.uuid(), toolName: McpToolNameSchema });

/**
 * Signs out of one server: the daemon's single sign-in for it, which both
 * providers and every binding naming it share. `serverId` is the server's
 * address, not a scope-qualified binding.
 */
export interface McpOauthLogoutRequest {
  serverId: string;
}
/** Parses an {@link McpOauthLogoutRequest}. */
export const McpOauthLogoutRequestSchema: z.ZodType<McpOauthLogoutRequest, McpOauthLogoutRequest> =
  z.object({ serverId: mcpServerAddressSchema }).strict();

/**
 * Asks the provider to open a binding's connection again. It carries no key: it
 * writes nothing, so there is no receipt to replay. `bindingId` names one live leg;
 * `sessionId` alone names every leg of that session; neither names every live leg.
 */
export type McpReconnectRequest = McpServerBindingRef & {
  sessionId?: SessionId | undefined;
  bindingId?: string | undefined;
};
/** Parses an {@link McpReconnectRequest}. */
export const McpReconnectRequestSchema: z.ZodType<McpReconnectRequest, McpReconnectRequest> =
  bindingAddressed({
    sessionId: SessionIdSchema.optional(),
    bindingId: wireFreeFormString(
      DRIVER_BINDING_ID_MAX_LEN,
      "McpReconnectRequest.bindingId",
    ).optional(),
  });

/**
 * Searches the public MCP Registry for servers to add. The daemon makes the call,
 * only when the person types, and keeps nothing past the page it answers.
 */
export interface McpRegistrySearchRequest {
  query: string;
  cursor?: string | undefined;
}
/** Parses an {@link McpRegistrySearchRequest}. */
export const McpRegistrySearchRequestSchema: z.ZodType<
  McpRegistrySearchRequest,
  McpRegistrySearchRequest
> = z
  .object({
    query: mcpRequestText("McpRegistrySearchRequest.query"),
    cursor: mcpRequestText("McpRegistrySearchRequest.cursor").optional(),
  })
  .strict();

// ---- Replies ----

/** Parses one of the five server statuses. */
export const McpServerStatusSchema: z.ZodType<McpServerStatus> = z.enum(
  MCP_SERVER_STATUS_SEVERITY_ORDER,
);

const McpServerConfigViewSchema: z.ZodType<McpServerConfigView> = z.discriminatedUnion(
  "transport",
  [
    z
      .object({
        transport: z.literal("stdio"),
        command: z.string(),
        args: z.array(z.string()).optional(),
        envVarNames: z.array(z.string()).optional(),
        ...serverSettingsShape,
      })
      .strict(),
    z
      .object({
        transport: z.enum(["http", "sse"]),
        url: z.string(),
        urlQueryParamNames: z.array(z.string()).optional(),
        headerNames: z.array(z.string()).optional(),
        bearerTokenEnvVar: z.string().optional(),
        envHttpHeaders: z.record(z.string(), z.string()).optional(),
        oauthScopes: z.array(z.string()).optional(),
        oauthResource: z.string().optional(),
        ...serverSettingsShape,
      })
      .strict(),
  ],
);

const McpServerLegStatusSchema: z.ZodType<McpServerLegStatus> = z
  .object({
    sessionId: SessionIdSchema,
    bindingId: z.string().min(1),
    status: McpServerStatusSchema,
    observedAt: isoDateTimeSchema.optional(),
  })
  .strict();

const inventoryFactsShape = {
  config: McpServerConfigViewSchema,
  status: McpServerStatusSchema,
  legs: z.array(McpServerLegStatusSchema).optional(),
  observedAt: isoDateTimeSchema.optional(),
  requiredServer: z.boolean().optional(),
  failedReason: z.enum(MCP_SERVER_FAILED_REASON_VALUES).optional(),
};
const storeAnsweredEntryShape = {
  enabled: z.boolean(),
  toolOverrides: z.array(McpToolOverrideSchema),
};
const bindingStoreUnavailableEntryShape = {
  bindingStoreUnavailable: z.literal(true),
  enabled: z.boolean().optional(),
};

/** One binding arm's two inventory arms: the binding store answered, or it did not. */
const inventoryEntryArms = <Binding extends z.ZodRawShape>(binding: Binding) =>
  [
    z.object({ ...binding, ...inventoryFactsShape, ...storeAnsweredEntryShape }).strict(),
    z.object({ ...binding, ...inventoryFactsShape, ...bindingStoreUnavailableEntryShape }).strict(),
  ] as const;

/** Parses an {@link McpServerInventoryEntry}; refuses a failure reason on a non-`failed` server. */
const McpServerInventoryEntrySchema: z.ZodType<McpServerInventoryEntry> = z
  .union([
    ...inventoryEntryArms(userBindingShape),
    ...inventoryEntryArms(projectBindingShape),
    ...inventoryEntryArms(localBindingShape),
  ])
  .refine((entry) => entry.failedReason === undefined || entry.status === "failed", {
    message: "failedReason is carried only on a failed server.",
    path: ["failedReason"],
  });

/** Parses an {@link McpApplicationGrade}. */
export const McpApplicationGradeSchema: z.ZodType<McpApplicationGrade> = z.enum(
  MCP_APPLICATION_GRADE_VALUES,
);

const McpLiveApplicationResultSchema: z.ZodType<McpLiveApplicationResult> = z
  .object({
    sessionId: SessionIdSchema,
    bindingId: z.string().min(1),
    outcome: z.enum(["applied", "failed"]),
    errorCode: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();

/** What `mcp.list` answers with. */
export interface McpListResponse {
  servers: McpServerInventoryEntry[];
}
/** Parses an {@link McpListResponse}. */
export const McpListResponseSchema: z.ZodType<McpListResponse> = z
  .object({ servers: z.array(McpServerInventoryEntrySchema) })
  .strict();

/** What `mcp.get` answers with. */
export interface McpGetResponse {
  server: McpServerInventoryEntry;
}
/** Parses an {@link McpGetResponse}. */
export const McpGetResponseSchema: z.ZodType<McpGetResponse> = z
  .object({ server: McpServerInventoryEntrySchema })
  .strict();

/** Parses an {@link McpMutationResult}. */
export const McpMutationResultSchema: z.ZodType<McpMutationResult> = z
  .object({
    server: McpServerInventoryEntrySchema,
    applied: McpApplicationGradeSchema,
    liveResults: z.array(McpLiveApplicationResultSchema).optional(),
  })
  .strict();

/** Parses an {@link McpRemoveServerResult}. */
export const McpRemoveServerResultSchema: z.ZodType<McpRemoveServerResult> = z
  .object({
    applied: McpApplicationGradeSchema,
    liveResults: z.array(McpLiveApplicationResultSchema).optional(),
  })
  .strict();

/** Parses an {@link McpToolOverrideMutationResult}. */
export const McpToolOverrideMutationResultSchema: z.ZodType<McpToolOverrideMutationResult> = z
  .object({
    server: McpServerInventoryEntrySchema,
    applied: z
      .object({
        enabled: McpApplicationGradeSchema.optional(),
        approvalMode: McpApplicationGradeSchema.optional(),
        idempotencyClass: z.literal("daemon_enforced").optional(),
      })
      .strict(),
  })
  .strict();

/**
 * What starting a sign-in answers with: the sign-in page's address for the client
 * to open. A replayed retry answers without it, because the address is used once
 * and never stored; that caller starts a new sign-in under a new key.
 */
export interface McpOauthLoginResponse {
  authorizationUrl?: string | undefined;
}
/** Parses an {@link McpOauthLoginResponse}. */
export const McpOauthLoginResponseSchema: z.ZodType<McpOauthLoginResponse> = z
  .object({ authorizationUrl: mcpHttpAddressSchema.optional() })
  .strict();

/** What reconnecting answers with: each leg's status after the attempt. */
export interface McpReconnectResponse {
  legs: McpServerLegStatus[];
}
/** Parses an {@link McpReconnectResponse}. */
export const McpReconnectResponseSchema: z.ZodType<McpReconnectResponse> = z
  .object({ legs: z.array(McpServerLegStatusSchema) })
  .strict();

/** A registry server that runs as a package the person's machine installs. */
export interface McpRegistryPackage {
  registryType: string;
  identifier: string;
  runtimeHint?: string | undefined;
  runtimeArguments: string[];
}

/** A registry server reached at an address. */
export interface McpRegistryRemote {
  type: string;
  url: string;
}

/** An environment variable a registry server reads: its name, never a value. */
export interface McpRegistryEnvironmentVariable {
  name: string;
  description?: string | undefined;
  isRequired: boolean;
}

/**
 * One registry search result. Untrusted data from a public registry anyone can
 * publish to: it fills the add form and nothing else, and it never holds an
 * environment variable's value.
 */
export interface McpRegistryServer {
  name: string;
  title?: string | undefined;
  description: string;
  version: string;
  packages: McpRegistryPackage[];
  remotes: McpRegistryRemote[];
  environmentVariables: McpRegistryEnvironmentVariable[];
}

/** One page of registry search results. */
export interface McpRegistrySearchResponse {
  servers: McpRegistryServer[];
  nextCursor?: string | undefined;
}
/** Parses an {@link McpRegistrySearchResponse}. */
export const McpRegistrySearchResponseSchema: z.ZodType<McpRegistrySearchResponse> = z
  .object({
    servers: z.array(
      z
        .object({
          name: z.string().min(1),
          title: z.string().optional(),
          description: z.string(),
          version: z.string(),
          packages: z.array(
            z
              .object({
                registryType: z.string(),
                identifier: z.string().min(1),
                runtimeHint: z.string().optional(),
                runtimeArguments: z.array(z.string()),
              })
              .strict(),
          ),
          remotes: z.array(z.object({ type: z.string(), url: mcpHttpAddressSchema }).strict()),
          environmentVariables: z.array(
            z
              .object({
                name: z.string().min(1),
                description: z.string().optional(),
                isRequired: z.boolean(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
