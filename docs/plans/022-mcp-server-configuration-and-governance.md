# Plan-022: MCP Server Configuration and Governance

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `022` |
| **Slug** | `mcp-server-configuration-and-governance` |
| **Date** | `2026-07-22` |
| **Author(s)** | Claude (AI-assisted) |
| **Spec** | [Spec-024](../specs/024-mcp-server-configuration-and-governance.md) |
| **Required ADRs** | [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-014](../decisions/014-v1-feature-scope-definition.md), [ADR-017](../decisions/017-cross-version-compatibility.md), [ADR-038](../decisions/038-mcp-credential-custody.md) |
| **Dependencies** | [Plan-003](./003-provider-driver-contract-and-capabilities.md) (driver seams: `onMcpServerStatus` producer, `driver_tools` metadata store, capability probe), [Plan-004](./004-session-event-taxonomy-and-audit-log.md) (event registry + append path; T1.9 registers the `mcp.*` literals), [Plan-005](./005-local-ipc-and-daemon-control.md) (partial — `MethodRegistry` dispatch substrate + the streaming primitive `mcp.subscribe` rides), [Plan-009](./009-approvals-permissions-and-trust-boundaries.md) (the approval layer a Claude tool override is enforced at; D-009-11's rule revocation), [Plan-020](./020-desktop-app-and-renderer.md)-partial (shipped — the renderer substrate the Phase 5 desktop MCP panel views build on, reading the daemon through the renderer's `services/daemon/` client; live bridge verification with Plan-020's remainder, per the cross-plan graph's Plan-022 row) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Deliver V1 feature #15: the daemon's MCP governance layer per [Spec-024](../specs/024-mcp-server-configuration-and-governance.md) — unified server inventory over scope-qualified bindings, configuration mutation at every scope on both providers (Claude Code's `claude mcp add-json --scope` writes + live reconcile; Codex user-config CRUD + reload, the daemon's own format-preserving edit of a project's `.codex/config.toml`, and the emulated `local` scope), tool-level overrides feeding the Plan-003 tool-metadata resolution layer, the daemon's own OAuth sign-in per server under [ADR-038](../decisions/038-mcp-credential-custody.md), the daemon's own MCP client and the route that fronts servers for Codex, a session's own server set, a search of the public MCP Registry, normalized status observation, and the `mcp_governance` status and sign-in events — all open to this machine's own client or any linked device, and no session, with no policy check and no ownership refusal.

## Scope

- `packages/contracts`: `mcp.*` operation payload schemas (the `McpServerBindingRef` discriminated union, the redacted `McpServerConfigView`, per-leg `McpServerLegStatus` / `McpLiveApplicationResult`, the mandatory `clientIdempotencyKey`, `scope` and `scopeRef` on upsert and remove, `mcp.registrySearch`, `mcp.oauthLogout`, the entry's `failedReason`), the `session.mcp*` schemas, the `McpGovernanceEventPayload` schemas (emitter-authors-payload precedent — the type literals and category themselves are Plan-004-owned, registered by Plan-004 T1.9), error-code constants.
- `packages/runtime-daemon`: `mcp_server_bindings` + `mcp_tool_overrides` + `mcp_mutation_receipts` + `mcp_server_admitted_clients` in the daemon's one schema; the `McpGovernanceService` (inventory, bindings, overrides, idempotency receipts), provider config adapters (Claude Code's `claude mcp add-json --scope` writer at every scope + session-set builder + live-reconcile client; Codex config CRUD client, project-file writer and `local` emulation), status normalizer consuming the Plan-003 `onMcpServerStatus` seam, the daemon's own MCP client and its fronted route, the sign-in service with its credential-store custody and header-helper answerer (ADR-038), the registry search, `mcp.*` and `session.mcp*` `MethodRegistry` handlers incl. the `mcp.subscribe` live-tail stream.
- `packages/client-sdk` + CLI/desktop surfaces: typed `mcp.*` and `session.mcp*` client methods; CLI `sidekicks mcp …` command group (the Plan-005 registered bin name); desktop MCP panel data hooks over `mcp.list`/`mcp.get` + the `mcp.subscribe` stream.
- Doc mirrors: [api-payload-contracts.md §Plan-022 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-022--mcp-governance-contract-surfaces), [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance), [local-sqlite-schema.md §MCP Governance Tables (Plan-022)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-022). Code phases keep them true.

## Non-Goals

- Everything [Spec-024 §Non-Goals](../specs/024-mcp-server-configuration-and-governance.md#non-goals) excludes: no governance added by the daemon's own MCP client beyond what a direct connection gets (the daemon's callback-tool host of [Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior) sits outside this governance model and is never override-governed), no credential custody beyond [ADR-038](../decisions/038-mcp-credential-custody.md), no provider-config-store ownership, no installing a server on the person's behalf, no governance by a caller who does not own the node (ownership is the whole predicate — never which transport carried the call, per [Spec-024 §Authorization](../specs/024-mcp-server-configuration-and-governance.md#authorization)), no session permission-matrix extension.
- No new `ApprovalCategory` value — governance mutations are not interactive approvals.
- No emitter code for any non-`mcp.*` event literal Spec-005 mints (`session.*` / `run.*` / `usage.*` / `user.message` emitters belong to Plan-002 / Plan-003 per [Plan-004 §Event Taxonomy Coverage](./004-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)).

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-022 PRs and downstream extensions.

### I-022-1 — Credential custody is exactly what ADR-038 records

The daemon holds an MCP server's credentials only as [ADR-038](../decisions/038-mcp-credential-custody.md#decision) records: one sign-in per server; its refresh token, and for a DPoP server its signing key, in the operating system's credential store under items the daemon created, never in a file and never in SQLite; access tokens in memory, handed only to the header helper of a provider process the daemon launched and to its own MCP client. It never reads or renews a sign-in the person's own Claude Code or Codex holds, and never logs, relays, or embeds in events, errors, receipts, read models, wire payloads, renderer state, or a helper's command line any OAuth token, authorization code, PKCE material, signing key, bearer-token value, or env-var value belonging to an MCP server. The `mcp.oauthLogin` idempotency receipt stores its acknowledgment with `authorizationUrl` structurally omitted — launch URLs embed single-use PKCE state, so they are never durable and its replay is a URL-free acknowledgment. That URL's **sole carrier is the `mcp.oauthLogin` reply**: it appears on no durable and no broadcast destination, and each client consumes it at exactly one — the login command's own result stream, and transient renderer state cleared at settlement. The only durable auth trace on the governance stream is the `mcp.server_oauth_completed` event (identity + outcome).

**Why load-bearing.** The daemon holding refresh tokens for every server the person signs in to puts it in their blast radius; ADR-038 accepts that only inside these bounds. A credential on any other surface, a token handed to a process the daemon did not launch, or a renewal of a sign-in the person's own provider holds (which signs that provider out, because servers rotate a public client's refresh token) would each break the record. Plan-019's PII/retention model assumes no credential columns exist.

**Verification.** Schema-level adversarial test sweeping every event payload schema + every error code + every table DDL for credential-shaped fields (incl. the `McpServerConfigView` read model — env/header/query-param names only, never values, the URL served query-redacted — and the receipts row: the stored `response_json` is a sanitized wire payload by construction, and the `mcp.oauthLogin` row is asserted URL-free); integration tests asserting a sign-in leaves no new SQLite rows beyond the completion event, its receipt and the admitted-client record, and exactly one new credential-store item per server (two for a DPoP server); that `mcp.oauthLogout` removes those items; that a provider-owned sign-in planted outside the daemon's homes is untouched after sign-in, renewal and sign-out; and that no helper command line carries a credential.

### I-022-2 — Writes go through the provider's own mechanism, or a guarded edit where there is none

Configuration mutations go through each provider's own mechanism wherever one exists (Claude Code: `claude mcp add-json` / `claude mcp remove` at the binding's `--scope` as the unconditional durable leg, and `mcp_set_servers` as the live leg and the session-declaration surface; Codex: `config/value/write` / `config/batchWrite` on the user file with `expected_version`, followed by reload, and the conversation's `thread/start` table for a session). The one file no provider mechanism writes, a project's `.codex/config.toml`, is changed only by a format-preserving edit renamed into place while the file still hashes to what the daemon last read, and counts only once `config/read` lists the server in its project layer. The daemon never rewrites any other provider config file directly, and never uses `mcp_toggle`.

**Why load-bearing.** Blind file rewrites race the provider's own writes, corrupt layered scopes, destroy the comments and layout of a file that belongs to the person and the repository, and break the inventory's source-of-truth model; `mcp_toggle` persists a per-project "off" the person never chose.

**Verification.** Integration tests asserting provider files are byte-identical after every daemon mutation except through these paths; a hand-commented Codex project file round-trips an add and a remove with its comments and layout intact; a project file changed between the daemon's read and its write refuses with `mcp.config_write_conflict`, file unchanged; no Claude Code process is ever sent `mcp_toggle`.

### I-022-3 — Every governance mutation is receipted exactly once

Each non-read `mcp.*` operation (`mcp.list`/`mcp.get`/`mcp.subscribe`/`mcp.registrySearch` are the reads) is open to this machine's own client or any linked device, and no session, with no policy check and no ownership refusal, and each of the **governance mutations** (`mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setToolOverride`, `mcp.clearToolOverride`) applies exactly once, made durable by the mandatory `clientIdempotencyKey` + the **two-phase** `mcp_mutation_receipts` (a `pending` intent commits before the provider leg; finalization and store writes commit in one SQLite transaction; startup reconciliation completes any crash-window intent so a durable provider write is never left unfinalized — the Plan-012 `command_receipts` discipline; a retry with the same key replays the receipt). No governance mutation appends a governance event. The operational commands sit outside the mutation set (Spec-024 §Authorization): `mcp.reconnect` changes no store or config and audits through the `mcp.server_status_changed` transitions it induces; `mcp.oauthLogin` is receipted but its durable trace — `mcp.server_oauth_completed` — completes asynchronously and cannot commit with the launch acknowledgment, so it is emitted exactly once per **completed** sign-in, the daemon's own callback or the provider's flow finishing in the throwaway home (an abandoned sign-in, or one ended by a newer attempt, leaves only the expiring receipt); `mcp.oauthLogout` is receipted and mints no event of its own, its trace being the `mcp.server_status_changed` transition to `needs-auth` on each leg that was connected on that sign-in.

**Why load-bearing.** A retry after a lost reply that re-ran the mutation would apply it twice.

**Verification.** Per-operation integration tests asserting exactly-once finalization; replay assertions on retry paths (the Codex conflict retry must not double-apply) and the crash-window reconciliation fixture (durable provider write + lost finalization → startup finalizes exactly once).

### I-022-4 — The idempotency floor moves only through governed override

