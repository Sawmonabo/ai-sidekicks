// The MCP governance plane's values: what a server binding IS, what it is reported
// to be, and what a mutation did to the live legs behind it.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
//
// EVERY VOCABULARY HERE IS TRANSCRIBED, NEVER INVENTED. The five statuses, the four
// application grades, the four approval modes, and the two providers are enumerated
// in `api-payload-contracts.md §Plan-028`, and the operator surface's tables are
// total over them — which is what makes a sixth arm a compile error at the page
// rather than a blank cell on screen. The three CONFIG SCOPES are deliberately not
// among them: they are the discriminant of the binding union below, so an array
// beside it would be the same closed set declared twice, and the union is the
// declaration that carries the per-scope shape differences an array cannot.
//
// AND EVERY SHAPE HERE IS A READ-BACK, WHICH IS WHY NONE OF THEM CARRIES A VALUE.
// The governing section splits configuration three ways: collected input whose
// credential-bearing values are write-only, read-back that is exactly the redacted
// view the daemon serves, and values the daemon does not serve at all. The config
// view below is the middle one and carries NAMES where the wire carries names —
// `envVarNames`, `headerNames`, `urlQueryParamNames` — so a surface rendering
// everything this module publishes still cannot render a configuration value, an
// environment-variable value, a header value, or a token. There is deliberately no
// `McpServerConfigInput` here: this console does not author the configuration form,
// and a shape for one would be a write surface minted ahead of its writer.

/** The two providers a binding can be declared against. */
export const GROWTH_MCP_PROVIDERS = ["claude", "codex"] as const;

/** One such provider. Derived, so the set is declared exactly once. */
export type GrowthMcpProvider = (typeof GROWTH_MCP_PROVIDERS)[number];

/**
 * The five server statuses, in the aggregate's own severity order.
 *
 * Ordered most severe first because that IS the daemon's documented aggregation rule
 * — `failed > needs-auth > unknown > starting > connected`, with a live leg whose
 * observation source is lost reporting `unknown` because lost observability outranks
 * a known-healthy state. The console never applies that rule: the aggregate arrives
 * on the entry and is rendered. The order is carried so a surface listing the
 * vocabulary lists it the way the daemon reasons about it.
 */
export const GROWTH_MCP_SERVER_STATUSES = [
  "failed",
  "needs-auth",
  "unknown",
  "starting",
  "connected",
] as const;

/** One such status. Derived, so the set is declared exactly once. */
export type GrowthMcpServerStatus = (typeof GROWTH_MCP_SERVER_STATUSES)[number];

/** When and where a mutation took effect. Honest, typed, and never silent. */
export const GROWTH_MCP_APPLICATION_GRADES = [
  "live_reconcile",
  "user_config_write",
  "next_run",
  "daemon_enforced",
] as const;

/** One such grade. Derived, so the set is declared exactly once. */
export type GrowthMcpApplicationGrade = (typeof GROWTH_MCP_APPLICATION_GRADES)[number];

/** The normalized approval vocabulary a tool override may pin. */
export const GROWTH_MCP_APPROVAL_MODES = ["auto", "prompt", "writes", "approve"] as const;

/** One such mode. Derived, so the set is declared exactly once. */
export type GrowthMcpApprovalMode = (typeof GROWTH_MCP_APPROVAL_MODES)[number];

/**
 * The scope-qualified binding identity: `(provider, scope, scopeRef, serverName)`.
 *
 * A DISCRIMINATED UNION on `scope` rather than four optional members, which is the
 * registered shape and is load-bearing here: `user` carries no `scopeRef` at all,
 * project and local require one, and `(codex, local)` does not exist. A flat record
 * would let a surface compose an identity the daemon would reject and would collapse
 * two same-named servers in two scopes into one row.
 */
export type GrowthMcpBindingRef =
  | { readonly provider: GrowthMcpProvider; readonly scope: "user"; readonly serverName: string }
  | {
      readonly provider: GrowthMcpProvider;
      readonly scope: "project";
      readonly scopeRef: string;
      readonly serverName: string;
    }
  | {
      readonly provider: "claude";
      readonly scope: "local";
      readonly scopeRef: string;
      readonly serverName: string;
    };

/**
 * The redacted normalized read-back of a binding's declaration.
 *
 * NAMES WHERE THE WIRE CARRIES NAMES. The env map, the header map, and the URL's
 * query string each reach this shape as their KEYS, because their values are
 * credential-equivalent and the daemon does not serve them. The URL itself is
 * query-redacted at the daemon — scheme, host, and path — and is carried verbatim
 * from there rather than trimmed again here, which would be this console deciding
 * what part of a served string is safe.
 */
