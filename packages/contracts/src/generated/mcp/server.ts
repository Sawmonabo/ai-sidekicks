// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// MCP server bindings: what a binding is, what the daemon reports about it, what a mutation did to the live sessions behind it, and each `mcp.*` method's request and reply.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { PlacedPath, WslPlace } from "../place.js";
import type { ProviderAccountId } from "../provider/account/record.js";
import type { RuntimeBindingId } from "../provider/driver/runtime-binding.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "../session/id.js";

/**
 * The five statuses, most severe first: the daemon's order for folding a server's sessions
 * into one status, so lost observability (`unknown`) outranks a known-healthy state. A client
 * draws the folded status and never applies the order itself.
 */
export const MCP_SERVER_STATUS_SEVERITY_ORDER = [
  "failed",
  "needsAuth",
  "unknown",
  "starting",
  "connected",
] as const;

/** Every application grade, in declaration order. */
export const MCP_APPLICATION_GRADES = [
  "liveReconcile",
  "userConfigWrite",
  "nextRun",
  "daemonEnforced",
] as const;

/** Every approval mode, in the order the per-tool control offers them. */
export const MCP_APPROVAL_MODES = ["auto", "prompt", "writes", "approve"] as const;

/**
 * The longest command, argument, name, value, address or search text an `mcp.*` request
 * carries.
 */
export const MCP_REQUEST_TEXT_MAX_LEN = 8192 as const;

/** Every tool override facet, in declaration order. */
export const MCP_TOOL_OVERRIDE_FACETS = ["enabled", "approvalMode", "idempotencyClass"] as const;

/**
 * A server's connection state; it says nothing about which of its tools a session can see.
 */
export type McpServerStatus = "failed" | "needsAuth" | "unknown" | "starting" | "connected";
/**
 * When and where a mutation took effect: in the live sessions now, in the provider's config store
 * for later runs, in the next run's composed config, or at the daemon's decision layer at once.
 * Always stated, never silent.
 */
export type McpApplicationGrade =
  | "liveReconcile"
  | "userConfigWrite"
  | "nextRun"
  | "daemonEnforced";
/**
 * The normalized approval vocabulary a tool override may pin.
 */
export type McpApprovalMode = "auto" | "prompt" | "writes" | "approve";
/**
 * Where a server binding applies: `user` in all projects, `project` in one project with its
 * declaration in the repository, `local` in one project with its declaration outside the
 * repository, `plugin` for a server an installed plugin carries, and, on a provider that brings
 * servers itself, `connector` for a connector of its account and `managed` for a server an
 * administrator layer declares (an organization's managed settings, or a provider's system-wide
 * or managed-device configuration). The first three are writable on every provider; where a
 * provider has no per-project layer outside the repository, the daemon emulates `local` with a
 * user entry that is off by default and switched on in that project's sessions. The last two are
 * read-only.
 */
export type McpBindingScope = "user" | "project" | "local" | "plugin" | "connector" | "managed";
/**
 * The id of a server binding, the same on its `mcp.server.list` entry and on every status
 * notice about it and across the daemon's runs: a page places a notice on its row by it. It
 * holds no path, and is opaque to every client.
 */
export type McpServerBindingId = string & { readonly __brand: "McpServerBindingId" };
/**
 * A binding in a scope the person writes: its declaration lives in a provider's own config,
 * so it can be added, changed and removed. `user` carries no `scopeRef`; `project` and `local`
 * name the project's root folder and the distribution it is in.
 */
export type McpWritableBindingRef =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
    };
/**
 * The scope-qualified identity of one server binding: a writable binding, a server an
 * installed plugin carries, or one the provider brings itself (a connector of its account or
 * an organization's server). Same-named servers in two scopes stay two rows.
 */
export type McpServerBindingRef =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
    };
/**
 * The live notice `mcp.subscribe` sends after each edit to a binding, from this machine or a
 * linked device: an add, a change, a switch on or off, a tool override or a removal. A page
 * showing the binding reads it again with `mcp.server.read`; a removed one answers
 * `mcp.server.notFound`. Sent live only, written to no session's log.
 */
export type McpServerConfigChangedNotice =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * Always `mcp.server.config.changed`.
       */
      type: "mcp.server.config.changed";
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * Always `mcp.server.config.changed`.
       */
      type: "mcp.server.config.changed";
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * Always `mcp.server.config.changed`.
       */
      type: "mcp.server.config.changed";
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * Always `mcp.server.config.changed`.
       */
      type: "mcp.server.config.changed";
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * Always `mcp.server.config.changed`.
       */
      type: "mcp.server.config.changed";
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * Always `mcp.server.config.changed`.
       */
      type: "mcp.server.config.changed";
    };
