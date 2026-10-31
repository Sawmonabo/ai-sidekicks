// MCP server governance shapes: what a server binding is, what the daemon reports about it, and
// what a mutation did to the live sessions behind it, plus each `mcp.*` method's request and reply.
// A server's declaration is in `mcp/server-config.ts`, a tool's override and reading in
// `mcp/tool-settings.ts`, the registry search in `mcp/registry-search.ts`, and the method table,
// event payloads and refusal codes in `mcp/governance.ts`.
//
// Every governance mutation carries a `clientIdempotencyKey` that the caller mints: a retry of
// one press must reuse it, and a key minted per call would make every retry a new
// operation. `mcp.reconnect` alone carries none, because it is unreceipted and there is no
// saved result for a key to return.
import { z } from "zod";

import { ProviderNameSchema, type ProviderName } from "../provider/name.js";
import {
  DRIVER_BINDING_ID_MAX_LEN,
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
} from "../provider/driver/length-limits.js";
import { pluginTokenSchema } from "../plugin.js";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { isoDateTimeSchema } from "../internal/wire-scalars.js";
import {
  McpServerConfigInputSchema,
  McpServerConfigViewSchema,
  mcpHttpAddressSchema,
  mcpServerAddressSchema,
  type McpServerConfigInput,
  type McpServerConfigView,
} from "./server-config.js";
import {
  McpToolNameSchema,
  McpToolOverrideFacetSchema,
  McpToolOverrideSchema,
  McpToolReadingSchema,
  type McpToolOverride,
  type McpToolOverrideFacet,
  type McpToolReading,
} from "./tool-settings.js";

/**
 * The five server statuses, most severe first: the daemon's order for folding a server's sessions
 * into one status, so lost observability (`unknown`) outranks a known-healthy state. A client draws
 * the folded status and never applies the order itself.
 */
export const MCP_SERVER_STATUS_SEVERITY_ORDER = [
  "failed",
  "needs-auth",
  "unknown",
  "starting",
  "connected",
] as const;
/** A server's connection state; it says nothing about which of its tools a session can see. */
export type McpServerStatus = (typeof MCP_SERVER_STATUS_SEVERITY_ORDER)[number];

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
/**
 * Every {@link McpApplicationGrade}, in the order above.
 *
 * @consumedBy the daemon's MCP mutation replies, which say when and where a change takes effect
 */
export const MCP_APPLICATION_GRADES: readonly McpApplicationGrade[] = MCP_APPLICATION_GRADE_VALUES;

const MCP_BINDING_SCOPE_VALUES = ["user", "project", "local", "plugin"] as const;

/**
 * Where a server binding applies: `user` in all projects, `project` in one project with its
 * declaration in the repository, `local` in one project with its declaration outside the
 * repository, and `plugin` for a server an installed plugin carries. The first three are writable
 * on both providers; Codex has no per-project layer outside the repository, so the daemon emulates
 * `local` there with a user entry that is off by default and switched on in that project's
 * sessions.
 */
export type McpBindingScope = (typeof MCP_BINDING_SCOPE_VALUES)[number];
/** Parses an {@link McpBindingScope}, as an event that carries no `scopeRef` names it. */
export const McpBindingScopeSchema: z.ZodType<McpBindingScope, McpBindingScope> =
  z.enum(MCP_BINDING_SCOPE_VALUES);

/**
 * A binding in a scope the person writes: its declaration lives in a provider's own config, so
 * it can be added, changed and removed. A union on `scope`, so `user` carries no `scopeRef` and
 * `project` and `local` require one (the project's root folder).
 */
export type McpWritableBindingRef =
  | { provider: ProviderName; scope: "user"; serverName: string }
  | { provider: ProviderName; scope: "project"; scopeRef: string; serverName: string }
  | { provider: ProviderName; scope: "local"; scopeRef: string; serverName: string };

/**
 * The scope-qualified identity of one server binding: a writable binding, or a server an
 * installed plugin carries, its `scopeRef` the plugin's name. A plugin's server is switched on
 * and off and takes tool overrides, but its declaration changes only with the plugin. Same-named
 * servers in two scopes stay two rows.
 */
export type McpServerBindingRef =
  | McpWritableBindingRef
  | { provider: ProviderName; scope: "plugin"; scopeRef: string; serverName: string };

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
const pluginBindingShape = {
  provider: ProviderNameSchema,
  scope: z.literal("plugin"),
  scopeRef: pluginTokenSchema("McpServerBindingRef.scopeRef"),
  serverName: McpServerNameSchema,
};

// The writable arms with `extra` members added to each, every arm strict.
const writableBindingArms = <Extra extends z.ZodRawShape>(extra: Extra) =>
  [
    z.object({ ...userBindingShape, ...extra }).strict(),
    z.object({ ...projectBindingShape, ...extra }).strict(),
    z.object({ ...localBindingShape, ...extra }).strict(),
  ] as const;