export type GrowthMcpServerConfigView =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly envVarNames?: readonly string[];
      readonly enabled?: boolean;
      readonly required?: boolean;
      readonly startupTimeoutSec?: number;
      readonly toolTimeoutSec?: number;
    }
  | {
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly urlQueryParamNames?: readonly string[];
      readonly headerNames?: readonly string[];
      readonly bearerTokenEnvVar?: string;
      readonly envHttpHeaders?: Readonly<Record<string, string>>;
      readonly oauthScopes?: readonly string[];
      readonly oauthResource?: string;
      readonly enabled?: boolean;
      readonly required?: boolean;
      readonly startupTimeoutSec?: number;
      readonly toolTimeoutSec?: number;
    };

/**
 * One live session's observation of one binding.
 *
 * The grain is preserved rather than folded: one configuration can back several
 * concurrent sessions, and two legs of one binding can honestly disagree. A surface
 * that showed one scalar would report a partial outage as either fine or broken.
 */
export interface GrowthMcpServerLegStatus {
  readonly sessionId: string;
  readonly bindingId: string;
  readonly status: GrowthMcpServerStatus;
  readonly observedAt?: string;
}

/**
 * One tool's override, by facet.
 *
 * Every facet is optional and at least one is present, which is the registered
 * refinement. An absent facet means "inherit", and the console renders that as an
 * absence rather than as a default it picked — `idempotencyClass` in particular
 * falls back to the manual-reconcile floor at the daemon, and a renderer naming that
 * floor here would be re-deriving a class Spec-015 recovery depends on.
 */
export interface GrowthMcpToolOverride {
  readonly toolName: string;
  readonly enabled?: boolean;
  readonly approvalMode?: GrowthMcpApprovalMode;
  readonly idempotencyClass?: "idempotent" | "compensable";
}

/**
 * What every inventory entry carries in both arms.
 *
 * Split out from the discriminated pair below so the trust-dependent half is stated
 * exactly once as the thing that is ABSENT in the degraded arm, rather than repeated
 * as optional members that a reader would then have to test twice.
 */
interface GrowthMcpInventoryFacts {
  readonly effectiveInRuns: boolean;
  readonly config: GrowthMcpServerConfigView;
  readonly status: GrowthMcpServerStatus;
  readonly legs?: readonly GrowthMcpServerLegStatus[];
  readonly observedAt?: string;
  readonly requiredServer?: boolean;
  readonly scopeRefDigest?: string;
}

/**
 * One inventory row: the binding, what is known about it, and the trust arm.
 *
 * A DISCRIMINATED PAIR on `trustUnavailable`, which is the registered shape and the
 * one thing this page must not smooth over. When the trust store is unreachable the
 * trust- and override-dependent fields are STRUCTURALLY ABSENT — not `false`, not
 * `unknown`, not an empty override list — because a fabricated verdict is exactly
 * what the degraded arm exists to prevent. The console renders that absence as an
 * absence and withholds the trust controls on that row alone.
 */
export type GrowthMcpInventoryEntry = GrowthMcpBindingRef &
  GrowthMcpInventoryFacts &
  (
    | {
        readonly trustUnavailable?: undefined;
        readonly enabled: boolean;
        readonly trusted: boolean;
        readonly configHash: string;
        readonly toolOverrides: readonly GrowthMcpToolOverride[];
      }
    | {
        readonly trustUnavailable: true;
        readonly enabled?: boolean;
      }
  );

/**
 * One live leg's outcome after a mutation that touched it.
 *
 * A partial outcome is typed rather than masked: a mutation that committed durably
 * and failed on one session's leg answers `served` and reports the failing leg, so
 * the page renders per-binding outcomes instead of one aggregate verdict.
 */
export interface GrowthMcpLiveApplicationResult {
  readonly sessionId: string;
  readonly bindingId: string;
  readonly outcome: "applied" | "failed";
  readonly errorCode?: string;
  readonly detail?: string;
}

/**
 * What a governance mutation answers with: the row as it now stands, where the
 * change took effect, and what happened on each live leg.
 *
 * `liveResults` is absent where the mutation touched no live binding, which is a
 * different fact from an empty array and is carried as one.
 */
export interface GrowthMcpMutationResult {
  readonly server: GrowthMcpInventoryEntry;
  readonly applied: GrowthMcpApplicationGrade;
  readonly liveResults?: readonly GrowthMcpLiveApplicationResult[];
}
