// MCP server governance: what a server binding is, what the daemon reports about
// it, and what a governance mutation did to the live sessions behind it.
//
// Every read-back shape here carries no configuration value. The configuration
// splits three ways: collected input whose credential-bearing values are write-only,
// the redacted view the daemon serves, and values the daemon never serves.
// `McpServerConfigView` is the middle one and carries NAMES where the wire carries
// names (`envVarNames`, `headerNames`, `urlQueryParamNames`), so a surface that
// renders every read-back here still cannot render a configuration value, an
// environment-variable value, a header value or a token.
//
// EVERY GOVERNANCE MUTATION CARRIES `clientIdempotencyKey`, AND THE CALLER MINTS IT.
// The key sits on the request rather than being minted inside the client, because
// the value belongs to the caller: a retry of one operator press must reuse it, and
// a client that minted one per call would make every retry a new operation. The
// receipted `mcp.oauthLogin` carries one too.
//
// `mcp.reconnect` IS THE ONE OPERATION THAT CARRIES NO KEY. It is unreceipted at the
// daemon, so a key on it would describe a replay that does not exist; its absence
// is not an oversight to be fixed by symmetry.
import { z } from "zod";

import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import { DRIVER_MCP_SERVER_NAME_MAX_LEN, type McpServerStatus } from "./provider-driver.js";
import { wireFreeFormString, type SessionId } from "./session.js";

const mcpServerNameSchema = wireFreeFormString(
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  "McpServerBindingRef.serverName",
);

/**
 * The five server statuses, most severe first, which is the daemon's aggregation
 * order: `failed > needs-auth > unknown > starting > connected`. A live session whose
 * observation source is lost reports `unknown`, because lost observability outranks a
 * known-healthy state. A client never applies the order; the aggregate arrives on the
 * entry and is rendered. The order is carried so a surface listing the vocabulary
 * lists it the way the daemon reasons about it.
 */
export const MCP_SERVER_STATUS_SEVERITY_ORDER: readonly McpServerStatus[] = Object.freeze([
  "failed",
  "needs-auth",
  "unknown",
  "starting",
  "connected",
] as const);

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

/**
 * The scope-qualified identity of one server binding: provider, scope, scope
 * reference and server name.
 *
 * A DISCRIMINATED UNION on `scope`, not four optional members: `user` carries no
 * `scopeRef`, `project` and `local` require one, and `(codex, local)` does not exist.
 * A flat record would let a caller compose an identity the daemon rejects, and would
 * collapse two same-named servers in two scopes into one row.
 */
export type McpServerBindingRef =
  | { provider: ProviderName; scope: "user"; serverName: string }
  | { provider: ProviderName; scope: "project"; scopeRef: string; serverName: string }
  | { provider: "claude"; scope: "local"; scopeRef: string; serverName: string };

