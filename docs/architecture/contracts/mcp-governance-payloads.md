# MCP Governance Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-022 — MCP Governance Contract Surfaces

Governed by [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md). The `mcp.*` operations register against the Plan-005 `MethodRegistry` when Plan-022 lands (the CP-005-2 late-namespace pattern; `mcp.subscribe` rides the Plan-005 streaming primitive, the `session.event.subscribe` consumer shape); the event payloads mirror [Spec-005 §MCP Governance (`mcpGovernance`)](../../specs/005-session-event-taxonomy-and-audit-log.md#mcp-governance-mcpgovernance) (registered into contracts by Plan-004 T1.9; payloads authored by Plan-022 — the emitter-authors-payload precedent); the status read model consumes the Plan-003 `McpServerStatusUpdate` seam (provider-driver-capability-payloads.md). Authorization: every mutating operation is open to this machine's own client or any linked device, and no session, with no policy check and no ownership refusal — no `ApprovalCategory` value is added. Idempotency: every governance mutation — and the receipted operational commands `mcp.server.signIn` and `mcp.server.signOut` — carries the mandatory requester-generated UUID `clientIdempotencyKey` (Spec-004's mandatory requester-generated key; the intervention-surface precedent) with a durable receipt that returns the saved result on a retry, per Spec-024 §Authorization (`mcp.server.reconnect` is unreceipted). Error codes: [error-contracts.md §MCP Governance](./error-contracts.md#mcp-governance). Sanitization: no payload below carries config values, env-var values, header values, tokens, or unsanitized paths (Plan-022 I-022-1: credential custody is exactly what ADR-038 records) — raw `scopeRef` filesystem paths included: durable event payloads identify a binding by the path-free audit ref (`McpServerBindingAuditRef` below), never the path itself; `serverName` / `toolName` are untrusted provider-adjacent strings, `FreeFormText<MAX>`-bounded under the trust-boundary header's free-form text rule, classified as non-PII infrastructure identifiers per Spec-024 §Status Observation and Events. Identity throughout is the scope-qualified binding `(provider, scope, scopeRef, serverName)` per Spec-024 §Unified Inventory — a **discriminated union on `scope`**, so an invalid shape (`scopeRef` on `user`, or a missing `scopeRef` on `project`/`local`) is a schema-level rejection, never a service-layer surprise or a collapsed primary key. The three writable scopes exist on every provider: Codex has no private per-project layer, so its `local` scope is the daemon's emulation described with the operations below. A binding's `provider` is the open `ProviderId`, checked against the registered drivers wherever a request or a provider's reading brings one in; a name with no driver is refused, and a stored row keeps the name as it was written. Two grains share this section deliberately: the config **binding** above and the Plan-003 **runtime-binding leg** (`sessionId` + `bindingId`) — live per-session state (status legs, live mutation results, reconnect targets) always keys by leg, never by collapsing legs into the binding scalar.

```ts
// ---- Primitives (Spec-024) ----
type McpBindingScope = "user" | "project" | "local" | "plugin" | "connector" | "managed"; // scope axis of the binding identity; the first three are writable on every provider, `plugin` names a server an installed plugin carries, and `connector` and `managed` (read-only, the servers a provider brings itself: Claude Code's) name a claude.ai connector and an organization's server: user = the provider's own user configuration, read on the page as `All projects`; project = the project's own file in the repository (Claude Code's `<project>/.mcp.json`, Codex's `<project>/.codex/config.toml`), `This project · in the repo`; local = one project, declared outside the repository (Claude Code's per-project entry in its user configuration; on Codex, which has no such layer, a user entry kept switched off and switched on per conversation in that project's sessions), `This project · not in the repo`. Scope-applicability is PER OPERATION (see the operations block)
type McpApplicationGrade = "liveReconcile" | "userConfigWrite" | "nextRun" | "daemonEnforced"; // when/where a mutation takes effect — honest, typed, never silent (parity-triad degrade-honestly): live session set / provider config store (subsequent runs) / next-run composed config / daemon decision layer (immediate)
type McpApprovalMode = "auto" | "prompt" | "writes" | "approve"; // Codex-native vocabulary adopted as the normalized set; Claude-side enforcement is daemon-owned (Spec-024 §Tool-Level Overrides)

// The scope-qualified server binding (Spec-024 §Unified Inventory): identity is (provider, scope,
// scopeRef, serverName) — never merged across providers OR scopes. Same-named servers in two scopes
// are distinct configurations with independent status and overrides; collapsing them would bleed
// overrides across configurations.
// Structural validity is type-level (an internally tagged enum on `scope`), not service-layer:
// `user` FORBIDS scopeRef (persisted as '' in the daemon tables), and `project`/`local` REQUIRE a
// canonical non-empty scopeRef (the project root), so unrelated projects can never collapse onto
// one empty-string PK component. Payload/read-model types compose this union via intersection
// (never `interface extends` — unions don't extend).
// A fourth arm names a server an installed plugin carries in its `.mcp.json`, its scopeRef the
// plugin's name: listed on the MCP servers page as `From plugin <name>` and sent to a session only
// when switched on for it. Its declaration changes only with the plugin, so mcp.server.upsert and
// mcp.server.delete refuse it; mcp.server.enabled.update and the tool overrides target it.
// A binding in a scope the person writes, its declaration in a provider's own config. A `project`
// or `local` scopeRef is the project's root folder, with `place`, the WSL 2 distribution it is in,
// its path in Linux form there; absent elsewhere, so one path in two distributions is two roots.
// `WslPlace` and `PlacedPath` are `@ai-sidekicks/contracts/place`'s `{ distro: string }` and `{
// path: string; place?: WslPlace }`.
type McpWritableBindingRef =
  | { provider: ProviderId; scope: "user"; serverName: string }
  | {
      provider: ProviderId;
      scope: "project";
      scopeRef: string;
      place?: WslPlace;
      serverName: string;
    }
  | {
      provider: ProviderId;
      scope: "local";
      scopeRef: string;
      place?: WslPlace;
      serverName: string;
    };
// Two read-only arms name the servers a provider brings itself, Claude Code's today, listed in the page's
// `claude.ai · <account name>` group of each account and its `Organization` group: a claude.ai connector, its scopeRef the provider account's id (connectors
// are that claude.ai account's own) and its serverName the display name Claude Code reports
// (`claude.ai Slack`); and an organization's server, from `managedMcpServers` or `managed-mcp.json`,
// with no scopeRef and its address served as the host only. upsertServer and removeServer refuse both,
// and the tool overrides apply to both; setEnabled takes them with a projectRoot, the daemon's own
// per-project switch.
type McpReadOnlyBindingRef =
  | { provider: ProviderId; scope: "connector"; scopeRef: string; serverName: string }
  | { provider: ProviderId; scope: "managed"; serverName: string };
type McpServerBindingRef =
  | McpWritableBindingRef
  | { provider: ProviderId; scope: "plugin"; scopeRef: string; serverName: string }
  | McpReadOnlyBindingRef;

// Event-side binding identity (Spec-024 §Status Observation and Events): path-free. scopeRef
// (canonical project root / keying directory) is a user-specific filesystem path — a Spec-020
// durable-tier PII class — and event payloads are durable and re-read on every rebuild, so the raw path never
// enters them: an event names the provider, the scope and the server, and nothing else.
// Requests and inventory reads keep the full McpServerBindingRef (transient wire / the person's read,
// not durable audit rows).
interface McpServerBindingAuditRef {
  provider: ProviderId;
  scope: McpBindingScope;
  serverName: string;
}

// The binding's id on the wire: opaque and path-free, the lowercase hex of a blake3 hash over the
// binding's whole key (provider, scope, scopeRef, the root's distribution, serverName), so it is the
// same on the binding's mcp.server.list entry and on every status notice about it, and across the
// daemon's runs. The audit ref names a binding to a person; this id places every status notice on
// its row, which the audit ref alone cannot where two bindings share it (two project roots with a
// `github` server, or one root in two WSL 2 distributions). A page never re-reads the list to place
// a notice.
type McpServerBindingId = string; // 64 lowercase hex digits

// Effective-binding derivation output (Plan-022 T22.4.5). NOT a carrier threaded in from another plan — Plan-022 derives this
// in-plan from the session sets it builds (T22.3.3, T22.3.8). `null` is a first-class answer meaning the tool
// resolved from NO governed binding: a provider built-in, or a tool served by the daemon's own
// ephemeral callback-tool host (Spec-004 §Required Behavior), which sits outside Spec-024 governance
// entirely (Spec-024 §Non-Goals) and is never override-governed.
// NEVER derived by parsing the delivered wire tool name: provider-side `mcp__<server>__<tool>`
// prefixing and collision-suffixing are provider defaults rather than wire invariants, so the
// mapping runs off the daemon's own registration identity.
type McpEffectiveBinding = McpServerBindingRef | null;

// mcp.server.upsert config input — the normalized governed surface, discriminated on transport.
// Env-var and header VALUES are write-only credential-adjacent material: accepted here, passed only
// to the sanctioned provider write path, NEVER round-tripped in inventory reads or event payloads
// (names may appear; values never do). Which transports and members a provider takes is that
// provider's own declaration, the tool-server transports and fields in its driver's descriptor,
// which `provider.list` carries: the form checks against it as the person types, and the daemon
// checks the request against the binding's provider again, refusing a transport or member that
// provider does not declare with mcp.server.configInvalid before anything is written. The comments
// below name the provider whose native field each member is.
// EVERY SCOPE TAKES WHAT THE PERSON TYPES: at `project` scope the values are written into the
// project's file in that provider's own format, as at the other scopes. A declaration may name a
// variable in place of a value — a Claude Code `env` or `headers` value written as a `${VAR}` or
// `${VAR:-default}` reference, a Codex server naming its variables through `envVars`,
// `envHttpHeaders` and `bearerTokenEnvVar`. On Claude Code the daemon expands the references from
// the session's own start environment before it sends the server set, holding the expanded value
// only for that call and never storing or logging it.
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
      envVars?: string[]; // Codex's `env_vars` — variable NAMES the server inherits from the environment Codex starts in
      enabled?: boolean; // whether the server is on; unset keeps the provider's value. Written to the provider's own field where it has one, else kept as the daemon's per-server enabled overlay
      required?: boolean; // Codex's `required` — thread start/resume fails if the server cannot initialize
      startupTimeoutSec?: number; // Codex's native timeout
      toolTimeoutSec?: number; // Codex's native timeout
    }
  | {
      transport: "http" | "sse"; // "sse" is a Claude Code transport; Codex declares none
      url: string; // absolute http(s) URL, taken as typed and passed to the provider write path as typed, a user name or password in it included. That user name and password and the query-string VALUES are write-only credential-equivalent material: accepted, passed on — never round-tripped (the view serves query param NAMES)
      headers?: Record<string, string>; // write-only values (see above)
      bearerTokenEnvVar?: string; // Codex's `bearer_token_env_var` — the env-var NAME, never the value
      envHttpHeaders?: Record<string, string>; // Codex's `env_http_headers` — header NAME → env-var NAME (both references, no values; resolved provider-side at connect time)
      oauthScopes?: string[]; // Codex's `scopes` — OAuth scopes requested for the server's auth flow
      oauthResource?: string; // Codex's `oauth_resource` — the RFC 8707 resource indicator for the flow
      enabled?: boolean;
      required?: boolean; // Codex's (as above)
      startupTimeoutSec?: number; // Codex's (as above)
      toolTimeoutSec?: number; // Codex's (as above)
    };

// Redacted normalized config view (Spec-024 §Unified Inventory): the read-back of what
// mcp.server.upsert wrote — every non-secret field preserved, secret VALUES structurally absent
// (env/header/query-param NAMES only), so mcp.server.read supports read/edit workflows without the
// daemon ever serving credential material. command/args are process-visible strings the person
// authors — the same documented residual class as serverName/toolName in the preamble; the URL is
// NOT in that class (an http URL is not a process argument): it serves query-redacted below.
type McpServerConfigView =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      envVarNames?: string[]; // the env map's KEYS; values never round-trip
      enabled?: boolean;
      required?: boolean; // Codex's, as on input
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    }
  | {
      transport: "http" | "sse";
      url: string; // QUERY-REDACTED: scheme + host + path only (a user name or password, like the query values, is credential-equivalent and never round-trips)
      urlQueryParamNames?: string[]; // the query string's parameter NAMES when one existed; values never round-trip (the env/header names-not-values discipline)
      headerNames?: string[]; // the header map's KEYS; values never round-trip
      bearerTokenEnvVar?: string; // an env-var NAME (Codex's), safe to serve
      envHttpHeaders?: Record<string, string>; // Codex's — header NAME → env-var NAME: a name→name reference map, round-trips verbatim
      oauthScopes?: string[]; // Codex's — non-secret auth references, round-trip verbatim
      oauthResource?: string; // Codex's — non-secret auth reference, round-trips verbatim
      enabled?: boolean;
      required?: boolean;
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    }
  | {
      transport: "ws"; // a Claude Code transport, listed but never probed, so its status reads unknown until a session reports it
      url: string; // query-redacted, as above
      urlQueryParamNames?: string[];
      headerNames?: string[];
    };