/**
 * A server's declaration as the person submits it, by transport. An absent member keeps the
 * provider's value and a `null` one removes it; a `null` for a member the provider does not
 * read is refused, as a value is. Environment and header values are write-only, handed to the
 * provider's write path and never served back. The daemon refuses a transport or member the
 * binding's provider does not declare, the declared set `provider.list` sends.
 */
export type McpServerConfigInput =
  | {
      transport: "stdio";
      /**
       * The program.
       */
      command: string;
      /**
       * Its arguments. Absent keeps the provider's value, and `null` removes the member from
       * the provider's entry.
       */
      args?: string[] | null;
      /**
       * Its environment, values included. Absent keeps the provider's value, and `null`
       * removes the member from the provider's entry.
       */
      env?: {
        [k: string]: string | undefined;
      } | null;
      /**
       * The names of the variables it inherits from the environment the provider starts in.
       * Absent keeps the provider's value, and `null` removes the member from the provider's
       * entry.
       */
      envVars?: string[] | null;
      /**
       * Whether the server is on; unset keeps the provider's value.
       */
      enabled?: boolean;
      /**
       * Whether a session refuses to start without the server. Unset keeps the provider's
       * value.
       */
      required?: boolean;
      /**
       * How long the server may take to start, in seconds. Absent keeps the provider's
       * value, and `null` removes the member from the provider's entry.
       */
      startupTimeoutSec?: number | null;
      /**
       * How long one tool call may take, in seconds. Absent keeps the provider's value, and
       * `null` removes the member from the provider's entry.
       */
      toolTimeoutSec?: number | null;
    }
  | {
      transport: "http";
      /**
       * Its address.
       */
      url: string;
      /**
       * Headers sent with each request, values included. Absent keeps the provider's value,
       * and `null` removes the member from the provider's entry.
       */
      headers?: {
        [k: string]: string | undefined;
      } | null;
      /**
       * The environment variable holding a bearer token. Absent keeps the provider's value,
       * and `null` removes the member from the provider's entry.
       */
      bearerTokenEnvVar?: string | null;
      /**
       * A header name mapped to the name of the environment variable holding its value.
       * Absent keeps the provider's value, and `null` removes the member from the provider's
       * entry.
       */
      envHttpHeaders?: {
        [k: string]: string | undefined;
      } | null;
      /**
       * The scopes a sign-in asks for. Absent keeps the provider's value, and `null` removes
       * the member from the provider's entry.
       */
      oauthScopes?: string[] | null;
      /**
       * The resource a sign-in names. Absent keeps the provider's value, and `null` removes
       * the member from the provider's entry.
       */
      oauthResource?: string | null;
      /**
       * Whether the server is on; unset keeps the provider's value.
       */
      enabled?: boolean;
      /**
       * Whether a session refuses to start without the server. Unset keeps the provider's
       * value.
       */
      required?: boolean;
      /**
       * How long the server may take to start, in seconds. Absent keeps the provider's
       * value, and `null` removes the member from the provider's entry.
       */
      startupTimeoutSec?: number | null;
      /**
       * How long one tool call may take, in seconds. Absent keeps the provider's value, and
       * `null` removes the member from the provider's entry.
       */
      toolTimeoutSec?: number | null;
    }
  | {
      transport: "sse";
      /**
       * Its address.
       */
      url: string;
      /**
       * Headers sent with each request, values included. Absent keeps the provider's value,
       * and `null` removes the member from the provider's entry.
       */
      headers?: {
        [k: string]: string | undefined;
      } | null;
      /**
       * The environment variable holding a bearer token. Absent keeps the provider's value,
       * and `null` removes the member from the provider's entry.
       */
      bearerTokenEnvVar?: string | null;
      /**
       * A header name mapped to the name of the environment variable holding its value.
       * Absent keeps the provider's value, and `null` removes the member from the provider's
       * entry.
       */
      envHttpHeaders?: {
        [k: string]: string | undefined;
      } | null;
      /**
       * The scopes a sign-in asks for. Absent keeps the provider's value, and `null` removes
       * the member from the provider's entry.
       */
      oauthScopes?: string[] | null;
      /**
       * The resource a sign-in names. Absent keeps the provider's value, and `null` removes
       * the member from the provider's entry.
       */
      oauthResource?: string | null;
      /**
       * Whether the server is on; unset keeps the provider's value.
       */
      enabled?: boolean;
      /**
       * Whether a session refuses to start without the server. Unset keeps the provider's
       * value.
       */
      required?: boolean;
      /**
       * How long the server may take to start, in seconds. Absent keeps the provider's
       * value, and `null` removes the member from the provider's entry.
       */
      startupTimeoutSec?: number | null;
      /**
       * How long one tool call may take, in seconds. Absent keeps the provider's value, and
       * `null` removes the member from the provider's entry.
       */
      toolTimeoutSec?: number | null;
    };