const userBindingShape = {
  provider: ProviderNameSchema,
  scope: z.literal("user"),
  serverName: mcpServerNameSchema,
};
const projectBindingShape = {
  provider: ProviderNameSchema,
  scope: z.literal("project"),
  scopeRef: z.string().min(1),
  serverName: mcpServerNameSchema,
};
const localBindingShape = {
  provider: z.literal("claude"),
  scope: z.literal("local"),
  scopeRef: z.string().min(1),
  serverName: mcpServerNameSchema,
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

/** Turns one binding on or off. A retry of one press reuses its key. */
export type McpSetEnabledRequest = McpServerBindingRef & {
  clientIdempotencyKey: string;
  enabled: boolean;
};
/** Parses an {@link McpSetEnabledRequest}; a request without a UUID key is refused. */
export const McpSetEnabledRequestSchema: z.ZodType<McpSetEnabledRequest, McpSetEnabledRequest> =
  bindingAddressed({ clientIdempotencyKey: z.uuid(), enabled: z.boolean() });

/**
 * Grants or withdraws trust in one binding. The grant binds to the binding's
 * current configuration, so a changed configuration needs a new grant.
 */
export type McpSetTrustRequest = McpServerBindingRef & {
  clientIdempotencyKey: string;
  trusted: boolean;
};
/** Parses an {@link McpSetTrustRequest}; a request without a UUID key is refused. */
export const McpSetTrustRequestSchema: z.ZodType<McpSetTrustRequest, McpSetTrustRequest> =
  bindingAddressed({ clientIdempotencyKey: z.uuid(), trusted: z.boolean() });

/**
 * The redacted read-back of a binding's declaration, by transport.
 *
 * The env map, the header map and the URL's query string reach this shape as their
 * KEYS only, because their values are credential-equivalent and the daemon does not
 * serve them. The URL is query-redacted at the daemon (scheme, host and path) and is
 * carried verbatim from there, never trimmed again by a client.
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
 * One live session's observation of one binding.
 *
 * The grain is kept rather than folded: one configuration can back several
 * concurrent sessions, and two sessions' connections to one binding can honestly
 * disagree. One scalar would report a partial outage as either fine or broken.
 */
export interface McpServerLegStatus {
  sessionId: SessionId;
  /** The runtime binding the observation came from, not the config binding. */
  bindingId: string;
  status: McpServerStatus;
  observedAt?: string | undefined;
}

/**
 * One tool's override, by facet.
 *
 * Every facet is optional and at least one is present. An absent facet means
 * "inherit", and a client renders it as an absence rather than as a default it
 * picked: an absent `idempotencyClass` falls back to the manual-reconcile floor at
 * the daemon, and a client naming that floor would be re-deriving a class crash
 * recovery depends on.
 */
export interface McpToolOverride {
  toolName: string;
  enabled?: boolean | undefined;
  approvalMode?: McpApprovalMode | undefined;
  idempotencyClass?: "idempotent" | "compensable" | undefined;
}

/**
 * What an inventory entry carries whether or not the trust store answered.
 * `effectiveInRuns` says whether the binding reaches provider runs; `status` is the
 * daemon's aggregate over `legs`.
 */
interface McpServerInventoryFacts {
  effectiveInRuns: boolean;
  config: McpServerConfigView;
  status: McpServerStatus;
  legs?: McpServerLegStatus[] | undefined;
  observedAt?: string | undefined;
  requiredServer?: boolean | undefined;
  /** The keyed digest of `scopeRef`, served on project and local bindings in both arms. */
  scopeRefDigest?: string | undefined;
}

/**
 * One inventory row: the binding, what is known about it, and the trust arm.
 *
 * A DISCRIMINATED PAIR on `trustUnavailable`. When the trust store is unreachable,
 * the trust- and override-dependent members are STRUCTURALLY ABSENT: not `false`, not
 * `unknown`, not an empty override list, because a made-up verdict is exactly what
 * the degraded arm exists to prevent. A client renders that absence as an absence
 * and withholds the trust controls on that row alone.
 */
export type McpServerInventoryEntry = McpServerBindingRef &
  McpServerInventoryFacts &
  (
    | {
        trustUnavailable?: undefined;
        enabled: boolean;
        trusted: boolean;
        configHash: string;
        toolOverrides: McpToolOverride[];
      }
    | {
        trustUnavailable: true;
        enabled?: boolean | undefined;
      }
  );

/**
 * One live session's outcome after a mutation that touched it.
 *
 * A partial outcome is typed rather than masked: a mutation that committed durably
 * and failed on one session answers served and reports the failing session, so a
 * client renders per-session outcomes instead of one verdict.
 */
export interface McpLiveApplicationResult {
  sessionId: SessionId;
  bindingId: string;
  outcome: "applied" | "failed";
  errorCode?: string | undefined;
  detail?: string | undefined;
}

/**
 * What a governance mutation answers with: the row as it now stands, where the change
 * took effect, and what happened on each live session.
 *
 * `liveResults` is absent where the mutation touched no live session, which is a
 * different fact from an empty list and is carried as one. The trust mutation always
 * answers `daemon_enforced`, because a trust grant binds at the daemon and reaches no
 * provider config; it shares this shape so a client reads `applied` the same way
 * whichever mutation it sent.
 */
export interface McpMutationResult {
  server: McpServerInventoryEntry;
  applied: McpApplicationGrade;
  liveResults?: McpLiveApplicationResult[] | undefined;
}