MCP-sourced tools resolve to `manual_reconcile_only` unless an `mcp_tool_overrides` row assigns `idempotent` / `compensable`; the resolution layer (Plan-003's) is the only reader — downstream consumers never read the override table directly.

**Why load-bearing.** [Spec-004 §Tool Metadata](../specs/004-provider-driver-contract-and-capabilities.md#tool-metadata) makes the conservative floor the safety spine of Spec-013 recovery; an ungoverned path off it would let recovery replay non-idempotent tools.

**Verification.** Resolver unit tests (floor absent override; override applied; override cleared mid-session).

## Cross-Plan Obligations

### CP-022-1 — Event registration rides Plan-004 T1.9

The `mcp.*` event literals and the `mcp_governance` category are Plan-004-owned registry surface, registered by [Plan-004 §Event Taxonomy Coverage](./004-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)'s T1.9 registration task. Plan-022 authors the payload schemas (emitter-authors-payload precedent, the Plan-009 `ApprovalFlowEventPayloadSchema` shape) and MUST NOT add the literals to `packages/contracts/src/event-registry.ts` itself.

**Resolution.** Plan-004 T1.9 — the registration task this obligation rides — merges before Plan-022 Phase 1; the phase-scoped precondition below enforces it.

### CP-022-2 — Plan-003 seam consumption (status producer + tool-metadata resolution)

Plan-022 is the declared consumer of two Plan-003 surfaces: (a) the `onMcpServerStatus` producer seam (`McpServerStatusEmission` → `McpServerStatusUpdate`, whose consumer Plan-003 names as this plan), consumed by the Phase 2 status normalizer; (b) the tool-metadata resolution layer over the `driver_tools` store, which Phase 4 extends with the `mcp_tool_overrides` overlay — Plan-022 reads that store's resolution output, never Plan-003's owned symbols directly. The overlay is **binding-keyed**: the Plan-003 store resolves by `(driver_name, tool_name)`, which cannot disambiguate the same `serverName` bound in two scopes, so the Plan-022-owned overlay keys its lookup by the full `McpServerBindingRef` plus `toolName`. Plan-003 exposes no named resolver service — [Spec-004 §Tool Metadata](../specs/004-provider-driver-contract-and-capabilities.md#tool-metadata) states the floor as a rule over the `driver_tools` store — so the overlay is a Plan-022-owned module reading that store's output, never a decorator over a Plan-003 symbol. The **effective binding** the lookup needs is **derived in-plan** by T28.4.5 from the session sets T28.3.3 and T28.3.8 build, and recovery dispatches on the receipt's stamped `idempotency_class` rather than re-resolving, which [Spec-013 §Required Behavior](../specs/013-persistence-recovery-and-replay.md#required-behavior) forbids.

**Resolution.** Plan-003 Phase 3 merged is the Phase 2 precondition. The overlay lands in Phase 4 as T28.4.4's Plan-022-owned module reading the `driver_tools` store's output. Plan-003's `onMcpServerStatus` consumer note names Plan-022.

### CP-022-3 — `mcp.*` namespace registration against the Plan-005 substrate

The `mcp.*` operations and the `session.mcp*` operations register against `MethodRegistry.register()` (`packages/contracts/src/jsonrpc-registry.ts`, shipped) when this plan lands — the Plan-005 CP-005-2 late-namespace pattern (`presence.*` precedent: namespace owners register when they land against the stable substrate); `mcp.subscribe` and `session.mcpServerList` additionally ride Plan-005's streaming primitive (the `session.subscribe` long-lived consumer shape).

**Resolution.** Plan-005 Phase 2 merged is the Phase 1 precondition; the handlers land in Phase 2–5 as each operation's backing service exists. Plan-005's CP-005-2 heading and its registry-surface enumeration name this plan.

### CP-022-4 — Renderer substrate via Plan-020-partial

The Phase 5 desktop MCP panel views consume daemon state only through the renderer's `services/daemon/` client over the Plan-020-partial renderer substrate (shipped; live bridge verification with Plan-020's remainder) — the [Plan-013 §Cross-Plan Obligations](./013-multi-agent-orchestration.md#cross-plan-obligations) CP-013-8 renderer-bridge pattern. **Tasks:** T28.5.7.

**Resolution.** Declared in the plan header; Phase 5's precondition names it. The substrate has shipped.

### CP-022-5 — MCP-governance settings page built here, in the settings frame [Plan-020](./020-desktop-app-and-renderer.md) owns (reciprocal of CP-020-4)

[Spec-024 §The MCP servers page](../specs/024-mcp-server-configuration-and-governance.md#the-mcp-servers-page) names the settings-level MCP Servers page and [Spec-021 §Signature Feature Composition Sketches](../specs/021-desktop-app-and-renderer.md#signature-feature-composition-sketches) sketches it. The split is: **Plan-020 owns** the settings frame and its page list (its T-020p-1C-4), and the page list, `apps/desktop/src/renderer/src/features/settings/settings-pages.ts`, already registers the MCP servers page under the `mcp-servers` section; **this plan builds** the page's components and their projection in the settings feature's MCP servers page folder, `apps/desktop/src/renderer/src/features/settings/pages/mcp-servers/` (T28.5.7), and Plan-020 owns nothing inside that folder. The reason the split runs this way rather than the reverse is the fail-closed-projection rule: the page must derive no connection state and no effective idempotency class of its own, and a state projection authored in Plan-020's code — away from the plan that owns the governance rules — is exactly how a second source of truth for those decisions gets written. Eligibility is not projected anywhere, in either plan: no field reports it, every control is offered, and the daemon's typed refusal is what renders. This is distinct from CP-022-4, which is the substrate obligation (the `services/daemon/` client these components read through); CP-022-5 is the obligation on where the page is built.

**Resolution.** The reciprocal is Plan-020 CP-020-4. Plan-020 gains no task — the frame and the page list's `mcp-servers` entry are its T-020p-1C-4's — and T28.5.7 sits in Phase 5 carrying the Plan-020-partial substrate as its precondition.

## Target Areas

- `packages/contracts/src/mcp-governance.ts` (CREATE) — operation payload schemas (incl. the `McpServerConfigInput` transport-discriminated union with provider-conditional refinements and the Codex auth references `envHttpHeaders`/`oauthScopes`/`oauthResource`, the `McpServerBindingRef` scope-discriminated union with `local` on both providers, `scope` and `scopeRef` on upsert and remove, the redacted `McpServerConfigView` with the query-redacted URL, the entry's `failedReason: commandNotRunnable`, the discriminated degraded inventory arm, the mandatory `clientIdempotencyKey` on every mutation and on both sign-in operations, the ≥ 1-facet override refinement, `mcp.registrySearch {query, cursor?}` → `{servers, nextCursor?}`, `mcp.oauthLogout {serverId}`, and the session-feed `bindingId` conditionality on the status payload), the `session.mcpServerList` / `session.mcpServerUpdate` / `session.mcpResourceList` schemas, event payload schemas, error-code consts, `McpApplicationGrade` (`live_reconcile | user_config_write | next_run | daemon_enforced`), override facet + per-facet application types, per-leg `McpServerLegStatus` / `McpLiveApplicationResult`.
- `packages/runtime-daemon/src/mcp/` (CREATE) — `McpGovernanceService`, `McpInventoryService`, provider adapters (`claudeMcpConfigAdapter`, `codexMcpConfigAdapter`, the Codex project-file writer and `local` emulation), `McpStatusNormalizer`, the sign-in service (the daemon's own OAuth client, the provider-admitted takeover, DPoP keys, the credential-store custody and the header-helper answerer on the daemon's same-user socket), the daemon's own MCP client in `mcp/client/` and its fronted route, the registry search, binding + override stores, the typed `mcp.*` refusal classes in `mcp-errors.ts` (T28.1.5 — subclasses in their own file over Plan-005's `DaemonDomainError` base), plus the startup receipt-intent reconciler.
- The daemon's one schema (EXTEND) — the tables per [local-sqlite-schema.md §MCP Governance Tables (Plan-022)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-022), with the schema's test (EXTEND) covering them.
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND) — the `mcp.*` namespace handler files per CP-022-3.
- `packages/client-sdk/src/mcp-client.ts` (CREATE) + the client's named export line in the package's entry point `packages/client-sdk/src/index.ts` — typed `mcp.*` client methods.
- `apps/desktop/src/renderer/src/features/settings/pages/mcp-servers/` (EXTEND) — MCP panel views over the renderer's `services/daemon/` client.
- `apps/cli/src/commands/` `mcp-*.ts` (CREATE) + the `main.ts` `.register()` EXTENDs — the `sidekicks mcp` command group (`list` / `add` / `remove` / `override` / `login` / `watch` — `watch` tails `mcp.subscribe`) under the Plan-005 registered bin name (`bin: { "sidekicks": … }`, the Plan-013 command precedent; per-subcommand filenames: `mcp-list.ts`, `mcp-add.ts`, `mcp-remove.ts`, `mcp-override.ts`, `mcp-login.ts`, `mcp-watch.ts`).

## Data And Storage Changes

- `mcp_server_bindings` — `(provider, scope, scope_ref, server_name)` binding PK with the structural-validity CHECK (user ⇔ empty `scope_ref`), an emulated Codex `local` binding a row like any other and removed with its server; the `enabled_override` Claude overlay; the `native_tool_baseline_json` pre-governance snapshot (Codex-materialized bindings — the restore anchor per Spec-024 §Tool-Level Overrides). No key material and no credential. Owner: Plan-022 (CREATE).
- `mcp_server_admitted_clients` — `(provider, server_name)` PK; which client the server admitted at its last sign-in (the daemon's own, Claude Code's or Codex's), kept once per server rather than on each binding row, and kept after a sign-out, so every later sign-in is one press; not a credential. Owner: Plan-022 (CREATE).
- The operating system's credential store (not SQLite): per signed-in server, the daemon's refresh-token item and, for a DPoP server, its signing-key item, created at sign-in and deleted at sign-out ([ADR-038](../decisions/038-mcp-credential-custody.md)).
- A session's own switched-off servers are kept with the session, so the daemon can send its set again after each resume.
- `mcp_tool_overrides` — `(provider, scope, scope_ref, server_name, tool_name)` PK; nullable facets `enabled` / `approval_mode` / `idempotency_class` (≥ 1 non-NULL); binding-validity CHECKs mirrored; FK-cascade to the binding row. Owner: Plan-022 (CREATE).
- `mcp_mutation_receipts` — `client_idempotency_key` PK; operation, two-phase `status` (`pending` intent before the provider leg → `committed` at finalization, with `response_json` nullable until committed and startup reconciliation of crash-window intents), `created_at` (24 h opportunistic prune of `committed` rows). Owner: Plan-022 (CREATE).
- The plan's tables land in the daemon's one schema in Phase 1.
- Events append through the Plan-004 `EventLogService` path — no bespoke audit storage.

## API And Transport Changes

- The `mcp.*` JSON-RPC operations (`mcp.list`, `mcp.get`, `mcp.subscribe`, `mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setToolOverride`, `mcp.clearToolOverride`, `mcp.oauthLogin`, `mcp.oauthLogout`, `mcp.reconnect`, `mcp.registrySearch`) and the session operations (`session.mcpServerList`, `session.mcpServerUpdate`, `session.mcpResourceList`) registered per CP-022-3; typed mirrors in [api-payload-contracts.md §Plan-022 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-022--mcp-governance-contract-surfaces). Tools on the daemon's fronted route, `task_output {task_id, wait_seconds?}` and `task_stop {task_id}`, visible to a model and never to a client.
- The `mcp_governance` events (registered via CP-022-1); the `mcp.*` error codes per [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance).
- Provider wire consumption: Claude `claude mcp add-json` / `claude mcp remove` / `claude mcp get` (`--scope user|project|local`) + `setMcpServers` / `reconnectMcpServer` / `mcpServerStatus` (SDK) + `--strict-mcp-config`, with only the daemon's own entry on `--mcp-config` + `headersHelper` + `CLAUDE_AUTO_BACKGROUND_TASKS` + the `mcp_authenticate` control request in a throwaway credential folder; Codex `config/read` / `config/value/write` / `config/batchWrite` / `config/mcpServer/reload` / `mcpServer/refresh` / `mcpServerStatus/list` / `mcpServer/resource/read` / `mcpServer/oauth/login` in a throwaway home (+ `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed` notifications) + the `thread/start` `mcp_servers` table + `http_headers_helper` + `turn/steer` / `turn/start` for background delivery. MCP itself, through the daemon's own client (`@modelcontextprotocol/client` 2.1.0): `tools/call` task-augmented where allowed, `tasks/get` / `tasks/result` / `tasks/cancel`, `notifications/cancelled`, `prompts/list` / `prompts/get`, and the OAuth authorization flow with DPoP. The public MCP Registry's `GET /v0/servers`. All floors capability-probed at spawn and re-verified against then-installed binaries per the [provider-wire trust model](../reference/provider-wire/README.md).

## Implementation Steps

1. **Phase 1 — Contracts + storage.** Author `packages/contracts/src/mcp-governance.ts` (operation + event payload schemas incl. the binding-ref discriminated union, config view, per-leg types, `clientIdempotencyKey`, error consts, grades, facets; `--isolatedDeclarations`-clean); the plan's tables in the daemon's one schema; wire the error codes into the daemon error substrate. Register the `mcp.*` and `session.mcp*` method names + schemas against `MethodRegistry` with `not_implemented` handlers behind a feature gate so the namespace shape ships reviewable before behavior.
2. **Phase 2 — Inventory + status observation.** Provider config readers (Claude `~/.claude.json` user + project-keyed `local` scopes + `.mcp.json`; Codex `config/read` with layer attribution incl. project-local rows) resolving scope-qualified bindings; `McpInventoryService.list/get` merging config + status + binding rows + overrides; `McpStatusNormalizer` consuming the Plan-003 `onMcpServerStatus` seam and the Codex status wire, attributing observations to the effective binding; binding-row upsert on first observation; per-leg status retention (`legs[]` + the aggregate rule, `unknown` ranked in the fixed order) keyed by the Plan-003 runtime-binding leg, with leg retirement on runtime-binding close (a terminated session's leg leaves the aggregate); the degraded inventory arm when the binding store is unreachable (`bindingStoreUnavailable: true`, store-dependent fields structurally absent); `mcp.server_status_changed` emission with per-event binding (the path-free audit ref — `provider`, `scope` and `serverName`, never raw `scopeRef`; `origin: 'session_feed'` payloads carrying the observing leg's `bindingId`); the `mcp.subscribe` live-tail fan-out off the append path (registration live before first delivery — the I-005-9 ordering the gap-free subscribe-then-list handshake relies on).
3. **Phase 3 — Configuration mutation engines.** Claude: the unconditional durable leg (`claude mcp add-json` / `claude mcp remove` at the binding's scope, write-verified before acknowledgment) + the live `setMcpServers` leg selected by its own full-desired-set reconcile rather than by a driver-side probe (a typed refusal on that call selects the `user_config_write` grade and withdraws no capability flag; the CLI-version conjunct is subsumed by the `2.1.286` admission floor, while SDK ≥ `0.3.166` + streaming mode remain reachability preconditions) (full-set semantics, per-server error reconciliation) + the enabled overlay and the session-set builder (`--strict-mcp-config`, `mcp_set_servers` at start and after each resume, never `mcp_toggle`); Codex: `config/batchWrite` with `expected_version` on the user file, single silent retry, reload trigger, `mcp.config_write_conflict` on double conflict; the Codex session table, the project-file writer and the `local` emulation; `project` declarations written as typed and `${VAR}` expansion; `mcp.registrySearch`; validation-first ordering (`mcp.config_invalid` strictly pre-commit) with per-leg `liveResults[]` partial-outcome reporting; the two-phase `mcp_mutation_receipts` idempotency layer (`pending` intent committed before the provider leg; finalization + store writes in one transaction; startup reconciliation of crash-window intents — the Plan-012 `command_receipts` precedent; replay) (I-022-2, I-022-3).
4. **Phase 4 — Overrides.** In-plan effective-binding derivation off the session sets (T28.4.5); the binding store's native-field baseline and the removal revocation of a server's approval rules (T28.4.2); override service with baseline capture/restore on facet materialization and clear (a user's native entries survive a set → clear round-trip), materializing Codex facets in the file that holds the binding at every scope; the binding-keyed tool-metadata resolver overlay (CP-022-2 — the effective `McpServerBindingRef` carried through invocation and recovery resolution); retrofit Phases 2–3 handlers off the feature gate.
5. **Phase 5 — Sign-in, the daemon's client and route, and client delivery.** The daemon's own MCP client (T28.5.9) and its fronted route with background long calls (T28.5.10); the sign-in service under ADR-038 — the daemon's own OAuth client, owner-issued clients, the provider-admitted takeover, DPoP, the credential-store custody and the header helper (T28.5.1, T28.5.2), the URL-free `mcp.oauthLogin` receipt representation per I-022-1, completion-event dedup — exactly once per completed sign-in, nothing for abandoned ones (T28.5.3), and `mcp.oauthLogout` (T28.5.11); `mcp.reconnect`; a session's own tool servers (T28.5.12); client-sdk methods, CLI `sidekicks mcp list/add/remove/override/login/watch`, desktop panel hooks (reads + the `mcp.subscribe` stream through the renderer's `services/daemon/` client, CP-022-4); end-to-end acceptance sweep against Spec-024 §Acceptance Criteria.

## Parallelization Notes

- Phase 1's contracts and its tables in the daemon's one schema are independent — parallelizable within the phase.
- Phases 2 and 3 both depend on Phase 1 but not on each other (read path vs write path) — parallelizable as separate PRs after Phase 1 merges; both must merge before Phase 4 (which gates their handlers).
- Phase 5 is strictly after Phase 4 (OAuth and client surfaces assume the handlers are live).
- The two provider adapters within any phase are parallel work units (no shared state beyond the service interfaces).

## Test And Verification Plan

- Unit: payload/DDL schema tests incl. the `McpServerConfigInput` provider-conditional refinements, the binding-ref discriminated union (scopeRef forbidden/required per scope on both providers — typed validation, with the DDL CHECKs as the negative-control mirror), and the ≥ 1-facet override refinement; audit-ref payload identity (raw `scopeRef` structurally absent from every event payload schema); `McpServerConfigView` redaction (env/header names round-trip, values structurally absent; the URL served query-redacted with query-parameter names, and an address carrying a user name and password accepted as typed, passed to the provider as typed, and served with neither); leg-status aggregation (severity ranking with `unknown` ranked between `needs-auth` and `starting`, node-probe fallback, no-source `unknown` floor, and retirement — a closed session's leg leaves `legs[]` and the aggregate recomputes); the degraded inventory arm (binding store unreachable → `bindingStoreUnavailable: true` with store-dependent fields structurally absent, provider-observed fields intact); status normalization maps (Claude `pending`/`disabled`, Codex `Starting|Ready|Failed|Cancelled` → `McpServerStatus`); the baseline lifecycle (snapshot at first materialization, never refreshed while held, dropped once facet-free); resolver overlay floor semantics under override set and clear.
- Integration (fixture-driven fake provider wires for both CLIs): full mutation matrix × {control-channel reachable, control-channel unreachable-on-an-admitted-build} Claude with restart-durability assertions (an acknowledged mutation survives a daemon restart via the provider store); scope-collision fixtures (same `serverName` in two scopes — independent status and overrides); scope writes on both providers (a `user`, `project` and `local` add and remove each landing where Spec-024 §Configuration Mutation says, the Codex project file read back and its comments intact; a value at `project` scope landing in each file as typed; a Codex `project` binding's `enabled`/`approvalMode` facet landing in that project's `.codex/config.toml`); a repository-borne `project` server present in both providers' session sets once switched on; the session set (`mcp_set_servers` at start and after resume, never `mcp_toggle`; the Codex `thread/start` table); Codex conflict-retry-once; idempotency (a retry with the same key replays with zero provider calls and writes — asserted across a daemon restart; receipt prune at the 24 h bound; the `mcp.oauthLogin` receipt stores and replays a URL-free acknowledgment; the two-phase crash windows — pending intent with no provider effect expires at startup, pending intent with a durable provider write reconciles to a finalized receipt, exactly once); unmodeled-field preservation (a Codex server table carrying fields the input does not model is byte-identical on them after an update); durable-success/live-failure partial outcomes (`applied: 'user_config_write'` + failing `liveResults[]` entry, never a post-commit error); two-session leg divergence (per-leg statuses + scoped `mcp.reconnect` — `{sessionId}` restarts that session's legs, `{bindingId}` exactly one leg); resolver-overlay two-scope disambiguation (same `serverName` in user + project bindings: each session's invocation resolves its own effective binding's override); `mcp.subscribe` live-tail delivery (status and sign-in envelopes, no replay before the acknowledgment) + the gap-free handshake (an event appended between the subscribe acknowledgment and the `mcp.list` read arrives on the stream); no governance event from any governance mutation, retry paths included, plus the reconnect no-event negative control and the `mcp.server_oauth_completed` exactly-once-per-observed-completion dedup (abandoned flow: no event, receipt expires; unobserved completion: the status transition is the surviving trace); native-baseline round-trip (a Codex user config with pre-existing `enabled_tools`/`tools.<t>.approval_mode` values survives override set → clear with the native values restored); removing a server removes every approval rule over its tools from the provider's file that holds it, in the same transaction; async OAuth completion failure delivered as the `outcome: 'failure'` event (launch failure keeps `mcp.oauth_flow_failed` reachable); required-server thread-start failure mapping.
- Adversarial-Tampering Boundary: credential-echo sweep over every event payload, every error code, the `McpServerConfigView`, receipt rows (the `mcp.oauthLogin` row URL-free), logs, helper command lines and renderer state (I-022-1); the provider-owned sign-in negative control (a sign-in the person's own provider holds is never read or renewed); raw-`scopeRef` absence from every event payload (the audit-ref negative control); provider-file byte-identity after refused mutations (a changed Codex project file); spoofed `serverName` from the status seam stays `wireFreeFormString`-bounded, the bound Plan-003 applies to untrusted provider output; and the Phase-5 egress sweep — **no token, authorization code, or PKCE material** reaches CLI stdout/stderr, the `mcp.subscribe` stream, or any `window.desktopBridge` bridge payload, asserted at each of the three new egress surfaces the OAuth + client phase opens (I-022-1 beyond the daemon boundary). `authorizationUrl` is asserted **by destination** rather than universally: absent from the `mcp.subscribe` stream, from every event payload, from the receipt row, and from logs; present only on the `mcp.oauthLogin` reply, which is the single carrier [Spec-024 §Interfaces And Contracts](../specs/024-mcp-server-configuration-and-governance.md#interfaces-and-contracts) names and the one each client's launch surface consumes.
- CI-Pinned Tool Versions: provider fixtures name the wire pins they encode, read from the [provider-wire reference](../reference/provider-wire/README.md)'s §Version pin tables rather than restated here, plus the version-anchored `2.1.210` `mcp_set_servers` behavior (an upstream feature anchor, not a pin); `gitleaks v8.30.1` per [ADR-022 §Axis 4 — Supply-Chain Hygiene](../decisions/022-v1-ci-cd-and-release-automation.md#axis-4--supply-chain-hygiene) on every PR.
- Manual: real-provider smoke on one machine per OS tier before Phase 5 completion (OAuth browser round-trip cannot be fixture-verified end to end).

## Implementation Phase Sequence

Plan-022 implementation lands one PR per phase. Each PR carries a `**Precondition:**` line so the merge order is reviewer-checkable.

### Phase 1 — Contracts + storage

**Precondition:** Plan-004 Phase 1 merged; Plan-005 Phase 2 merged.

**Goal:** contracts + the plan's tables in the daemon's one schema + registered-but-gated namespace compile, open, and round-trip; schema tests green. Satisfies the storage half of I-022-1; stages CP-022-1/CP-022-3.

#### Tasks

- **T28.1.1 — Binding-ref and config-input discriminated unions.**
  - Files: `packages/contracts/src/mcp-governance.ts` (CREATE)
  - Author `McpServerBindingRef` as a discriminated union on `scope`: `user` (no `scopeRef`), `project` (non-empty `scopeRef`), `local` (non-empty `scopeRef`), on both providers — Codex `local` is the emulated scope. Author `McpServerConfigInput` as a transport-discriminated union with provider-conditional refinements carrying the Codex auth references `envHttpHeaders` / `oauthScopes` / `oauthResource`. `--isolatedDeclarations`-clean (explicit type annotations on every exported const — repo-wide `tsconfig.base.json` rule).
  - **Spec coverage:** Spec-024 §Unified Inventory, Spec-024 §Interfaces And Contracts
  - **Verifies invariant:** I-022-1
  - **Consumes:** none (leaf contract module).

- **T28.1.2 — Redacted read model: config view, inventory entry, legs, degraded arm.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - `McpServerConfigView` serving transport, command/args, the query-redacted URL (scheme + host + path plus query-parameter **names**), timeouts, `required`, `bearerTokenEnvVar`, the Codex auth references, and env-var/header **names only**. `McpServerLegStatus` (leg identity, status, `observedAt`); the inventory entry with `legs[]` and the aggregate `status`; the discriminated `bindingStoreUnavailable: true` degraded arm with store-dependent fields structurally absent.
  - **Spec coverage:** Spec-024 §Unified Inventory, Spec-024 §Fallback Behavior
  - **Verifies invariant:** I-022-1
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).

- **T28.1.3 — Mutation request/response payloads, grades, and the idempotency key.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - Request/response shapes for the non-read operations; mandatory requester-generated UUID `clientIdempotencyKey` on every governance mutation and on `mcp.oauthLogin` (`mcp.reconnect` unreceipted); `McpApplicationGrade` (`live_reconcile | user_config_write | next_run | daemon_enforced`); `McpLiveApplicationResult` per-leg entries; the per-facet `McpToolOverrideApplication`; the ≥ 1-facet override refinement mirroring the DDL's all-NULL prohibition.
  - **Spec coverage:** Spec-024 §Configuration Mutation, Spec-024 §Authorization, Spec-024 §Tool-Level Overrides
  - **Verifies invariant:** I-022-3
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).

- **T28.1.4 — The `mcp_governance` event payload schemas.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND); `packages/contracts/src/event-variant-types.ts` (EXTEND — the two variants' event types in the `SessionEvent` union) and `packages/contracts/src/event.ts` (EXTEND — their `SessionEventSchema` arms)
  - Author the payloads over a shared `McpServerBindingAuditRef` (path-free: `provider`, `scope` and `serverName`, never raw `scopeRef`). `mcp.server_status_changed` carries `origin: 'session_feed' | 'node_probe'` with `bindingId` required for `session_feed` and absent for `node_probe`. Author the payloads and register their variants in the union, per [Plan-004](./004-session-event-taxonomy-and-audit-log.md)'s T1.9 — the type literals, their category rows and the `mcp_governance` category are Plan-004-owned (CP-022-1); this task MUST NOT edit `packages/contracts/src/event-registry.ts` (the type literals), `packages/contracts/src/event-envelope.ts` (the category) or the `SESSION_EVENT_CATEGORY_BY_TYPE` rows in `packages/contracts/src/event.ts`.
  - **Spec coverage:** Spec-024 §Status Observation and Events
  - **Verifies invariant:** I-022-1
  - **Consumes:** the `mcp.*` type literals + the `mcp_governance` category ← Plan-004 T1.9 (shipped); `EventEnvelope` ← Plan-004 Phase 1 (shipped).

- **T28.1.5 — Error-code constants and typed daemon error classes.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND) + `packages/runtime-daemon/src/mcp/mcp-errors.ts` (CREATE)
  - The `mcp.*` codes as typed constants matching error-contracts.md §MCP Governance byte-for-byte, plus the typed refusal classes subclassing `DaemonDomainError` in this Plan-022-owned module — keeping per-namespace classes out of the Plan-005 substrate (no per-namespace mapping-table maintenance; the Plan-007 `worktree-errors.ts` precedent), so each refusal reaches the wire as `data.type` with sanitized `data.fields` through the existing discriminator branch and `packages/runtime-daemon/src/ipc/domain-error.ts` is never edited.
  - **Spec coverage:** Spec-024 §Interfaces And Contracts
  - **Verifies invariant:** none (contract-registration task; the reachability assertion is T28.5.8's)
  - **Consumes:** `DaemonDomainError` ← Plan-005 substrate.

- **T28.1.6 — The plan's tables in the daemon's one schema.**
  - Files: the daemon's one schema (EXTEND) + the schema's test (EXTEND)
  - `mcp_server_bindings`, `mcp_tool_overrides`, `mcp_mutation_receipts`, `mcp_server_admitted_clients` per local-sqlite-schema.md §MCP Governance Tables (Plan-022); the schema's test inserts each value the contract admits and refuses one it does not. DDL CHECKs mirror the type-layer binding rules as defense in depth: user ⇔ empty `scope_ref`; ≥ 1 non-NULL override facet; FK-cascade from overrides to the binding row. **No column stores key material.**
  - **Spec coverage:** Spec-024 §State And Data Implications
  - **Verifies invariant:** I-022-1, I-022-4
  - **Consumes:** the daemon's one schema ← Plan-001 (shipped).

- **T28.1.7 — Register the `mcp.*` and `session.mcp*` methods behind a `not_implemented` feature gate.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (CREATE)
  - Register every name + schema against `MethodRegistry.register()` with `not_implemented` handlers behind a feature gate, so the namespace shape ships reviewable before behavior and a mid-sequence pause leaves no half-built surface. Registration only — no substrate file's semantics change (CP-022-3, the CP-005-2 late-namespace pattern).
  - **Spec coverage:** Spec-024 §Interfaces And Contracts
  - **Verifies invariant:** none (namespace-shape staging; the handlers open at T28.4.1)
  - **Consumes:** `MethodRegistry.register()` ← Plan-005-partial, `packages/contracts/src/jsonrpc-registry.ts` (shipped; `METHOD_NAME_FORMAT` admits every `mcp.*` name).

- **T28.1.8 — Schemas for the operations and members the design adds.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - `scope` and `scopeRef` on `mcp.upsertServer` and `mcp.removeServer` for every scope on both providers; `mcp.registrySearch {query, cursor?}` → `{servers, nextCursor?}`, each result carrying its title or name, description, version, whether it runs as a package or at an address, the package's runtime hint and arguments or its remote address, and each environment variable's name, description and required flag, never a value; `mcp.oauthLogout {serverId}` with its `clientIdempotencyKey`; `failedReason: 'commandNotRunnable'` on an entry reading `failed`; `session.mcpServerList {sessionId}` (a live list, each row the server's name, binding, status with its reason, whether it is on for the session, and whether a switch waits for the next turn), `session.mcpServerUpdate {sessionId, serverName, enabled}`, and `session.mcpResourceList {sessionId, serverName}` → `{serverName, resources, complete}`.
  - **Spec coverage:** Spec-024 §Interfaces And Contracts, Spec-024 §A session's own tool servers
  - **Verifies invariant:** I-022-1
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).
  - **Not built:** every schema this task names.

### Phase 2 — Inventory + status observation

**Precondition:** Phase 1 merged; Plan-003 Phase 3 merged.

**Goal:** `mcp.list` / `mcp.get` serve the merged read model from both providers; status events flow with correct binding; first observation creates a binding row. Satisfies CP-022-2(a).

#### Tasks

- **T28.2.1 — Claude config reader across user, project, and local scopes.**
  - Files: `packages/runtime-daemon/src/mcp/claude-mcp-config-adapter.ts` (CREATE)
  - Read `~/.claude.json` user scope + the project-keyed `local` scope + `.mcp.json`, yielding scope-qualified declarations. Credential-bearing values are handled transiently in memory and never persisted, logged, or served (Spec-024 §Implementation Notes transient-secret rule).
  - **Spec coverage:** Spec-024 §Unified Inventory
  - **Verifies invariant:** I-022-1
  - **Consumes:** `McpServerConfigView` ← T28.1.2 (Phase 1, merged).

- **T28.2.2 — Codex config reader with layer attribution.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (CREATE)
  - `config/read` yielding user-scope (`$CODEX_HOME/config.toml`) and project-local rows with layer attribution, and the emulated `local` bindings from their governance rows.
  - **Spec coverage:** Spec-024 §Unified Inventory
  - **Verifies invariant:** I-022-1
  - **Consumes:** `McpServerConfigView` ← T28.1.2 (Phase 1, merged).

- **T28.2.3 — Binding resolution.**
  - Files: `packages/runtime-daemon/src/mcp/binding-resolver.ts` (CREATE)
  - Resolve `(provider, scope, scopeRef, serverName)` bindings without merging same-named servers across providers or scopes.
  - **Spec coverage:** Spec-024 §Unified Inventory
  - **Verifies invariant:** none (identity resolution; the no-merge assertion rides T28.5.8)
  - **Consumes:** declarations ← T28.2.1 + T28.2.2 (same phase).

- **T28.2.4 — `McpInventoryService.list/get` four-source merge and degraded arm.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-inventory-service.ts` (CREATE)
  - Merge declared config + normalized status + binding row + override rows per binding. `refresh: true` forces a provider round-trip; default serves most-recent observations. On binding-store unreachability serve the `bindingStoreUnavailable: true` arm with store-dependent fields structurally absent, provider-observed fields intact.
  - **Spec coverage:** Spec-024 §Unified Inventory, Spec-024 §Fallback Behavior
  - **Verifies invariant:** I-022-1
  - **Consumes:** bindings ← T28.2.3 (same phase); binding/override rows ← T28.1.6 (Phase 1, merged).

- **T28.2.5 — `McpStatusNormalizer` over the Plan-003 seam and the Codex wire.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-status-normalizer.ts` (CREATE)
  - Consume `McpServerStatusUpdate` values from the daemon-injected `onMcpServerStatus` producer and the Codex `mcpServerStatus/list` + `mcpServer/startupStatus/updated` wire; map Claude `pending` → `starting` and Claude `disabled` → `enabled: false` with last-observed status; absence of any source → `unknown`. Attribute each observation to the effective binding (the set the daemon sent that session). For a server the daemon fronts, take the observation from its own client's connection, and read `needs-auth` for a server whose sign-in the daemon holds from the daemon's sign-in state, since a helper-authenticated server reports `authStatus: unknown` on Codex. `serverName` stays `wireFreeFormString`-bounded — untrusted provider output.
  - **Spec coverage:** Spec-024 §Unified Inventory, Spec-024 §Status Observation and Events
  - **Verifies invariant:** none (normalization mapping; the spoof-bound assertion rides T28.5.8)
  - **Consumes:** `onMcpServerStatus` / `McpServerStatusUpdate` ← Plan-003 Phase 3 (§Precondition, Plan-003 Phase 3 merged; Plan-003's seam bullet names Plan-022 CP-022-2).

- **T28.2.6 — Node-scope status probe (the `node_probe` origin producer).**
  - Files: `packages/runtime-daemon/src/mcp/node-status-probe.ts` (CREATE)
  - Produce node-scope, session-independent status observations for bindings with no live leg, on demand only — driven by `mcp.list` / `mcp.get` with `refresh: true`, never by a poll loop (Spec-024 §Default Behavior forbids busy-polling). Claude leg: the zero-billed-turn `claude mcp list` read. Codex leg: `mcpServerStatus/list` unscoped by `thread_id`. Observations are stamped `origin: 'node_probe'` with `bindingId` structurally absent and bind to the daemon-scope sentinel session.
  - **Spec coverage:** Spec-024 §Unified Inventory, Spec-024 §Default Behavior
  - **Verifies invariant:** none (observation producer; the fallback-ordering assertion is T28.2.7's)
  - **Consumes:** the daemon-scope sentinel session id ← Plan-004 ([Spec-005 §Daemon-Scope Event Binding](../specs/005-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding), shipped).

- **T28.2.7 — Per-leg retention, deterministic aggregate, and leg retirement.**
  - Files: `packages/runtime-daemon/src/mcp/leg-status-store.ts` (CREATE)
  - Retain per-leg observations in `legs[]` keyed by the Plan-003 runtime-binding leg; compute the top-level aggregate as the most severe **current live-leg** status under the fixed order `failed > needs-auth > unknown > starting > connected`; fall back to the newest node-probe observation when no live leg exists, then to `unknown`. Retire a leg when its backing runtime binding closes and recompute — a terminated session's `failed` leg never pins the aggregate.
  - **Spec coverage:** Spec-024 §Unified Inventory
  - **Verifies invariant:** none (aggregation rule; asserted at T28.5.8 against the AC)
  - **Consumes:** normalized observations ← T28.2.5; node-probe observations ← T28.2.6 (same phase).

- **T28.2.8 — Binding-row upsert on first observation.**
  - Files: `packages/runtime-daemon/src/mcp/binding-store.ts` (CREATE)
  - First observation of a binding the binding store has never seen upserts its row — the anchor its enabled overlay and tool overrides hang from.
  - **Spec coverage:** Spec-024 §Unified Inventory, Spec-024 §Default Behavior
  - **Verifies invariant:** none (the anchor row; asserted at T28.5.8 against the AC)
  - **Consumes:** `mcp_server_bindings` ← T28.1.6 (Phase 1, merged).

- **T28.2.9 — `mcp.server_status_changed` emission with the path-free audit ref.**
  - Files: `packages/runtime-daemon/src/mcp/status-event-emitter.ts` (CREATE)
  - Emit on transition only (an unchanged re-observation emits nothing). Payloads never carry raw `scopeRef`. `origin: 'session_feed'` rows bind to the observing session's real `session_id` and carry the leg's `bindingId`; `origin: 'node_probe'` rows bind to the daemon-scope sentinel and omit `bindingId`. Append through the Plan-004 `EventLogService` path — no bespoke audit storage.
  - **Spec coverage:** Spec-024 §Status Observation and Events
  - **Verifies invariant:** I-022-1
  - **Consumes:** `EventLogService.append` ← Plan-004 Phase 4 (sole append path).

- **T28.2.10 — `mcp.subscribe` live-tail fan-out with the gap-free handshake.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-subscribe-handler.ts` (CREATE)
  - Long-lived subscription the person reads, delivering every `mcp_governance` envelope — sentinel-bound and session-bound alike — as the daemon appends it. Registration MUST be live before the first delivery so the subscribe-acknowledgment-then-`mcp.list` handshake is gap-free (the Plan-005 I-005-9 wire-ordering invariant). Live-tail only: nothing appended before the acknowledgment is delivered; history remains the sentinel session's log.
  - **Spec coverage:** Spec-024 §Status Observation and Events
  - **Verifies invariant:** none (delivery ordering; the gap-free assertion rides T28.5.8's AC sweep)
  - **Consumes:** the streaming primitive + I-005-9 ordering guarantee ← Plan-005-partial `streaming-primitive.ts` (shipped).

- **T28.2.11 — `failedReason: commandNotRunnable` after a move between Windows and WSL.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-inventory-service.ts` (EXTEND)
  - After the background service moves between Windows and a WSL distribution, the move marks every server whose command or arguments name a program on the side the service left; the inventory keeps such a server as it was and serves it reading `failed` with `failedReason: 'commandNotRunnable'`. A bare command name such as `npx` is looked up on the new side and is not marked. No status is added.
  - **Spec coverage:** Spec-024 §Unified Inventory
  - **Verifies invariant:** none (a read-model member; asserted at T28.5.8 against the AC)
  - **Consumes:** the move's list of stranded servers ← Plan-005 (the service on WSL 2); the entry schema ← T28.1.8 (Phase 1, merged).
  - **Not built:** the member and its marking.

### Phase 3 — Configuration mutation engines

**Precondition:** Phase 1 merged.

**Goal:** both mutation engines pass the fixture matrix with honest application grades; conflict refusals surface the right codes; receipts finalize exactly once. Satisfies I-022-2 and the mutation half of I-022-3 (behind the feature gate until Phase 4 opens the handlers).

#### Tasks

- **T28.3.1 — Claude durable leg: `claude mcp add-json --scope` at every scope, verified before acknowledgment.**
  - Files: `packages/runtime-daemon/src/mcp/claude-mcp-config-adapter.ts` (EXTEND)
  - `claude mcp add-json <name> <json> --scope <user|project|local>` / `claude mcp remove <name> --scope <scope>`, unconditional on every `mcp.upsertServer` / `mcp.removeServer`; a `project` or `local` write runs with the project root as the working folder, landing in `<project>/.mcp.json` or the project's entry in `~/.claude.json`. Re-read via `claude mcp get` (or observation of that scope) to verify the write took effect **before** the mutation is acknowledged. Upserts are read-modify-write over the observed current declaration so provider fields the input does not model survive byte-identical. The daemon never rewrites `~/.claude.json` or `.mcp.json` bytes directly.
  - **Not built:** the `project` and `local` writes.
  - **Spec coverage:** Spec-024 §Configuration Mutation
  - **Verifies invariant:** I-022-2
  - **Consumes:** observed declarations ← T28.2.1 (Phase 2, merged).

- **T28.3.2 — Claude opportunistic live `setMcpServers` leg, detected by its own reconcile.**
  - Files: `packages/runtime-daemon/src/mcp/claude-live-reconcile.ts` (CREATE)
  - Select the live leg by **this task's own full-desired-set reconcile**, never by a CLI-version comparison and never by a driver-side probe — the CLI conjunct is subsumed by the `2.1.286` admission floor Spec-004 states. There is deliberately no driver-side `mcp_set_servers` probe to consult: `mcp_set_servers` is a control-request subtype rather than one of Spec-004's capability flags, and Plan-003 guarantees the driver never issues it, because the operation replaces the full named-server set and an empty-set probe would clear this session's servers (CP-003-9). Availability is therefore established by the reconcile call this task already makes — the first full-set send **is** the detection, and a typed `Unsupported control request subtype` refusal on it falls through to `user_config_write` and withdraws **no** capability flag — in particular not `mcp`, which denotes MCP tool invocation and is unaffected, with the negative control asserted in the driver's own suite rather than issued here. SDK ≥ `0.3.166` and streaming-input mode stay stated reachability preconditions — the SDK version is not covered by the CLI admission floor — probed, never assumed from the pin. When satisfied, send the **full desired named-server set** (never a delta — a delta silently removes every unsent server) and reconcile the returned `{added, removed, errors}` against the requested delta. Grade `live_reconcile` only when every attempted live leg applied; `user_config_write` otherwise. A session whose control channel refuses the call gets its servers no other way: each of that session's servers reads `failed`, with the refusal as its reason ([Spec-024 §Fallback Behavior](../specs/024-mcp-server-configuration-and-governance.md#fallback-behavior)). Emit one `liveResults[]` entry per attempted leg (`sessionId` + the Plan-003 leg key, `outcome`, sanitized per-leg code).
  - **Spec coverage:** Spec-024 §Configuration Mutation, Spec-024 §Provider Capability Model
  - **Verifies invariant:** I-022-2
  - **Consumes:** the driver-spawn capability report ← Plan-003 T3.20 under **CP-003-9** (§Precondition on Phase 2, transitively merged) — the per-capability capability report carrying each flag's detection source, which covers the Spec-004 capability flags and does **not** include `mcp_set_servers` — that is a control-request subtype, not a flag, and Plan-003 guarantees no driver-side probe issues it (the operation replaces the full named-server set, so an empty-set probe would clear this task's servers) — so establishing its live value is this task's own reconcile.

- **T28.3.3 — Claude enabled overlay and the session-set builder.**
  - Files: `packages/runtime-daemon/src/mcp/claude-session-server-set.ts` (CREATE)
  - `mcp.setEnabled` on a Claude binding records the daemon's per-server enabled overlay (Claude Code's configuration has no enabled field; removal would destroy the declaration). Build each session's set from every scope's switched-on bindings plus governance overlays — a plugin's servers only where switched on for the session, less the session's own switched-off servers (T28.5.12) — with `${VAR}` references expanded per T28.3.11. The process starts with `--strict-mcp-config` and only the daemon's own entry on `--mcp-config`; the set goes out with `mcp_set_servers` right after start and again after each resume, and in a running session a change is another full-set send (T28.3.2). Grade `next_run`, or `live_reconcile` when every attempted leg applied. `mcp_toggle` is never sent.
  - **Spec coverage:** Spec-024 §Configuration Mutation, Spec-024 §Implementation Notes
  - **Verifies invariant:** I-022-2
  - **Consumes:** the enabled-overlay column ← T28.1.6 (Phase 1, merged); the session's process start and resume ← Plan-003's Claude Code driver.
  - **Not built:** the builder, the start-time send and the resend after resume.

- **T28.3.4 — Codex batched user-scope write with optimistic concurrency and reload.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (EXTEND)
  - `config/batchWrite` (multi-field mutations MUST be batched — one version check, one reload) with `expected_version` from the immediately preceding `config/read`. On `configVersionConflict`: re-read and retry exactly once, then surface `mcp.config_write_conflict` carrying both version tokens. Trigger `config/mcpServer/reload` (or per-server `mcpServer/refresh`) after a successful write. Writes are field-granular `config/value` paths, so unmodeled sibling fields stay byte-identical. Grade `user_config_write`. This task writes the user file; the project file and the emulated `local` scope are T28.3.9 and T28.3.10, because Codex rejects project paths for its own config writes.
  - **Spec coverage:** Spec-024 §Configuration Mutation, Spec-024 §Fallback Behavior
  - **Verifies invariant:** I-022-2
  - **Consumes:** `config/read` layer attribution ← T28.2.2 (Phase 2, merged).

- **T28.3.5 — Validation-first ordering.**
  - Files: `packages/runtime-daemon/src/mcp/mutation-preflight.ts` (CREATE)
  - Every check that can fail a mutation outright runs **before** the durable leg commits; `mcp.config_invalid` is exclusively a pre-commit refusal — including a Codex `local` name that clashes across the user file (the refusal naming the project that holds the other one). Once the durable leg commits, the mutation never converts to a thrown error — later per-leg failures report inside the successful response. Every operation applies at every scope on both providers.
  - **Spec coverage:** Spec-024 §Configuration Mutation, Spec-024 §Fallback Behavior
  - **Verifies invariant:** I-022-2
  - **Consumes:** bindings ← T28.2.3 (Phase 2, merged).

- **T28.3.6 — Two-phase `mcp_mutation_receipts` idempotency layer.**
  - Files: `packages/runtime-daemon/src/mcp/mutation-receipt-store.ts` (CREATE)
  - Commit a `pending` **intent** (key, operation) in its own transaction **before** any provider leg runs; finalize (`committed`, response recorded) in the **same SQLite transaction** as the mutation's store writes. A retry with the same key replays the recorded response, whatever the second request carries, with no provider call and no store write. `committed` rows older than 24 h prune opportunistically on later mutation writes; `pending` intents are never silently pruned.
  - **Spec coverage:** Spec-024 §Authorization
  - **Verifies invariant:** I-022-3
  - **Consumes:** `mcp_mutation_receipts` ← T28.1.6 (Phase 1, merged).

- **T28.3.7 — Startup receipt-intent reconciler.**
  - Files: `packages/runtime-daemon/src/mcp/receipt-reconciler.ts` (CREATE)
  - At startup, resolve every `pending` intent by observing provider state: an intent with no provider effect expires; an intent whose durable provider write landed is completed — store writes applied, the receipt finalized — **late but exactly once, never lost and never doubled**. An identical-key retry meeting a pending intent drives reconciliation first, then replays (the Plan-012 `command_receipts` two-phase discipline).
  - **Spec coverage:** Spec-024 §Authorization
  - **Verifies invariant:** I-022-3
  - **Consumes:** the two-phase receipt discipline ← Plan-012 `command_receipts` (pattern reuse, not a symbol import — Plan-022 owns its own store).

- **T28.3.8 — The Codex session table.**
  - Files: `packages/runtime-daemon/src/mcp/codex-session-server-table.ts` (CREATE)
  - Compose each Codex session's whole `mcp_servers` table from every scope's effective bindings plus governance overlays, each server with its per-conversation `enabled` flag: an emulated `local` binding switched on only in its project's sessions (T28.3.10), the session's own switched-off servers off (T28.5.12). Plan-003's Codex driver sends the table at `thread/start`; a whole table replaces the service's table for that conversation. Until the fronted route lands (T28.5.10), each entry is the server as declared; T28.5.10 rewrites each entry as a `url` entry on the daemon's route under the server's own name.
  - **Spec coverage:** Spec-024 §Provider Capability Model, Spec-024 §Implementation Notes
  - **Verifies invariant:** I-022-2
  - **Consumes:** effective bindings ← T28.2.3 (Phase 2, merged); the `thread/start` send ← Plan-003's Codex driver.
  - **Not built:** the table composer.

- **T28.3.9 — Codex project-file writer with read-back.**
  - Files: `packages/runtime-daemon/src/mcp/codex-project-file-writer.ts` (CREATE)
  - Edit `<project>/.codex/config.toml` with `@decimalturn/toml-patch` 3.1.2, a format-preserving TOML edit that keeps the file's comments and layout; write to a temporary file and rename into place only if the file still hashes to what the daemon last read, else refuse `mcp.config_write_conflict` with nothing written; read the result back with `config/read {cwd, includeLayers}`, whose project layer must list the server, then `config/mcpServer/reload`. The edit touches only that server's own table. Library choice: `@decimalturn/toml-patch` over `smol-toml` 1.9.0, which drops comments, and the unmaintained `toml-patch` 0.2.3 and `@iarna/toml` 2.2.5; a format-preserving edit is required because the file belongs to the person and the repository.
  - **Tests:** a hand-commented project file round-trips an add and a remove with its comments and layout byte-identical outside the server's table; a file changed between read and write refuses with the file unchanged.
  - **Spec coverage:** Spec-024 §Configuration Mutation
  - **Verifies invariant:** I-022-2
  - **Consumes:** `config/read` layer attribution ← T28.2.2 (Phase 2, merged).
  - **Not built:** the writer.

- **T28.3.10 — Codex `local` emulation.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (EXTEND)
  - Write the server into the user file through `config/value/write` with `enabled = false`; keep one governance row for the binding, removed with the server; switch it on with `mcp_servers.<name>.enabled = true` in the `thread/start` table of each session whose project is that one. The name must be unique across the user file; a clash refuses per T28.3.5.
  - **Spec coverage:** Spec-024 §Configuration Mutation
  - **Verifies invariant:** I-022-2
  - **Consumes:** the Codex user writer ← T28.3.4; the session table ← T28.3.8 (same phase).
  - **Not built:** the emulation and its governance row.

- **T28.3.11 — `project` declarations as typed, and `${VAR}` expansion for Claude Code.**
  - Files: `packages/runtime-daemon/src/mcp/claude-session-server-set.ts` (EXTEND)
  - A `project` declaration is written as the person typed it, values included, in each provider's own format (T28.3.1, T28.3.9). A declaration may name a variable in place of a value. On Codex, `env_vars`, `env_http_headers` and `bearer_token_env_var` name the variables and Codex reads them. On Claude Code the file holds `${VAR}` / `${VAR:-default}`, which the daemon expands from the session's spawn environment before each `mcp_set_servers` send, holding the value only for that call and never storing or logging it.
  - **Spec coverage:** Spec-024 §Configuration Mutation, Spec-024 §Implementation Notes
  - **Verifies invariant:** I-022-1
  - **Consumes:** the input schema ← T28.1.1 (Phase 1, merged); the session-set builder ← T28.3.3 (same phase).
  - **Not built:** the expansion.

- **T28.3.12 — `mcp.registrySearch`.**
  - Files: `packages/runtime-daemon/src/mcp/registry-search.ts` (CREATE) + `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (EXTEND)
  - Answer `{query, cursor?}` from the public MCP Registry's `GET /v0/servers?search=<query>&version=latest` with `{servers, nextCursor?}`, mapping each record's package (`runtimeHint`, `runtimeArguments`) or `remotes`, and its environment variables' names, descriptions and required flags, never a value; cache nothing past the call. Budget: one request per search (measured at 1.83 s, answers of 1.3 to 3.3 KB), no background reads.
  - **Spec coverage:** Spec-024 §The MCP servers page, Spec-024 §Interfaces And Contracts
  - **Verifies invariant:** none (a read)
  - **Consumes:** the schema ← T28.1.8 (Phase 1, merged).
  - **Not built:** the handler.

### Phase 4 — Overrides

**Precondition:** Phase 2 merged; Phase 3 merged; Plan-009 Phase 2 merged.

**Goal:** every mutating operation is open off the feature gate; the resolver overlay moves the floor only through an override the person sets; removing a server ends the approval rules over its tools. Satisfies I-022-3, I-022-4, CP-022-2(b).

#### Tasks

- **T28.4.1 — Open the handlers.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (EXTEND)
  - Retrofit the Phase 2–3 handlers off the `not_implemented` feature gate. Every non-read operation is open to this machine's own client or any linked device, and no session, with no policy check and no ownership refusal, and behaves the same whichever transport carried it ([Spec-027 §Parity by construction](../specs/027-remote-control.md#parity-by-construction)).
  - **Spec coverage:** Spec-024 §Authorization
  - **Verifies invariant:** I-022-3
  - **Consumes:** the Phase 2–3 handlers (Phase 3, merged).

- **T28.4.2 — Binding store: the native-field baseline and the removal revocation.**
  - Files: `packages/runtime-daemon/src/mcp/binding-store.ts` (EXTEND)
  - Snapshot `native_tool_baseline_json` from the observed native values at a binding's first facet materialization; never silently refresh it while held; drop it once the binding has no materialized facets. `mcp.removeServer` removes every approval rule over the removed server's tools from the provider's file that holds it, one `approval.rule_revoked` per rule with `server_removed`, in the same transaction as the removal ([Plan-009](./009-approvals-permissions-and-trust-boundaries.md) D-009-11), matching the rules by the binding identity T28.4.5 derives.
  - **Spec coverage:** Spec-024 §Configuration Mutation, Spec-024 §Tool-Level Overrides
  - **Verifies invariant:** none (asserted at T28.5.8 against the AC)
  - **Consumes:** binding rows ← T28.2.8 (Phase 2, merged); the binding identity ← T28.4.5 (same phase).

- **T28.4.3 — Override service: baseline restore and materialization at every scope.**
  - Files: `packages/runtime-daemon/src/mcp/tool-override-service.ts` (CREATE)
  - `mcp.setToolOverride` / `mcp.clearToolOverride` over the three optional facets. Codex `enabled`/`approvalMode` materialize into native fields in the file that holds the binding — the user file, or a project's `.codex/config.toml` through T28.3.9's edit (grade `user_config_write`); Claude equivalents are `daemon_enforced`; `idempotencyClass` is always `daemon_enforced`. Clearing restores the cleared facet's portions from the baseline; clearing a binding's last facet restores it verbatim and drops it, so a user's own native entries survive a set → clear round-trip.
  - **Spec coverage:** Spec-024 §Tool-Level Overrides
  - **Verifies invariant:** I-022-4
  - **Consumes:** baseline ← T28.4.2 (same phase); the Codex project-file writer ← T28.3.9 (Phase 3, merged).

- **T28.4.4 — Binding-keyed tool-metadata overlay (CP-022-2(b)).**
  - Files: `packages/runtime-daemon/src/mcp/tool-metadata-overlay.ts` (CREATE)
  - Overlay `mcp_tool_overrides` onto the `driver_tools`-sourced metadata so an `idempotencyClass` the person assigns reaches the resolution output and absence resolves to the `manual_reconcile_only` floor. The lookup keys on the full `(provider, scope, scopeRef, serverName, toolName)` binding, not `(driver_name, tool_name)`, so two sessions resolving the same tool name from user- and project-scope bindings each get their own scope's override. Downstream consumers read the resolution output, never the override table.
  - **Spec coverage:** Spec-024 §Tool-Level Overrides
  - **Verifies invariant:** I-022-4
  - **Consumes:** `driver_tools` metadata ← Plan-003 Phase 2 (T2.1/T2.4); the full `(provider, scope, scopeRef, serverName)` lookup key ← **T28.4.5** (same phase).
  - **Ownership note:** `driver_tools` is Owner=Plan-003. This overlay is a Plan-022-owned module reading that store's output; it MUST NOT edit any Plan-003-owned file.

- **T28.4.5 — Effective-binding derivation for a session's tool namespace.**
  - Files: `packages/runtime-daemon/src/mcp/effective-binding-resolver.ts` (CREATE)
  - Resolve `(sessionId, toolName)` to an `McpServerBindingRef` **or** to `null`, from the session sets T28.3.3 and T28.3.8 build, applying the same scope precedence the provider applies — so the answer is the binding the provider actually served the tool from, not a plausible reconstruction. `null` is a first-class answer meaning _no governed binding_ (a provider built-in, or a daemon-hosted callback tool), never an error and never a guess; it is what tells an approval rule over a tool server's tool from one over a built-in tool. This is **derivation, not registration**: nothing is threaded in from Plan-003 or Plan-012. **Never key on the delivered wire tool name's shape** — provider-side tool-name prefixing and collision-suffixing are provider defaults rather than wire invariants, so the mapping runs off the daemon's own registration identity, never off parsing the delivered name. Emit the binding identity here too, so the approval rule's tool-server match ([Plan-009](./009-approvals-permissions-and-trust-boundaries.md)) and T28.4.2's removal lookup are two readers of **one** derivation rather than two implementations that can disagree.
  - **Spec coverage:** Spec-024 §Tool-Level Overrides
  - **Verifies invariant:** I-022-4
  - **Consumes:** the session sets ← T28.3.3 and T28.3.8 (Phase 3, merged).

### Phase 5 — Sign-in, the daemon's client and route, and client delivery

**Precondition:** Phase 4 merged; the Plan-020-partial renderer substrate (shipped, CP-022-4).

**Goal:** one daemon-held sign-in per server serves both providers and the daemon's own client; the fronted route moves a long call to the background on Codex; a session's own server operations work; CLI + desktop surfaces ship; the Spec-024 §Acceptance Criteria sweep is green end to end. Satisfies I-022-1's flow-level verification.

#### Tasks

- **T28.5.1 — The daemon's own sign-in, its custody, and the header helper.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-sign-in-service.ts` (CREATE) + `packages/runtime-daemon/src/mcp/header-helper-answerer.ts` (CREATE) + `packages/contracts/src/mcp-governance.ts` (EXTEND — the header helper's token request and its reply, which the command-line tool sends and the daemon answers)
  - `mcp.oauthLogin` starts the daemon's own sign-in over T28.5.9's client: discovery from the server's protected-resource metadata, registration by the server's metadata document or dynamic registration, PKCE, `resource` set to the server's address; a server whose entry names an owner-issued client (Codex's `oauth.client_id` and `oauth.callback_url`) signs in as that client. The client implements `discoveryState` and `saveDiscoveryState`, binding the callback to its authorization server. The reply carries the sign-in page's address; the idempotency receipt persists the acknowledgment with `authorizationUrl` **structurally omitted**, so an identical-key retry replays a URL-free acknowledgment. A new `mcp.oauthLogin` on a server whose sign-in waits ends that wait and starts the next attempt. The refresh token goes into the operating system's credential store under an item the daemon creates, never a file — through `@napi-rs/keyring` 2.1.0, opened with `{linux: {store: "secret-service"}}`, on macOS and Linux, and on Windows, native and WSL alike, through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE` ([Plan-019](./019-data-retention-and-gdpr.md) `WindowsCredentialStore`, CP-019-5), as every daemon item is, never at a roaming persistence; on Linux with no Secret Service answering it goes into the daemon's one items file, readable only by the person (mode `0600`), never silently; a store that cannot be reached refuses the sign-in — and the daemon renews it itself under its client id, one renewal in flight per server. Each provider process the daemon launches gets a header helper per signed-in server (Codex `http_headers_helper`, Claude Code `headersHelper`) whose command line names the command-line tool by absolute path and carries only a server handle, a session handle and the socket path; the helper asks the daemon over its same-user socket for a current access token and prints the `Authorization` header, and the daemon answers only for a session it launched with that server on. The daemon watches each Claude Code process's stderr for `headersHelper not run` and reports it as a fault on that leg. No token, code, PKCE value or key reaches any egress, CLI stdout and the renderer bridge included.
  - **Tests:** one sign-in lets a Claude Code session and a Codex session reach the server; a rotated access token is renewed by each provider re-running its helper, with no step by the person; a helper asked for a session the daemon did not launch prints nothing; the helper command line carries no credential; the receipt row is URL-free.
  - **Spec coverage:** Spec-024 §OAuth Orchestration
  - **Verifies invariant:** I-022-1
  - **Consumes:** the MCP client ← T28.5.9 (same phase); the receipt store ← T28.3.6 (Phase 3, merged).
  - **Not built:** the sign-in service, the custody and the helper answerer.

- **T28.5.2 — The provider-admitted takeover and DPoP servers.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-sign-in-service.ts` (EXTEND)
  - A server that admits only Claude Code's or Codex's own client: run that provider's own flow in a throwaway home the daemon makes for this sign-in (Codex `mcpServer/oauth/login` with `mcp_oauth_credentials_store = "file"`, no ChatGPT sign-in; Claude Code's `mcp_authenticate` control request in a credential folder of its own), take the saved entry (server, issuer, client id, access and refresh tokens, expiry) into the daemon's own item, delete the home, renew under that client id, and front the server for both providers. Learn the admitted client before the browser opens from a refused dynamic registration or pushed-authorization request; otherwise open with the daemon's own client and, when that attempt does not finish, go through the admitted provider's client on the next. Remember the admitted client per server. Never read or renew a sign-in outside a home the daemon made. A server that demands DPoP tokens: sign in with a signing key made for that one sign-in (the client's `DpopSession`), one key per server and never the machine's control-plane key, kept in the credential store beside the refresh token by the same route; front the server for both providers and sign a proof per request.
  - **Tests:** against a local server admitting only one provider's client, the sign-in completes through that provider's flow, the throwaway home is gone afterward, and a later renewal succeeds under that client id; a provider-owned sign-in planted outside the daemon's homes is byte-identical after sign-in and renewal; against a local DPoP server, a `Bearer` or proof-less call is refused and the fronted call succeeds from both providers.
  - **Spec coverage:** Spec-024 §OAuth Orchestration
  - **Verifies invariant:** I-022-1
  - **Consumes:** the sign-in service ← T28.5.1; the fronted route ← T28.5.10 (same phase).
  - **Not built:** the takeover and the DPoP arm.

- **T28.5.3 — `mcp.server_oauth_completed` exactly once per completed sign-in.**
  - Files: `packages/runtime-daemon/src/mcp/oauth-completion-emitter.ts` (CREATE)
  - Emit exactly once per completed sign-in — the daemon's own callback, or the provider's flow finishing in the throwaway home. An abandoned sign-in, or one ended by a newer attempt, emits nothing and leaves only its expiring receipt. Launch failures (discovery, registration, or the provider's flow failing to start) are the error `mcp.oauth_flow_failed` on the still-open call; asynchronous completion failures are the event with `outcome: 'failure'` and a sanitized `failureReason` — never a late JSON-RPC error on a closed request.
  - **Spec coverage:** Spec-024 §OAuth Orchestration, Spec-024 §Authorization
  - **Verifies invariant:** I-022-3
  - **Consumes:** `EventLogService.append` ← Plan-004 Phase 4 (shipped path).

- **T28.5.4 — `mcp.reconnect` leg-addressable handler.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-reconnect-handler.ts` (CREATE)
  - Claude `reconnectMcpServer()` / Codex `mcpServer/refresh`. Leg-addressable: a `bindingId` reconnects exactly one leg (with `sessionId`, both must name the same leg), a `sessionId` alone reconnects that session's legs, neither reconnects every live leg. Unreceipted; changes no store and no provider config, so it emits **no** dedicated governance event — its observable effect is audited through the `mcp.server_status_changed` transitions it induces, and an attempt producing no transition intentionally leaves no governance row.
  - **Spec coverage:** Spec-024 §Authorization
  - **Verifies invariant:** none (no-event negative control is asserted at T28.5.8)
  - **Consumes:** per-leg statuses ← T28.2.7 (Phase 2, merged).

- **T28.5.5 — Client SDK `mcp.*` surface.**
  - Files: `packages/client-sdk/src/mcp-client.ts` (CREATE) + `packages/client-sdk/src/index.ts` (EXTEND — the client's named exports)
  - Typed client methods for every `mcp.*` operation and every `session.mcp*` operation over the `JsonRpcClient` transport, including the `mcp.subscribe` and `session.mcpServerList` stream consumers.
  - **Spec coverage:** Spec-024 §Interfaces And Contracts
  - **Verifies invariant:** none (transport surface)
  - **Consumes:** `JsonRpcClient` ← Plan-005-partial `transport/json-rpc-client.ts` (shipped, CP-005-3).

- **T28.5.6 — CLI `sidekicks mcp` command group.**
  - Files: `apps/cli/src/commands/mcp-list.ts`, `mcp-add.ts`, `mcp-remove.ts`, `mcp-override.ts`, `mcp-login.ts`, `mcp-watch.ts` (all CREATE) + `apps/cli/src/main.ts` (EXTEND — six `.register()` calls)
  - Subcommands under the Plan-005 registered bin name; `mcp-watch.ts` tails `mcp.subscribe`. There is no sign-out subcommand: the design gives `mcp.oauthLogout` one control, `Sign out of this server` on Settings › MCP servers (T28.5.7, T28.5.11), and names no command-line sign-out. clipanion has no auto-discovery, so each file needs an explicit `.register()` on the `Cli` instance. Honors Plan-005's I-005-12 import isolation (only `@ai-sidekicks/client-sdk` / `@ai-sidekicks/contracts` / `clipanion` / Node built-ins), enforced by `apps/cli/eslint.config.mjs`, which Plan-005 T-005r-3-1 creates. **`mcp-login.ts` prints the daemon-returned authorization URL as the command's own RESULT** — on the result stream `Plan-005 I-005-18` assigns results to, never as a diagnostic — because the URL is what the person must open for the flow to proceed, and a login command that withholds it cannot complete. That is its only destination: it is not logged, not written to any file the CLI owns, and not re-emitted after settlement, and no token, authorization code, or PKCE material reaches either stream at all. The command then settles on the daemon's own completion, never on a timer.
  - **Tests:** `mcp-login` writes the authorization URL to the result stream and nothing credential-bearing to either stream, asserted by capturing both; and no second emission of that URL follows the completion.
  - **Spec coverage:** Spec-024 §Interfaces And Contracts
  - **Verifies invariant:** none (client reachability surface)
  - **Consumes:** the `apps/cli/` scaffold + `src/commands/` directory + `main.ts` `Cli` builder ← Plan-005 Phase R3 (T-005r-3-1 / T-005r-3-2).

- **T28.5.7 — Desktop MCP-governance settings page (CP-022-4, CP-022-5).**
  - Files: `apps/desktop/src/renderer/src/features/settings/pages/mcp-servers/` (EXTEND)
  - Panel views reading `mcp.list` / `mcp.get` and the `mcp.subscribe` stream **only** through the renderer's `services/daemon/` client — no direct daemon access from the renderer and no view reading `window.desktopBridge` (the CP-013-8 pattern; live bridge verification arrives with Plan-020's remainder).
  - **The MCP servers page.** The views become the full settings-level page [Spec-024 §The MCP servers page](../specs/024-mcp-server-configuration-and-governance.md#the-mcp-servers-page) and the MCP Servers View sketch under [Spec-021 §Signature Feature Composition Sketches](../specs/021-desktop-app-and-renderer.md#signature-feature-composition-sketches) specify: the two-pane server list and detail, the per-tool effective idempotency class marked as native baseline or an override the person set, and the mutating controls — add / update with `Where it applies` and its project chooser, `Browse servers`, remove, enable / disable, set / clear a tool override, sign in and sign out, and reconnect — **one wire mutation per explicit action by the person**, over the `mcp.*` operations this plan documents; the list's first read and its failure with `Try again`; and the `Failed` line for a command that cannot run after a move. Three properties are obligations rather than styling. **(1)** The page updates from `mcp.subscribe` and **never** polls `mcp.list` on a timer. **(2)** Configuration content splits three ways rather than being uniformly withheld: the declaration form **collects** what `mcp.upsertServer` accepts — transport, command, args, URL, timeouts, the required marker, env-var and header names, and the credential-bearing values that input shape admits, those held **write-only in the renderer** (masked, never read back, never in serializable renderer state, cleared on submit); it **reads back** exactly `McpServerConfigView` and nothing beyond it; and it **renders nothing the daemon does not serve** — env-var values, header values, tokens, URL query values — and reads no provider config file. The OAuth launch URL is governed by that same write-only discipline rather than by the withholding rule: it arrives on the `mcp.oauthLogin` reply, is rendered so the person can open it, is held in no serializable renderer state and no client-side storage, is entered into no log, and is dropped at settlement — one destination, for the life of one attempt. **(3)** It **derives no state and projects no eligibility**: connection status and effective class are wire-verbatim and recomputed nowhere, while eligibility is projected **not at all** — no inventory or event field on this governance layer reports whether an operation would be permitted, so every control is offered, the daemon adjudicates, and the typed refusal renders. The single non-offer is a control whose required input is structurally absent from the served entry — on the degraded arm the store-dependent fields are structurally absent, so the per-tool controls have nothing to act on while every control whose input did arrive is offered exactly as on the normal arm — which is missing data rather than a derived judgment. Plan-020 owns the settings frame and the page list, which already registers this page, and owns nothing inside this folder (CP-022-5 ⇄ CP-020-4).
  - **Spec coverage:** Spec-024 §Status Observation and Events; Spec-024 §The MCP servers page; Spec-021 §Signature Feature Composition Sketches (the MCP Servers View sketch)
  - **Verifies invariant:** none (read-and-steer view layer; the refusals it surfaces are the daemon's)
  - **Tests:** an effective idempotency class rendered from the daemon read is not recomputed when a tool override changes — asserted by setting an override and checking the class re-renders only on the daemon's own row, since the failure mode is a plausible local re-derivation; an override the daemon refuses renders the daemon's reason and the control was not pre-disabled; the page issues no `mcp.list` call on a timer with the subscription live; and no value the daemon withholds — env-var value, header value, token, or URL query value — reaches a rendered node, asserted against a served `McpServerConfigView` whose name-only fields are present, so the assertion distinguishes withheld values from absent configuration rather than passing vacuously. A credential-bearing form value is absent from serialized renderer state and cleared after submit, asserted by snapshotting that state rather than by inspecting the request — the same snapshot asserting that a rendered authorization URL is absent from it and gone after settlement, while a token, authorization code, and PKCE value are absent from every bridge payload the page ever receives; and every mutating control is **offered** on a binding the daemon will refuse — a Codex project-file override refused with `mcp.config_write_conflict` among them — with the refusal rendered, the assertion that the page projects no eligibility of its own.
  - **Consumes:** the renderer substrate ← Plan-020-partial (shipped); the renderer's `services/daemon/` client.

- **T28.5.8 — End-to-end acceptance sweep against Spec-024 §Acceptance Criteria.**
  - Files: `packages/runtime-daemon/src/mcp/__tests__/acceptance.test.ts` (CREATE)
  - One assertion per Spec-024 §Acceptance Criteria bullet, fixture-driven against fake provider wires for both CLIs, plus the Adversarial-Tampering sweep: credential echo over every payload / error code / the config view / receipt rows / logs / helper command lines / renderer state **and the two Phase-5 egress surfaces (CLI stdout and the renderer bridge payloads)** — credential material asserted absent at both, and `authorizationUrl` asserted by destination per the boundary sweep above: absent from the subscription, the events, the receipt row, and the logs, and present only on the login reply each client consumes; raw-`scopeRef` absence; provider-file byte-identity after every refused mutation; and the hash-brute-force negative control (no served or stored digest is reproducible from a database copy alone). Every error code reachable and absent from success paths.
  - **Spec coverage:** Spec-024 §Acceptance Criteria
  - **Verifies invariant:** I-022-1, I-022-2, I-022-3, I-022-4
  - **Consumes:** every Phase 1–4 surface (same plan, merged).

- **T28.5.9 — The daemon's own MCP client.**
  - Files: `packages/runtime-daemon/src/mcp/client/` (CREATE)
  - One module on `@modelcontextprotocol/client` 2.1.0, the one maintained MCP client that signs DPoP proofs; `@modelcontextprotocol/sdk` stays only to host Playwright's tool server. It makes a call task-augmented wherever the tool allows one (`taskSupport` `required` or `optional`), writes the `taskId` to `command_receipts.mcp_task_id` before answering anything else, and polls with Claude Code's figures (2 s by default, the server's `pollInterval` held between 100 ms and 60 s, a halt after 10 failures in a row with the handle kept). It starts a stdio server with the environment values its declaration holds, or connects to an address with its headers, reading those values from the provider's config only for the connection. It serves the fronted route (T28.5.10), Codex's prompt list over the connection it already holds for the server, so listing prompts never starts a second copy of it, the workflow MCP-tool step's `tools/call`, and Plan-012's recovery sweep, which resumes every receipt with a handle to a server reached at an address (`tasks/get` to a terminal status, then `tasks/result`).
  - **Spec coverage:** Spec-024 §Long tool calls and the fronted route, Spec-024 §Implementation Notes
  - **Verifies invariant:** I-022-1
  - **Consumes:** `command_receipts.mcp_task_id` ← Plan-003 T5.1.
  - **Not built:** the client.

- **T28.5.10 — The fronted route and background long calls.**
  - Files: `packages/runtime-daemon/src/mcp/client/fronted-route.ts` (CREATE)
  - On a Codex session, rewrite each entry of T28.3.8's table as a `url` entry on the daemon's route under the server's own name, keeping its `enabled` flag; the client holds the real connection, one stdio copy per conversation. Answer a call normally when it ends within 120 s; past 120 s, or when the daemon steers the conversation while it runs, answer with Claude Code's handle text and keep the call running. Serve `task_output {task_id, wait_seconds?}` (waiting at most 10 s) and `task_stop {task_id}` (`tasks/cancel` for a task-augmented call, `notifications/cancelled` for a plain one). When the call ends, deliver `MCP task <id> (<server>/<tool>) completed.` with the result by `turn/steer` into a running turn or `turn/start` into an idle one, and to a helper a Codex agent started, which takes no direct input, at its next tool call by the post-tool hook's added context or by the `SubagentStop` continuation as it finishes, and set `delivered` on the receipt so a result after a restart is delivered once. Apply Codex's per-tool approval on the route from the session's permission level and the server's `tools.<t>.approval_mode`; hand an elicitation on as the session's question card and a progress notice as the row's progress line. Front a server behind a sign-in on the daemon's sign-in. On a Claude Code session front only a DPoP server, signing a proof per request, a long call there taking the client's own task handling. Budget: at most 5 ms added to a fronted call against a direct one, measured at build.
  - **Tests:** a probe server's long call with the route's delay lowered is answered with the handle text, `task_output` returns its result once it ends, and the result is delivered exactly once by `turn/steer` into a running turn and by `turn/start` into an idle one, and to a Codex helper by the post-tool hook's added context, with no `turn/steer` or `turn/start` sent to it; `task_stop` cancels it; after a daemon restart a task-augmented call's result is delivered once and a stdio server's task halts.
  - **Spec coverage:** Spec-024 §Long tool calls and the fronted route
  - **Verifies invariant:** I-022-1
  - **Consumes:** the client ← T28.5.9 (same phase); the session table ← T28.3.8 (Phase 3, merged); `turn/steer` / `turn/start` delivery ← Plan-003's Codex driver; the Claude Code side (`CLAUDE_AUTO_BACKGROUND_TASKS=1` at process start) ← Plan-003's Claude Code driver.
  - **Not built:** the route, `task_output`, `task_stop`, delivery and the `delivered` flag.

- **T28.5.11 — `mcp.oauthLogout`.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-sign-in-service.ts` (EXTEND) + `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (EXTEND)
  - Receipted. Delete the daemon's refresh-token item for the server, and its DPoP signing-key item where it has one, and stop answering the helpers for it, so each provider's next call gets no token; each connected leg's transition to `needs-auth` emits `mcp.server_status_changed`, and the operation mints no event of its own.
  - **Tests:** after sign-out both credential-store items are gone, a helper asked for that server prints nothing, and every leg on both providers reads `needs-auth` on its next call.
  - **Spec coverage:** Spec-024 §OAuth Orchestration, Spec-024 §Authorization
  - **Verifies invariant:** I-022-1, I-022-3
  - **Consumes:** the sign-in service ← T28.5.1 (same phase).
  - **Not built:** the operation.

- **T28.5.12 — A session's own tool servers.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/session-mcp-handlers.ts` (CREATE)
  - `session.mcpServerList {sessionId}`: a live list of the servers the session was started with, each row from the inventory — name, binding, status and reason, whether it is on for the session, whether a switch waits for the next turn — with only names and statuses, never a config value. `session.mcpServerUpdate {sessionId, serverName, enabled}`: a session-level switch that only narrows what governance allows, kept with the session, applied at the next turn — on Claude Code another full-set `mcp_set_servers` call, on Codex the conversation's `enabled` flag — and sent again after each resume; a new session starts with every server on; no governance event. `session.mcpResourceList {sessionId, serverName}`: what a working server offers, for the composer's attachment row (on Codex through `mcpServer/resource/read`), refused for a server that is off or not working.
  - **Spec coverage:** Spec-024 §A session's own tool servers
  - **Verifies invariant:** none (session reads and a narrowing switch; asserted at T28.5.8)
  - **Consumes:** the inventory ← T28.2.4 (Phase 2, merged); the session sets ← T28.3.3 and T28.3.8 (Phase 3, merged).
  - **Not built:** all these operations.

## Rollout Order

1. Phases 1–5 as sequenced above.

## Rollback Or Fallback

- All the plan's tables are additive and Plan-022-only — rollback of any phase is a revert; no other plan reads or writes them.
- The `MethodRegistry` feature gate keeps `mcp.*` and `session.mcp*` operations `not_implemented` until their backing phase, so a mid-sequence pause leaves no half-built surface.
- Provider-side state needs no rollback by construction: I-022-2 means the daemon's writes are always provider-valid config the person could have made by hand.

## Risks And Blockers

- **Provider drift beyond the pins.** The provider-wire reference re-pins on its own cadence and `0.141.0` is the Codex **floor** rather than the pin; the config-method introduction versions remain unresolvable from upstream docs (bounded ≥ `0.141.0`). Mitigation: the per-capability detection + re-verify-at-execution rule (Spec-024 §Implementation Notes) is a hard phase-entry step, and Spec-004 §Required Behavior makes per-capability declared detection the driver-wide rule — so drift above the pin degrades one capability instead of a session, and the nightly compatibility check reports the drift without gating anything.
- **MCP 2026-07-28 revision.** Lands mid-execution window; binds here only through provider releases (Spec-024 binds provider surfaces, not the MCP wire). Watch item, not a blocker.
- **A Claude Code session that refuses the live reconcile.** Every build Spec-004 §Required Behavior admits (`2.1.286` and later) answers the reconcile control request on the driver's streaming-input transport: measured, it answers `success` at `2.1.234`, `2.1.245` and `2.1.246`, and an unknown subtype is refused. The measurement uses an **empty** desired set against a scratch session, out of band, so it shows the subtype dispatches and returns the documented reconcile envelope, not that a non-empty set lands; T28.3.2's own reconcile, run against the server set it is about to install, confirms that. The live path is the default on every admitted build. The risk is reachability, not version: a session the CLI treats as cloud-hosted refuses control requests a local one answers. Such a session gets its servers no other way: they read `Failed` with the refusal as their reason, and a change made meanwhile answers with grade `user_config_write` ([Spec-024 §Fallback Behavior](../specs/024-mcp-server-configuration-and-governance.md#fallback-behavior)). So T28.3.2 treats the reconcile as detection, and its `{control-channel reachable, control-channel unreachable-on-an-admitted-build}` fixture arms exercise a reconcile refusal rather than a version comparison.