// Per-leg live status (Spec-024 §Unified Inventory): one config binding can back several concurrent
// sessions' connections; the Plan-003 seam keys observations by runtime-binding leg, and the
// inventory preserves that grain instead of overwriting divergent leg states into one scalar.
interface McpServerLegStatus {
  sessionId: SessionId;
  bindingId: string; // the Plan-003 runtime-binding leg key (provider-driver-capability-payloads.md McpServerStatusUpdate) — NOT this section's config binding
  status: McpServerStatus;
  observedAt?: string; // ISO-8601 of this leg's newest observation
  // Present only on a leg reading "failed" whose session runs in a WSL 2 distribution, because the
  // server's command or arguments name a Windows program, which cannot run there; the leg's session
  // names the distribution. The selected view reads `Its command names a Windows program, which
  // cannot run in Ubuntu. Use the program's name without its folder.`, and a bare command name such
  // as npx is looked up in the distribution and is not marked. One member on the leg, not a status
  // of its own.
  failedReason?: "commandNotRunnable";
}

// Where a provider's own configuration takes a declaration's place or switches it off: a project
// root or settings file, or an administrator's layer the provider reads from no file.
type McpOverrideOrigin = PlacedPath | { managedLayer: "deviceManagement" | "organizationCloud" };

// Inventory read model (mcp.server.list / mcp.server.read): four merged sources per binding —
// provider-declared config, live status (McpServerStatus, provider-driver-capability-payloads.md
// seam), the binding row, the override rows. A DISCRIMINATED PAIR on bindingStoreUnavailable
// (Spec-024 §Fallback Behavior): the normal arm serves all four sources; the degraded arm (binding
// store unreachable) serves the provider-observed sources only, with every store-dependent field
// STRUCTURALLY ABSENT rather than fabricated (tools, whose sources need the override rows, and the
// daemon's enabled overlay live in the unreachable store).
// All mutations fail closed while degraded.
type McpServerInventoryEntry = McpServerBindingRef & {
  serverBindingId: McpServerBindingId; // the id every status notice about this binding carries
  config: McpServerConfigView; // the redacted normalized declaration (see above)
  status: McpServerStatus; // deterministic aggregate over legs[]: most severe current live-leg status (failed > needsAuth > unknown > starting > connected — a live leg whose observation source is lost reports "unknown": lost observability outranks known-healthy states, never a concrete failure), else newest machine-probe observation, else "unknown" — never fabricated
  legs?: McpServerLegStatus[]; // per-leg session-feed observations; absent when no live leg exists. Legs are LIVE-session observations with a bounded lifecycle: when a leg's backing runtime binding closes (session end / driver exit), the daemon retires it and recomputes the aggregate — a terminated session's last status never pins `status`
  observedAt?: string; // ISO-8601 of the newest status observation backing `status`
  probeFailureReason?: string; // the machine probe's newest failure text, at most `ERROR_MESSAGE_MAX_LEN` code points, sanitized (no credential, address query or file path); present only while the probe's reading decides a `failed` status
  supersededIn?: McpOverrideOrigin[]; // unique entries, each a `{path, place?}` (`place` the WSL 2 distribution a path is in) or a `{managedLayer}`: each a project root where another binding of this provider is the effective one, by the provider's order (a project's `local` binding over its `project` one, either over the `user` one, matched by serverName; on Claude Code a plugin's server or a connector also matched when it points at the same address or command), or, on Codex, the settings file (the person's or a project's) or the administrator's layer written in no file (`deviceManagement` for a device-management profile, `organizationCloud` for the policy the provider fetches for the organization) whose entry overrides a lower layer's server field by field; the daemon already resolves this to send each session its effective set (Spec-024 §Status Observation and Events), so it serves the answer rather than the page working it out. The page reads a project root as `Not used in <project>: its own <name> takes its place.` and a settings file or a managed layer as `Overridden by <file or layer>`. Absent where the binding is used wherever it applies; never empty
  disabledIn?: McpOverrideOrigin[]; // unique entries, each a `{path, place?}` (`place` the WSL 2 distribution a root is in) or a `{managedLayer}`. Claude Code: the project roots where this server is switched off — by `disabledMcpServers` in the person's own `~/.claude.json`, which Claude Code's own `/mcp` writes, or, on a `connector` or `managed` binding, by the daemon's per-project switch; the server stays out of those projects' sessions and the page reads `Off in <project>` beside its state, dimmed, once per project. Codex: the settings file or the administrator's layer written in no file whose entry switches the server off. Absent where nothing switched it off; never empty
} & (
    | {
        bindingStoreUnavailable?: never; // the normal (binding-store-available) arm
        enabled: boolean; // whether the binding is on: the provider-declared enabled state composed with the daemon's enabled overlay where the binding keeps its switch there (the overlay lives on the binding row)
        tools: McpToolReading[]; // every tool the server offers, in the order the daemon serves them
      }
    | {
        bindingStoreUnavailable: true; // degraded read: binding store unreachable — mutations fail closed (Spec-024 §Fallback Behavior)
        enabled?: boolean; // the provider's own enabled field only; ABSENT for a binding whose switch the daemon keeps as its enabled overlay — the overlay lives in the unreachable store, and a fabricated value would be a lie
      }
  );

