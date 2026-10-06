# MCP Governance Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-022 — MCP Governance Contract Surfaces

Governed by [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md). The `mcp.*` operations register against the Plan-005 `MethodRegistry` when Plan-022 lands (the CP-005-2 late-namespace pattern; `mcp.subscribe` rides the Plan-005 streaming primitive, the `session.subscribe` consumer shape); the event payloads mirror [Spec-005 §MCP Governance (`mcp_governance`)](../../specs/005-session-event-taxonomy-and-audit-log.md#mcp-governance-mcp_governance) (registered into contracts by Plan-004 T1.9; payloads authored by Plan-022 — the emitter-authors-payload precedent); the status read model consumes the Plan-003 `McpServerStatusUpdate` seam (provider-driver-capability-payloads.md). Authorization: every mutating operation is open to this machine's own client or any linked device, and no session, with no policy check and no ownership refusal — no `ApprovalCategory` value is added. Idempotency: every governance mutation — and the receipted operational commands `mcp.oauthLogin` and `mcp.oauthLogout` — carries the mandatory requester-generated UUID `clientIdempotencyKey` (Spec-004's mandatory requester-generated key; the intervention-surface precedent) with a durable receipt that returns the saved result on a retry, per Spec-024 §Authorization (`mcp.reconnect` is unreceipted). Error codes: [error-contracts.md §MCP Governance](./error-contracts.md#mcp-governance). Sanitization: no payload below carries config values, env-var values, header values, tokens, or unsanitized paths (Plan-022 I-022-1: credential custody is exactly what ADR-038 records) — raw `scopeRef` filesystem paths included: durable event payloads identify a binding by the path-free audit ref (`McpServerBindingAuditRef` below), never the path itself; `serverName` / `toolName` are untrusted provider-adjacent strings, `wireFreeFormString`-bounded under the trust-boundary header's free-form-string rule, classified as non-PII infrastructure identifiers per Spec-024 §Status Observation and Events. Identity throughout is the scope-qualified binding `(provider, scope, scopeRef, serverName)` per Spec-024 §Unified Inventory — a **discriminated union on `scope`**, so an invalid shape (`scopeRef` on `user`, or a missing `scopeRef` on `project`/`local`) is a schema-level rejection, never a service-layer surprise or a collapsed primary key. Every scope exists on both providers: Codex has no private per-project layer, so its `local` scope is the daemon's emulation described with the operations below. Two grains share this section deliberately: the config **binding** above and the Plan-003 **runtime-binding leg** (`sessionId` + `bindingId`) — live per-session state (status legs, live mutation results, reconnect targets) always keys by leg, never by collapsing legs into the binding scalar.

```ts
// ---- Primitives (Spec-024) ----
type McpProvider = "claude" | "codex";
type McpBindingScope = "user" | "project" | "local" | "plugin"; // scope axis of the binding identity; the first three are writable on both providers, and `plugin` names a server an installed plugin carries: user = the provider's own user configuration, read on the page as `All projects`; project = the project's own file in the repository (Claude Code's `<project>/.mcp.json`, Codex's `<project>/.codex/config.toml`), `This project · in the repo`; local = one project, declared outside the repository (Claude Code's per-project entry in its user configuration; on Codex, which has no such layer, a user entry kept switched off and switched on per conversation in that project's sessions), `This project · not in the repo`. Scope-applicability is PER OPERATION (see the operations block)
type McpApplicationGrade = "live_reconcile" | "user_config_write" | "next_run" | "daemon_enforced"; // when/where a mutation takes effect — honest, typed, never silent (parity-triad degrade-honestly): live session set / provider config store (subsequent runs) / next-run composed config / daemon decision layer (immediate)
type McpApprovalMode = "auto" | "prompt" | "writes" | "approve"; // Codex-native vocabulary adopted as the normalized set; Claude-side enforcement is daemon-owned (Spec-024 §Tool-Level Overrides)

// The scope-qualified server binding (Spec-024 §Unified Inventory): identity is
// (provider, scope, scopeRef, serverName) — never merged across providers OR scopes. Same-named
// servers in two scopes are distinct configurations with independent status and overrides;
// collapsing them would bleed overrides across configurations.
// Structural validity is schema-level (a Zod discriminated union on `scope`), not service-layer:
// `user` FORBIDS scopeRef (persisted as '' in the daemon tables), and `project`/`local` REQUIRE a
// canonical non-empty scopeRef (the project root), so unrelated projects can never collapse onto one
// empty-string PK component. Payload/read-model types compose this union via intersection (never
// `interface extends` — unions don't extend).
// A fourth arm names a server an installed plugin carries in its `.mcp.json`, its scopeRef the
// plugin's name: listed on the MCP servers page as `From plugin <name>` and sent
// to a session only when switched on for it. Its declaration changes only with the plugin, so
// mcp.upsertServer and mcp.removeServer refuse it; mcp.setEnabled and the tool overrides target it.
// A binding in a scope the person writes, its declaration in a provider's own config.
type McpWritableBindingRef =
  | { provider: McpProvider; scope: "user"; serverName: string }
  | { provider: McpProvider; scope: "project"; scopeRef: string; serverName: string }
  | { provider: McpProvider; scope: "local"; scopeRef: string; serverName: string };
type McpServerBindingRef =
  | McpWritableBindingRef
  | { provider: McpProvider; scope: "plugin"; scopeRef: string; serverName: string };

// Event-side binding identity (Spec-024 §Status Observation and Events): path-free. scopeRef
// (canonical project root / keying directory) is a user-specific filesystem path — a Spec-020
// durable-tier PII class — and event payloads are durable and re-read on every rebuild, so the raw path never
// enters them: an event names the provider, the scope and the server, and nothing else.
// Requests and inventory reads keep the full McpServerBindingRef (transient wire / the person's read,
// not durable audit rows).
interface McpServerBindingAuditRef {
  provider: McpProvider;
  scope: McpBindingScope;
  serverName: string;
}

// Effective-binding derivation output (Plan-022 T22.4.5). NOT a carrier threaded in from another plan — Plan-022 derives this
// in-plan from the session sets it builds (T22.3.3, T22.3.8). `null` is a first-class answer meaning the tool
// resolved from NO governed binding: a provider built-in, or a tool served by the daemon's own
// ephemeral callback-tool host (Spec-004 §Required Behavior), which sits outside Spec-024 governance
// entirely (Spec-024 §Non-Goals) and is never override-governed.
// NEVER derived by parsing the delivered wire tool name: provider-side `mcp__<server>__<tool>`
// prefixing and collision-suffixing are provider defaults rather than wire invariants, so the
// mapping runs off the daemon's own registration identity.
type McpEffectiveBinding = McpServerBindingRef | null;

// mcp.upsertServer config input — the normalized governed surface, discriminated on transport.
// Env-var and header VALUES are write-only credential-adjacent material: accepted here, passed only
// to the sanctioned provider write path, NEVER round-tripped in inventory reads or event payloads
// (names may appear; values never do). Provider-conditional validation is schema-enforced (Zod
// refinements), not prose: a field marked Codex-only rejects for provider "claude" and vice versa,
// so the canonical request schema and SDK signature derive from this union without divergence.
// EVERY SCOPE TAKES WHAT THE PERSON TYPES: at `project` scope the values are written into the
// project's file in that provider's own format, as at the other scopes. A declaration may name a
// variable in place of a value — a Claude Code `env` or `headers` value written as a `${VAR}` or
// `${VAR:-default}` reference, a Codex server naming its variables through `envVars`,
// `envHttpHeaders` and `bearerTokenEnvVar`. On Claude Code the daemon expands the references from the
// session's own start environment before it sends the server set, holding the expanded value only
// for that call and never storing or logging it.
// PRESERVATION RULE (Spec-024 §Configuration Mutation): upserts are read-modify-write over the
// provider's own declaration — provider fields this union does not model (or the request does not
// carry) are preserved, never erased. Codex `user` writes are field-granular `config/value/write`
// paths, a Codex `project` write is a format-preserving edit that keeps the file's comments and
// layout, and the regenerated Claude declaration starts from the observed current one.
type McpServerConfigInput =
  | {
      transport: "stdio";
      command: string; // executable; non-empty, NUL-rejected
      args?: string[];
      env?: Record<string, string>; // write-only values (see above)
      envVars?: string[]; // Codex-only `env_vars` — variable NAMES the server inherits from the environment Codex starts in
      enabled?: boolean; // Codex: native `enabled` field; Claude: maps to the daemon enabled overlay
      required?: boolean; // Codex-only — thread start/resume fails if the server cannot initialize
      startupTimeoutSec?: number; // Codex-only native timeout
      toolTimeoutSec?: number; // Codex-only native timeout
    }
  | {
      transport: "http" | "sse"; // "sse" is Claude-only (Claude-native transport kind)
      url: string; // absolute http(s) URL, taken as typed and passed to the provider write path as typed, a user name or password in it included. That user name and password and the query-string VALUES are write-only credential-equivalent material: accepted, passed on — never round-tripped (the view serves query param NAMES)
      headers?: Record<string, string>; // write-only values (see above)
      bearerTokenEnvVar?: string; // Codex-only `bearer_token_env_var` — the env-var NAME, never the value
      envHttpHeaders?: Record<string, string>; // Codex-only `env_http_headers` — header NAME → env-var NAME (both references, no values; resolved provider-side at connect time)
      oauthScopes?: string[]; // Codex-only `scopes` — OAuth scopes requested for the server's auth flow
      oauthResource?: string; // Codex-only `oauth_resource` — the RFC 8707 resource indicator for the flow
      enabled?: boolean;
      required?: boolean; // Codex-only (as above)
      startupTimeoutSec?: number; // Codex-only (as above)
      toolTimeoutSec?: number; // Codex-only (as above)
    };

// Redacted normalized config view (Spec-024 §Unified Inventory): the read-back of what
// mcp.upsertServer wrote — every non-secret field preserved, secret VALUES structurally absent
// (env/header/query-param NAMES only), so mcp.get supports read/edit workflows without the daemon
// ever serving credential material. command/args are process-visible strings the person authors —
// the same documented residual class as serverName/toolName in the preamble; the URL is NOT in that
// class (an http URL is not a process argument): it serves query-redacted below.
type McpServerConfigView =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      envVarNames?: string[]; // the env map's KEYS; values never round-trip
      enabled?: boolean;
      required?: boolean; // Codex-only, as on input
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    }
  | {
      transport: "http" | "sse";
      url: string; // QUERY-REDACTED: scheme + host + path only (a user name or password, like the query values, is credential-equivalent and never round-trips)
      urlQueryParamNames?: string[]; // the query string's parameter NAMES when one existed; values never round-trip (the env/header names-not-values discipline)
      headerNames?: string[]; // the header map's KEYS; values never round-trip
      bearerTokenEnvVar?: string; // an env-var NAME (Codex-only), safe to serve
      envHttpHeaders?: Record<string, string>; // Codex-only — header NAME → env-var NAME: a name→name reference map, round-trips verbatim
      oauthScopes?: string[]; // Codex-only — non-secret auth references, round-trip verbatim
      oauthResource?: string; // Codex-only — non-secret auth reference, round-trips verbatim
      enabled?: boolean;
      required?: boolean;
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    };

// Per-leg live status (Spec-024 §Unified Inventory): one config binding can back several concurrent
// sessions' connections; the Plan-003 seam keys observations by runtime-binding leg, and the
// inventory preserves that grain instead of overwriting divergent leg states into one scalar.
interface McpServerLegStatus {
  sessionId: SessionId;
  bindingId: string; // the Plan-003 runtime-binding leg key (provider-driver-capability-payloads.md McpServerStatusUpdate) — NOT this section's config binding
  status: McpServerStatus;
  observedAt?: string; // ISO-8601 of this leg's newest observation
}

// Inventory read model (mcp.list / mcp.get): four merged sources per binding — provider-declared
// config, live status (McpServerStatus, provider-driver-capability-payloads.md seam), the binding row, the override
// rows. A DISCRIMINATED PAIR on bindingStoreUnavailable (Spec-024 §Fallback Behavior): the normal arm serves
// all four sources; the degraded arm (binding store unreachable) serves the provider-observed sources
// only, with every store-dependent field STRUCTURALLY ABSENT rather than fabricated (tools, whose
// sources need the override rows, and the Claude enabled overlay live in the unreachable store).
// All mutations fail closed while degraded.
type McpServerInventoryEntry = McpServerBindingRef & {
  config: McpServerConfigView; // the redacted normalized declaration (see above)
  status: McpServerStatus; // deterministic aggregate over legs[]: most severe current live-leg status (failed > needs-auth > unknown > starting > connected — a live leg whose observation source is lost reports "unknown": lost observability outranks known-healthy states, never a concrete failure), else newest node-probe observation, else "unknown" — never fabricated
  failedReason?: "commandNotRunnable"; // present only on an entry reading "failed" because, after the background service moved between Windows and a WSL distribution, its command or arguments name a program on the side it left; a bare command name such as npx is looked up on the new side and is not marked. One member on the entry, not a status of its own
  legs?: McpServerLegStatus[]; // per-leg session-feed observations; absent when no live leg exists. Legs are LIVE-session observations with a bounded lifecycle: when a leg's backing runtime binding closes (session end / driver exit), the daemon retires it and recomputes the aggregate — a terminated session's last status never pins `status`
  observedAt?: string; // ISO-8601 of the newest status observation backing `status`
  requiredServer?: boolean; // Codex `required = true` — thread start/resume fails if the server cannot initialize
  supersededIn?: string[]; // the project roots where another binding of this provider and serverName is the effective one, by the provider's order (a project's `local` binding over its `project` one, either over the `user` one); the daemon already resolves this to send each session its effective set (Spec-024 §Status Observation and Events), so it serves the answer rather than the page working it out. The page reads each one as `Not used in <project>: its own <name> takes its place.` Absent where the binding is used wherever it applies; never empty
} & (
    | {
        bindingStoreUnavailable?: never; // the normal (binding-store-available) arm
        enabled: boolean; // provider-declared enabled state composed with the daemon's Claude enabled overlay (the overlay lives on the binding row)
        tools: McpToolReading[]; // every tool the server offers, in the order the daemon serves them
      }
    | {
        bindingStoreUnavailable: true; // degraded read: binding store unreachable — mutations fail closed (Spec-024 §Fallback Behavior)
        enabled?: boolean; // the provider-native enabled field only (Codex); ABSENT for Claude bindings — the daemon enabled overlay lives in the unreachable store, and a fabricated value would be a lie
      }
  );

// One tool's settings as the page draws them, every per-tool value saying where it came from: each
// facet's value IN FORCE, resolved by the daemon from the server's own declaration and the person's
// override row, and its source — "server" (`The server's own`) or "override" (`Set here`). Under an
// override the setting also carries `serverValue`, the server's own value a clear returns to (for
// Codex, the preserved native baseline), so the page's control lists only the facet's values and
// choosing the server's own one sends mcp.clearToolOverride for that facet instead of a set. The
// client draws all of it and derives none.
type McpToolSetting<OverrideValue, ServerValue = OverrideValue> =
  | { source: "server"; value: ServerValue }
  | { source: "override"; value: OverrideValue; serverValue: ServerValue };
type McpToolSettingSource = McpToolSetting<unknown>["source"];
type McpAssignableIdempotencyClass = "idempotent" | "compensable"; // the classes a person assigns; manual_reconcile_only is the floor a clear returns to, never set
interface McpToolReading {
  toolName: string;
  enabled: McpToolSetting<boolean>; // with no override: the provider config (for Codex, the preserved native baseline)
  approvalMode: McpToolSetting<McpApprovalMode>; // with no override: the provider default, in the normalized vocabulary
  idempotencyClass: McpToolSetting<McpAssignableIdempotencyClass, "manual_reconcile_only">; // with no override: the manual_reconcile_only floor, the only class a server's own reading holds
}

// The override REQUEST shape (mcp.setToolOverride): the facets the request touches; an absent facet
// is left as it stands. At least one facet is REQUIRED — a toolName-only override is meaningless and
// the canonical DDL rejects the all-NULL row, so the Zod mirror refines "enabled, approvalMode, or
// idempotencyClass present" and a facet-less request dies as a typed validation error, never a
// constraint failure.
interface McpToolOverride {
  toolName: string;
  enabled?: boolean;
  approvalMode?: McpApprovalMode;
  idempotencyClass?: McpAssignableIdempotencyClass;
}

// The facet mcp.clearToolOverride clears. One per request: the page clears the one facet the person
// returned to the server's own value, and the tool's other facets stand.
type McpToolOverrideFacet = "enabled" | "approvalMode" | "idempotencyClass";

// Per-facet application grades for override mutations (Spec-024 §Tool-Level Overrides): Codex
// enabled/approvalMode materialize into native config fields (user_config_write) in the file that
// holds the binding — the user file for `user` and `local` bindings (an emulated local binding is a
// user entry), the project's `.codex/config.toml` for a `project` binding; Claude enforces all of
// them at the daemon approval/resolution layer (daemon_enforced, immediate).
// Present keys mirror the facets the request touched (or reverted, on clear).
interface McpToolOverrideApplication {
  enabled?: McpApplicationGrade;
  approvalMode?: McpApplicationGrade;
  idempotencyClass?: "daemon_enforced";
}

// Per-leg live-application outcome (Spec-024 §Configuration Mutation — partial outcomes are typed,
// never masked): a durable-success/live-failure mutation is a SUCCESSFUL response reporting the
// durable grade plus the failing legs — never a post-commit JSON-RPC error inviting an unsafe retry,
// and never a blanket success hiding a live failure.
interface McpLiveApplicationResult {
  sessionId: SessionId;
  bindingId: string; // the Plan-003 runtime-binding leg key
  outcome: "applied" | "failed";
  errorCode?: string; // mcp.* code for a failed leg (e.g. a per-server setMcpServers error)
  detail?: string; // sanitized — never config values or unsanitized paths
}

// ---- Operations (12; JSON-RPC per ADR-009) ----
// Reads:
//   mcp.list      {refresh?: boolean} → {servers: McpServerInventoryEntry[]}
//   mcp.get       McpServerBindingRef → {server: McpServerInventoryEntry}
//   mcp.subscribe {} → AsyncIterable<EventEnvelope | McpServerBindingRef & {type: "mcp.server_config_changed"} | McpServerStatusChangedNotice> // live-tail of every mcp_governance envelope as appended, a live notice after each edit to a binding (an add, a change, a switch, a tool override or a removal, from any client), and a live notice of each status change; neither notice is written to any log; a page showing the binding reads it again with mcp.get (sentinel- and session-bound alike; Plan-005 streaming primitive, session.subscribe consumer shape). Gap-free by ORDERING, not by cursor: a (re)connecting client opens mcp.subscribe FIRST, then reads mcp.list — the subscribe acknowledgment precedes the stream's first delivery (the Plan-005 I-005-9 wire-ordering invariant), so registration is live before the snapshot read and an event concurrent with the snapshot arrives on the stream instead of falling between snapshot and subscription (re-observation is harmless — governance envelopes and status notices are re-entrant state updates; omission is impossible). A settled sign-in's history is the sentinel session's log; a status change has none (Spec-024 §Status Observation and Events)
//   mcp.registrySearch {query: string, cursor?: string} → {servers: McpRegistryServer[], nextCursor?: string} // `Browse servers`: a search of the public MCP Registry (`GET /v0/servers?search=<query>&version=latest` on registry.modelcontextprotocol.io), made by the daemon only when the person types and caching nothing past the page. Each result carries its title or name, description and version, whether it runs as a package (its `runtimeHint` and `runtimeArguments`) or at an address (its `remotes`), and each environment variable's name, description and whether it is required — never a value. A pick fills the add form; the person still adds the server and types every secret
// Non-reads (open to this machine's own client or any linked device, with no policy check; every
// operation except mcp.reconnect carries the MANDATORY clientIdempotencyKey: string —
// requester-generated UUID; a retry under the same key returns the saved result from the durable
// receipt, Spec-024 §Authorization). The governance mutations below finalize their receipt with their store writes and
// emit no governance event; mcp.oauthLogin, mcp.oauthLogout and mcp.reconnect are operational
// commands — oauthLogin is receipted but its durable trace is the asynchronous
// mcp.server_oauth_completed, emitted exactly once per completed sign-in (an abandoned sign-in, or
// one ended by a newer attempt, leaves only its expiring receipt); oauthLogout is receipted, and it
// and reconnect show through the status notices they induce; reconnect is unreceipted:
//   mcp.upsertServer      McpWritableBindingRef & {clientIdempotencyKey: string, config: McpServerConfigInput} → {server: McpServerInventoryEntry, applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]}
//   mcp.removeServer      McpWritableBindingRef & {clientIdempotencyKey: string} → {applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]} // removing an emulated Codex local server also removes the daemon's row for it; removing any server removes every approval rule over its tools from the provider's file that holds it, in the same transaction
//   mcp.setEnabled        McpServerBindingRef & {clientIdempotencyKey: string, enabled: boolean} → {server: McpServerInventoryEntry, applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]}
//   mcp.setToolOverride   McpServerBindingRef & {clientIdempotencyKey: string, override: McpToolOverride} → {server: McpServerInventoryEntry, applied: McpToolOverrideApplication}
//   mcp.clearToolOverride McpServerBindingRef & {clientIdempotencyKey: string, toolName: string, facet: McpToolOverrideFacet} → {server: McpServerInventoryEntry, applied: McpToolOverrideApplication} // clears that one facet back to the server's own value (a Codex facet restored from the binding's baseline) and leaves the tool's other facets set; clearing a tool's last set facet drops its override row; `applied` carries the cleared facet's grade alone
//   mcp.oauthLogin        McpServerBindingRef & {clientIdempotencyKey: string} → {authorizationUrl?: string} // starts the daemon's own sign-in for that server, whatever kind of server it is, and returns the address of the sign-in page for the client to open; a new mcp.oauthLogin on a server whose sign-in is still waiting ends that wait and starts the next attempt; mcp.oauth_flow_failed is LAUNCH-phase only — a failure to start the sign-in (discovery, registration, or the provider's own flow in its throwaway home) — and an async completion failure arrives as mcp.server_oauth_completed outcome: 'failure' on the mcp.subscribe stream, never a late JSON-RPC error (Spec-024 §OAuth Orchestration). Its idempotency receipt persists the acknowledgment with authorizationUrl STRUCTURALLY OMITTED (single-use PKCE-bearing launch material is never durable — Plan-022 I-022-1), so an identical-key retry returns a saved acknowledgment with no URL: the sign-in already started, completion arrives as the event, and a caller that never received the URL starts a new sign-in under a fresh key
//   mcp.oauthLogout       {serverId: string, clientIdempotencyKey: string} → EmptyPayload // `Sign out of this server`. `serverId` is the server's address, not a scope-qualified binding: the daemon holds one sign-in per server, used by both providers and every binding that names it, and each of those bindings' change after the sign-out arrives as its status notice on mcp.subscribe. It deletes the daemon's refresh token for the server, and its signing key where the server demands proof-of-possession tokens, and ends the access tokens it handed out, so each provider's next call to that server carries no token and the server reads needs-auth in every session on both providers until the next sign-in
//   mcp.reconnect         McpServerBindingRef & {sessionId?: SessionId, bindingId?: string} → {legs: McpServerLegStatus[]} // operational: restarts the binding's live provider leg(s), LEG-ADDRESSABLE — exactly one leg when bindingId is given (with sessionId, both must name the same leg), every live leg of one session when only sessionId is given, every live leg otherwise; per-leg post-reconnect statuses, honest per leg
// Session operations (Spec-024 §A session's own tool servers), in the session.* namespace; none emits a governance event:
// `serverName` is the server's name in the session's own list, the name both providers start the session's servers by; it is not the address `mcp.oauthLogout` takes, and a server run as a local command has none.
//   session.mcpServerList   {sessionId} → a live list of the servers the session was started with, each row the server's name, binding, status with its reason, whether it is on for the session, and whether a switch waits for the next turn — names and statuses only, never a config value
//   session.mcpServerUpdate {sessionId, serverName, enabled} // narrows only: off stops the session offering that server's tools; kept with the session, applied at the next turn and sent again after each resume; a new session starts with every server on
//   session.mcpResourceList {sessionId, serverName} → {serverName, resources, complete} // what a working server offers, for the composer's attachment row; refused for a server that is off or not working
// Scope applicability is per operation (Spec-024 §Configuration Mutation), never a blanket rule.
// upsertServer and removeServer take an McpWritableBindingRef, the three writable scopes, so a
// `plugin` binding is a schema-level rejection; setEnabled takes any McpServerBindingRef, and on a
// `plugin` binding it is the daemon's own switch and writes no provider configuration. On the three
// writable scopes, upsertServer, removeServer and setEnabled write the provider's own configuration
// on both providers:
// Claude Code writes through `claude mcp add-json <name> <json> --scope <scope>` (a `project` write run from the
// project root, landing in `<project>/.mcp.json`; `local` in Claude Code's per-project entry of its
// user configuration); Codex `user` writes through `config/value/write`; Codex `project` is a
// format-preserving edit of `<project>/.codex/config.toml` written to a temporary file and renamed
// into place only while the file still hashes to what the daemon last read (else
// mcp.config_write_conflict), then read back with `config/read` and reloaded with
// `config/mcpServer/reload`; Codex `local` is emulated as a user entry with `enabled = false`,
// switched on per conversation in each session of that project, its name unique across the user
// file (a clash is refused, naming the project that holds the other one).
// Overrides, oauthLogin and reconnect apply to any binding, and oauthLogout to any server.
// One mcp.registrySearch result, read from the registry's own record. Untrusted data: it fills the add
// form and nothing else, and no value of any environment variable is ever part of it.
interface McpRegistryServer {
  name: string;
  title?: string;
  description: string;
  version: string;
  packages?: Array<{
    registryType: string;
    identifier: string;
    runtimeHint?: string;
    runtimeArguments?: Array<Record<string, unknown>>;
  }>; // runs as a package
  remotes?: Array<{ type: string; url: string }>; // reached at an address
  environmentVariables: Array<{ name: string; description?: string; isRequired: boolean }>;
}

// ---- The status notice and the event payload mirror (Spec-005 §MCP Governance) ----
// Each embeds the PATH-FREE binding identity via intersection with McpServerBindingAuditRef
// (provider, scope, serverName) — never the raw scopeRef (see the audit-ref comment above). A
// status change is a live notice on mcp.subscribe and is written to no log; a settled sign-in is a
// durable row, and Spec-024 forbids filesystem paths in both.
type McpServerStatusChangedNotice = McpServerBindingAuditRef & {
  type: "mcp.server_status_changed";
  previousStatus: McpServerStatus;
  status: McpServerStatus;
  failureReason?: string; // sanitized
  // a session's own feed, or the daemon's probe of a server no session runs
  origin: "session_feed" | "node_probe";
  // REQUIRED for origin "session_feed", the session whose feed saw it; ABSENT for "node_probe"
  sessionId?: SessionId;
  bindingId?: string; // REQUIRED for origin "session_feed" — the Plan-003 runtime-binding leg key (opaque daemon-minted id), attributing the transition to its legs[] entry when one binding backs several legs in the same session; ABSENT for "node_probe" (no leg observed). The Zod mirror enforces the conditionality as a refinement
};
type McpServerOauthCompletedPayload = McpServerBindingAuditRef & {
  outcome: "success" | "failure"; // 'failure' IS the asynchronous completion-failure channel (Spec-024 §OAuth Orchestration — launch failures are errors, completion failures are events)
  failureReason?: string; // sanitized — never tokens, authorization codes, or URLs with embedded secrets
  initiatingSessionId?: SessionId;
};
```