/**
 * The redacted read-back of a binding's declaration, by transport: environment, header and
 * query names only. The daemon strips an address's query and any user name or password from
 * it, and serves an organization's server with its address's host only; a client shows the
 * address verbatim.
 */
export type McpServerConfigView =
  | {
      transport: "stdio";
      /**
       * The program.
       */
      command: string;
      /**
       * Its arguments.
       */
      args?: string[];
      /**
       * The names of the environment variables it is given.
       */
      envVarNames?: string[];
      /**
       * Whether the server is on; unset keeps the provider's value.
       */
      enabled?: boolean;
      /**
       * Whether a session refuses to start without the server. Unset keeps the provider's
       * value.
       */
      required?: boolean;
      /**
       * How long the server may take to start, in seconds.
       */
      startupTimeoutSec?: number;
      /**
       * How long one tool call may take, in seconds.
       */
      toolTimeoutSec?: number;
    }
  | {
      transport: "http";
      /**
       * Its address, stripped.
       */
      url: string;
      /**
       * The names of the query parameters stripped from the address.
       */
      urlQueryParamNames?: string[];
      /**
       * The names of the headers sent with each request.
       */
      headerNames?: string[];
      /**
       * The environment variable holding a bearer token.
       */
      bearerTokenEnvVar?: string;
      /**
       * A header name mapped to the name of the environment variable holding its value;
       * names only, so it is served back.
       */
      envHttpHeaders?: {
        [k: string]: string | undefined;
      };
      /**
       * The scopes a sign-in asks for.
       */
      oauthScopes?: string[];
      /**
       * The resource a sign-in names.
       */
      oauthResource?: string;
      /**
       * Whether the server is on; unset keeps the provider's value.
       */
      enabled?: boolean;
      /**
       * Whether a session refuses to start without the server. Unset keeps the provider's
       * value.
       */
      required?: boolean;
      /**
       * How long the server may take to start, in seconds.
       */
      startupTimeoutSec?: number;
      /**
       * How long one tool call may take, in seconds.
       */
      toolTimeoutSec?: number;
    }
  | {
      transport: "sse";
      /**
       * Its address, stripped.
       */
      url: string;
      /**
       * The names of the query parameters stripped from the address.
       */
      urlQueryParamNames?: string[];
      /**
       * The names of the headers sent with each request.
       */
      headerNames?: string[];
      /**
       * The environment variable holding a bearer token.
       */
      bearerTokenEnvVar?: string;
      /**
       * A header name mapped to the name of the environment variable holding its value;
       * names only, so it is served back.
       */
      envHttpHeaders?: {
        [k: string]: string | undefined;
      };
      /**
       * The scopes a sign-in asks for.
       */
      oauthScopes?: string[];
      /**
       * The resource a sign-in names.
       */
      oauthResource?: string;
      /**
       * Whether the server is on; unset keeps the provider's value.
       */
      enabled?: boolean;
      /**
       * Whether a session refuses to start without the server. Unset keeps the provider's
       * value.
       */
      required?: boolean;
      /**
       * How long the server may take to start, in seconds.
       */
      startupTimeoutSec?: number;
      /**
       * How long one tool call may take, in seconds.
       */
      toolTimeoutSec?: number;
    }
  | {
      transport: "ws";
      /**
       * Its address, stripped.
       */
      url: string;
      /**
       * The names of the query parameters stripped from the address.
       */
      urlQueryParamNames?: string[];
      /**
       * The names of the headers sent when the connection opens.
       */
      headerNames?: string[];
    };
/**
 * How a server is reached: a program the provider starts, streamable HTTP or server-sent events.
 */
export type McpTransport = "stdio" | "http" | "sse";
/**
 * A member of a submitted declaration that a provider reads only if its driver declares it.
 */
export type McpDeclaredConfigMember =
  | "envVars"
  | "required"
  | "startupTimeoutSec"
  | "toolTimeoutSec"
  | "bearerTokenEnvVar"
  | "envHttpHeaders"
  | "oauthScopes"
  | "oauthResource";
/**
 * Why a session saw a server fail, where the daemon knows a reason the person can act on.
 */
export type McpServerFailedReason = "commandNotRunnable";
/**
 * Where a provider's own configuration takes a declaration's place or switches it off: a project
 * root or settings file at a path, or an administrator's layer the provider reads from no file.
 */
export type McpOverrideOrigin = PlacedPath | McpManagedLayer;
/**
 * Where an administrator's layer that no file holds comes from.
 */
export type McpManagedLayerKind = "deviceManagement" | "organizationCloud";
/**
 * The interrupted-call classes a person can assign to a tool. `manualReconcileOnly` is the floor
 * a tool reads with no assignment, so it is cleared to, never set.
 */
export type McpAssignableIdempotencyClass = "idempotent" | "compensable";
/**
 * One tool's override as `mcp.toolOverride.update` sets it, by facet: at least one facet is
 * present, and an absent facet is left as it stands. What a tool reads in force is its
 * [`McpToolReading`].
 */