// One tool's settings as the page draws them, every per-tool value saying where it came from: each
// facet's value IN FORCE, resolved by the daemon from the server's own declaration and the person's
// override row, and its source — "server" (`The server's own`) or "override" (`Set here`). Under an
// override the setting also carries `serverValue`, the server's own value a clear returns to (for
// Codex, the preserved native baseline), so the page's control lists only the facet's values and
// choosing the server's own one sends mcp.toolOverride.clear for that facet instead of a set. The
// client draws all of it and derives none.
type McpToolSetting<OverrideValue, ServerValue = OverrideValue> =
  | { source: "server"; value: ServerValue }
  | { source: "override"; value: OverrideValue; serverValue: ServerValue };
type McpToolSettingSource = McpToolSetting<unknown>["source"];
type McpAssignableIdempotencyClass = "idempotent" | "compensable"; // the classes a person assigns; manualReconcileOnly is the floor a clear returns to, never set
interface McpToolReading {
  toolName: string;
  enabled: McpToolSetting<boolean>; // with no override: the provider config (for Codex, the preserved native baseline)
  approvalMode: McpToolSetting<McpApprovalMode>; // with no override: the provider default, in the normalized vocabulary
  idempotencyClass: McpToolSetting<McpAssignableIdempotencyClass, "manualReconcileOnly">; // with no override: the manualReconcileOnly floor, the only class a server's own reading holds
}

