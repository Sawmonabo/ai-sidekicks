# Spec-028: MCP Server Configuration and Governance

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `028` |
| **Slug** | `mcp-server-configuration-and-governance` |
| **Date** | `2026-07-22` |
| **Author(s)** | Capability-enhancement campaign (B18) |
| **Depends On** | [Spec-005](./005-provider-driver-contract-and-capabilities.md) (driver contract, `McpServerStatus`, tool-metadata registry, idempotency classes), [Spec-006](./006-session-event-taxonomy-and-audit-log.md) (event taxonomy — `mcp_governance` category per the 2026-07-22 B18 amendment), [Spec-012](./012-approvals-permissions-and-trust-boundaries.md) (approval categories, trust boundaries), [ADR-012](../decisions/012-cedar-approval-policy-engine.md) (Cedar policy engine), [ADR-015](../decisions/015-v1-feature-scope-definition.md) (feature #18), [ADR-018](../decisions/018-cross-version-compatibility.md) (cross-version compatibility) |
| **Implementation Plan** | [Plan-028](../plans/028-mcp-server-configuration-and-governance.md) |

## Purpose

This spec defines V1 feature #18 ([ADR-015 §Decision](../decisions/015-v1-feature-scope-definition.md#decision)): how the local runtime daemon configures, governs, and observes **MCP servers** attached to the two provider CLIs (`claude` and `codex`). Both providers are MCP _clients_ that own their MCP server connections; the daemon never joins the MCP wire. What the daemon owns is the **governance layer** above those connections:

1. A **unified server inventory** — one normalized read model across both providers' divergent config surfaces.
2. **Configuration mutation** — add / update / remove / enable / disable servers through each provider's sanctioned mechanism, never by blind config-file rewriting.
3. A **trust store** — operator-granted, config-hash-bound trust per server, untrusted by default, auto-revoked on config drift. This is the operator-managed trusted-server store that [ADR-015 §References](../decisions/015-v1-feature-scope-definition.md#references) binds MCP annotation trust to: the MCP spec requires clients to treat tool annotations as untrusted unless the server is trusted, and trust classification MUST bind on this store, never on annotation self-claims.
4. **Tool-level overrides** — per-(server, tool) enable/disable, approval-mode, and idempotency-class assignment, feeding the [Spec-005](./005-provider-driver-contract-and-capabilities.md) tool-metadata resolution layer.
5. **OAuth orchestration** — driving each provider's own login flow for servers that require it; the daemon never stores tokens.
6. **Status observation** — normalizing both providers' server-status feeds onto the Spec-005 `McpServerStatus` enum and the session event timeline.
7. **Audit** — every governance mutation and status transition emits a canonical event in the `mcp_governance` category ([Spec-006 §MCP Governance (`mcp_governance`)](./006-session-event-taxonomy-and-audit-log.md#mcp-governance-mcp_governance), 2026-07-22 B18 amendment).

## Scope

- The `mcp.*` IPC operation namespace (10 operations) on the daemon control surface.
- Normalized server inventory merging provider-declared config, live provider status, the daemon trust store, and the daemon override store.
- Provider-specific mutation engines: the Claude Code live-reconcile / next-run pair and the Codex user-config CRUD + reload pair.
- The `mcp_server_trust` and `mcp_tool_overrides` SQLite tables (daemon-local, node-scoped).
- Cedar-gated authorization for every governance mutation (node-operator scope).
- The five `mcp.*` event types and their payloads, session binding, and sanitization rules.
- OAuth login orchestration for both providers, including the honest degradation for flows a mode cannot run in-band.

## Non-Goals

- **No MCP protocol implementation.** The daemon is not an MCP client or server and does not proxy, intercept, or transform MCP traffic. Provider CLIs own their connections end to end.
- **No token custody.** OAuth tokens, bearer tokens, and API keys live where each provider stores them. The daemon never reads, persists, or relays credential material, and event/error payloads never carry it.
- **No config-store ownership.** Provider config files (`~/.claude.json` scopes, `$CODEX_HOME/config.toml`, project-local `.codex/config.toml`, `.mcp.json`) remain provider-owned; the daemon mutates them only through each provider's sanctioned write mechanism and treats them as the source of truth it observes, not a mirror it maintains.
- **No server marketplace, registry, or discovery.** V1 governs servers the operator declares; it does not fetch, recommend, or install them.
- **No remote governance mutation.** V1 authorizes only the node-local operator (the caller-owns-the-node model, [BL-141](../backlog.md)); control-plane-relayed mutation attempts are denied, not queued.
- **No session-role permission-matrix extension.** Governance is node-operator authority, deliberately outside the session-role matrix ([Security Architecture §Permission Matrix (Task 5.4)](../architecture/security-architecture.md#permission-matrix-task-54)); the only session-role-facing MCP surface remains `mcp_elicitation` approvals per Spec-012.
- **No Codex project-local config writes.** V1 observes cwd-resolved `.codex/config.toml` (trusted projects) read-only; writes target user scope only (see §Fallback Behavior for the honest degradation).

## Domain Dependencies

- [Session model](../domain/session-model.md) — sessions observe node-scoped governance changes through the event timeline; the daemon-scope sentinel binding rule is Spec-006's.
- [Glossary](../domain/glossary.md) — provider, driver, runtime node, operator terminology.

## Architectural Dependencies

- [Spec-005 §Tool Metadata](./005-provider-driver-contract-and-capabilities.md#tool-metadata) — the `manual_reconcile_only` floor for MCP-sourced tools and the tool-metadata resolution layer this spec's overrides feed.
- [Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring](./006-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding-and-node-scope-anchoring) — the sentinel-session binding rule for node-scoped events.
- [Spec-012](./012-approvals-permissions-and-trust-boundaries.md) + [ADR-012](../decisions/012-cedar-approval-policy-engine.md) — Cedar evaluation for governance mutations; the `mcp_elicitation` approval category for run-time server elicitations stays Spec-012-owned.
- [API Payload Contracts §Plan-028 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-028--mcp-governance-contract-surfaces) — typed operation and event payload mirrors.
- [Error Contracts §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance) — the `mcp.*` error-code registry.
- [Local SQLite Schema §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028) — `mcp_server_trust` + `mcp_tool_overrides` DDL.
- [Provider wire references](../reference/provider-wire/README.md) — version-pinned primary-source shapes for every provider mechanism this spec binds to; the trust model there (Verified-at-pin, Provisional beyond) governs the re-verify-at-execution rule in §Implementation Notes.

## Preconditions

- [ ] All declared `Depends On` specs are at `approved` status — Spec-005 and Spec-012 are `approved`; Spec-006 is at `review` while its 2026-07-22 B18 amendment (authored in the same PR as this spec) awaits its restoring re-promotion, the named W3 follow-on gate
- [x] All declared `Depends On` ADRs are at `accepted` status
- [x] Blocking open questions are resolved or explicitly deferred
- [ ] **Spec-status promotion gate cleared per [`docs/operations/plan-implementation-readiness-audit-runbook.md#spec-status-promotion-gate`](../operations/plan-implementation-readiness-audit-runbook.md#spec-status-promotion-gate)**

## Required Behavior

### Provider Capability Model

Both providers expose MCP configuration, status, and auth surfaces, but through structurally different mechanisms. Per the capability-parity principle (all provider capabilities integrate at V1; asymmetries are normalized, emulated, or degraded honestly — never silently dropped), the daemon binds to each mechanism natively and grades what each application path can deliver:

| Capability | Claude Code mechanism | Codex mechanism |
| --- | --- | --- |
| Declare servers for a session | Per-run ephemeral config: `--mcp-config <file-or-inline-json>` + `--strict-mcp-config` (ignores other scopes) | cwd-resolved project-local `.codex/config.toml` (trusted projects) layered over `$CODEX_HOME/config.toml` |
| Mutate a live session's server set | `mcp_set_servers` control request — SDK `setMcpServers(servers)` returning `{added, removed, errors}`; streaming-input mode only; version floor CLI `2.1.210` / SDK `0.3.166` | Not live per-thread; config write + `config/mcpServer/reload` applies to subsequent thread starts |
| Mutate durable config | Ephemeral-config regeneration at next run (V1 posture; the daemon does not rewrite `~/.claude.json`) | `config/value/write` / `config/batchWrite` with `expected_version` optimistic concurrency; user scope (`$CODEX_HOME/config.toml`) only |
| Server status | Init census `mcp_servers[]` + `mcpServerStatus()` SDK query; `claude mcp list` glyphs (human CLI, no `--json`) | `mcpServerStatus/list` (ephemeral, cursored, `thread_id`-scopable) + `mcpServer/startupStatus/updated` notifications |
| Per-server reconnect | SDK `reconnectMcpServer()` | `mcpServer/refresh` |
| Enable/disable | SDK `toggleMcpServer()` (live) / config regeneration (next run) | `enabled` field write + reload |
| Tool allow/deny + approval mode | Daemon-enforced (no native per-tool config field; the daemon's approval layer enforces overrides) | Native config fields: `enabled_tools` (allow), `disabled_tools` (deny, applied after allow), `default_tools_approval_mode` (`auto`\|`prompt`\|`writes`\|`approve`), `tools.<t>.approval_mode` |
| OAuth login | `claude mcp login <server>` (CLI ≥ `2.1.186`) / `/mcp` panel; no dedicated completion event — completion is observed as a status flip to `connected` | `codex mcp login <server>` and app-server `mcpServer/oauth/login` → `authorization_url`; completion notification `mcpServer/oauthLogin/completed` |
| Required-server gating | Not native; daemon surfaces failed servers via status | `required = true` ⇒ `thread/start` / `thread/resume` FAIL if the server cannot initialize |

Every mutation response MUST carry an **application grade** — `live_reconcile`, `next_run`, or `user_config_write` — so callers know _when_ the change takes effect. Degradation is honest and typed, never silent: a Claude mutation below the live-reconcile version floor succeeds with grade `next_run`, not an error and not a fake `live_reconcile`.

### Unified Inventory

- The daemon MUST expose one normalized inventory (`mcp.list` / `mcp.get`) merging four sources per server: (1) provider-declared configuration (parsed from the provider's own config surfaces), (2) live provider status normalized onto `McpServerStatus` (`unknown | starting | connected | needs-auth | failed` per [Spec-005](./005-provider-driver-contract-and-capabilities.md) — the api-payload `McpServerStatus` union), (3) the daemon trust row, (4) the daemon tool-override rows.
- Server identity is the pair `(provider, serverName)`. The inventory MUST NOT merge same-named servers across providers into one logical entry — provider config semantics differ, and a cross-provider merge would launder trust.
- Provider states outside the normalized enum map deterministically: Claude `pending` → `starting`; Claude `disabled` → `enabled: false` on the inventory entry with status from the last observation (or `unknown`); absence of any status source → `unknown`, honestly.
- First observation of a server the trust store has never seen MUST upsert an untrusted trust row (`trusted = 0`) — observation creates the governance anchor; it never creates trust.

### Configuration Mutation

- Mutations (`mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`) MUST route through the provider-native mechanism for the target provider, per the capability table above.
- **Claude, live path:** when the running CLI/SDK pair satisfies the version floor (capability-probed at driver spawn, not assumed from the pin), the daemon applies mutations via `setMcpServers` and MUST reconcile the returned `{added, removed, errors}` against the requested delta; partial failures surface per-server, not as a blanket success. The call replaces the named-server set but keeps unnamed plugin-provided servers — the daemon MUST always send the full desired named-server set, never a delta.
- **Claude, next-run path:** below the floor (or outside streaming-input mode), the daemon records the desired set and applies it as the regenerated ephemeral `--mcp-config` payload at the next run start, returning grade `next_run`.
- **Codex:** the daemon writes user-scope config via `config/batchWrite` (multi-field mutations MUST be batched — one version check, one reload) with `expected_version` from the immediately-preceding `config/read`; on `configVersionConflict` the daemon MUST re-read and retry exactly once, then surface `mcp.config_write_conflict`. After a successful write the daemon MUST trigger `config/mcpServer/reload` (or per-server `mcpServer/refresh` when scoped to one server).
- Codex project-local `.codex/config.toml` entries appear in the inventory (source `project`) but are read-only in V1; a mutation targeting one fails with `mcp.config_scope_unsupported` and actionable guidance naming the file to edit.
- Every applied mutation MUST emit `mcp.server_config_changed` with the change kind, application grade, and post-change config hash — and MUST NOT include config values (env vars, headers, URLs with embedded credentials, tokens) in the event payload.

### Trust Governance

- Trust is per `(provider, serverName)`, granted and revoked only by the node operator via `mcp.setTrust`, Cedar-gated.
- A trust grant MUST bind to the server's current **config hash**: `b3:`-prefixed BLAKE3 over the RFC 8785 JCS canonicalization of the normalized server config (the same canonical-bytes discipline as [Spec-006 §Integrity Protocol](./006-session-event-taxonomy-and-audit-log.md#integrity-protocol)). Trust means "the operator trusts _this_ configuration", not the name.
- On any observation where a trusted server's current config hash differs from the bound hash, the daemon MUST auto-revoke trust (`trusted = 0`, `revoked_reason = 'config_drift'`) before the changed config is used, and emit `mcp.server_trust_changed` with `reason: 'config_drift'`. Re-trusting after drift is an explicit operator action.
- Trust consequences (the enforcement points other specs own but this store feeds):
  - MCP tool **annotations** (`readOnlyHint`, `destructiveHint`, etc.) are honored in daemon decision surfaces only for trusted servers, per the ADR-015 binding of the MCP spec's annotation-trust MUST. Untrusted servers' annotations are display-only.
  - **Safety-weakening tool overrides** (idempotency-class assignment off the floor; approval modes weaker than the provider default) require a trusted server — `mcp.trust_required` otherwise. Safety-tightening overrides (disable a tool, force `approve` mode) are allowed regardless of trust.

### Tool-Level Overrides

- `mcp.setToolOverride` / `mcp.clearToolOverride` manage per-`(provider, serverName, toolName)` rows carrying up to three optional facets: `enabled` (allow/deny), `approvalMode` (`auto | prompt | writes | approve` — the Codex-native vocabulary, adopted as the normalized set), `idempotencyClass` (`idempotent | compensable`; absence means the [Spec-005](./005-provider-driver-contract-and-capabilities.md) `manual_reconcile_only` floor).
- Enforcement is provider-graded: for Codex, `enabled`/`approvalMode` facets are materialized into the native config fields (`enabled_tools` / `disabled_tools` / `tools.<t>.approval_mode`) on write; for Claude, the daemon enforces them at its own approval layer (Spec-012 evaluation sees the override before prompting). The `idempotencyClass` facet is provider-independent: it feeds the Spec-005 tool-metadata resolution layer, which downstream consumers (recovery/replay per Spec-015) already read — consumers never read the override table directly.
- Idempotency-class assignment is the **only** governed path off the `manual_reconcile_only` floor ([Spec-005 §Tool Metadata](./005-provider-driver-contract-and-capabilities.md#tool-metadata)): operator-initiated, Cedar-gated, trusted-server-only, and always audited via `mcp.tool_override_changed`.
- Every override mutation emits `mcp.tool_override_changed` (set and clear alike).

### Authorization

- Every governance mutation (`mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setTrust`, `mcp.setToolOverride`, `mcp.clearToolOverride`, `mcp.oauthLogin`, `mcp.reconnect`) MUST be authorized through the Plan-012 Cedar evaluation surface (`PermissionCheckService`) under a dedicated `mcp` Cedar action family before any provider call or store write. Read operations (`mcp.list`, `mcp.get`) are operator-readable without a Cedar mutation check.
- The V1 principal model is **caller-owns-the-node**: only the node-local operator identity is authorized; callers arriving via control-plane relay receive `mcp.operator_scope_required`. The formalized remote-caller authorization model is [BL-141](../backlog.md)'s scope and a V1.1 ADR trigger, not a V1 surface.
- A Cedar deny returns `mcp.governance_denied`; authorization is evaluated before existence checks so the refusal is stable and does not leak inventory contents to unauthorized callers.
- No new approval _category_ is minted: governance mutations are direct Cedar authorization decisions, not interactive approval requests, so the [api-payload `ApprovalCategory`](../architecture/contracts/api-payload-contracts.md#shared-enums) union is unchanged; `mcp_elicitation` (run-time server elicitations) remains the only MCP-related approval category, owned by Spec-012.

### OAuth Orchestration

- `mcp.oauthLogin` starts the provider's own flow. Codex: app-server `mcpServer/oauth/login` — the daemon returns the provider's `authorization_url` to the caller, then observes `mcpServer/oauthLogin/completed` and emits `mcp.server_oauth_completed` with the outcome. Claude: interactive contexts route to `claude mcp login <server>`; the daemon observes completion as the server-status flip (there is no dedicated completion event on this provider) and emits `mcp.server_oauth_completed` on the flip.
- In a mode where the provider cannot run the flow in-band (Claude non-interactive), `mcp.oauthLogin` fails with `mcp.oauth_unsupported` and guidance naming the out-of-band command; the server's `needs-auth` status remains the visible state.
- The daemon MUST NOT store, log, or relay tokens, authorization codes, or PKCE material; the only durable trace is the `mcp.server_oauth_completed` event, whose payload carries the server identity and outcome, never credentials or URLs with embedded secrets.

### Status Observation and Events

Five event types, `mcp_governance` category ([Spec-006 §MCP Governance (`mcp_governance`)](./006-session-event-taxonomy-and-audit-log.md#mcp-governance-mcp_governance)):

| Event | Emission point | Session binding |
| --- | --- | --- |
| `mcp.server_status_changed` | Normalized status transition from either provider feed (Codex `mcpServer/startupStatus/updated` / `mcpServerStatus/list` deltas; Claude init census + `mcpServerStatus()` deltas) | Per-event: the observing session's real `session_id` when the observation is a session-scoped provider feed; the daemon-scope sentinel for node-level probes |
| `mcp.server_config_changed` | Every applied configuration mutation | Sentinel-bound (node-scope) per [Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring](./006-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding-and-node-scope-anchoring); `initiatingSessionId` in the payload when a session-scoped caller initiated |
| `mcp.server_trust_changed` | Trust grant, operator revoke, config-drift auto-revoke | Sentinel-bound; `initiatingSessionId` when applicable (absent on drift auto-revoke) |
| `mcp.tool_override_changed` | Override set / clear | Sentinel-bound; `initiatingSessionId` when applicable |
| `mcp.server_oauth_completed` | Provider flow completion (Codex notification; Claude status-flip observation) | Sentinel-bound; `initiatingSessionId` when applicable |

- Status observation is event-driven plus on-demand (`mcp.list` refresh); the daemon MUST NOT busy-poll provider status endpoints.
- All five payloads are PII-free by construction (server names, tool names, hashes, enums, sanitized failure reasons); `failureReason` fields pass the daemon's error-sanitization layer and MUST NOT echo config values or filesystem paths.

### Required-Server Semantics

- A Codex server with `required = true` that fails to initialize fails the thread start/resume; the daemon MUST map that failure onto the run-failure path with an actionable error naming the server, and emit `mcp.server_status_changed` (`failed`) for it — the run failure is never silent or attributed to the provider generically.

## Default Behavior

- New servers are enabled per provider config, **untrusted** in the daemon trust store, with no tool overrides (provider defaults + `manual_reconcile_only` idempotency floor).
- `mcp.list` serves the merged inventory from the most recent observations without forcing a provider round-trip; `refresh: true` forces one.
- Claude mutations prefer the live path whenever the capability probe says it exists; callers never select the mechanism, only observe the returned grade.
- Event emission is on-transition only — an unchanged status re-observation emits nothing.

## Fallback Behavior

- **Claude below the live-reconcile floor** (CLI < `2.1.210` or SDK < `0.3.166`, or a non-streaming-input session): mutations apply at next run, grade `next_run`.
- **Codex write conflict:** one silent re-read-and-retry; a second `configVersionConflict` surfaces `mcp.config_write_conflict` with both version tokens so the caller can re-inspect.
- **Codex project-scope mutation:** `mcp.config_scope_unsupported` with the resolved project config path in the _message guidance only_ (never in event payloads).
- **Status source unavailable** (provider down, probe unsupported at the running version): inventory serves `unknown` with an `observedAt` timestamp; the daemon does not fabricate `connected`/`failed`.
- **OAuth not runnable in-band:** `mcp.oauth_unsupported` + out-of-band guidance (see §OAuth Orchestration).
- **Trust store unavailable** (storage failure): governance reads degrade to inventory-without-trust with an explicit `trustUnavailable: true` marker; all mutations fail closed.

## Interfaces And Contracts

- **IPC operations** (10, JSON-RPC per [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md); registered in the Plan-007 `MethodRegistry` at Plan-028's tier per the `presence.*` late-namespace precedent): `mcp.list`, `mcp.get`, `mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setTrust`, `mcp.setToolOverride`, `mcp.clearToolOverride`, `mcp.oauthLogin`, `mcp.reconnect`. Typed request/response mirrors live in [API Payload Contracts §Plan-028 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-028--mcp-governance-contract-surfaces).
- **Events**: the five `mcp.*` types above; payload mirrors in the same api-payload section; category registration in Spec-006; contracts-package registration via Plan-006 T1.10.
- **Errors**: the nine-code `mcp.*` registry in [Error Contracts §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance) — the six codes narrated in §Required Behavior plus `mcp.server_not_found`, `mcp.config_invalid`, and `mcp.oauth_flow_failed` for the unknown-server, malformed-config, and failed-provider-flow outcomes every mutation surface shares.
- **Driver seam**: consumes the Spec-005/B10 `onMcpServerStatus` producer seam (`McpServerStatusEmission` → `McpServerStatusUpdate`) as the session-scoped status source — this spec is the consumer that seam was built for.
- **Versioning**: operation payloads follow [ADR-018](../decisions/018-cross-version-compatibility.md) cross-version compatibility rules; provider version floors are capability-probed at driver spawn and re-verified against the then-installed binaries per the provider-wire trust model.

## State And Data Implications

- **Two new daemon-local tables** (node-scoped; DDL in [Local SQLite Schema §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028)): `mcp_server_trust` (identity, `trusted`, `b3:`-hash binding, grant/revoke provenance) and `mcp_tool_overrides` (per-tool facets, FK-cascaded to the trust row). SQLite census 52 → 54.
- **No provider-config mirroring**: provider files remain the config source of truth; the daemon persists only governance state (trust, overrides) and derives inventory on read.
- **Events are the audit trail**: every mutation and transition appends through the Plan-006 `EventLogService` path — hash-chained, signed, replayable like every other category. Node-scoped events bind to the daemon-scope sentinel session per [Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring](./006-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding-and-node-scope-anchoring).
- **Replay/recovery impact**: operator-assigned idempotency classes change what [Spec-015](./015-persistence-recovery-and-replay.md) recovery may safely replay — which is exactly why assignment is trusted-server-only, Cedar-gated, and audited.

## Example Flows

- `Example: live server add on Claude` — operator calls `mcp.upsertServer` (provider `claude`); capability probe says CLI `2.1.210+` streaming session; daemon computes the full desired named-server set, calls `setMcpServers`, reconciles `{added: ["linear"], removed: [], errors: []}`, upserts an untrusted trust row for `linear`, emits `mcp.server_config_changed` (grade `live_reconcile`) then `mcp.server_status_changed` (`starting` → `connected`), and returns the inventory entry with grade `live_reconcile`.
- `Example: Codex write conflict` — two operators race `mcp.setEnabled`; the second write's `expected_version` is stale; the daemon re-reads, retries once against the new version, succeeds, triggers `config/mcpServer/reload`, emits `mcp.server_config_changed` (grade `user_config_write`).
- `Example: trust drift` — operator trusts `github` at hash `b3:abc…`; a later inventory refresh parses a changed `http_headers` block, hash now `b3:def…`; the daemon auto-revokes before use, emits `mcp.server_trust_changed` (`reason: 'config_drift'`), and the server's annotations stop informing approval decisions until re-trusted.
- `Example: OAuth on Codex` — `mcp.oauthLogin` → `mcpServer/oauth/login` → daemon returns `authorization_url`; operator completes in browser; `mcpServer/oauthLogin/completed` arrives; daemon emits `mcp.server_oauth_completed` (`outcome: 'success'`); next status observation flips `needs-auth` → `connected`.
- `Example: safety-weakening override denied` — operator sets `idempotencyClass: 'idempotent'` on a tool of an untrusted server; the daemon returns `mcp.trust_required` before any write; after `mcp.setTrust` grants trust, the same call succeeds and emits `mcp.tool_override_changed`.

## Implementation Notes

- **Re-verify at execution.** Every provider mechanism above is Verified at the provider-wire pins (`claude` `2.1.198`, `codex-cli 0.141.0`) or version-anchored beyond them (`mcp_set_servers` at `2.1.210`); Plan-028 code MUST re-verify load-bearing shapes against the then-installed binaries per [provider-wire README](../reference/provider-wire/README.md) before binding.
- **Codex generic thread-config map.** `ThreadStartParams` carries a generic `config` map whose MCP reach is unverified; if it can scope servers per-thread at execution time, it is an optimization _inside_ the same normalized surface (per-session scoping without user-config writes) — adopt behind the same interface, never as a new caller-visible mechanism. Recorded as the explicitly-deferred question in §Open Questions.
- **MCP revision watch.** The MCP 2026-07-28 revision (RC locked 2026-05-21) restructures the protocol core (stateless core, Tasks → extension, Roots/Sampling/Logging deprecated); both providers will absorb it in their own releases. This spec binds to _provider surfaces_, not the MCP wire, so the revision lands here only as provider-behavior changes caught by the re-verify rule.
- **Claude durable scopes.** `claude mcp add --scope user|project|local` exists as a human CLI; V1 deliberately declares session server sets via ephemeral config (`--mcp-config` + `--strict-mcp-config`) for determinism — the daemon-composed set is exactly what the session sees, immune to ambient scope drift. Operators keep using the human CLI for their own ambient config; the inventory observes it.
- **Config-hash normalization.** Hash inputs normalize the server config to the daemon's canonical shape (sorted keys via JCS, provider-native field names preserved) so cosmetic reordering does not flip hashes, but any semantic change (URL, headers, env, tool filters, timeouts) does.

## Pitfalls To Avoid

- **Writing Codex project-local config.** Upstream rejects project paths for config writes (user scope only); attempting it corrupts the parity story — surface `mcp.config_scope_unsupported` instead.
- **Trusting annotation self-claims.** A server saying `readOnlyHint: true` is data, not authorization; only the operator trust store admits annotations into decision surfaces (the ADR-015 MUST — stable MCP-spec language since 2025-03-26, not a recent strengthening).
- **Delta-sending `setMcpServers`.** The call replaces the full named-server set; sending a delta silently removes every unsent server. Always send the full desired set.
- **Treating `--help` as the capability census.** The Claude CLI's `--help` omits real flags; capability probes and the provider-wire reference are authoritative (the documented `--help`-non-authoritative rule).
- **Echoing secrets.** Config values, env vars, headers, tokens, and authorization URLs never enter events, errors beyond guidance messages, or logs; `bearer_token_env_var` names an env var — the _name_ may appear in inventory, the _value_ never leaves the provider.
- **Conflating elicitation approval with governance authorization.** `mcp_elicitation` (Spec-012, session-scoped, interactive) and the `mcp` Cedar action family (this spec, node-scoped, non-interactive) are different layers; routing governance through interactive approvals would deadlock headless operation.
- **Polling provider status.** Both providers push (notifications / feed emissions); polling is on-demand-only.

## Acceptance Criteria

- [ ] `mcp.list` merges all four sources and round-trips both providers' declared servers with correct `(provider, serverName)` identity separation
- [ ] Claude mutation above the version floor applies live and returns grade `live_reconcile`; below the floor it returns grade `next_run` and the next run's ephemeral config contains the mutation
- [ ] Codex mutation writes user scope with `expected_version`, retries a conflict exactly once, triggers reload, and surfaces `mcp.config_write_conflict` on double conflict
- [ ] Codex project-scope mutation attempts fail with `mcp.config_scope_unsupported`; the project file is byte-identical after the attempt
- [ ] First observation of an unknown server creates an untrusted trust row; no code path creates `trusted = 1` without an operator `mcp.setTrust`
- [ ] Config drift on a trusted server auto-revokes before use and emits `mcp.server_trust_changed` with `reason: 'config_drift'`
- [ ] Safety-weakening overrides on untrusted servers fail with `mcp.trust_required`; safety-tightening overrides succeed regardless of trust
- [ ] Operator-assigned `idempotencyClass` reaches the Spec-005 tool-metadata resolution output; absent assignment resolves to `manual_reconcile_only`
- [ ] Every governance mutation emits its event exactly once, with sentinel binding for node-scope events and real-session binding for session-feed status observations
- [ ] Event and error payloads contain no config values, tokens, env-var values, or unsanitized paths (schema-level test over all five payload types + nine error codes)
- [ ] All nine `mcp.*` error codes are reachable in integration tests and absent from success paths
- [ ] Remote (relay-originated) mutation attempts fail with `mcp.operator_scope_required` before any store or provider mutation

## ADR Triggers

- Remote governance mutation (control-plane-relayed operator actions) — requires the BL-141 caller-authorization model formalized as an ADR before any implementation.
- A third provider CLI joining the parity set — re-derives the capability table and may fork normalization decisions.
- Provider adoption of the MCP 2026-07-28 revision materially changing config/auth surfaces (e.g., Tasks-extension governance) — reference update plus re-derivation of the capability table.
- Any proposal to store credential material in the daemon — hard ADR gate; the no-custody posture is a deliberate one-way-door refusal.

## Open Questions

- _Explicitly deferred (non-blocking):_ whether the Codex `ThreadStartParams` generic `config` map accepts `mcp_servers` scoping per-thread. Verify at Plan-028 execution against the then-installed binary; adopt as an internal optimization if real (see §Implementation Notes). No V1 surface depends on the answer.

## References

Primary sources verified 2026-07-22 (campaign B18); provider shapes carry the [provider-wire](../reference/provider-wire/README.md) trust grades:

- MCP specification versioning (2025-11-25 = current stable) — <https://modelcontextprotocol.io/specification/versioning> (accessed 2026-07-22)
- MCP 2025-11-25 Tools (annotation-trust MUST; stable since 2025-03-26 per the 2025-03-26 and 2025-06-18 Tools pages; SEP-1303 "Input Validation Errors as Tool Execution Errors", Final) — <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>, <https://modelcontextprotocol.io/specification/2025-03-26/server/tools>, <https://modelcontextprotocol.io/seps/1303-input-validation-errors-as-tool-execution-errors> (accessed 2026-07-22)
- MCP 2025-11-25 changelog + Authorization (OIDC Discovery MUST, Client ID Metadata Documents, step-up scopes; RFC 8707 `resource` carried from 2025-06-18) — <https://modelcontextprotocol.io/specification/2025-11-25/changelog>, <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization> (accessed 2026-07-22)
- MCP 2026-07-28 release candidate (locked 2026-05-21; stateless core, Tasks → extension) — <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/> (accessed 2026-07-22)
- Claude Code MCP reference + CLI reference (`--mcp-config`, `--strict-mcp-config`, `claude mcp login` at `2.1.186`) — <https://code.claude.com/docs/en/mcp>, <https://code.claude.com/docs/en/cli-reference> (accessed 2026-07-22)
- Claude Agent SDK TypeScript reference (`setMcpServers` / `McpSetServersResult` / `mcpServerStatus` / `toggleMcpServer` / `reconnectMcpServer`) + SDK changelog (`mcp_set_servers` CLI floor `2.1.210`, SDK `0.3.166`; companions at `0.2.21`) — <https://code.claude.com/docs/en/agent-sdk/typescript>, <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md> (accessed 2026-07-22)
- Codex app-server protocol (config CRUD `config/read` / `config/value/write` / `config/batchWrite` / `config/mcpServer/reload`; `mcpServerStatus/list`; `mcpServer/oauth/login` + `mcpServer/oauthLogin/completed`; `mcpServer/startupStatus/updated`) — <https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md>, <https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/config.rs>, <https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs> (accessed 2026-07-22)
- Codex MCP config fields (`RawMcpServerConfig`: `bearer_token_env_var`, `enabled_tools` / `disabled_tools`, `default_tools_approval_mode`, `required`, timeouts, `auth`) — <https://raw.githubusercontent.com/openai/codex/main/codex-rs/config/src/mcp_types.rs>, <https://learn.chatgpt.com/docs/extend/mcp?surface=cli> (accessed 2026-07-22)
- Codex config-write behavior receipts: optimistic concurrency `configVersionConflict` — <https://github.com/openai/codex/issues/20538>; user-scope-only writes (project paths rejected) — <https://github.com/openai/codex/issues/11728>; per-thread MCP status scoping — <https://github.com/openai/codex/pull/24532> (accessed 2026-07-22)
- [Spec-005](./005-provider-driver-contract-and-capabilities.md), [Spec-006](./006-session-event-taxonomy-and-audit-log.md), [Spec-012](./012-approvals-permissions-and-trust-boundaries.md), [Spec-015](./015-persistence-recovery-and-replay.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [Security Architecture](../architecture/security-architecture.md), [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)