export type McpToolOverride = (
  | {
      enabled: unknown;
    }
  | {
      approvalMode: unknown;
    }
  | {
      idempotencyClass: unknown;
    }
) & {
  /**
   * The tool.
   */
  toolName: string;
  /**
   * Whether the tool is on.
   */
  enabled?: boolean;
  /**
   * The approval mode pinned on it.
   */
  approvalMode?: McpApprovalMode;
  /**
   * The interrupted-call class assigned to it.
   */
  idempotencyClass?: McpAssignableIdempotencyClass;
};
/**
 * One facet of a tool override, as `mcp.toolOverride.clear` names the one it clears.
 */
export type McpToolOverrideFacet = "enabled" | "approvalMode" | "idempotencyClass";
/**
 * An inventory row whose binding store answered.
 */
export type McpAnsweredInventoryEntry =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Never present: the store answered.
       */
      bindingStoreUnavailable?: never;
      /**
       * Whether the binding is on.
       */
      enabled: boolean;
      /**
       * Its server's tools.
       */
      tools: McpToolReading[];
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Never present: the store answered.
       */
      bindingStoreUnavailable?: never;
      /**
       * Whether the binding is on.
       */
      enabled: boolean;
      /**
       * Its server's tools.
       */
      tools: McpToolReading[];
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Never present: the store answered.
       */
      bindingStoreUnavailable?: never;
      /**
       * Whether the binding is on.
       */
      enabled: boolean;
      /**
       * Its server's tools.
       */
      tools: McpToolReading[];
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Never present: the store answered.
       */
      bindingStoreUnavailable?: never;
      /**
       * Whether the binding is on.
       */
      enabled: boolean;
      /**
       * Its server's tools.
       */
      tools: McpToolReading[];
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Never present: the store answered.
       */
      bindingStoreUnavailable?: never;
      /**
       * Whether the binding is on.
       */
      enabled: boolean;
      /**
       * Its server's tools.
       */
      tools: McpToolReading[];
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Never present: the store answered.
       */
      bindingStoreUnavailable?: never;
      /**
       * Whether the binding is on.
       */
      enabled: boolean;
      /**
       * Its server's tools.
       */
      tools: McpToolReading[];
    };
/**
 * An inventory row while the binding store is unavailable: the members that need the store
 * are absent, not `false`, `unknown` or an empty list, so no made-up verdict exists. A
 * binding whose switch the daemon keeps in the store leaves `enabled` out.
 */
export type McpStoreUnavailableInventoryEntry =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Always `true`.
       */
      bindingStoreUnavailable: true;
      /**
       * Whether the binding is on, as the provider's own config says; absent where the switch
       * lives in the store.
       */
      enabled?: boolean;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Always `true`.
       */
      bindingStoreUnavailable: true;
      /**
       * Whether the binding is on, as the provider's own config says; absent where the switch
       * lives in the store.
       */
      enabled?: boolean;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Always `true`.
       */
      bindingStoreUnavailable: true;
      /**
       * Whether the binding is on, as the provider's own config says; absent where the switch
       * lives in the store.
       */
      enabled?: boolean;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Always `true`.
       */
      bindingStoreUnavailable: true;
      /**
       * Whether the binding is on, as the provider's own config says; absent where the switch
       * lives in the store.
       */
      enabled?: boolean;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Always `true`.
       */
      bindingStoreUnavailable: true;
      /**
       * Whether the binding is on, as the provider's own config says; absent where the switch
       * lives in the store.
       */
      enabled?: boolean;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, which places a status notice on this row.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The redacted declaration.
       */
      config: McpServerConfigView;
      /**
       * The status folded over the legs.
       */
      status: McpServerStatus;
      /**
       * Each live session's observation.
       */
      legs?: McpServerLegStatus[];
      /**
       * When the status was last observed.
       */
      observedAt?: WireInstant;
      /**
       * Why the machine probe last read the server failed, in the provider's words or
       * the daemon's line where the provider gave none: present only while the probe's
       * reading decides a `failed` status, with no credential, address query or file
       * path in it.
       */
      probeFailureReason?: string;
      /**
       * Where another declaration of this provider takes this one's place, by the
       * provider's order: a project root, with the distribution it is in, where a
       * project's `local` binding wins over its `project` one, either over the `user`
       * one, matched by server name, or, on a provider that matches that way, a plugin's
       * server or a connector that points at the same address or command; or the
       * settings file, the person's or a project's, or the administrator's layer written
       * in no file, whose entry overrides a lower layer's server field by field. Absent
       * where it is used wherever it applies.
       *
       * @minItems 1
       */
      supersededIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Where the server is switched off: the project roots, each with its
       * distribution, where the provider's own per-project list or, on a connector or an
       * organization's server, the daemon's per-project switch keeps it out of those
       * projects' sessions; or the settings file, or the administrator's layer written
       * in no file, whose entry switches it off. Absent where nothing switched it off,
       * and on a connector or an organization's server while the binding store, which
       * keeps its switch, is unavailable.
       *
       * @minItems 1
       */
      disabledIn?: [McpOverrideOrigin, ...McpOverrideOrigin[]];
      /**
       * Whether the account's organization manages the connector's sign-in, as the
       * provider's own connector list reads it. Present only on a connector whose list
       * was read; absent on every other row and where the list could not be read, which
       * a client renders as unknown, never as not managed.
       */
      organizationManaged?: boolean;
      /**
       * Always `true`.
       */
      bindingStoreUnavailable: true;
      /**
       * Whether the binding is on, as the provider's own config says; absent where the switch
       * lives in the store.
       */
      enabled?: boolean;
    };