/**
 * The binding union with `extra` members added to each arm, every arm strict. A
 * request addressed to a binding is built here so the scope rules hold on it too.
 */
const bindingAddressed = <Extra extends z.ZodRawShape>(extra: Extra) =>
  z.discriminatedUnion("scope", [
    ...writableBindingArms(extra),
    z.object({ ...pluginBindingShape, ...extra }).strict(),
  ]);

/**
 * {@link bindingAddressed} over the writable scopes only, for a request that writes a
 * declaration: a plugin's server is refused here, because its declaration is the plugin's.
 */
const writableBindingAddressed = <Extra extends z.ZodRawShape>(extra: Extra) =>
  z.discriminatedUnion("scope", writableBindingArms(extra));

/** Parses an {@link McpServerBindingRef}; a shape outside the four arms is refused. */
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
 * What an inventory entry carries whether or not the binding store answered. `status` is the
 * daemon's aggregate over `legs`.
 */
interface McpServerInventoryFacts {
  config: McpServerConfigView;
  status: McpServerStatus;
  legs?: McpServerLegStatus[] | undefined;
  observedAt?: string | undefined;
  /**
   * The machine probe's newest failure text, sanitized and at most `ERROR_MESSAGE_MAX_LEN` code
   * points; present only while the probe's reading decides a `failed` status.
   */
  probeFailureReason?: string | undefined;
  requiredServer?: boolean | undefined;
  /**
   * The project roots in which another binding of this provider and server name takes this one's
   * place, by the provider's order: a project's `local` binding over its `project` one, either
   * over the `user` one. The daemon sends a project's sessions only the binding in force there, so
   * the page names where this one goes unused; absent where it is used wherever it applies.
   */
  supersededIn?: string[] | undefined;
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
        tools: McpToolReading[];
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
 * Adds a binding or changes its declaration, at any writable scope on either provider. Every
 * scope takes what the person typed, values included, written in that provider's own file format.
 */
export type McpUpsertServerRequest = McpWritableBindingRef & {
  clientIdempotencyKey: string;
  config: McpServerConfigInput;
};
/** Parses an {@link McpUpsertServerRequest}; a plugin's server is refused. */
export const McpUpsertServerRequestSchema: z.ZodType<
  McpUpsertServerRequest,
  McpUpsertServerRequest
> = writableBindingAddressed({
  clientIdempotencyKey: z.uuid(),
  config: McpServerConfigInputSchema,
});

/** Removes a binding from its provider's config. A plugin's server leaves only with its plugin. */
export type McpRemoveServerRequest = McpWritableBindingRef & { clientIdempotencyKey: string };
/** Parses an {@link McpRemoveServerRequest}; a plugin's server is refused. */
export const McpRemoveServerRequestSchema: z.ZodType<
  McpRemoveServerRequest,
  McpRemoveServerRequest
> = writableBindingAddressed({ clientIdempotencyKey: z.uuid() });

/** A keyed command on one binding with nothing else to say: starting the daemon's sign-in. */
export type McpKeyedBindingRequest = McpServerBindingRef & { clientIdempotencyKey: string };
/** Parses an {@link McpKeyedBindingRequest}. */
export const McpKeyedBindingRequestSchema: z.ZodType<
  McpKeyedBindingRequest,
  McpKeyedBindingRequest
> = bindingAddressed({ clientIdempotencyKey: z.uuid() });

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

/**
 * Clears one facet of one tool's override, returning that facet to the server's own value and
 * leaving the tool's other facets as they stand.
 */
export type McpClearToolOverrideRequest = McpServerBindingRef & {
  clientIdempotencyKey: string;
  toolName: string;
  facet: McpToolOverrideFacet;
};
/** Parses an {@link McpClearToolOverrideRequest}; a request naming no facet is refused. */
export const McpClearToolOverrideRequestSchema: z.ZodType<
  McpClearToolOverrideRequest,
  McpClearToolOverrideRequest
> = bindingAddressed({
  clientIdempotencyKey: z.uuid(),
  toolName: McpToolNameSchema,
  facet: McpToolOverrideFacetSchema,
});

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
 * writes nothing, so there is no receipt to return. `bindingId` names one live leg;
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

// ---- Replies ----

/** Parses one of the five server statuses. */
export const McpServerStatusSchema: z.ZodType<McpServerStatus> = z.enum(
  MCP_SERVER_STATUS_SEVERITY_ORDER,
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
  supersededIn: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)).min(1).optional(),
  failedReason: z.enum(MCP_SERVER_FAILED_REASON_VALUES).optional(),
};
const storeAnsweredEntryShape = {
  enabled: z.boolean(),
  tools: z.array(McpToolReadingSchema),
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
    ...inventoryEntryArms(pluginBindingShape),
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
 * to open. A retry answered with the saved result comes without it, because the address is
 * used once and never stored; that caller starts a new sign-in under a new key.
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