// The override REQUEST shape (mcp.toolOverride.update): the facets the request touches; an absent
// facet is left as it stands. At least one facet is REQUIRED — a toolName-only override is
// meaningless and the canonical DDL rejects the all-NULL row, so the Rust type's garde check
// requires "enabled, approvalMode, or idempotencyClass present" and a facet-less request dies as a
// typed validation error, never a constraint failure.
interface McpToolOverride {
  toolName: string;
  enabled?: boolean;
  approvalMode?: McpApprovalMode;
  idempotencyClass?: McpAssignableIdempotencyClass;
}

// The facet mcp.toolOverride.clear clears. One per request: the page clears the one facet the
// person returned to the server's own value, and the tool's other facets stand.
type McpToolOverrideFacet = "enabled" | "approvalMode" | "idempotencyClass";

// Per-facet application grades for override mutations (Spec-024 §Tool-Level Overrides): Codex
// enabled/approvalMode materialize into native config fields (userConfigWrite) in the file that
// holds the binding — the user file for `user` and `local` bindings (an emulated local binding is a
// user entry), the project's `.codex/config.toml` for a `project` binding; Claude enforces all of
// them at the daemon approval/resolution layer (daemonEnforced, immediate).
// Present keys mirror the facets the request touched (or reverted, on clear).
interface McpToolOverrideApplication {
  enabled?: McpApplicationGrade;
  approvalMode?: McpApplicationGrade;
  idempotencyClass?: "daemonEnforced";
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

// ---- Operations (12; JSON-RPC per ADR-009) ---- Reads:
//   mcp.server.list      {refresh?: boolean} → {servers: McpServerInventoryEntry[],
// failedProviders: {provider: ProviderId, cause: string}[]} // each provider is read on its own:
// one whose read fails is left out of `servers` and named in `failedProviders` with its cause,
// sanitized (no credential, URL query or path outside a web address) and capped at the error
// message's length; the other providers' rows still list
//   mcp.server.read       McpServerBindingRef → {server: McpServerInventoryEntry} // a driver's
// refusal answers by its code (`provider.unavailable`, `provider.timeout`); any other failure of
// the provider's read is an internal error
//   mcp.subscribe {} → AsyncIterable<EventEnvelope | McpServerBindingRef & {type:
// "mcp.server.config.changed"} | McpServerStatusChangedNotice> // live-tail of every mcpGovernance
// envelope as appended, a live notice after each edit to a binding (an add, a change, a switch, a
// tool override or a removal, from any client), and a live notice of each status change; neither
// notice is written to any log; a page showing the binding reads it again with mcp.server.read
// (sentinel- and session-bound alike; Plan-005 streaming primitive, session.event.subscribe
// consumer shape). Gap-free by ORDERING, not by cursor: a (re)connecting client opens mcp.subscribe
// FIRST, then reads mcp.server.list — the subscribe acknowledgment precedes the stream's first
// delivery (the Plan-005 I-005-9 wire-ordering invariant), so registration is live before the
// snapshot read and an event concurrent with the snapshot arrives on the stream instead of falling
// between snapshot and subscription (re-observation is harmless — governance envelopes and status
// notices are re-entrant state updates; omission is impossible). A settled sign-in's history is the
// sentinel session's log; a status change has none (Spec-024 §Status Observation and Events)
//   mcp.registry.search {query: string, cursor?: string} → {servers: McpRegistryServer[],
// nextCursor?: string} // `Browse servers`: a search of the public MCP Registry (`GET
// /v0/servers?search=<query>&version=latest` on registry.modelcontextprotocol.io), made by the
// daemon only when the person types and caching nothing past the page. Each result carries its
// title or name, description and version, whether it runs as a package (its `runtimeHint` and
// `runtimeArguments`) or at an address (its `remotes`), and each environment variable's name,
// description and whether it is required — never a value. A pick fills the add form; the person
// still adds the server and types every secret Non-reads (open to this machine's own client or any
// linked device, with no policy check; every operation except mcp.server.reconnect carries the
// MANDATORY clientIdempotencyKey: string — requester-generated UUID; a retry under the same key
// returns the saved result from the durable receipt, Spec-024 §Authorization). The governance
// mutations below finalize their receipt with their store writes and emit no governance event;
// mcp.server.signIn, mcp.server.signOut and mcp.server.reconnect are operational commands —
// oauthLogin is receipted but its durable trace is the asynchronous mcp.server.signIn.completed,
// emitted exactly once per completed sign-in (an abandoned sign-in, or one ended by a newer
// attempt, leaves only its expiring receipt); oauthLogout is receipted, and it and reconnect show
// through the status notices they induce; reconnect is unreceipted:
//   mcp.server.upsert      McpWritableBindingRef & {clientIdempotencyKey: string, config:
// McpServerConfigInput} → {server: McpServerInventoryEntry, applied: McpApplicationGrade,
// liveResults?: McpLiveApplicationResult[]}
//   mcp.server.delete      McpWritableBindingRef & {clientIdempotencyKey: string} → {applied:
// McpApplicationGrade, liveResults?: McpLiveApplicationResult[]} // removing an emulated Codex
// local server also removes the daemon's row for it; removing any server removes every approval
// rule over its tools from the provider's file that holds it, in the same transaction
//   mcp.server.enabled.update        McpServerBindingRef & {clientIdempotencyKey: string, enabled:
// boolean, projectRoot?: string, place?: WslPlace} → {server: McpServerInventoryEntry, applied:
// McpApplicationGrade, liveResults?: McpLiveApplicationResult[]} // projectRoot required on a
// `connector` or `managed` binding and refused on every other, with `place`, the WSL 2 distribution
// the root is in, its path in Linux form there: the daemon's own switch for that one project, never
// Claude Code's `disabledMcpServers`
//   mcp.toolOverride.update   McpServerBindingRef & {clientIdempotencyKey: string, override:
// McpToolOverride} → {server: McpServerInventoryEntry, applied: McpToolOverrideApplication}
//   mcp.toolOverride.clear McpServerBindingRef & {clientIdempotencyKey: string, toolName: string,
// facet: McpToolOverrideFacet} → {server: McpServerInventoryEntry, applied:
// McpToolOverrideApplication} // clears that one facet back to the server's own value (a Codex
// facet restored from the binding's baseline) and leaves the tool's other facets set; clearing a
// tool's last set facet drops its override row; `applied` carries the cleared facet's grade alone
//   mcp.server.signIn        McpServerBindingRef & {clientIdempotencyKey: string} →
// {authorizationUrl?: string} // starts the daemon's own sign-in for that server, whatever kind of
// server it is, and returns the address of the sign-in page for the client to open; a new
// mcp.server.signIn on a server whose sign-in is still waiting ends that wait and starts the next
// attempt; a server that publishes no sign-in route (no protected-resource or authorization-server
// metadata, or metadata the daemon cannot read) is refused with mcp.server.signInUnsupported;
// mcp.server.signInFailed is LAUNCH-phase only — a failure to start the sign-in (discovery,
// registration, or the provider's own flow in its throwaway home) — and an async completion failure
// arrives as mcp.server.signIn.completed outcome: 'failure' on the mcp.subscribe stream, never a
// late JSON-RPC error (Spec-024 §OAuth Orchestration). Its idempotency receipt persists the
// acknowledgment with authorizationUrl STRUCTURALLY OMITTED (single-use PKCE-bearing launch
// material is never durable — Plan-022 I-022-1), so an identical-key retry returns a saved
// acknowledgment with no URL: the sign-in already started, completion arrives as the event, and a
// caller that never received the URL starts a new sign-in under a fresh key
//   mcp.server.signOut       {serverId: string, clientIdempotencyKey: string} → EmptyPayload //
// `Sign out of this server`. `serverId` is the server's address, not a scope-qualified binding: the
// daemon holds one sign-in per server, used by every provider and every binding that names it, and
// each of those bindings' change after the sign-out arrives as its status notice on mcp.subscribe.
// It deletes the daemon's refresh token for the server, and its signing key where the server
// demands proof-of-possession tokens, and ends the access tokens it handed out, so each provider's
// next call to that server carries no token and the server reads `needsAuth` in every session on
// every provider until the next sign-in
//   mcp.server.reconnect         McpServerBindingRef & {sessionId?: SessionId, bindingId?: string}
// → {legs: McpServerLegStatus[]} // operational: restarts the binding's live provider leg(s),
// LEG-ADDRESSABLE — exactly one leg when bindingId is given (with sessionId, both must name the
// same leg), every live leg of one session when only sessionId is given, every live leg otherwise;
// per-leg post-reconnect statuses, honest per leg Session operations (Spec-024 §A session's own
// tool servers), in the session.* namespace; none emits a governance event:
// `serverName` is the server's name in the session's own list, the name each provider starts the
// session's servers by; it is not the address `mcp.server.signOut` takes, and a server run as a
// local command has none.
//   session.mcpServer.subscribe   {sessionId} → a live list of the servers the session was started
// with, each row the server's name, binding, status with its reason, whether it is on for the
// session, and whether a switch waits for the next turn — names and statuses only, never a config
// value
//   session.mcpServer.enabled.update {sessionId, serverName, enabled} // narrows only: off stops
// the session offering that server's tools; kept with the session, applied at the next turn and
// sent again after each resume; a new session starts with every server on
//   mcp.resource.list {sessionId, serverName} → {serverName, resources, complete} // what a working
// server offers, for the composer's attachment row; refused for a server that is off or not working
// Scope applicability is per operation (Spec-024 §Configuration Mutation), never a blanket rule.
// upsertServer and removeServer take an McpWritableBindingRef, the three writable scopes, so a
// `plugin`, `connector` or `managed` binding is a schema-level rejection; setEnabled takes any
// McpServerBindingRef, and on a `plugin` binding it is the daemon's own switch and on a `connector`
// or `managed` one the daemon's own switch for its projectRoot, neither writing provider
// configuration. On the three writable scopes, upsertServer, removeServer and setEnabled write the
// provider's own configuration, each provider through its own mechanism:
// Claude Code writes through `claude mcp add-json <name> <json> --scope <scope>` (a `project` write
// run from the project root, landing in `<project>/.mcp.json`; `local` in Claude Code's per-project
// entry of its user configuration); Codex `user` writes through `config/value/write`; Codex
// `project` is a format-preserving edit of `<project>/.codex/config.toml` written to a temporary
// file and renamed into place only while the file still hashes to what the daemon last read (else
// mcp.server.configWriteConflict), then read back with `config/read` and reloaded with
// `config/mcpServer/reload`; Codex `local` is emulated as a user entry with `enabled = false`,
// switched on per conversation in each session of that project, its name unique across the user
// file (a clash is refused, naming the project that holds the other one).
// Overrides, oauthLogin and reconnect apply to any binding, and oauthLogout to any server.
// One mcp.registry.search result, read from the registry's own record. Untrusted data: it fills the
// add form and nothing else, and no value of any environment variable is ever part of it.
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
// (provider, scope, serverName) — never the raw scopeRef (see the audit-ref comment above); the
// status notice also carries the binding's path-free serverBindingId, which places it on its row. A
// status change is a live notice on mcp.subscribe and is written to no log; a settled sign-in is a
// durable row, and Spec-024 forbids filesystem paths in both.
type McpServerStatusChangedNotice = McpServerBindingAuditRef & {
  type: "mcp.server.status.changed";
  serverBindingId: McpServerBindingId; // places the notice on its mcp.server.list row
  // "sessionFeed": the leg's own status before and now, so a page updates that leg's line; "sessionEnded": the aggregate before the leg left and over the legs that remain; "machineProbe": the probe's own reading before and now
  previousStatus: McpServerStatus;
  status: McpServerStatus;
  failureReason?: string; // sanitized
  // a session's own feed, a session's leg leaving the binding (retired, now serving the server from another binding, or with the server switched off for it), or the daemon's probe of a server no session runs
  origin: "sessionFeed" | "sessionEnded" | "machineProbe";
  // REQUIRED for origins "sessionFeed" and "sessionEnded", the session whose feed saw it or whose leg left; ABSENT for "machineProbe"
  sessionId?: SessionId;
  // REQUIRED for origin "sessionFeed", the instant of the reading that changed the leg's status; ABSENT otherwise. The list's legs[].observedAt is the leg's newest reading, so it may be newer than the last notice's while the status agrees
  observedAt?: string;
  bindingId?: string; // REQUIRED for origins "sessionFeed" and "sessionEnded" — the Plan-003 runtime-binding leg key (opaque daemon-minted id), attributing the transition to its legs[] entry when one binding backs several legs in the same session; on "sessionEnded" the leg that left, `status` then the aggregate over the legs that remain, so the page drops that leg and reads nothing again; ABSENT for "machineProbe" (no leg observed). The Rust type holds the conditionality (a type where the arms allow, else a garde check)
};
type McpServerSignInCompletedPayload = McpServerBindingAuditRef & {
  outcome: "success" | "failure"; // 'failure' IS the asynchronous completion-failure channel (Spec-024 §OAuth Orchestration — launch failures are errors, completion failures are events)
  failureReason?: string; // sanitized — never tokens, authorization codes, or URLs with embedded secrets
  initiatingSessionId?: SessionId;
};
```