/**
 * One inventory row: the binding and what is known about it. A client renders an absent member
 * as unknown.
 */
export type McpServerInventoryEntry = McpAnsweredInventoryEntry | McpStoreUnavailableInventoryEntry;
/**
 * Adds a binding or changes its declaration, at any writable scope on any provider. Every
 * scope takes what the person typed, values included, written in that provider's own file
 * format; a plugin's, connector's or organization's server is refused, and so is a transport
 * or member the binding's provider does not declare.
 */
export type McpServerUpsertRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The declaration.
       */
      config: McpServerConfigInput;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The declaration.
       */
      config: McpServerConfigInput;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The declaration.
       */
      config: McpServerConfigInput;
    };
/**
 * How a mutation went on one live session.
 */
export type McpLiveApplicationOutcome = "applied" | "failed";
/**
 * Removes a binding from its provider's config. A plugin's server leaves only with its
 * plugin, and a connector or an organization's server only with the provider's own account or
 * settings, so each is refused.
 */
export type McpServerDeleteRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    };
/**
 * Turns one binding on or off. A connector or an organization's server is switched for one
 * project, `projectRoot`, by the daemon's own switch, never in the provider's config; every
 * other binding is switched where it applies and takes no `projectRoot`.
 */
export type McpServerEnabledUpdateRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * On or off.
       */
      enabled: boolean;
      /**
       * Never present: the binding is switched where it applies.
       */
      projectRoot?: never;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * On or off.
       */
      enabled: boolean;
      /**
       * Never present: the binding is switched where it applies.
       */
      projectRoot?: never;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * On or off.
       */
      enabled: boolean;
      /**
       * Never present: the binding is switched where it applies.
       */
      projectRoot?: never;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * On or off.
       */
      enabled: boolean;
      /**
       * Never present: the binding is switched where it applies.
       */
      projectRoot?: never;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * On or off.
       */
      enabled: boolean;
      /**
       * The project the switch applies in.
       */
      projectRoot: string;
      /**
       * The distribution the project's root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * On or off.
       */
      enabled: boolean;
      /**
       * The project the switch applies in.
       */
      projectRoot: string;
      /**
       * The distribution the project's root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
    };
/**
 * Sets one tool's override on a binding.
 */
export type McpToolOverrideUpdateRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The override.
       */
      override: McpToolOverride;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The override.
       */
      override: McpToolOverride;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The override.
       */
      override: McpToolOverride;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The override.
       */
      override: McpToolOverride;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The override.
       */
      override: McpToolOverride;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The override.
       */
      override: McpToolOverride;
    };
/**
 * Clears one facet of one tool's override, returning that facet to the server's own value
 * and leaving the tool's other facets as they stand.
 */
export type McpToolOverrideClearRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The tool.
       */
      toolName: string;
      /**
       * The facet it clears.
       */
      facet: McpToolOverrideFacet;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The tool.
       */
      toolName: string;
      /**
       * The facet it clears.
       */
      facet: McpToolOverrideFacet;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The tool.
       */
      toolName: string;
      /**
       * The facet it clears.
       */
      facet: McpToolOverrideFacet;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The tool.
       */
      toolName: string;
      /**
       * The facet it clears.
       */
      facet: McpToolOverrideFacet;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The tool.
       */
      toolName: string;
      /**
       * The facet it clears.
       */
      facet: McpToolOverrideFacet;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
      /**
       * The tool.
       */
      toolName: string;
      /**
       * The facet it clears.
       */
      facet: McpToolOverrideFacet;
    };
/**
 * A keyed command on one binding with nothing else to say: starting the daemon's sign-in.
 */
export type McpServerSignInRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    };
/**
 * Signs out of the server at the address the binding's entry declares: the one sign-in every
 * binding at that address shares.
 */
export type McpServerSignOutRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The press's key; a retry reuses it.
       */
      clientIdempotencyKey: string;
    };
/**
 * Asks the provider to open a binding's connection again. It carries no key: it writes
 * nothing, so there is no receipt to return. `bindingId` names one live leg; `sessionId`
 * alone names every leg of that session; neither names every live leg.
 */
export type McpServerReconnectRequest =
  | {
      scope: "user";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The session whose legs to reconnect.
       */
      sessionId?: SessionId;
      /**
       * The one live leg to reconnect.
       */
      bindingId?: RuntimeBindingId;
    }
  | {
      scope: "project";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The session whose legs to reconnect.
       */
      sessionId?: SessionId;
      /**
       * The one live leg to reconnect.
       */
      bindingId?: RuntimeBindingId;
    }
  | {
      scope: "local";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The project's root folder.
       */
      scopeRef: string;
      /**
       * The distribution the root is in, in Linux form; absent elsewhere.
       */
      place?: WslPlace;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The session whose legs to reconnect.
       */
      sessionId?: SessionId;
      /**
       * The one live leg to reconnect.
       */
      bindingId?: RuntimeBindingId;
    }
  | {
      scope: "plugin";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The plugin's name.
       */
      scopeRef: string;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The session whose legs to reconnect.
       */
      sessionId?: SessionId;
      /**
       * The one live leg to reconnect.
       */
      bindingId?: RuntimeBindingId;
    }
  | {
      scope: "connector";
      /**
       * The provider, one whose accounts bring connectors.
       */
      provider: ProviderId;
      /**
       * The provider account the connector belongs to.
       */
      scopeRef: ProviderAccountId;
      /**
       * The name the provider reports for it.
       */
      serverName: string;
      /**
       * The session whose legs to reconnect.
       */
      sessionId?: SessionId;
      /**
       * The one live leg to reconnect.
       */
      bindingId?: RuntimeBindingId;
    }
  | {
      scope: "managed";
      /**
       * The provider, one that reads an organization's managed servers.
       */
      provider: ProviderId;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The session whose legs to reconnect.
       */
      sessionId?: SessionId;
      /**
       * The one live leg to reconnect.
       */
      bindingId?: RuntimeBindingId;
    };

/**
 * What a provider's driver declares about the servers it takes: the transports it reaches them
 * over and the members it reads beyond the ones every provider reads. The desktop's form offers
 * only these, and the daemon refuses any other.
 */
export interface ProviderMcpDeclaration {
  /**
   * The transports, at least one.
   *
   * @minItems 1
   */
  transports: [McpTransport, ...McpTransport[]];
  /**
   * The members it reads beyond the shared ones; may be empty.
   */
  configMembers: McpDeclaredConfigMember[];
}
/**
 * One live session's observation of one binding, kept per session because two sessions'
 * connections to one binding can disagree, and one verdict would hide a partial outage.
 */
export interface McpServerLegStatus {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The runtime binding the observation came from.
   */
  bindingId: RuntimeBindingId;
  /**
   * What the session saw.
   */
  status: McpServerStatus;
  /**
   * When it saw it.
   */
  observedAt?: WireInstant;
  /**
   * Why the session saw it fail, where the daemon knows; only on a failed leg.
   */
  failedReason?: McpServerFailedReason;
}
/**
 * An administrator's layer of a provider's configuration that no file on the computer holds.
 */
export interface McpManagedLayer {
  /**
   * Where the layer comes from.
   */
  managedLayer: McpManagedLayerKind;
}
/**
 * One tool a binding's server offers, each setting in force and where it came from. The daemon
 * resolves each from the server's own declaration and the person's override, so a client draws
 * them and works none out: an unset approval mode reads the provider's default in the normalized
 * vocabulary, and an unset interrupted-call class reads `manualReconcileOnly`.
 */
export interface McpToolReading {
  /**
   * The tool.
   */
  toolName: string;
  /**
   * Whether it is on.
   */
  enabled:
    | {
        source: "server";
        /**
         * The value.
         */
        value: boolean;
      }
    | {
        source: "override";
        /**
         * The value.
         */
        value: boolean;
        /**
         * The server's own value, which clearing the override returns to.
         */
        serverValue: boolean;
      };
  /**
   * Its approval mode.
   */
  approvalMode:
    | {
        source: "server";
        /**
         * The value.
         */
        value: McpApprovalMode;
      }
    | {
        source: "override";
        /**
         * The value.
         */
        value: McpApprovalMode;
        /**
         * The server's own value, which clearing the override returns to.
         */
        serverValue: McpApprovalMode;
      };
  /**
   * Its interrupted-call class.
   */
  idempotencyClass:
    | {
        source: "server";
        /**
         * The value.
         */
        value: "manualReconcileOnly";
      }
    | {
        source: "override";
        /**
         * The value.
         */
        value: McpAssignableIdempotencyClass;
        /**
         * The server's own value, which clearing the override returns to.
         */
        serverValue: "manualReconcileOnly";
      };
}
/**
 * Reads the whole inventory; `refresh` asks the daemon to probe before answering.
 */
export interface McpServerListRequest {
  /**
   * Whether to probe first.
   */
  refresh?: boolean;
}
/**
 * A provider whose MCP servers could not be read, with why.
 */
export interface McpProviderReadFailure {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * Why its read failed, with no credential, address query or file path in it.
   */
  cause: string;
}
/**
 * What `mcp.server.list` answers with: the bindings of every provider whose read answered, and
 * each provider whose read failed.
 */
export interface McpServerListResponse {
  /**
   * Every binding of the providers that answered.
   */
  servers: McpServerInventoryEntry[];
  /**
   * One entry per provider whose read failed, whose bindings `servers` leaves out; empty when
   * every provider answered.
   */
  failedProviders: McpProviderReadFailure[];
}
/**
 * What `mcp.server.read` answers with.
 */
export interface McpServerReadResponse {
  /**
   * The binding.
   */
  server: McpServerInventoryEntry;
}
/**
 * Searches the public MCP Registry for servers to add. The daemon makes the call, only when the
 * person types, and keeps nothing past the page it answers.
 */
export interface McpRegistrySearchRequest {
  /**
   * What the person typed.
   */
  query: string;
  /**
   * The page to read on from.
   */
  cursor?: string;
}
/**
 * What a registry server asks the person to fill (an environment variable, a header or a
 * placeholder in its address): its name and how to ask, never a value or a default.
 */
export interface McpRegistryInput {
  /**
   * The input's name.
   */
  name: string;
  /**
   * What it is for.
   */
  description?: string;
  /**
   * Whether the server needs it.
   */
  isRequired: boolean;
  /**
   * Whether it is a secret, which the form masks.
   */
  isSecret: boolean;
}
/**
 * A registry server that runs as a package the person's machine installs.
 */
export interface McpRegistryPackage {
  /**
   * The package registry, such as `npm`.
   */
  registryType: string;
  /**
   * The package's name there.
   */
  identifier: string;
  /**
   * The package's version, where the registry names one.
   */
  version?: string;
  /**
   * The runtime that runs it, such as `npx`.
   */
  runtimeHint?: string;
  /**
   * The runtime's arguments, each as the registry describes it (its kind, name, value and
   * whether it is required); a secret argument, or a secret variable of one, carries no `value`
   * or `default`.
   */
  runtimeArguments?: {
    [k: string]: unknown | undefined;
  }[];
  /**
   * The package's own arguments, each as the registry describes it; a secret argument, or a
   * secret variable of one, carries no `value` or `default`.
   */
  packageArguments?: {
    [k: string]: unknown | undefined;
  }[];
}
/**
 * A registry server reached at an address.
 */
export interface McpRegistryRemote {
  /**
   * How it is reached, as the registry names it.
   */
  type: string;
  /**
   * The address as the registry writes it: an `http:` or `https:` address, or a template whose
   * `{name}` placeholders its `variables` fill. The form asks for each variable and checks the
   * filled address, which the upsert reads as a server address.
   */
  url: string;
  /**
   * The placeholders in its address the person fills.
   */
  variables?: McpRegistryInput[];
  /**
   * The headers its requests carry, which the person fills.
   */
  headers?: McpRegistryInput[];
}
/**
 * One registry search result. Untrusted data from a public registry anyone can publish to: it
 * fills the add form and nothing else. No environment variable, header or address input carries
 * a value or a default, and neither does a secret argument.
 */
export interface McpRegistryServer {
  /**
   * The server's registry name.
   */
  name: string;
  /**
   * The name a person reads.
   */
  title?: string;
  /**
   * What it does.
   */
  description: string;
  /**
   * Its version.
   */
  version: string;
  /**
   * The packages it runs as, where it runs as one.
   */
  packages?: McpRegistryPackage[];
  /**
   * The addresses it is reached at, where it is reached at one.
   */
  remotes?: McpRegistryRemote[];
  /**
   * The environment variables it reads.
   */
  environmentVariables: McpRegistryInput[];
}
/**
 * One page of registry search results.
 */
export interface McpRegistrySearchResponse {
  /**
   * The results.
   */
  servers: McpRegistryServer[];
  /**
   * The page after this one.
   */
  nextCursor?: string;
}
/**
 * One live session's outcome after a mutation that touched it. A mutation that committed and
 * failed on one session still answers served and reports that session here.
 */
export interface McpLiveApplicationResult {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The live leg.
   */
  bindingId: RuntimeBindingId;
  /**
   * How it went.
   */
  outcome: McpLiveApplicationOutcome;
  /**
   * The provider's error code, on a failure.
   */
  errorCode?: string;
  /**
   * What went wrong, on a failure.
   */
  detail?: string;
}
/**
 * One tool override's result, per facet it touched. An `enabled` or `approvalMode` facet may be
 * written into the provider's own config, where the provider keeps it, so each facet carries its
 * own grade.
 */
export interface McpToolOverrideApplication {
  /**
   * The `enabled` facet's grade.
   */
  enabled?: McpApplicationGrade;
  /**
   * The `approvalMode` facet's grade.
   */
  approvalMode?: McpApplicationGrade;
  /**
   * The `idempotencyClass` facet's grade.
   */
  idempotencyClass?: "daemonEnforced";
}
/**
 * What a governance mutation answers with: the row as it now stands, where the change took
 * effect, each live session's outcome, and why the provider's running service did not reload the
 * change, where it did not. `liveResults` is absent, not empty, where none was touched.
 */
export interface McpServerMutationResponse {
  /**
   * The row.
   */
  server: McpServerInventoryEntry;
  /**
   * Where the change took effect.
   */
  applied: McpApplicationGrade;
  /**
   * Each touched session's outcome.
   */
  liveResults?: McpLiveApplicationResult[];
  /**
   * Present when the provider holds the change but its running service did not reload it, so
   * the change applies at that service's next start; it says why, with no config value or file
   * path.
   */
  reloadFailure?: string;
}
/**
 * What removing a binding answers with: where the change took effect, each live session's
 * outcome, and why the provider's running service did not reload the removal, where it did not.
 * There is no row left to return.
 */
export interface McpServerDeleteResponse {
  /**
   * Where the change took effect.
   */
  applied: McpApplicationGrade;
  /**
   * Each touched session's outcome.
   */
  liveResults?: McpLiveApplicationResult[];
  /**
   * Present when the provider holds the change but its running service did not reload it, so
   * the change applies at that service's next start; it says why, with no config value or file
   * path.
   */
  reloadFailure?: string;
}
/**
 * What setting or clearing a tool override answers with.
 */
export interface McpToolOverrideMutationResponse {
  /**
   * The row.
   */
  server: McpServerInventoryEntry;
  /**
   * Each touched facet's grade.
   */
  applied: McpToolOverrideApplication;
}
/**
 * What starting a sign-in answers with: the sign-in page's address for the client to open. A
 * retry answered with the saved result comes without it, because the address is used once and
 * never stored; that caller starts a new sign-in under a new key.
 */
export interface McpServerSignInResponse {
  /**
   * The sign-in page, `http:` or `https:`.
   */
  authorizationUrl?: string;
}
/**
 * What reconnecting answers with: each leg's status after the attempt.
 */
export interface McpServerReconnectResponse {
  /**
   * Each leg.
   */
  legs: McpServerLegStatus[];
}

export {
  validateMcpAnsweredInventoryEntry,
  validateMcpApplicationGrade,
  validateMcpApprovalMode,
  validateMcpAssignableIdempotencyClass,
  validateMcpBindingScope,
  validateMcpDeclaredConfigMember,
  validateMcpLiveApplicationOutcome,
  validateMcpLiveApplicationResult,
  validateMcpManagedLayer,
  validateMcpManagedLayerKind,
  validateMcpOverrideOrigin,
  validateMcpProviderReadFailure,
  validateMcpRegistryInput,
  validateMcpRegistryPackage,
  validateMcpRegistryRemote,
  validateMcpRegistrySearchRequest,
  validateMcpRegistrySearchResponse,
  validateMcpRegistryServer,
  validateMcpServerBindingId,
  validateMcpServerBindingRef,
  validateMcpServerConfigChangedNotice,
  validateMcpServerConfigInput,
  validateMcpServerConfigView,
  validateMcpServerDeleteRequest,
  validateMcpServerDeleteResponse,
  validateMcpServerEnabledUpdateRequest,
  validateMcpServerFailedReason,
  validateMcpServerInventoryEntry,
  validateMcpServerLegStatus,
  validateMcpServerListRequest,
  validateMcpServerListResponse,
  validateMcpServerMutationResponse,
  validateMcpServerReadResponse,
  validateMcpServerReconnectRequest,
  validateMcpServerReconnectResponse,
  validateMcpServerSignInRequest,
  validateMcpServerSignInResponse,
  validateMcpServerSignOutRequest,
  validateMcpServerStatus,
  validateMcpServerUpsertRequest,
  validateMcpStoreUnavailableInventoryEntry,
  validateMcpToolOverride,
  validateMcpToolOverrideApplication,
  validateMcpToolOverrideClearRequest,
  validateMcpToolOverrideFacet,
  validateMcpToolOverrideMutationResponse,
  validateMcpToolOverrideUpdateRequest,
  validateMcpToolReading,
  validateMcpTransport,
  validateProviderMcpDeclaration,
} from "../checks/mcp/server.js";
