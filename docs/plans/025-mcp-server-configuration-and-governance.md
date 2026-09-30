# Plan-025: MCP Server Configuration and Governance

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `025` |
| **Slug** | `mcp-server-configuration-and-governance` |
| **Date** | `2026-07-22` |
| **Author(s)** | Claude (AI-assisted) |
| **Spec** | [Spec-025](../specs/025-mcp-server-configuration-and-governance.md) |
| **Required ADRs** | [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-040](../decisions/040-mcp-credential-custody.md) |
| **Dependencies** | [Plan-003](./003-queue-steer-pause-resume.md) (the `RunSetupGate` registration seam per CP-003-8, carrying the run-admission drift gate per CP-025-5), [Plan-004](./004-provider-driver-contract-and-capabilities.md) (driver seams: `onMcpServerStatus` producer, `driver_tools` metadata store, capability probe), [Plan-005](./005-session-event-taxonomy-and-audit-log.md) (event registry + append path; T1.10 registers the five `mcp.*` literals), [Plan-006](./006-local-ipc-and-daemon-control.md) (partial — `MethodRegistry` dispatch substrate + the streaming primitive `mcp.subscribe` rides), [Plan-010](./010-approvals-permissions-and-trust-boundaries.md) (Cedar `PermissionCheckService`), [Plan-013](./013-persistence-recovery-and-replay.md) (the startup-recovery attach admission seam — T15.3's vacuous-default gate that CP-025-5's composition-root wiring fills; order-independent: the default is honestly vacuous until Plan-025 ships), [Plan-021](./021-desktop-app-and-renderer.md)-partial (shipped — renderer substrate + `window.desktopBridge` bridge stub consumed by the Phase 5 desktop MCP panel views; live bridge verification with Plan-021's remainder, per the cross-plan graph's Plan-025 row) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Deliver V1 feature #18: the daemon's MCP governance layer per [Spec-025](../specs/025-mcp-server-configuration-and-governance.md) — unified server inventory over scope-qualified bindings, configuration mutation at every scope on both providers (Claude Code's `claude mcp add-json --scope` writes + live reconcile; Codex user-config CRUD + reload, the daemon's own format-preserving edit of a project's `.codex/config.toml`, and the emulated `local` scope), the base-config-hash-bound trust store with its gate on repository-borne servers, tool-level overrides feeding the Plan-004 tool-metadata resolution layer, the daemon's own OAuth sign-in per server under [ADR-040](../decisions/040-mcp-credential-custody.md), the daemon's own MCP client and the route that fronts servers for Codex, a session's own server set, a search of the public MCP Registry, normalized status observation, and the `mcp_governance` audit surface — all Cedar-gated, open to this machine's own client or any linked device, and no session.

## Scope

- `packages/contracts`: `mcp.*` operation payload schemas (the `McpServerBindingRef` discriminated union, the redacted `McpServerConfigView`, per-leg `McpServerLegStatus` / `McpLiveApplicationResult`, the mandatory `clientIdempotencyKey`, `scope` and `scopeRef` on upsert and remove, `mcp.registrySearch`, `mcp.oauthLogout`, the entry's `failedReason`), the `session.mcp*` schemas, the `McpGovernanceEventPayload` schemas (emitter-authors-payload precedent — the type literals and category themselves are Plan-005-owned, registered by Plan-005 T1.10), error-code constants.
- `packages/runtime-daemon`: `mcp_server_trust` + `mcp_tool_overrides` + `mcp_mutation_receipts` + `mcp_server_admitted_clients` in the daemon's one schema; the `McpGovernanceService` (inventory, trust, overrides, idempotency receipts), provider config adapters (Claude Code's `claude mcp add-json --scope` writer at every scope + session-set builder + live-reconcile client; Codex config CRUD client, project-file writer and `local` emulation), status normalizer consuming the Plan-004 `onMcpServerStatus` seam, the drift-admission service registered through Plan-003's `RunSetupGate` seam and wired into Plan-013's recovery attach seam (CP-025-5), the daemon's own MCP client and its fronted route, the sign-in service with its credential-store custody and header-helper answerer (ADR-040), the registry search, the `mcp` Cedar action wiring, `mcp.*` and `session.mcp*` `MethodRegistry` handlers incl. the `mcp.subscribe` live-tail stream.
- `packages/client-sdk` + CLI/desktop surfaces: typed `mcp.*` and `session.mcp*` client methods; CLI `sidekicks mcp …` command group (the Plan-006 registered bin name); desktop MCP panel data hooks over `mcp.list`/`mcp.get` + the `mcp.subscribe` stream.
- Doc mirrors: [api-payload-contracts.md §Plan-025 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-025--mcp-governance-contract-surfaces), [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance), [local-sqlite-schema.md §MCP Governance Tables (Plan-025)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-025). Code phases keep them true.

## Non-Goals

- Everything [Spec-025 §Non-Goals](../specs/025-mcp-server-configuration-and-governance.md#non-goals) excludes: no governance added by the daemon's own MCP client beyond what a direct connection gets (the daemon's callback-tool host of [Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior) sits outside this governance model and is never trusted, drift-evaluated, or override-governed), no credential custody beyond [ADR-040](../decisions/040-mcp-credential-custody.md), no provider-config-store ownership, no installing a server on the person's behalf, no governance by a caller who does not own the node (ownership is the whole predicate — never which transport carried the call, per [Spec-025 §Authorization](../specs/025-mcp-server-configuration-and-governance.md#authorization)), no session permission-matrix extension.
- No new `ApprovalCategory` value — governance mutations are direct Cedar decisions, not interactive approvals.
- No emitter code for any non-`mcp.*` event literal Spec-005 mints (`session.*` / `run.*` / `usage.*` / `user.message` emitters belong to Plan-003 / Plan-004 per [Plan-005 §Event Taxonomy Coverage](./005-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)).

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-025 PRs and downstream extensions.

### I-025-1 — Credential custody is exactly what ADR-040 records

The daemon holds an MCP server's credentials only as [ADR-040](../decisions/040-mcp-credential-custody.md#decision) records: one sign-in per server; its refresh token, and for a DPoP server its signing key, in the operating system's credential store under items the daemon created, never in a file and never in SQLite; access tokens in memory, handed only to the header helper of a provider process the daemon launched and to its own MCP client. It never reads or renews a sign-in the person's own Claude Code or Codex holds, and never logs, relays, or embeds in events, errors, receipts, read models, wire payloads, renderer state, or a helper's command line any OAuth token, authorization code, PKCE material, signing key, bearer-token value, or env-var value belonging to an MCP server. The `mcp.oauthLogin` idempotency receipt stores its acknowledgment with `authorizationUrl` structurally omitted — launch URLs embed single-use PKCE state, so they are never durable and its replay is a URL-free acknowledgment. That URL's **sole carrier is the `mcp.oauthLogin` reply**: it appears on no durable and no broadcast destination, and each client consumes it at exactly one — the login command's own result stream, and transient renderer state cleared at settlement. The only durable auth trace on the governance stream is the `mcp.server_oauth_completed` event (identity + outcome).

**Why load-bearing.** The daemon holding refresh tokens for every server the person signs in to puts it in their blast radius; ADR-040 accepts that only inside these bounds. A credential on any other surface, a token handed to a process the daemon did not launch, or a renewal of a sign-in the person's own provider holds (which signs that provider out, because servers rotate a public client's refresh token) would each break the record. Plan-020's PII/retention model assumes no credential columns exist.

**Verification.** Schema-level adversarial test sweeping every event payload schema + every error code + every table DDL for credential-shaped fields (incl. the `McpServerConfigView` read model — env/header/query-param names only, never values, the URL served query-redacted — and the receipts row: the digest is keyed under the receipt-digest subkey of the governance key, which the database holds only sealed under the daemon master key, the stored `response_json` is a sanitized wire payload by construction, and the `mcp.oauthLogin` row is asserted URL-free); integration tests asserting a sign-in leaves no new SQLite rows beyond the completion event, its receipt and the admitted-client record, and exactly one new credential-store item per server (two for a DPoP server); that `mcp.oauthLogout` removes those items; that a provider-owned sign-in planted outside the daemon's homes is untouched after sign-in, renewal and sign-out; and that no helper command line carries a credential.

### I-025-2 — Untrusted by default; trust is hash-bound and drift-revoked

Every observed binding `(provider, scope, scopeRef, serverName)` gets a `trusted = 0` trust row on first observation; `trusted = 1` is reachable only via the person's `mcp.setTrust`; a trusted binding whose base-config hash (keyed BLAKE3 under the binding's config-hash subkey, derived from the governance key, which SQLite holds only sealed under the daemon master key; daemon-managed override-projection fields excluded) diverges from the bound hash is auto-revoked (`revoked_reason = 'config_drift'`) before the changed config informs any decision surface, with safety-weakening override facets neutralized in the same operation (Spec-025 §Trust Governance — revocation neutralizes weakening). Drift evaluation is **hash-plus-projection**: the hash-excluded override-projection fields are reconciled on every evaluation against the expected native state — the preserved `native_tool_baseline_json` baseline overlaid with the materialized facets (Spec-025 §Trust Governance) — so a projection-field-only out-of-band edit drifts too, never rides under an unchanged base hash, and the trusted-no-override corner is covered (the baseline snapshots at trust grant, not only at first materialization). "Before use" is admission-enforced at both call sites: the CP-025-5 drift-admission service completes a fresh provider-config read and full drift processing before any provider process spawns against the affected bindings — at run starts via the `RunSetupGate` registration and at daemon-restart recovery via the Plan-013 attach seam — so out-of-band edits can never race a run start or a recovery resume past drift detection.

**Why load-bearing.** This is the trusted-server store, managed by the person, that ADR-015 binds the MCP annotation-trust MUST to; a default-trust or stale-hash path would let a mutated server inherit trust granted to a different configuration.

**Verification.** Unit tests over the trust service state machine (observe → grant → drift → re-grant); integration test mutating a trusted server's config between observations and asserting revocation precedes use.

### I-025-3 — Writes go through the provider's own mechanism, or a guarded edit where there is none

Configuration mutations go through each provider's own mechanism wherever one exists (Claude Code: `claude mcp add-json` / `claude mcp remove` at the binding's `--scope` as the unconditional durable leg, and `mcp_set_servers` as the live leg and the session-declaration surface; Codex: `config/value/write` / `config/batchWrite` on the user file with `expected_version`, followed by reload, and the conversation's `thread/start` table for a session). The one file no provider mechanism writes, a project's `.codex/config.toml`, is changed only by a format-preserving edit renamed into place while the file still hashes to what the daemon last read, and counts only once `config/read` lists the server in its project layer. The daemon never rewrites any other provider config file directly, and never uses `mcp_toggle`.

**Why load-bearing.** Blind file rewrites race the provider's own writes, corrupt layered scopes, destroy the comments and layout of a file that belongs to the person and the repository, and break the inventory's source-of-truth model; `mcp_toggle` persists a per-project "off" the person never chose.

**Verification.** Integration tests asserting provider files are byte-identical after every daemon mutation except through these paths; a hand-commented Codex project file round-trips an add and a remove with its comments and layout intact; a project file changed between the daemon's read and its write refuses with `mcp.config_write_conflict`, file unchanged; no Claude Code process is ever sent `mcp_toggle`.

### I-025-4 — Every governance mutation is Cedar-authorized and audited exactly once

Each non-read `mcp.*` operation (`mcp.list`/`mcp.get`/`mcp.subscribe`/`mcp.registrySearch` are the reads) evaluates the `mcp` Cedar actions before any provider call or store write, and each of the **six governance mutations** (`mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setTrust`, `mcp.setToolOverride`, `mcp.clearToolOverride`) emits its defined `mcp_governance` event set exactly once — a single event for most mutations; a weakening-facet trust revocation appends its atomic batch, the trust event plus one `mcp.tool_override_changed` per reverted facet (sentinel-bound for node-scope events per [Spec-005 §Daemon-Scope Event Binding](../specs/005-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding)) — exactly-once made durable by the mandatory `clientIdempotencyKey` + the **two-phase** `mcp_mutation_receipts` (a `pending` intent commits before the provider leg; finalization, store writes, and the event set commit in one SQLite transaction; startup reconciliation completes any crash-window intent so a durable provider write is never left unaudited — the Plan-013 `command_receipts` discipline; an identical retry replays the receipt, a divergent reuse fails `mcp.idempotency_conflict`, and neither re-emits). The Cedar-gated operational commands sit outside the atomic mutation set (Spec-025 §Authorization): `mcp.reconnect` changes no store or config and audits through the `mcp.server_status_changed` transitions it induces; `mcp.oauthLogin` is receipted but its durable trace — `mcp.server_oauth_completed` — completes asynchronously and cannot commit with the launch acknowledgment, so it is emitted exactly once per **completed** sign-in, the daemon's own callback or the provider's flow finishing in the throwaway home (an abandoned sign-in, or one ended by a newer attempt, leaves only the expiring receipt); `mcp.oauthLogout` is receipted and mints no event of its own, its trace being the `mcp.server_status_changed` transition to `needs-auth` on each leg that was connected on that sign-in.

**Why load-bearing.** The audit trail is the governance feature — an unaudited mutation path is indistinguishable from tampering; authorization-after-mutation would be TOCTOU.

**Verification.** Per-operation integration tests asserting deny-before-effect and one-event-set-per-mutation (incl. the revocation-batch count); event-count assertions on retry paths (the Codex conflict retry must not double-emit) and the crash-window reconciliation fixture (durable provider write + lost finalization → startup appends the event exactly once).

### I-025-5 — The idempotency floor moves only through governed override

MCP-sourced tools resolve to `manual_reconcile_only` unless an `mcp_tool_overrides` row assigns `idempotent` / `compensable`; assignment requires a trusted server and Cedar authorization; the resolution layer (Plan-004's) is the only reader — downstream consumers never read the override table directly.

**Why load-bearing.** [Spec-004 §Tool Metadata](../specs/004-provider-driver-contract-and-capabilities.md#tool-metadata) makes the conservative floor the safety spine of Spec-013 recovery; an ungoverned or untrusted path off it would let recovery replay non-idempotent tools.

**Verification.** Resolver unit tests (floor absent override; override applied; override ignored when trust revoked mid-session); the `mcp.trust_required` acceptance test.

### I-025-6 — Trust revocation neutralizes the durable surface, not only the live one

A trust revocation — initiated by the person or drift-driven — rewrites every non-terminal `command_receipts` row stamped with the revoked binding's `mcp_binding_digest` to the `manual_reconcile_only` floor, inside the revocation's own transaction. Recovery keeps dispatching on the stamped `idempotency_class` and never re-resolves an override. **The digest is keyed, so its key is part of this invariant.** `mcp_binding_digest` is a keyed BLAKE3 over the binding tuple, and a revocation matches receipts by recomputing that digest — so if the binding-identity subkey becomes unavailable (host re-key, keystore loss, a restore onto a host whose governance master key differs), the daemon can no longer prove which stamped receipts a revocation covers. In that state it MUST neutralize **every** non-terminal receipt carrying a non-`NULL` `mcp_binding_digest` to the `manual_reconcile_only` floor, and refuse to stamp new digests until a key is available. Unmatchable is treated as revoked, never as untouched: the alternative leaves `compensable` receipts dispatching under an authority the daemon can no longer even identify.

**Why load-bearing.** I-025-5 moves the floor only while trust holds, but the floor is _stamped_ into a durable row at accept time, and [Spec-013](../specs/013-persistence-recovery-and-replay.md) recovery dispatches on that stamp with no session to re-resolve against. Without this, a receipt stamped `compensable` under a trust revoked minutes later would be auto-compensated by a post-crash recovery under an authority that no longer exists — a governed weakening outliving its governance, which is the failure I-025-5 exists to prevent, displaced in time. Neutralizing inside the revocation's transaction is what keeps the durable and live surfaces agreeing at every instant; the alternative — having recovery re-resolve — is precisely the re-resolution Spec-013's dispatch contract forbids, and would also be impossible, since the binding's scope is a session-scoped fact recovery does not have.

**Verification.** A revoke-then-recover integration fixture **per entry point** (the person's `mcp.setTrust` to untrusted; drift auto-revoke): stamp a `compensable` receipt, revoke, kill the daemon, recover, and assert the tool halts at the floor instead of compensating. A transactional-atomicity test asserting a revocation that fails after the trust write leaves no receipt rewritten and no event appended. A negative control asserting terminal receipts and `NULL`-digest receipts are untouched by either entry. A key-loss fixture: stamp a `compensable` receipt, make the binding-identity subkey unavailable, restart, and assert every non-terminal digest-bearing receipt is at the floor and that a new tool acceptance refuses to stamp rather than writing an unverifiable digest.

## Cross-Plan Obligations

### CP-025-1 — Event registration rides Plan-005 T1.10

The `mcp.*` event literals and the `mcp_governance` category are Plan-005-owned registry surface, registered by [Plan-005 §Event Taxonomy Coverage](./005-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)'s T1.10 registration task. Plan-025 authors the payload schemas (emitter-authors-payload precedent, the Plan-010 `ApprovalFlowEventPayloadSchema` shape) and MUST NOT add the literals to `packages/contracts/src/event.ts` itself.

**Resolution.** Plan-005 T1.10 — the registration task this obligation rides — merges before Plan-025 Phase 1; the phase-scoped precondition below enforces it.

### CP-025-2 — Plan-004 seam consumption (status producer + tool-metadata resolution)

Plan-025 is the declared consumer of two Plan-004 surfaces: (a) the `onMcpServerStatus` producer seam (`McpServerStatusEmission` → `McpServerStatusUpdate`, whose consumer Plan-004 names as this plan), consumed by the Phase 2 status normalizer; (b) the tool-metadata resolution layer over the `driver_tools` store, which Phase 4 extends with the `mcp_tool_overrides` overlay — Plan-025 reads that store's resolution output, never Plan-004's owned symbols directly. The overlay is **binding-keyed**: the Plan-004 store resolves by `(driver_name, tool_name)`, which cannot disambiguate the same `serverName` bound in two scopes, so the Plan-025-owned overlay keys its lookup by the full `McpServerBindingRef` plus `toolName`. Plan-004 exposes no named resolver service — [Spec-004 §Tool Metadata](../specs/004-provider-driver-contract-and-capabilities.md#tool-metadata) states the floor as a rule over the `driver_tools` store — so the overlay is a Plan-025-owned module reading that store's output, never a decorator over a Plan-004 symbol. The **effective binding** the lookup needs is **derived in-plan** by T28.4.11 from the post-drift session sets T28.4.6 already builds, and the recovery-receipt surface is served by the stamped `command_receipts.mcp_binding_digest` under CP-025-7 / I-025-6 rather than by re-resolution, which [Spec-013 §Required Behavior](../specs/013-persistence-recovery-and-replay.md#required-behavior) forbids.

**Resolution.** Plan-004 Phase 3 merged is the Phase 2 precondition; the overlay lands as a Plan-025-owned decorator around the Plan-004 resolver surface in Phase 4. Reciprocal Plan-004 return-cite: its `onMcpServerStatus` consumer note names Plan-025.

### CP-025-3 — `mcp` Cedar actions via Plan-010's policy surface

Plan-025 consumes `PermissionCheckService` and registers the `mcp` Cedar actions through the Plan-010 `policy/` services — the same consumer pattern as Plan-015's Cedar policy reuse in Plan-010's CP-010-4. No Plan-010-owned symbol is modified; the actions are an additive policy-module registration.

**Resolution.** Plan-010 Phase 2 merged is the Phase 4 precondition; the Plan-010 return-cite is its CP-010-4 consumer enumeration, per that clause's consumer-registration pattern.

### CP-025-4 — `mcp.*` namespace registration against the Plan-006 substrate

The `mcp.*` operations and the `session.mcp*` operations register against `MethodRegistry.register()` (`packages/contracts/src/jsonrpc-registry.ts`, shipped) when this plan lands — the Plan-006 CP-006-3 late-namespace pattern (`presence.*` precedent: namespace owners register when they land against the stable substrate); `mcp.subscribe` and `session.mcpServerList` additionally ride Plan-006's streaming primitive (the `session.subscribe` long-lived consumer shape).

**Resolution.** Plan-006 Phase 2 merged is the Phase 1 precondition; the handlers land in Phase 2–5 as each operation's backing service exists. The Plan-006 return-cite is the CP-006-3 heading and its registry-surface enumeration.

### CP-025-5 — Drift admission at run start (Plan-003 `RunSetupGate`) and recovery attach (Plan-013 seam)

The Spec-025 §Trust Governance drift gate is one Plan-025-owned admission service — fresh provider-config read, keyed base-config hash recompute, projection-field reconciliation against the baseline-anchored expected native state, and full drift processing (auto-revocation + weakening neutralization incl. Codex native-field re-assertion) — invoked from **two admission points**. (a) Run/thread starts: registered through Plan-003's `RunSetupGate` registration seam (`{ assertRunReady, onRunTerminal? }`, the ordered gate array on `run-engine.ts` per CP-003-8) — a registration call, never an edit to Plan-003's owned files (the CP-008-9 precedent); `assertRunReady` completes drift processing before the run leaves `starting`, and each provider's session set is then built from the post-drift state. (b) Daemon-restart recovery: Plan-013's startup attach sequence — adoption and cold resume alike — invokes the same service through the vacuous-default admission seam on `startup-recovery-service.ts` (T15.3's attach-seam clause) before any `resumeSession` dispatch; Plan-025's Phase 4 ships the **composition-root wiring** that replaces the vacuous default with the real service (the Plan-003 T3.14 `RollbackAttributionSource` composition-root precedent), plus the runtime assertion that a production daemon carrying Plan-025 never constructs recovery with the vacuous default. Before Plan-025 ships, the vacuous default is honest — no trust store exists, so there is no drift to process.

**Resolution.** Plan-003 Phase 3 merged is the Phase 4 precondition (the gate lands with the trust machinery it enforces); the Plan-013 seam is order-independent (vacuous until Plan-025's wiring lands — whichever plan executes first, the composed behavior activates once both have shipped, enforced by the Phase-4 runtime assertion). Both reciprocals are in place: Plan-013 T15.3's attach-seam clause names this obligation, and Plan-003's CP-003-8 extender enumeration names this plan.

### CP-025-6 — Renderer substrate via Plan-021-partial

The Phase 5 desktop MCP panel views consume daemon state only via the `window.desktopBridge` bridge over the Plan-021-partial renderer substrate (shipped; live bridge verification with Plan-021's remainder) — the [Plan-014 §Cross-Plan Obligations](./014-multi-agent-orchestration.md#cross-plan-obligations) CP-014-11 renderer-bridge pattern. **Tasks:** T28.5.7.

**Resolution.** Declared in the plan header; Phase 5's precondition names it. The substrate has shipped.

### CP-025-7 — `command_receipts.mcp_binding_digest` EXTEND (Plan-003 owner)

Plan-025 EXTENDs the Plan-003-owned `command_receipts` table with one additive nullable column, `mcp_binding_digest`, carrying the governed binding a receipt's tool resolved from as a path-free keyed digest — the durable half of I-025-6. This follows the table's established EXTEND pattern exactly: Plan-013 adds the two-phase columns and Plan-004 adds the additive nullable `mcp_task_id` to the same table in the daemon's one schema. The column is written from the same Plan-025 resolution output that already supplies `idempotency_class` to the receipt write, so no new write seam is introduced and no Plan-003-owned or Plan-013-owned file is modified. No [shared-postgres-schema.md §Lock Ordering Across Shared Tables](../architecture/schemas/shared-postgres-schema.md#lock-ordering-across-shared-tables) row is owed: every registrant there locks control-plane Postgres rows, whereas `command_receipts` and the `mcp_*` tables are local SQLite, whose single-writer transactions cannot deadlock across plans.

**Resolution.** `command_receipts` is Plan-003-owned; Plan-025 joins Plan-013 and Plan-004 as an extender, registered on the [local SQLite schema](../architecture/schemas/local-sqlite-schema.md) `command_receipts` block. The reciprocal is an extender-list entry on a table Plan-003 owns — the [CP-006-15 consumer-row precedent](./006-local-ipc-and-daemon-control.md#cross-plan-obligations) for an obligation that rides existing ownership records rather than minting a reciprocal into the owner. The column lands in the daemon's one schema with Plan-025's Phase 4, after Plan-003 Phase 1 adds the table — the same ordering Plan-004's `mcp_task_id` EXTEND carries.

### CP-025-8 — MCP-governance settings page authored here, mounted by [Plan-021](./021-desktop-app-and-renderer.md) (reciprocal of CP-021-7)

[Spec-025 §The MCP servers page](../specs/025-mcp-server-configuration-and-governance.md#the-mcp-servers-page) names the settings-level MCP Servers page and [Spec-021 §Signature Feature Composition Sketches](../specs/021-desktop-app-and-renderer.md#signature-feature-composition-sketches) sketches it. The split is: **this plan authors** the page's components and their projection in its own `apps/desktop/src/renderer/src/mcp-governance/` subtree (T28.5.7), and **Plan-021 mounts** that subtree into the renderer's Settings, as the MCP servers page, and its router at its Phase 6, owning nothing inside it. The reason the split runs this way rather than the reverse is the fail-closed-projection rule: the page must derive no trust state and no effective idempotency class of its own, and a state projection authored in Plan-021's code — away from the plan that owns the governance rules and their drift semantics — is exactly how a second source of truth for those decisions gets written. Eligibility is not projected anywhere, in either plan: no field reports it, every control is offered, and the daemon's typed refusal is what renders. This is distinct from CP-025-6, which is the substrate obligation (the `window.desktopBridge` bridge these components read through); CP-025-8 is the mount-point obligation.

**Resolution.** The reciprocal is Plan-021 CP-021-7. Plan-021 gains no task — the mount is a route-table plus settings-page registration of the shape its Phase 6 already performs for every plan-owned subtree — and T28.5.7 sits in Phase 5 carrying the Plan-021-partial substrate as its precondition. A page mounted before the rest of Plan-021's app exists is unreachable rather than wrong.

## Target Areas

- `packages/contracts/src/mcp-governance.ts` (CREATE) — operation payload schemas (incl. the `McpServerConfigInput` transport-discriminated union with provider-conditional refinements and the Codex auth references `envHttpHeaders`/`oauthScopes`/`oauthResource`, the `McpServerBindingRef` scope-discriminated union with `local` on both providers, `scope` and `scopeRef` on upsert and remove, the redacted `McpServerConfigView` with the query-redacted URL, the entry's `failedReason: commandNotRunnable`, the discriminated degraded inventory arm, the mandatory `clientIdempotencyKey` on every mutation and on both sign-in operations, the ≥ 1-facet override refinement, `mcp.registrySearch {query, cursor?}` → `{servers, nextCursor?}`, `mcp.oauthLogout {serverId}`, and the session-feed `bindingId` conditionality on the status payload), the `session.mcpServerList` / `session.mcpServerUpdate` / `session.mcpResourceList` schemas, event payload schemas, error-code consts, `McpApplicationGrade` (`live_reconcile | user_config_write | next_run | daemon_enforced`), override facet + per-facet application types, per-leg `McpServerLegStatus` / `McpLiveApplicationResult`.
- `packages/runtime-daemon/src/mcp/` (CREATE) — `McpGovernanceService`, `McpInventoryService`, provider adapters (`claudeMcpConfigAdapter`, `codexMcpConfigAdapter`, the Codex project-file writer and `local` emulation), `McpStatusNormalizer`, the sign-in service (the daemon's own OAuth client, the provider-admitted takeover, DPoP keys, the credential-store custody and the header-helper answerer on the daemon's same-user socket), the daemon's own MCP client in `mcp/client/` and its fronted route, the registry search, trust + override stores, the typed `mcp.*` refusal classes in `mcp-errors.ts` (T28.1.5 — subclasses in their own file over Plan-006's `DaemonDomainError` base), the drift-admission service (the CP-025-5 call sites + the recovery composition-root wiring), config-hash canonicalizer (BLAKE3 over RFC 8785 JCS — reusing the Plan-005 canonicalization substrate), and the governance key's custody (one 32-byte key, sealed under the daemon master key in the daemon's database like every other daemon key, as the `daemon_secrets` row `purpose = 'mcp_governance'` ([Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key)), with no key file) with purpose- and binding-separated BLAKE3 keyed-PRF subkeys (config-hash, scope-ref, receipt-digest), plus the startup receipt-intent reconciler.
- `packages/runtime-daemon/src/policy/` (EXTEND via Plan-010's policy-module surface) — `mcp` Cedar action registration (CP-025-3).
- The daemon's one schema (EXTEND) — the tables per [local-sqlite-schema.md §MCP Governance Tables (Plan-025)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-025), with the schema's test (EXTEND) covering them.
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND) — the `mcp.*` namespace handler files per CP-025-4.
- `packages/runtime-daemon/src/bootstrap/index.ts` (EXTEND — Plan-006-owned) — one sanctioned recovery-attach wiring call per T28.4.7.
- `packages/client-sdk/src/mcpClient.ts` (CREATE) + the package-root barrel line — typed `mcp.*` client methods.
- `apps/desktop/src/renderer/src/mcp-governance/` (CREATE) — MCP panel views over the SDK surface.
- `apps/cli/src/commands/` `mcp-*.ts` (CREATE) + the `main.ts` `.register()` EXTENDs — the `sidekicks mcp` command group (`list` / `add` / `remove` / `trust` / `override` / `login` / `watch` — `watch` tails `mcp.subscribe`) under the Plan-006 registered bin name (`bin: { "sidekicks": … }`, the Plan-014 command precedent; per-subcommand filenames: `mcp-list.ts`, `mcp-add.ts`, `mcp-remove.ts`, `mcp-trust.ts`, `mcp-override.ts`, `mcp-login.ts`, `mcp-watch.ts`).

## Data And Storage Changes

- `mcp_server_trust` — `(provider, scope, scope_ref, server_name)` binding PK with the structural-validity CHECK (user ⇔ empty `scope_ref`), an emulated Codex `local` binding a row like any other and removed with its server; `trusted` INTEGER; keyed base-config `config_hash` TEXT `CHECK(config_hash GLOB 'b3:*')` (no key material in the row — every digest key derives from the governance key, which the database holds only sealed under the daemon master key); the `enabled_override` Claude overlay; the `native_tool_baseline_json` pre-governance snapshot (Codex-materialized bindings — the restore/reconciliation anchor per Spec-025 §Trust Governance); whether the daemon wrote a `project` binding (the repository-borne trust gate reads it); grant/revoke provenance columns. Owner: Plan-025 (CREATE).
- `mcp_server_admitted_clients` — `(provider, server_name)` PK; which client the server admitted at its last sign-in (the daemon's own, Claude Code's or Codex's), kept once per server rather than on each binding row, and kept after a sign-out, so every later sign-in is one press; not a credential. Owner: Plan-025 (CREATE).
- The operating system's credential store (not SQLite): per signed-in server, the daemon's refresh-token item and, for a DPoP server, its signing-key item, created at sign-in and deleted at sign-out ([ADR-040](../decisions/040-mcp-credential-custody.md)).
- A session's own switched-off servers are kept with the session, so the daemon can send its set again after each resume.
- `mcp_tool_overrides` — `(provider, scope, scope_ref, server_name, tool_name)` PK; nullable facets `enabled` / `approval_mode` / `idempotency_class` (≥ 1 non-NULL); binding-validity CHECKs mirrored; FK-cascade to the trust row. Owner: Plan-025 (CREATE).
- `mcp_mutation_receipts` — `client_idempotency_key` PK; operation, request digest (keyed under the receipt-digest subkey of the governance key, which the database holds only sealed under the daemon master key, so a database copy cannot verify secret guesses offline), two-phase `status` (`pending` intent before the provider leg → `committed` at finalization, with `response_json` nullable until committed and startup reconciliation of crash-window intents), `created_at` (24 h opportunistic prune of `committed` rows). Owner: Plan-025 (CREATE).
- The plan's tables land in the daemon's one schema in Phase 1.
- Events append through the Plan-005 `EventLogService` path — no bespoke audit storage.

## API And Transport Changes

- The `mcp.*` JSON-RPC operations (`mcp.list`, `mcp.get`, `mcp.subscribe`, `mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setTrust`, `mcp.setToolOverride`, `mcp.clearToolOverride`, `mcp.oauthLogin`, `mcp.oauthLogout`, `mcp.reconnect`, `mcp.registrySearch`) and the session operations (`session.mcpServerList`, `session.mcpServerUpdate`, `session.mcpResourceList`) registered per CP-025-4; typed mirrors in [api-payload-contracts.md §Plan-025 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-025--mcp-governance-contract-surfaces). Tools on the daemon's fronted route, `task_output {task_id, wait_seconds?}` and `task_stop {task_id}`, visible to a model and never to a client.
- The `mcp_governance` events (registered via CP-025-1); the `mcp.*` error codes per [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance).
- Provider wire consumption: Claude `claude mcp add-json` / `claude mcp remove` / `claude mcp get` (`--scope user|project|local`) + `setMcpServers` / `reconnectMcpServer` / `mcpServerStatus` (SDK) + `--strict-mcp-config`, with only the daemon's own entry on `--mcp-config` + `headersHelper` + `CLAUDE_AUTO_BACKGROUND_TASKS` + the `mcp_authenticate` control request in a throwaway credential folder; Codex `config/read` / `config/value/write` / `config/batchWrite` / `config/mcpServer/reload` / `mcpServer/refresh` / `mcpServerStatus/list` / `mcpServer/resource/read` / `mcpServer/oauth/login` in a throwaway home (+ `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed` notifications) + the `thread/start` `mcp_servers` table + `http_headers_helper` + `turn/steer` / `turn/start` for background delivery. MCP itself, through the daemon's own client (`@modelcontextprotocol/client` 2.1.0): `tools/call` task-augmented where allowed, `tasks/get` / `tasks/result` / `tasks/cancel`, `notifications/cancelled`, `prompts/list` / `prompts/get`, and the OAuth authorization flow with DPoP. The public MCP Registry's `GET /v0/servers`. All floors capability-probed at spawn and re-verified against then-installed binaries per the [provider-wire trust model](../reference/provider-wire/README.md).

## Implementation Steps

1. **Phase 1 — Contracts + storage.** Author `packages/contracts/src/mcp-governance.ts` (operation + event payload schemas incl. the binding-ref discriminated union, config view, per-leg types, `clientIdempotencyKey`, error consts, grades, facets; `--isolatedDeclarations`-clean); the plan's tables in the daemon's one schema; wire the error codes into the daemon error substrate. Register the `mcp.*` and `session.mcp*` method names + schemas against `MethodRegistry` with `not_implemented` handlers behind a feature gate so the namespace shape ships reviewable before behavior.
2. **Phase 2 — Inventory + status observation.** Provider config readers (Claude `~/.claude.json` user + project-keyed `local` scopes + `.mcp.json`; Codex `config/read` with layer attribution incl. project-local rows)
3. **Phase 3 — Configuration mutation engines.** Claude: the unconditional durable leg (`claude mcp add-json` / `claude mcp remove` at the binding's scope, write-verified before acknowledgment) + the live `setMcpServers` leg selected by its own full-desired-set reconcile rather than by a driver-side probe (a typed refusal on that call selects the `user_config_write` grade and withdraws no capability flag; the CLI-version conjunct is subsumed by the `2.1.234` admission floor, while SDK ≥ `0.3.166` + streaming mode remain reachability preconditions) (full-set semantics, per-server error reconciliation) + the enabled overlay and the session-set builder (`--strict-mcp-config`, `mcp_set_servers` at start and after each resume, never `mcp_toggle`); Codex: `config/batchWrite` with `expected_version` on the user file, single silent retry, reload trigger, `mcp.config_write_conflict` on double conflict; the Codex session table, the project-file writer and the `local` emulation; the names-only rule at `project` scope and `${VAR}` expansion; `mcp.registrySearch`; validation-first ordering (`mcp.config_invalid` strictly pre-commit) with per-leg `liveResults[]` partial-outcome reporting; the two-phase `mcp_mutation_receipts` idempotency layer (`pending` intent committed before the provider leg; finalization + event set + store writes in one transaction; startup reconciliation of crash-window intents — the Plan-013 `command_receipts` precedent; replay / `mcp.idempotency_conflict`); `mcp.server_config_changed` emission with application grade and the removal-payload conditionality (I-025-3, I-025-4).
4. **Phase 4 — Trust, overrides, and Cedar gating.** `mcp` Cedar action registration (CP-025-3); in-plan effective-binding derivation off the post-drift session sets (T28.4.11), the binding-digest column and receipt stamping that make its output durable (T28.4.12); trust service (grant/revoke/drift-revoke over the keyed config-hash canonicalizer, hash-plus-projection: the excluded override-projection fields reconciled on every evaluation against the baseline-anchored expected state — `native_tool_baseline_json` snapshotted at grant or first materialization, governed portions re-asserted on divergence, ungoverned portions adopted, revocation rewriting weakening fields to baseline ⊕ surviving tightening facets); the drift-admission service at both CP-025-5 call sites — the Plan-003 `RunSetupGate` registration and the Plan-013 recovery-attach composition-root wiring with its production non-vacuous runtime assertion; override service with the safety-weakening-requires-trust rule (`mcp.trust_required`, the weakening set incl. `enabled: true`), baseline capture/restore on facet materialization and clear (a user's native entries survive a set → clear round-trip), and the per-operation scope-applicability matrix (Spec-025 §Configuration Mutation); the binding-keyed tool-metadata resolver overlay (CP-025-2 — the effective `McpServerBindingRef` carried through invocation and recovery resolution); `mcp.server_trust_changed` + `mcp.tool_override_changed` emission; the repository-borne `project` trust gate over both providers' session sets (T28.4.13) and the recomputed hash committed with each write (T28.4.14); retrofit Phases 2–3 handlers from the feature gate to full authorization (every mutating op deny-before-effect).
5. **Phase 5 — Sign-in, the daemon's client and route, and client delivery.** The daemon's own MCP client (T28.5.9) and its fronted route with background long calls (T28.5.10); the sign-in service under ADR-040 — the daemon's own OAuth client, owner-issued clients, the provider-admitted takeover, DPoP, the credential-store custody and the header helper (T28.5.1, T28.5.2), the URL-free `mcp.oauthLogin` receipt representation per I-025-1, completion-event dedup — exactly once per completed sign-in, nothing for abandoned ones (T28.5.3), and `mcp.oauthLogout` (T28.5.11); `mcp.reconnect`; a session's own tool servers (T28.5.12); client-sdk methods, CLI `sidekicks mcp list/add/remove/trust/override/login/watch`, desktop panel hooks (reads + the `mcp.subscribe` stream over the Plan-021-partial bridge, CP-025-6); end-to-end acceptance sweep against Spec-025 §Acceptance Criteria.

## Parallelization Notes

- Phase 1's contracts and its tables in the daemon's one schema are independent — parallelizable within the phase.
- Phases 2 and 3 both depend on Phase 1 but not on each other (read path vs write path) — parallelizable as separate PRs after Phase 1 merges; both must merge before Phase 4 (which gates their handlers).
- Phase 5 is strictly after Phase 4 (OAuth and client surfaces assume authorization is live).
- The two provider adapters within any phase are parallel work units (no shared state beyond the service interfaces).

## Test And Verification Plan

- Unit: payload/DDL schema tests incl. the removal-payload conditionality (`configHash` absent + `previousConfigHash` required for `removed`), the `McpServerConfigInput` provider-conditional refinements, the binding-ref discriminated union (scopeRef forbidden/required per scope on both providers — typed validation, with the DDL CHECKs as the negative-control mirror), and the ≥ 1-facet override refinement; keyed base-config-hash canonicalization (reorder-stable, semantic-change-sensitive incl. secret-value drift, override-projection fields excluded, distinct bindings ⇒ distinct derived subkeys ⇒ distinct hashes for identical configs); audit-ref payload identity (`scopeRefDigest` present on project/local event payloads, raw `scopeRef` structurally absent from all five schemas; digest stable under the binding's derived subkey, distinct across bindings); `McpServerConfigView` redaction (env/header names round-trip, values structurally absent; the URL served query-redacted with query-parameter names, the full URL confined to the hash input); leg-status aggregation (severity ranking with `unknown` ranked between `needs-auth` and `starting`, node-probe fallback, no-source `unknown` floor, and retirement — a closed session's leg leaves `legs[]` and the aggregate recomputes); the degraded inventory arm (trust store unreachable → `trustUnavailable: true` with trust-/override-dependent fields structurally absent, provider-observed fields and the key-derived `scopeRefDigest` intact); status normalization maps (Claude `pending`/`disabled`, Codex `Starting|Ready|Failed|Cancelled` → `McpServerStatus`); trust state machine incl. revocation-neutralizes-weakening, the `enabled: true`-is-weakening rule, and the baseline lifecycle (snapshot at grant or first materialization — whichever first, never refreshed while held; dropped only untrusted-and-facet-free); resolver overlay floor semantics under trust flips.
- Integration (fixture-driven fake provider wires for both CLIs): full mutation matrix × {control-channel reachable, control-channel unreachable-on-an-admitted-build} Claude with restart-durability assertions (an acknowledged mutation survives a daemon restart via the provider store); scope-collision fixtures (same `serverName` in two scopes — independent status/trust/overrides, no drift ping-pong); scope writes on both providers (a `user`, `project` and `local` add and remove each landing where Spec-025 §Configuration Mutation says, the Codex project file read back and its comments intact; a value at `project` scope refused with both files unchanged; only a Codex `project` binding's `enabled`/`approvalMode` facet refuses `mcp.config_scope_unsupported`); the repository-borne trust gate (untrusted: absent from both providers' session sets; trusted: present; drift-revoked: absent again); the session set (`mcp_set_servers` at start and after resume, never `mcp_toggle`; the Codex `thread/start` table); Codex conflict-retry-once; drift auto-revoke ordering incl. native-field reversion; the drift-admission service (out-of-band edit → run start: revocation + neutralization complete pre-spawn, each provider's session set reflects post-drift state; a projection-field-only edit — unchanged base hash — revokes and reverts at the gate; the daemon-restart variant: edit-while-down processes drift before recovery adopts or resumes, via the Plan-013 attach-seam wiring, with the vacuous-default pass-through as the pre-Plan-025 negative control); idempotency (identical retry replays with zero provider calls/writes/events — asserted across a daemon restart; divergent key reuse fails `mcp.idempotency_conflict`; receipt prune at the 24 h bound; the `mcp.oauthLogin` receipt stores and replays a URL-free acknowledgment; the two-phase crash windows — pending intent with no provider effect expires at startup, pending intent with a durable provider write reconciles to a finalized receipt + exactly-once late event); unmodeled-field preservation (a Codex server table carrying fields the input does not model is byte-identical on them after an update); durable-success/live-failure partial outcomes (`applied: 'user_config_write'` + failing `liveResults[]` entry, never a post-commit error); two-session leg divergence (per-leg statuses + scoped `mcp.reconnect` — `{sessionId}` restarts that session's legs, `{bindingId}` exactly one leg); resolver-overlay two-scope disambiguation (same `serverName` in user + project bindings: each session's invocation resolves its own effective binding's override); `mcp.subscribe` live-tail delivery (governance + status envelopes, no replay before the acknowledgment) + the gap-free handshake (an event appended between the subscribe acknowledgment and the `mcp.list` read arrives on the stream); deny-before-effect per non-read op; one-event-set-per-mutation over the six governance mutations incl. retry paths and the revocation-batch assertion (trust event + per-facet reversion events, atomic, never re-emitted on replay), plus the reconnect no-event negative control and the `mcp.server_oauth_completed` exactly-once-per-observed-completion dedup (abandoned flow: no event, receipt expires; unobserved completion: the status transition is the surviving trace); native-baseline round-trip (a Codex user config with pre-existing `enabled_tools`/`tools.<t>.approval_mode` values survives override set → clear with the native values restored; revocation rewrites to baseline ⊕ surviving tightening facets); async OAuth completion failure delivered as the `outcome: 'failure'` event (launch failure keeps `mcp.oauth_flow_failed` reachable); required-server thread-start failure mapping.
- Adversarial-Tampering Boundary: credential-echo sweep over every event payload, every error code, the `McpServerConfigView`, receipt rows (the `mcp.oauthLogin` row URL-free), logs, helper command lines and renderer state (I-025-1); the provider-owned sign-in negative control (a sign-in the person's own provider holds is never read or renewed); raw-`scopeRef` absence from every event payload (the audit-ref negative control); provider-file byte-identity after refused mutations (a Codex `project` facet, a value at `project` scope, a changed Codex project file, Cedar-denied, trust-required, idempotency-conflict); spoofed `serverName` from the status seam stays `wireFreeFormString`-bounded (the Plan-004 seventeen-string rule); canonicalization round-trip on the config-hash input; hash-brute-force negative control (no served or stored digest — `configHash`, `scopeRefDigest`, or a receipt `request_digest` — is reproducible or verifiable from a database copy alone: the governance key rests in SQLite only sealed under the daemon master key, and its derived subkeys never do); and the Phase-5 egress sweep — **no token, authorization code, or PKCE material** reaches CLI stdout/stderr, the `mcp.subscribe` stream, or any `window.desktopBridge` bridge payload, asserted at each of the three new egress surfaces the OAuth + client phase opens (I-025-1 beyond the daemon boundary). `authorizationUrl` is asserted **by destination** rather than universally: absent from the `mcp.subscribe` stream, from every event payload, from the receipt row, and from logs; present only on the `mcp.oauthLogin` reply, which is the single carrier [Spec-025 §Interfaces And Contracts](../specs/025-mcp-server-configuration-and-governance.md#interfaces-and-contracts) names and the one each client's launch surface consumes. Asserting its absence from every bridge payload would have made the desktop login unimplementable while leaving the CLI login equally blocked, since this line covers stdout too — a sweep that fails a shipped requirement is a defect in the sweep, and the destination scoping is the spec's own §Pitfalls idiom rather than an exception to it.
- CI-Pinned Tool Versions: provider fixtures name the wire pins they encode, read from the [provider-wire reference](../reference/provider-wire/README.md)'s §Version pin tables rather than restated here, plus the version-anchored `2.1.210` `mcp_set_servers` behavior (an upstream feature anchor, not a pin); `gitleaks v8.30.1` per [ADR-023 §Axis 4 — Supply-Chain Hygiene](../decisions/023-v1-ci-cd-and-release-automation.md#axis-4--supply-chain-hygiene) on every PR.
- Manual: real-provider smoke on one machine per OS tier before Phase 5 completion (OAuth browser round-trip cannot be fixture-verified end to end).

## Implementation Phase Sequence

Plan-025 implementation lands as five PRs (one per phase). Each PR carries a `**Precondition:**` line so the merge order is reviewer-checkable.

### Phase 1 — Contracts + storage

**Precondition:** Plan-005 Phase 1 merged; Plan-006 Phase 2 merged.

**Goal:** contracts + the plan's tables in the daemon's one schema + registered-but-gated namespace compile, open, and round-trip; schema tests green. Satisfies the storage halves of I-025-1/I-025-2; stages CP-025-1/CP-025-4.

#### Tasks

- **T28.1.1 — Binding-ref and config-input discriminated unions.**
  - Files: `packages/contracts/src/mcp-governance.ts` (CREATE)
  - Author `McpServerBindingRef` as a discriminated union on `scope`: `user` (no `scopeRef`), `project` (non-empty `scopeRef`), `local` (non-empty `scopeRef`), on both providers — Codex `local` is the emulated scope. Author `McpServerConfigInput` as a transport-discriminated union with provider-conditional refinements carrying the Codex auth references `envHttpHeaders` / `oauthScopes` / `oauthResource`, and a `project`-scope refinement admitting environment-variable and header names only, never a value. `--isolatedDeclarations`-clean (explicit type annotations on every exported const — repo-wide `tsconfig.base.json` rule).
  - **Spec coverage:** Spec-025 §Unified Inventory, Spec-025 §Interfaces And Contracts
  - **Verifies invariant:** I-025-1
  - **Consumes:** none (leaf contract module).

- **T28.1.2 — Redacted read model: config view, inventory entry, legs, degraded arm.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - `McpServerConfigView` serving transport, command/args, the query-redacted URL (scheme + host + path plus query-parameter **names**), timeouts, `required`, `bearerTokenEnvVar`, the Codex auth references, and env-var/header **names only**. `McpServerLegStatus` (leg identity, status, `observedAt`); the inventory entry with `legs[]`, the aggregate `status`, `effectiveInRuns`, and `scopeRefDigest`; the discriminated `trustUnavailable: true` degraded arm with trust-/override-dependent fields structurally absent.
  - **Spec coverage:** Spec-025 §Unified Inventory, Spec-025 §Fallback Behavior
  - **Verifies invariant:** I-025-1
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).

- **T28.1.3 — Mutation request/response payloads, grades, and the idempotency key.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - Request/response shapes for the non-read operations; mandatory requester-generated UUID `clientIdempotencyKey` on every governance mutation and on `mcp.oauthLogin` (`mcp.reconnect` unreceipted); `McpApplicationGrade` (`live_reconcile | user_config_write | next_run | daemon_enforced`); `McpLiveApplicationResult` per-leg entries; the per-facet `McpToolOverrideApplication`; the ≥ 1-facet override refinement mirroring the DDL's all-NULL prohibition.
  - **Spec coverage:** Spec-025 §Configuration Mutation, Spec-025 §Authorization, Spec-025 §Tool-Level Overrides
  - **Verifies invariant:** I-025-4
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).

- **T28.1.4 — The `mcp_governance` event payload schemas.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - Author the payloads over a shared `McpServerBindingAuditRef` (path-free: `scopeRefDigest`, never raw `scopeRef`). `mcp.server_config_changed` carries the removal conditionality — `previousConfigHash` required and `configHash` structurally absent for `removed`. `mcp.server_status_changed` carries `origin: 'session_feed' | 'node_probe'` with `bindingId` required for `session_feed` and absent for `node_probe`. Author payloads only — the type literals and the `mcp_governance` category are Plan-005-owned (CP-025-1); this task MUST NOT edit `packages/contracts/src/event.ts`.
  - **Spec coverage:** Spec-025 §Status Observation and Events
  - **Verifies invariant:** I-025-1
  - **Consumes:** the `mcp.*` type literals + the `mcp_governance` category ← Plan-005 T1.10 (shipped); `EventEnvelope` ← Plan-005 Phase 1 (shipped).

- **T28.1.5 — Error-code constants and typed daemon error classes.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND) + `packages/runtime-daemon/src/mcp/mcp-errors.ts` (CREATE)
  - The `mcp.*` codes as typed constants matching error-contracts.md §MCP Governance byte-for-byte, plus the typed refusal classes subclassing `DaemonDomainError` in this Plan-025-owned module — keeping per-namespace classes out of the Plan-006 substrate (no per-namespace mapping-table maintenance; the Plan-008 `worktree-errors.ts` precedent), so each refusal reaches the wire as `data.type` with sanitized `data.fields` through the existing discriminator branch and `packages/runtime-daemon/src/ipc/domain-error.ts` is never edited.
  - **Spec coverage:** Spec-025 §Interfaces And Contracts
  - **Verifies invariant:** none (contract-registration task; the reachability assertion is T28.5.8's)
  - **Consumes:** `DaemonDomainError` ← Plan-006 substrate.

- **T28.1.6 — The plan's tables in the daemon's one schema.**
  - Files: the daemon's one schema (EXTEND) + the schema's test (EXTEND)
  - `mcp_server_trust`, `mcp_tool_overrides`, `mcp_mutation_receipts`, `mcp_server_admitted_clients` per local-sqlite-schema.md §MCP Governance Tables (Plan-025); the schema's test inserts each value the contract admits and refuses one it does not. DDL CHECKs mirror the type-layer binding rules as defense in depth: user ⇔ empty `scope_ref`; `config_hash GLOB 'b3:*'`; ≥ 1 non-NULL override facet; FK-cascade from overrides to the trust row. **No column stores key material.**
  - **Spec coverage:** Spec-025 §State And Data Implications
  - **Verifies invariant:** I-025-1, I-025-2, I-025-5
  - **Consumes:** the daemon's one schema ← Plan-001 (shipped).

- **T28.1.7 — Register the `mcp.*` and `session.mcp*` methods behind a `not_implemented` feature gate.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (CREATE)
  - Register every name + schema against `MethodRegistry.register()` with `not_implemented` handlers behind a feature gate, so the namespace shape ships reviewable before behavior and a mid-sequence pause leaves no half-authorized surface. Registration only — no substrate file's semantics change (CP-025-4, the CP-006-3 late-namespace pattern).

- **T28.1.8 — Schemas for the operations and members the design adds.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - `scope` and `scopeRef` on `mcp.upsertServer` and `mcp.removeServer` for every scope on both providers; `mcp.registrySearch {query, cursor?}` → `{servers, nextCursor?}`, each result carrying its title or name, description, version, whether it runs as a package or at an address, the package's runtime hint and arguments or its remote address, and each environment variable's name, description and required flag, never a value; `mcp.oauthLogout {serverId}` with its `clientIdempotencyKey`; `failedReason: 'commandNotRunnable'` on an entry reading `failed`; `session.mcpServerList {sessionId}` (a live list, each row the server's name, binding, status with its reason, whether it is on for the session, and whether a switch waits for the next turn), `session.mcpServerUpdate {sessionId, serverName, enabled}`, and `session.mcpResourceList {sessionId, serverName}` → `{serverName, resources, complete}`.
  - **Spec coverage:** Spec-025 §Interfaces And Contracts, Spec-025 §A session's own tool servers
  - **Verifies invariant:** I-025-1
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).
  - **Not built:** every schema this task names.
  - **Spec coverage:** Spec-025 §Interfaces And Contracts
  - **Verifies invariant:** none (namespace-shape staging; authorization lands at T28.4.3)
  - **Consumes:** `MethodRegistry.register()` ← Plan-006-partial, `packages/contracts/src/jsonrpc-registry.ts` (shipped; `METHOD_NAME_FORMAT` admits every `mcp.*` name).

### Phase 2 — Inventory + status observation

**Precondition:** Phase 1 merged; Plan-004 Phase 3 merged.

**Goal:** `mcp.list` / `mcp.get` serve the merged read model from both providers; status events flow with correct binding; first-observation trust rows appear untrusted. Satisfies CP-025-2(a) and the observation half of I-025-2.

#### Tasks

- **T28.2.1 — Claude config reader across user, project, and local scopes.**
  - Files: `packages/runtime-daemon/src/mcp/claude-mcp-config-adapter.ts` (CREATE)
  - Read `~/.claude.json` user scope + the project-keyed `local` scope + `.mcp.json`, yielding scope-qualified declarations. Credential-bearing values are handled transiently in memory and never persisted, logged, or served (Spec-025 §Implementation Notes transient-secret rule).
  - **Spec coverage:** Spec-025 §Unified Inventory
  - **Verifies invariant:** I-025-1
  - **Consumes:** `McpServerConfigView` ← T28.1.2 (Phase 1, merged).

- **T28.2.2 — Codex config reader with layer attribution.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (CREATE)
  - `config/read` yielding user-scope (`$CODEX_HOME/config.toml`) and project-local rows with layer attribution, and the emulated `local` bindings from their governance rows.
  - **Spec coverage:** Spec-025 §Unified Inventory
  - **Verifies invariant:** I-025-1
  - **Consumes:** `McpServerConfigView` ← T28.1.2 (Phase 1, merged).

- **T28.2.3 — Binding resolution and `effectiveInRuns` attribution.**
  - Files: `packages/runtime-daemon/src/mcp/binding-resolver.ts` (CREATE)
  - Resolve `(provider, scope, scopeRef, serverName)` bindings without merging same-named servers across providers or scopes; stamp `effectiveInRuns` true for every scope on both providers, except a `project` binding the daemon did not write, which reads false until it is trusted (T28.4.13).
  - **Spec coverage:** Spec-025 §Unified Inventory
  - **Verifies invariant:** none (identity resolution; the no-merge assertion rides T28.5.8)
  - **Consumes:** declarations ← T28.2.1 + T28.2.2 (same phase).

- **T28.2.4 — `McpInventoryService.list/get` four-source merge and degraded arm.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-inventory-service.ts` (CREATE)
  - Merge declared config + normalized status + trust row + override rows per binding. `refresh: true` forces a provider round-trip; default serves most-recent observations. On trust-store unreachability serve the `trustUnavailable: true` arm with trust-/override-dependent fields structurally absent, provider-observed fields and the key-derived `scopeRefDigest` intact.
  - **Spec coverage:** Spec-025 §Unified Inventory, Spec-025 §Fallback Behavior
  - **Verifies invariant:** I-025-1
  - **Consumes:** bindings ← T28.2.3 (same phase); trust/override rows ← T28.1.6 (Phase 1, merged).

- **T28.2.5 — `McpStatusNormalizer` over the Plan-004 seam and the Codex wire.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-status-normalizer.ts` (CREATE)
  - Consume `McpServerStatusUpdate` values from the daemon-injected `onMcpServerStatus` producer and the Codex `mcpServerStatus/list` + `mcpServer/startupStatus/updated` wire; map Claude `pending` → `starting` and Claude `disabled` → `enabled: false` with last-observed status; absence of any source → `unknown`. Attribute each observation to the effective binding (the set the daemon sent that session). For a server the daemon fronts, take the observation from its own client's connection, and read `needs-auth` for a server whose sign-in the daemon holds from the daemon's sign-in state, since a helper-authenticated server reports `authStatus: unknown` on Codex. `serverName` stays `wireFreeFormString`-bounded — untrusted provider output.
  - **Spec coverage:** Spec-025 §Unified Inventory, Spec-025 §Status Observation and Events
  - **Verifies invariant:** none (normalization mapping; the spoof-bound assertion rides T28.5.8)
  - **Consumes:** `onMcpServerStatus` / `McpServerStatusUpdate` ← Plan-004 Phase 3 (§Precondition, Plan-004 Phase 3 merged; reciprocal at Plan-004's seam bullet naming Plan-025 CP-025-2).

- **T28.2.6 — Node-scope status probe (the `node_probe` origin producer).**
  - Files: `packages/runtime-daemon/src/mcp/node-status-probe.ts` (CREATE)
  - Produce node-scope, session-independent status observations for bindings with no live leg, on demand only — driven by `mcp.list` / `mcp.get` with `refresh: true`, never by a poll loop (Spec-025 §Default Behavior forbids busy-polling). Claude leg: the zero-billed-turn `claude mcp list` read. Codex leg: `mcpServerStatus/list` unscoped by `thread_id`. Observations are stamped `origin: 'node_probe'` with `bindingId` structurally absent and bind to the daemon-scope sentinel session.
  - **Spec coverage:** Spec-025 §Unified Inventory, Spec-025 §Default Behavior
  - **Verifies invariant:** none (observation producer; the fallback-ordering assertion is T28.2.7's)
  - **Consumes:** the daemon-scope sentinel session id ← Plan-005 ([Spec-005 §Daemon-Scope Event Binding](../specs/005-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding), shipped).

- **T28.2.7 — Per-leg retention, deterministic aggregate, and leg retirement.**
  - Files: `packages/runtime-daemon/src/mcp/leg-status-store.ts` (CREATE)
  - Retain per-leg observations in `legs[]` keyed by the Plan-004 runtime-binding leg; compute the top-level aggregate as the most severe **current live-leg** status under the fixed order `failed > needs-auth > unknown > starting > connected`; fall back to the newest node-probe observation when no live leg exists, then to `unknown`. Retire a leg when its backing runtime binding closes and recompute — a terminated session's `failed` leg never pins the aggregate.
  - **Spec coverage:** Spec-025 §Unified Inventory
  - **Verifies invariant:** none (aggregation rule; asserted at T28.5.8 against the AC)
  - **Consumes:** normalized observations ← T28.2.5; node-probe observations ← T28.2.6 (same phase).

- **T28.2.8 — Untrusted-row upsert on first observation.**
  - Files: `packages/runtime-daemon/src/mcp/trust-store.ts` (CREATE)
  - First observation of a binding the trust store has never seen upserts `trusted = 0`. No code path on this task may write `trusted = 1` — observation creates the governance anchor, never trust.
  - **Spec coverage:** Spec-025 §Unified Inventory, Spec-025 §Default Behavior
  - **Verifies invariant:** I-025-2
  - **Consumes:** `mcp_server_trust` ← T28.1.6 (Phase 1, merged).

- **T28.2.9 — `mcp.server_status_changed` emission with the path-free audit ref.**
  - Files: `packages/runtime-daemon/src/mcp/status-event-emitter.ts` (CREATE)
  - Emit on transition only (an unchanged re-observation emits nothing). Payloads carry `scopeRefDigest`, never raw `scopeRef`. `origin: 'session_feed'` rows bind to the observing session's real `session_id` and carry the leg's `bindingId`; `origin: 'node_probe'` rows bind to the daemon-scope sentinel and omit `bindingId`. Append through the Plan-005 `EventLogService` path — no bespoke audit storage.
  - **Spec coverage:** Spec-025 §Status Observation and Events
  - **Verifies invariant:** I-025-1, I-025-4
  - **Consumes:** `EventLogService.append` ← Plan-005 Phase 4 (sole append path); `scopeRefDigest` derivation ← T28.4.1 **when trust machinery lands**; until then the digest derives from the same governance key, which this task creates and seals on first use if absent (the key is single, per Spec-025 §Implementation Notes).

- **T28.2.10 — `mcp.subscribe` live-tail fan-out with the gap-free handshake.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-subscribe-handler.ts` (CREATE)
  - Long-lived subscription the person reads, delivering every `mcp_governance` envelope — sentinel-bound and session-bound alike — as the daemon appends it. Registration MUST be live before the first delivery so the subscribe-acknowledgment-then-`mcp.list` handshake is gap-free (the Plan-006 I-006-10 wire-ordering invariant). Live-tail only: nothing appended before the acknowledgment is delivered; history remains the sentinel session's log.
  - **Spec coverage:** Spec-025 §Status Observation and Events
  - **Verifies invariant:** none (delivery ordering; the gap-free assertion rides T28.5.8's AC sweep)
  - **Consumes:** the streaming primitive + I-006-10 ordering guarantee ← Plan-006-partial `streaming-primitive.ts` (shipped).

- **T28.2.11 — `failedReason: commandNotRunnable` after a move between Windows and WSL.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-inventory-service.ts` (EXTEND)
  - After the background service moves between Windows and a WSL distribution, the move marks every server whose command or arguments name a program on the side the service left; the inventory keeps such a server as it was and serves it reading `failed` with `failedReason: 'commandNotRunnable'`. A bare command name such as `npx` is looked up on the new side and is not marked. No status is added.
  - **Spec coverage:** Spec-025 §Unified Inventory
  - **Verifies invariant:** none (a read-model member; asserted at T28.5.8 against the AC)
  - **Consumes:** the move's list of stranded servers ← Plan-006 (the service on WSL 2); the entry schema ← T28.1.8 (Phase 1, merged).
  - **Not built:** the member and its marking.

### Phase 3 — Configuration mutation engines

**Precondition:** Phase 1 merged.

**Goal:** both mutation engines pass the fixture matrix with honest application grades; conflict and scope refusals surface the right codes; config events emit exactly once. Satisfies I-025-3 and the mutation half of I-025-4 (behind the Phase 4 authorization gate).

#### Tasks

- **T28.3.1 — Claude durable leg: `claude mcp add-json --scope` at every scope, verified before acknowledgment.**
  - Files: `packages/runtime-daemon/src/mcp/claude-mcp-config-adapter.ts` (EXTEND)
  - `claude mcp add-json <name> <json> --scope <user|project|local>` / `claude mcp remove <name> --scope <scope>`, unconditional on every `mcp.upsertServer` / `mcp.removeServer`; a `project` or `local` write runs with the project root as the working folder, landing in `<project>/.mcp.json` or the project's entry in `~/.claude.json`. Re-read via `claude mcp get` (or observation of that scope) to verify the write took effect **before** the config event is emitted. Upserts are read-modify-write over the observed current declaration so provider fields the input does not model survive byte-identical. The daemon never rewrites `~/.claude.json` or `.mcp.json` bytes directly.
  - **Not built:** the `project` and `local` writes.
  - **Spec coverage:** Spec-025 §Configuration Mutation
  - **Verifies invariant:** I-025-3
  - **Consumes:** observed declarations ← T28.2.1 (Phase 2, merged).

- **T28.3.2 — Claude opportunistic live `setMcpServers` leg, detected by its own reconcile.**
  - Files: `packages/runtime-daemon/src/mcp/claude-live-reconcile.ts` (CREATE)
  - Select the live leg by **this task's own full-desired-set reconcile**, never by a CLI-version comparison and never by a driver-side probe — the CLI conjunct is subsumed by the `2.1.234` admission floor Spec-004 states. There is deliberately no driver-side `mcp_set_servers` probe to consult: `mcp_set_servers` is a control-request subtype rather than one of Spec-004's fourteen capability flags, and Plan-004 guarantees the driver never issues it, because the operation replaces the full named-server set and an empty-set probe would clear this session's servers (CP-004-11). Availability is therefore established by the reconcile call this task already makes — the first full-set send **is** the detection, and a typed `Unsupported control request subtype` refusal on it falls through to `user_config_write` and withdraws **no** capability flag — in particular not `mcp`, which denotes MCP tool invocation and is unaffected, with the negative control asserted in the driver's own suite rather than issued here. SDK ≥ `0.3.166` and streaming-input mode stay stated reachability preconditions — the SDK version is not covered by the CLI admission floor — probed, never assumed from the pin. When satisfied, send the **full desired named-server set** (never a delta — a delta silently removes every unsent server) and reconcile the returned `{added, removed, errors}` against the requested delta. Grade `live_reconcile` only when every attempted live leg applied; `user_config_write` otherwise. A session whose control channel refuses the call gets its servers no other way: each of that session's servers reads `failed`, with the refusal as its reason ([Spec-025 §Fallback Behavior](../specs/025-mcp-server-configuration-and-governance.md#fallback-behavior)). Emit one `liveResults[]` entry per attempted leg (`sessionId` + the Plan-004 leg key, `outcome`, sanitized per-leg code).
  - **Spec coverage:** Spec-025 §Configuration Mutation, Spec-025 §Provider Capability Model
  - **Verifies invariant:** I-025-3
  - **Consumes:** the driver-spawn capability report ← Plan-004 T3.24 under **CP-004-11** (§Precondition on Phase 2, transitively merged) — the per-capability capability report carrying each flag's detection source, which covers the Spec-004 capability flags and does **not** include `mcp_set_servers` — that is a control-request subtype, not a flag, and Plan-004 guarantees no driver-side probe issues it (the operation replaces the full named-server set, so an empty-set probe would clear this task's servers) — so establishing its live value is this task's own reconcile.

- **T28.3.3 — Claude enabled overlay and the session-set builder.**
  - Files: `packages/runtime-daemon/src/mcp/claude-session-server-set.ts` (CREATE)
  - `mcp.setEnabled` on a Claude binding records the daemon's per-server enabled overlay (Claude Code's configuration has no enabled field; removal would destroy the declaration). Build each session's set from every scope's effective bindings plus governance overlays — a repository-borne `project` binding only while trusted (T28.4.13), a server the person rejected in Claude Code (`disabledMcpjsonServers`) never, a plugin's servers only where switched on for the session, less the session's own switched-off servers (T28.5.12) — with `${VAR}` references expanded per T28.3.12. The process starts with `--strict-mcp-config` and only the daemon's own entry on `--mcp-config`; the set goes out with `mcp_set_servers` right after start and again after each resume, and in a running session a change is another full-set send (T28.3.2). Grade `next_run`, or `live_reconcile` when every attempted leg applied. `mcp_toggle` is never sent.
  - **Spec coverage:** Spec-025 §Configuration Mutation, Spec-025 §Implementation Notes
  - **Verifies invariant:** I-025-3
  - **Consumes:** the enabled-overlay column ← T28.1.6 (Phase 1, merged); the session's process start and resume ← Plan-004's Claude Code driver.
  - **Not built:** the builder, the start-time send and the resend after resume.

- **T28.3.4 — Codex batched user-scope write with optimistic concurrency and reload.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (EXTEND)
  - `config/batchWrite` (multi-field mutations MUST be batched — one version check, one reload) with `expected_version` from the immediately preceding `config/read`. On `configVersionConflict`: re-read and retry exactly once, then surface `mcp.config_write_conflict` carrying both version tokens. Trigger `config/mcpServer/reload` (or per-server `mcpServer/refresh`) after a successful write. Writes are field-granular `config/value` paths, so unmodeled sibling fields stay byte-identical. Grade `user_config_write`. This task writes the user file; the project file and the emulated `local` scope are T28.3.10 and T28.3.11, because Codex rejects project paths for its own config writes.
  - **Spec coverage:** Spec-025 §Configuration Mutation, Spec-025 §Fallback Behavior
  - **Verifies invariant:** I-025-3
  - **Consumes:** `config/read` layer attribution ← T28.2.2 (Phase 2, merged).

- **T28.3.5 — Validation-first ordering and the per-operation scope-applicability matrix.**
  - Files: `packages/runtime-daemon/src/mcp/mutation-preflight.ts` (CREATE)
  - Every check that can fail a mutation outright runs **before** the durable leg commits; `mcp.config_invalid` is exclusively a pre-commit refusal — including a value typed at `project` scope and a Codex `local` name that clashes across the user file (the refusal naming the project that holds the other one). Once the durable leg commits, the mutation never converts to a thrown error — later per-leg failures report inside the successful response. The scope rule is narrow: every operation applies at every scope on both providers, and only an `enabled` or `approvalMode` facet on a Codex `project` binding refuses, with `mcp.config_scope_unsupported` and the file path in message guidance only, never in an event payload.
  - **Spec coverage:** Spec-025 §Configuration Mutation, Spec-025 §Fallback Behavior
  - **Verifies invariant:** I-025-3
  - **Consumes:** `effectiveInRuns` ← T28.2.3 (Phase 2, merged).

- **T28.3.6 — Two-phase `mcp_mutation_receipts` idempotency layer.**
  - Files: `packages/runtime-daemon/src/mcp/mutation-receipt-store.ts` (CREATE)
  - Commit a `pending` **intent** (key, operation, keyed request digest) in its own transaction **before** any provider leg runs; finalize (`committed`, response recorded) in the **same SQLite transaction** as the mutation's store writes and event append. An identical retry (same key, same digest) replays the recorded response with no provider call, no store write, no second event; a differing digest refuses `mcp.idempotency_conflict` leaving the original untouched. `committed` rows older than 24 h prune opportunistically on later mutation writes; `pending` intents are never silently pruned. The request digest is keyed under the receipt-digest subkey of the daemon-held master key — never a value colocated with the row.
  - **Spec coverage:** Spec-025 §Authorization
  - **Verifies invariant:** I-025-4
  - **Consumes:** `mcp_mutation_receipts` ← T28.1.6 (Phase 1, merged); the receipt-digest subkey ← T28.4.1 (Phase 4) — until Phase 4 lands, this task creates the master-key artifact on first use per Spec-025 §Implementation Notes' single-artifact rule.

- **T28.3.7 — Startup receipt-intent reconciler.**
  - Files: `packages/runtime-daemon/src/mcp/receipt-reconciler.ts` (CREATE)
  - At startup, resolve every `pending` intent by observing provider state: an intent with no provider effect expires; an intent whose durable provider write landed is completed — store writes applied, the event appended, the receipt finalized — so the audit event lands **late but exactly once, never lost and never doubled**. An identical-key retry meeting a pending intent drives reconciliation first, then replays (the Plan-013 `command_receipts` two-phase discipline).
  - **Spec coverage:** Spec-025 §Authorization
  - **Verifies invariant:** I-025-4
  - **Consumes:** the two-phase receipt discipline ← Plan-013 `command_receipts` (pattern reuse, not a symbol import — Plan-025 owns its own store).

- **T28.3.8 — `mcp.server_config_changed` emission with removal conditionality.**
  - Files: `packages/runtime-daemon/src/mcp/config-event-emitter.ts` (CREATE)
  - Emit on every applied mutation with binding identity, change kind, application grade, and post-change `configHash` — except removals, whose payload carries `previousConfigHash` and structurally omits `configHash`. Sentinel-bound (node scope) with `initiatingSessionId` when a session-scoped caller initiated. Payloads carry no config values, env vars, headers, or URLs.
  - **Spec coverage:** Spec-025 §Configuration Mutation, Spec-025 §Status Observation and Events
  - **Verifies invariant:** I-025-4
  - **Consumes:** `EventLogService.append` ← Plan-005 Phase 4 (shipped path).

- **T28.3.9 — The Codex session table.**
  - Files: `packages/runtime-daemon/src/mcp/codex-session-server-table.ts` (CREATE)
  - Compose each Codex session's whole `mcp_servers` table from every scope's effective bindings plus governance overlays, each server with its per-conversation `enabled` flag: an emulated `local` binding switched on only in its project's sessions (T28.3.11), a repository-borne `project` binding switched off while untrusted (T28.4.13), the session's own switched-off servers off (T28.5.12). Plan-004's Codex driver sends the table at `thread/start`; a whole table replaces the service's table for that conversation. Until the fronted route lands (T28.5.10), each entry is the server as declared; T28.5.10 rewrites each entry as a `url` entry on the daemon's route under the server's own name.
  - **Spec coverage:** Spec-025 §Provider Capability Model, Spec-025 §Implementation Notes
  - **Verifies invariant:** I-025-3
  - **Consumes:** effective bindings ← T28.2.3 (Phase 2, merged); the `thread/start` send ← Plan-004's Codex driver.
  - **Not built:** the table composer.

- **T28.3.10 — Codex project-file writer with read-back.**
  - Files: `packages/runtime-daemon/src/mcp/codex-project-file-writer.ts` (CREATE)
  - Edit `<project>/.codex/config.toml` with `@decimalturn/toml-patch` 3.1.2, a format-preserving TOML edit that keeps the file's comments and layout; write to a temporary file and rename into place only if the file still hashes to what the daemon last read, else refuse `mcp.config_write_conflict` with nothing written; read the result back with `config/read {cwd, includeLayers}`, whose project layer must list the server, then `config/mcpServer/reload`. The edit touches only that server's own table. Library choice: `@decimalturn/toml-patch` over `smol-toml` 1.9.0, which drops comments, and the unmaintained `toml-patch` 0.2.3 and `@iarna/toml` 2.2.5; a format-preserving edit is required because the file belongs to the person and the repository.
  - **Tests:** a hand-commented project file round-trips an add and a remove with its comments and layout byte-identical outside the server's table; a file changed between read and write refuses with the file unchanged.
  - **Spec coverage:** Spec-025 §Configuration Mutation
  - **Verifies invariant:** I-025-3
  - **Consumes:** `config/read` layer attribution ← T28.2.2 (Phase 2, merged).
  - **Not built:** the writer.

- **T28.3.11 — Codex `local` emulation.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (EXTEND)
  - Write the server into the user file through `config/value/write` with `enabled = false`; keep one governance row for the binding, removed with the server; switch it on with `mcp_servers.<name>.enabled = true` in the `thread/start` table of each session whose project is that one. The name must be unique across the user file; a clash refuses per T28.3.5.
  - **Spec coverage:** Spec-025 §Configuration Mutation
  - **Verifies invariant:** I-025-3
  - **Consumes:** the Codex user writer ← T28.3.4; the session table ← T28.3.9 (same phase).
  - **Not built:** the emulation and its governance row.

- **T28.3.12 — Names only at `project` scope, and `${VAR}` expansion for Claude Code.**
  - Files: `packages/runtime-daemon/src/mcp/mutation-preflight.ts` (EXTEND) + `packages/runtime-daemon/src/mcp/claude-session-server-set.ts` (EXTEND)
  - A `project` declaration carries environment-variable and header names only; a value refuses `mcp.config_invalid` before anything is written. On Codex, `env_vars`, `env_http_headers` and `bearer_token_env_var` name the variables and Codex reads them. On Claude Code the file holds `${VAR}` / `${VAR:-default}`, which the daemon expands from the session's spawn environment before each `mcp_set_servers` send, holding the value only for that call and never storing or logging it.
  - **Spec coverage:** Spec-025 §Configuration Mutation, Spec-025 §Implementation Notes
  - **Verifies invariant:** I-025-1
  - **Consumes:** the input refinement ← T28.1.1 (Phase 1, merged); the session-set builder ← T28.3.3 (same phase).
  - **Not built:** the refusal and the expansion.

- **T28.3.13 — `mcp.registrySearch`.**
  - Files: `packages/runtime-daemon/src/mcp/registry-search.ts` (CREATE) + `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (EXTEND)
  - Answer `{query, cursor?}` from the public MCP Registry's `GET /v0/servers?search=<query>&version=latest` with `{servers, nextCursor?}`, mapping each record's package (`runtimeHint`, `runtimeArguments`) or `remotes`, and its environment variables' names, descriptions and required flags, never a value; cache nothing past the call. Budget: one request per search (measured at 1.83 s, answers of 1.3 to 3.3 KB), no background reads.
  - **Spec coverage:** Spec-025 §The MCP servers page, Spec-025 §Interfaces And Contracts
  - **Verifies invariant:** none (a read)
  - **Consumes:** the schema ← T28.1.8 (Phase 1, merged).
  - **Not built:** the handler.

### Phase 4 — Trust, overrides, and Cedar gating

**Precondition:** Phase 2 merged; Phase 3 merged; Plan-010 Phase 2 merged; Plan-003 Phase 3 merged (the `RunSetupGate` seam the CP-025-5 drift gate registers against).

**Goal:** every mutating operation is deny-before-effect; trust lifecycle incl. drift revocation is live; the resolver overlay moves the floor only under trust + authorization, and a revocation neutralizes the durable receipt surface as well as the live one. Satisfies I-025-4, I-025-5, I-025-6, CP-025-2(b), CP-025-3, CP-025-7.

#### Tasks

- **T28.4.1 — Governance key custody and subkey derivation.**
  - Files: `packages/runtime-daemon/src/mcp/governance-key-custody.ts` (CREATE)
  - One 32-byte key, generated at first governance use and **sealed under the daemon master key** in the daemon's database like every other daemon key, as the `daemon_secrets` row whose `purpose` is `mcp_governance`, in its `sealed_secret` column ([Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key)), with no key file. Derive purpose- and binding-separated subkeys via BLAKE3 keyed-PRF over a purpose tag plus the canonical binding identity: the config-hash, scope-ref, and receipt-digest subkeys. Losing the master key is fail-closed by construction — no key, no comparable hash, no trust.
  - **Spec coverage:** Spec-025 §Implementation Notes, Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-1
  - **Consumes:** BLAKE3 keyed mode ← the Plan-005 canonicalization substrate (shipped Phase 2); the master key and the one sealing format ← [Plan-020](./020-data-retention-and-gdpr.md) T22.1.2 and T22.1.7.

- **T28.4.2 — Keyed base-config hash canonicalizer with projection-field exclusion.**
  - Files: `packages/runtime-daemon/src/mcp/config-hash-canonicalizer.ts` (CREATE)
  - `b3:`-prefixed BLAKE3 in keyed mode (key = the binding's config-hash subkey) over the RFC 8785 JCS canonicalization of the normalized server config. Reorder-stable; sensitive to any semantic change including credential-bearing env-var and header **values**. Computed **excluding** the daemon-managed override-projection fields (`enabled_tools` / `disabled_tools` / `tools.<t>.approval_mode`) so a governed override write never self-revokes the trust that authorized it. Inputs are transient in memory — parse, canonicalize, hash, discard.
  - **Spec coverage:** Spec-025 §Trust Governance, Spec-025 §Implementation Notes
  - **Verifies invariant:** I-025-2
  - **Consumes:** the config-hash subkey ← T28.4.1 (same phase).

- **T28.4.3 — `mcp` Cedar action registration and the deny-before-effect retrofit.**
  - Files: `packages/runtime-daemon/src/policy/mcp-cedar-actions.ts` (CREATE) + `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (EXTEND)
  - Register the `mcp` Cedar actions additively through Plan-010's policy-module surface — no Plan-010-owned file is modified (CP-025-3, the CP-010-4 consumer pattern). Every non-read operation evaluates `PermissionCheckService` **before any provider call or store write**; authorization is evaluated **before existence checks** so a deny is stable and leaks no inventory contents. A deny returns `mcp.governance_denied`; a caller who does not own this node returns `mcp.operator_scope_required` before any store or provider mutation, and the ownership predicate reads the authenticated caller and the node's ownership record only — never the transport the call arrived on, so an owner driving the node from a linked device is admitted exactly as one at the machine is ([Spec-028 §Parity by construction](../specs/028-remote-control.md#parity-by-construction)). Retrofit the Phase 2–3 handlers off the `not_implemented` feature gate to full authorization in this task.
  - **Spec coverage:** Spec-025 §Authorization
  - **Verifies invariant:** I-025-4
  - **Consumes:** `PermissionCheckService.check()` ← Plan-010 Phase 2 (§Precondition, Plan-010 Phase 2 merged; reciprocal return-cite on Plan-010 CP-010-4).

- **T28.4.4 — Trust service: grant, revoke, and the native-field baseline lifecycle.**
  - Files: `packages/runtime-daemon/src/mcp/trust-store.ts` (EXTEND)
  - `mcp.setTrust` grants bind to the binding's **current** base-config hash; revocation is by the person or drift-driven. Snapshot `native_tool_baseline_json` from the observed native values at trust grant **or** at first facet materialization, whichever comes first; never silently refresh it while held; drop it only once the binding is untrusted with no materialized facets. Same-named bindings in different scopes carry independent trust. Revocation by **either** entry — the person (`mcp.setTrust` to untrusted) or drift (T28.4.5) — additionally neutralizes the **durable** surface in the same transaction: every non-terminal `command_receipts` row stamped with the revoked binding's `mcp_binding_digest` has its `idempotency_class` rewritten to the `manual_reconcile_only` floor (**I-025-6**, CP-025-7), and every remembered approval rule over the binding's tools is revoked with `server_trust_withdrawn`, one `approval.rule_revoked` per rule, in the same transaction; `mcp.removeServer` runs the same revocation, in the same transaction as the removal, for every remembered approval rule over the removed server's tools ([Plan-010](./010-approvals-permissions-and-trust-boundaries.md) D-010-11). This service is the single revocation writer both entries funnel through — the drift evaluator owns detection and calls **here** to write `trusted = 0` rather than writing trust rows itself — so neither entry can reach revocation without the neutralization, and a third entry added later inherits it by construction rather than by remembering to.
  - **Spec coverage:** Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-2, I-025-6
  - **Consumes:** the keyed hash ← T28.4.2 (same phase).

- **T28.4.5 — Drift evaluation (hash-plus-projection) with the atomic neutralization batch.**
  - Files: `packages/runtime-daemon/src/mcp/drift-evaluator.ts` (CREATE)
  - On any observation of a trusted binding: recompute the base-config hash and, **additionally**, reconcile the hash-excluded projection fields against the expected native state (the preserved baseline overlaid with materialized facets) — so a projection-field-only out-of-band edit drifts under an unchanged base hash. Any divergence auto-revokes (`trusted = 0`, `revoked_reason = 'config_drift'`) **before the changed config informs any decision surface**. Revocation neutralizes weakening in the same operation: daemon-enforced weakenings lapse at resolution time; Codex-materialized native weakening fields are rewritten to the **baseline-anchored safe state** (baseline ⊕ surviving tightening facets, never an invented default); governed portions of the projection fields are re-asserted while ungoverned portions adopt observed values. The trust event plus one `mcp.tool_override_changed` per reverted facet append as one **atomic batch** in the revocation's transaction under its receipt, never re-emitted on replay.
  - **Spec coverage:** Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-2, I-025-4
  - **Consumes:** baseline + trust rows ← T28.4.4 (same phase).

- **T28.4.6 — Drift-admission service registered through the Plan-003 `RunSetupGate` seam.**
  - Files: `packages/runtime-daemon/src/mcp/drift-admission-service.ts` (CREATE)
  - One admission service — fresh provider-config read, keyed hash recompute, projection reconciliation, full drift processing — exposed as a `RunSetupGate` (`{ assertRunReady, onRunTerminal? }`) and **registered** into the ordered gate array. A registration call, never an edit to `run-engine.ts` (the CP-008-9 precedent; `run-engine.ts` is Plan-003-owned and Plan-025 is a registrant on it, not an extender). `assertRunReady` completes drift processing before the run leaves `starting`, and each provider's session set (T28.3.3, T28.3.9) is built **from** the post-drift read.
  - **Spec coverage:** Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-2
  - **Consumes:** the `RunSetupGate` registration seam ← Plan-003 Phase 3, CP-003-8 (§Precondition, Plan-003 Phase 3 merged; reciprocal extender enumeration on Plan-003 CP-003-8).

- **T28.4.7 — Recovery-attach composition-root wiring and the non-vacuous production assertion.**
  - Files: `packages/runtime-daemon/src/bootstrap/index.ts` (EXTEND — Plan-006-owned; the sanctioned wiring-call edit)
  - Replace the vacuous default on Plan-013's `startup-recovery-service.ts` attach seam (`{ assertAttachAdmissible(context): Promise<void> }`) with the real drift-admission service at the daemon composition root (the Plan-003 T3.14 `RollbackAttributionSource` precedent), so an edit made while the daemon was down processes drift before any adoption or cold resume. Ship the runtime assertion that a production daemon carrying Plan-025 never constructs recovery with the vacuous default.
  - **Spec coverage:** Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-2
  - **Consumes:** the `assertAttachAdmissible` vacuous-default seam ← Plan-013 T15.3 (order-independent; reciprocal already present in Plan-013's T15.3 attach-seam clause naming Plan-025 CP-025-5).

- **T28.4.8 — Override service: weakening-requires-trust, baseline restore, scope matrix.**
  - Files: `packages/runtime-daemon/src/mcp/tool-override-service.ts` (CREATE)
  - `mcp.setToolOverride` / `mcp.clearToolOverride` over the three optional facets. Safety-weakening facets require a trusted binding — `mcp.trust_required` otherwise; the weakening set is idempotency-class assignment off the floor, approval modes weaker than the provider default, **and `enabled: true`** (broadening the executable tool set is capability expansion, never neutral). Safety-tightening facets succeed regardless of trust. Codex `enabled`/`approvalMode` materialize into native fields at `user` scope (grade `user_config_write`); Claude equivalents are `daemon_enforced`; `idempotencyClass` is always `daemon_enforced`. Clearing restores the cleared facet's portions from the baseline; clearing the last facet of an untrusted binding restores it verbatim and drops it, so a user's own native entries survive a set → clear round-trip.
  - **Spec coverage:** Spec-025 §Tool-Level Overrides, Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-5
  - **Consumes:** baseline ← T28.4.4; trust state ← T28.4.4 (same phase).

- **T28.4.9 — Binding-keyed tool-metadata overlay (CP-025-2(b)).**
  - Files: `packages/runtime-daemon/src/mcp/tool-metadata-overlay.ts` (CREATE)
  - Overlay `mcp_tool_overrides` onto the `driver_tools`-sourced metadata so an `idempotencyClass` the person assigns reaches the resolution output and absence resolves to the `manual_reconcile_only` floor. The lookup keys on the full `(provider, scope, scopeRef, serverName, toolName)` binding, not `(driver_name, tool_name)`, so two sessions resolving the same tool name from user- and project-scope bindings each get their own scope's override. Weakening facets resolve only while the binding's trust holds. Downstream consumers read the resolution output, never the override table.
  - **Spec coverage:** Spec-025 §Tool-Level Overrides
  - **Verifies invariant:** I-025-5
  - **Consumes:** `driver_tools` metadata ← Plan-004 Phase 2 (T2.1/T2.4); the full `(provider, scope, scopeRef, serverName)` lookup key ← **T28.4.11** (same phase).
  - **Ownership note:** `driver_tools` is Owner=Plan-004. This overlay is a Plan-025-owned module reading that store's output; it MUST NOT edit any Plan-004-owned file.

- **T28.4.10 — `mcp.server_trust_changed` and `mcp.tool_override_changed` emission.**
  - Files: `packages/runtime-daemon/src/mcp/governance-event-emitter.ts` (CREATE)
  - Sentinel-bound with `initiatingSessionId` when applicable (**absent on drift auto-revoke** — the person did not initiate it). Every override mutation emits on set and clear alike. The revocation batch appends atomically per T28.4.5. Payloads carry `scopeRefDigest`, never raw `scopeRef`.
  - **Spec coverage:** Spec-025 §Status Observation and Events
  - **Verifies invariant:** I-025-4
  - **Consumes:** `EventLogService.append` ← Plan-005 Phase 4 (shipped path).

- **T28.4.11 — Effective-binding derivation for a session's tool namespace.**
  - Files: `packages/runtime-daemon/src/mcp/effective-binding-resolver.ts` (CREATE)
  - Resolve `(sessionId, toolName)` to an `McpServerBindingRef` **or** to `null`, from the post-drift session set T28.4.6's read feeds, applying the same scope precedence the provider applies — so the answer is the binding the provider actually served the tool from, not a plausible reconstruction. `null` is a first-class answer meaning _no governed binding_ (a provider built-in, or a daemon-hosted callback tool), never an error and never a guess; it is what makes a `NULL` `mcp_binding_digest` meaningful rather than merely missing. This is **derivation, not registration**: nothing is threaded in from Plan-004 or Plan-013. **Never key on the delivered wire tool name's shape** — provider-side tool-name prefixing and collision-suffixing are provider defaults rather than wire invariants, so the mapping runs off the daemon's own registration identity, never off parsing the delivered name. Emit the binding-identity digest here too, so T28.4.4's neutralization lookup and the receipt write are two readers of **one** derivation rather than two implementations that can disagree.
  - **Spec coverage:** Spec-025 §Tool-Level Overrides, Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-5, I-025-6
  - **Consumes:** the post-drift session sets ← T28.4.6 (same phase).
- **T28.4.12 — Binding-digest column and receipt stamping.**
  - Files: the daemon's one schema (EXTEND — the `mcp_binding_digest` column and `idx_command_receipts_mcp_binding`) + the schema's test (EXTEND), `packages/runtime-daemon/src/persistence/sqlite/command-receipt-store.ts` (EXTEND — the receipt INSERT gains the digest argument; the directory Plan-013 T15.1 declares for the receipt store, not a `recovery/` sibling).
  - The column and its partial index have a defining DDL in `local-sqlite-schema.md` and an invariant that reads them, but until this task no code creates either and no writer populates them — a governed-binding provenance column that is always `NULL` would make I-025-6's neutralization sweep silently vacuous, matching nothing and reporting success. This task adds the additive nullable `mcp_binding_digest` column plus `idx_command_receipts_mcp_binding` under CP-025-7, and threads the digest T28.4.11 derives into the existing receipt write **as an argument to the current INSERT**, opening no second write path — the Plan-013-owned store keeps its single writer, and this plan supplies a value rather than authoring a seam.
  - **Ownership note:** `command_receipts` is Owner=Plan-003 and its receipt store is Owner=Plan-013. This task adds one column and one call-site argument under CP-025-7 and edits nothing else in either surface.
  - **Spec coverage:** Spec-025 §Trust Governance
  - **Verifies invariant:** I-025-6
  - **Consumes:** the derived digest ← T28.4.11 (same phase); the receipt write path ← Plan-013 (shipped).

- **T28.4.13 — The trust gate for repository-borne `project` bindings.**
  - Files: `packages/runtime-daemon/src/mcp/trust-store.ts` (EXTEND) + `packages/runtime-daemon/src/mcp/binding-resolver.ts` (EXTEND)
  - Record which `project` bindings the daemon wrote. A `project` binding it did not write joins a session's set only while trusted: left out of the Claude Code `mcp_set_servers` set, and `mcp_servers.<name>.enabled = false` in the Codex `thread/start` table, until `mcp.setTrust` grants trust; a drift auto-revoke takes it back out. On Claude Code the grant stands in for Claude Code's own approval of a repository's `.mcp.json`, and a server listed in `disabledMcpjsonServers` stays out regardless.
  - **Spec coverage:** Spec-025 §Trust Governance, Spec-025 §Unified Inventory
  - **Verifies invariant:** I-025-2
  - **Consumes:** trust state ← T28.4.4 (same phase); the session sets ← T28.3.3 and T28.3.9 (Phase 3, merged).
  - **Not built:** the written-by record and the gate.

- **T28.4.14 — One change on the wire: the recomputed hash commits with each write.**
  - Files: `packages/runtime-daemon/src/mcp/config-event-emitter.ts` (EXTEND)
  - Each write at any scope is one governed mutation: the provider write's verified result, the binding's recomputed base-config hash and `mcp.server_config_changed` commit in the same transaction, so a server saved through the MCP servers page never trips the drift gate and never loses its trust to its own save.
  - **Spec coverage:** Spec-025 §Configuration Mutation
  - **Verifies invariant:** I-025-2, I-025-4
  - **Consumes:** the keyed hash ← T28.4.2 (same phase); the config event ← T28.3.8 (Phase 3, merged).
  - **Not built:** the hash-with-write commit.

### Phase 5 — Sign-in, the daemon's client and route, and client delivery

**Precondition:** Phase 4 merged; the Plan-021-partial renderer substrate (shipped, CP-025-6).

**Goal:** one daemon-held sign-in per server serves both providers and the daemon's own client; the fronted route moves a long call to the background on Codex; a session's own server operations work; CLI + desktop surfaces ship; the Spec-025 §Acceptance Criteria sweep is green end to end. Satisfies I-025-1's flow-level verification.

#### Tasks

- **T28.5.1 — The daemon's own sign-in, its custody, and the header helper.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-sign-in-service.ts` (CREATE) + `packages/runtime-daemon/src/mcp/header-helper-answerer.ts` (CREATE) + `packages/contracts/src/mcp-governance.ts` (EXTEND — the header helper's token request and its reply, which the command-line tool sends and the daemon answers)
  - `mcp.oauthLogin` starts the daemon's own sign-in over T28.5.9's client: discovery from the server's protected-resource metadata, registration by the server's metadata document or dynamic registration, PKCE, `resource` set to the server's address; a server whose entry names an owner-issued client (Codex's `oauth.client_id` and `oauth.callback_url`) signs in as that client. The client implements `discoveryState` and `saveDiscoveryState`, binding the callback to its authorization server. The reply carries the sign-in page's address; the idempotency receipt persists the acknowledgment with `authorizationUrl` **structurally omitted**, so an identical-key retry replays a URL-free acknowledgment. A new `mcp.oauthLogin` on a server whose sign-in waits ends that wait and starts the next attempt. The refresh token goes into the operating system's credential store under an item the daemon creates, never a file — through `@napi-rs/keyring` 2.1.0, opened with `{linux: {store: "secret-service"}}`, on macOS and Linux, and on Windows, native and WSL alike, through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE` ([Plan-020](./020-data-retention-and-gdpr.md) `WindowsCredentialStore`, CP-020-8), as the master key's entry is, never at a roaming persistence; a store that cannot be reached refuses the sign-in — and the daemon renews it itself under its client id, one renewal in flight per server. Each provider process the daemon launches gets a header helper per signed-in server (Codex `http_headers_helper`, Claude Code `headersHelper`) whose command line names the command-line tool by absolute path and carries only a server handle, a session handle and the socket path; the helper asks the daemon over its same-user socket for a current access token and prints the `Authorization` header, and the daemon answers only for a session it launched with that server on. The daemon watches each Claude Code process's stderr for `headersHelper not run` and reports it as a fault on that leg. No token, code, PKCE value or key reaches any egress, CLI stdout and the renderer bridge included.
  - **Tests:** one sign-in lets a Claude Code session and a Codex session reach the server; a rotated access token is renewed by each provider re-running its helper, with no step by the person; a helper asked for a session the daemon did not launch prints nothing; the helper command line carries no credential; the receipt row is URL-free.
  - **Spec coverage:** Spec-025 §OAuth Orchestration
  - **Verifies invariant:** I-025-1
  - **Consumes:** the MCP client ← T28.5.9 (same phase); the receipt store ← T28.3.6 (Phase 3, merged).
  - **Not built:** the sign-in service, the custody and the helper answerer.

- **T28.5.2 — The provider-admitted takeover and DPoP servers.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-sign-in-service.ts` (EXTEND)
  - A server that admits only Claude Code's or Codex's own client: run that provider's own flow in a throwaway home the daemon makes for this sign-in (Codex `mcpServer/oauth/login` with `mcp_oauth_credentials_store = "file"`, no ChatGPT sign-in; Claude Code's `mcp_authenticate` control request in a credential folder of its own), take the saved entry (server, issuer, client id, access and refresh tokens, expiry) into the daemon's own item, delete the home, renew under that client id, and front the server for both providers. Learn the admitted client before the browser opens from a refused dynamic registration or pushed-authorization request; otherwise open with the daemon's own client and, when that attempt does not finish, go through the admitted provider's client on the next. Remember the admitted client per server. Never read or renew a sign-in outside a home the daemon made. A server that demands DPoP tokens: sign in with a signing key made for that one sign-in (the client's `DpopSession`), one key per server and never the machine's control-plane key, kept in the credential store beside the refresh token by the same route; front the server for both providers and sign a proof per request.
  - **Tests:** against a local server admitting only one provider's client, the sign-in completes through that provider's flow, the throwaway home is gone afterward, and a later renewal succeeds under that client id; a provider-owned sign-in planted outside the daemon's homes is byte-identical after sign-in and renewal; against a local DPoP server, a `Bearer` or proof-less call is refused and the fronted call succeeds from both providers.
  - **Spec coverage:** Spec-025 §OAuth Orchestration
  - **Verifies invariant:** I-025-1
  - **Consumes:** the sign-in service ← T28.5.1; the fronted route ← T28.5.10 (same phase).
  - **Not built:** the takeover and the DPoP arm.

- **T28.5.3 — `mcp.server_oauth_completed` exactly once per completed sign-in.**
  - Files: `packages/runtime-daemon/src/mcp/oauth-completion-emitter.ts` (CREATE)
  - Emit exactly once per completed sign-in — the daemon's own callback, or the provider's flow finishing in the throwaway home. An abandoned sign-in, or one ended by a newer attempt, emits nothing and leaves only its expiring receipt. Launch failures (discovery, registration, or the provider's flow failing to start) are the error `mcp.oauth_flow_failed` on the still-open call; asynchronous completion failures are the event with `outcome: 'failure'` and a sanitized `failureReason` — never a late JSON-RPC error on a closed request.
  - **Spec coverage:** Spec-025 §OAuth Orchestration, Spec-025 §Authorization
  - **Verifies invariant:** I-025-4
  - **Consumes:** `EventLogService.append` ← Plan-005 Phase 4 (shipped path).

- **T28.5.4 — `mcp.reconnect` leg-addressable handler.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-reconnect-handler.ts` (CREATE)
  - Claude `reconnectMcpServer()` / Codex `mcpServer/refresh`. Leg-addressable: a `bindingId` reconnects exactly one leg (with `sessionId`, both must name the same leg), a `sessionId` alone reconnects that session's legs, neither reconnects every live leg. Unreceipted and Cedar-evaluated; changes no store and no provider config, so it emits **no** dedicated governance event — its observable effect is audited through the `mcp.server_status_changed` transitions it induces, and an attempt producing no transition intentionally leaves no governance row.
  - **Spec coverage:** Spec-025 §Authorization
  - **Verifies invariant:** none (no-event negative control is asserted at T28.5.8)
  - **Consumes:** per-leg statuses ← T28.2.7 (Phase 2, merged).

- **T28.5.5 — Client SDK `mcp.*` surface.**
  - Files: `packages/client-sdk/src/mcpClient.ts` (CREATE) + `packages/client-sdk/src/index.ts` (EXTEND — barrel line)
  - Typed client methods for every `mcp.*` operation and every `session.mcp*` operation over the `JsonRpcClient` transport, including the `mcp.subscribe` and `session.mcpServerList` stream consumers.
  - **Spec coverage:** Spec-025 §Interfaces And Contracts
  - **Verifies invariant:** none (transport surface)
  - **Consumes:** `JsonRpcClient` ← Plan-006-partial `transport/jsonRpcClient.ts` (shipped, CP-006-4).

- **T28.5.6 — CLI `sidekicks mcp` command group.**
  - Files: `apps/cli/src/commands/mcp-list.ts`, `mcp-add.ts`, `mcp-remove.ts`, `mcp-trust.ts`, `mcp-override.ts`, `mcp-login.ts`, `mcp-watch.ts` (all CREATE) + `apps/cli/src/main.ts` (EXTEND — seven `.register()` calls)
  - Subcommands under the Plan-006 registered bin name; `mcp-watch.ts` tails `mcp.subscribe`. There is no sign-out subcommand: the design gives `mcp.oauthLogout` one control, `Sign out of this server` on Settings › MCP servers (T28.5.7, T28.5.11), and names no command-line sign-out. clipanion has no auto-discovery, so each file needs an explicit `.register()` on the `Cli` instance. Honors Plan-006's I-006-13 import isolation (only `@ai-sidekicks/client-sdk` / `@ai-sidekicks/contracts` / `clipanion` / Node built-ins), enforced by `apps/cli/eslint.config.mjs`. **`mcp-login.ts` prints the daemon-returned authorization URL as the command's own RESULT** — on the result stream `Plan-006 I-006-20` assigns results to, never as a diagnostic — because the URL is what the person must open for the flow to proceed, and a login command that withholds it cannot complete. That is its only destination: it is not logged, not written to any file the CLI owns, and not re-emitted after settlement, and no token, authorization code, or PKCE material reaches either stream at all. The command then settles on the daemon's own completion, never on a timer.
  - **Tests:** `mcp-login` writes the authorization URL to the result stream and nothing credential-bearing to either stream, asserted by capturing both; and no second emission of that URL follows the completion.
  - **Spec coverage:** Spec-025 §Interfaces And Contracts
  - **Verifies invariant:** none (client reachability surface)
  - **Consumes:** the `apps/cli/` scaffold + `src/commands/` directory + `main.ts` `Cli` builder ← Plan-006 Phase R3 (T-006r-3-1 / T-006r-3-2).

- **T28.5.7 — Desktop MCP-governance settings page (CP-025-6, CP-025-8).**
  - Files: `apps/desktop/src/renderer/src/mcp-governance/` (CREATE)
  - Panel views reading `mcp.list` / `mcp.get` and the `mcp.subscribe` stream **only** via the `window.desktopBridge` bridge — no direct daemon access from the renderer (the CP-014-11 pattern; live bridge verification arrives with Plan-021's remainder).
  - **The MCP servers page.** The views become the full settings-level page [Spec-025 §The MCP servers page](../specs/025-mcp-server-configuration-and-governance.md#the-mcp-servers-page) and the MCP Servers View sketch under [Spec-021 §Signature Feature Composition Sketches](../specs/021-desktop-app-and-renderer.md#signature-feature-composition-sketches) specify: the two-pane server list and detail, the trust chip carrying the daemon's own revoke reason (config-drift included), the per-tool effective idempotency class marked as native baseline or an override the person set, and the mutating controls — add / update with `Where it applies` and its project chooser, `Browse servers`, remove, enable / disable, trust / revoke, set / clear a tool override, sign in and sign out, and reconnect — **one wire mutation per explicit action by the person**, over the `mcp.*` operations this plan documents; the list's first read and its failure with `Try again`; the names-only refusal at `In this project, saved with the repository`; and the `Failed` line for a command that cannot run after a move. Three properties are obligations rather than styling. **(1)** The page updates from `mcp.subscribe` and **never** polls `mcp.list` on a timer. **(2)** Configuration content splits three ways rather than being uniformly withheld: the declaration form **collects** what `mcp.upsertServer` accepts — transport, command, args, URL, timeouts, the required marker, env-var and header names, and the credential-bearing values that input shape admits, those held **write-only in the renderer** (masked, never read back, never in serializable renderer state, cleared on submit); it **reads back** exactly `McpServerConfigView` and nothing beyond it; and it **renders nothing the daemon does not serve** — env-var values, header values, tokens, URL query values — and reads no provider config file. The OAuth launch URL is governed by that same write-only discipline rather than by the withholding rule: it arrives on the `mcp.oauthLogin` reply, is rendered so the person can open it, is held in no serializable renderer state and no client-side storage, is entered into no log, and is dropped at settlement — one destination, for the life of one attempt. **(3)** It **derives no state and projects no eligibility**: trust state, connection status, and effective class are wire-verbatim and recomputed nowhere, while eligibility is projected **not at all** — no inventory or event field on this governance layer reports whether an operation would be permitted, so every control is offered, the daemon adjudicates, and the typed refusal renders. The single non-offer is a control whose required input is structurally absent from the served entry — on the degraded arm the trust-/override-dependent fields are structurally absent, so the trust and per-tool controls have nothing to act on while every control whose input did arrive is offered exactly as on the normal arm — which is missing data rather than a derived judgment. Plan-021 mounts this subtree and owns nothing inside it (CP-025-8 ⇄ CP-021-7).
  - **Spec coverage:** Spec-025 §Status Observation and Events; Spec-025 §The MCP servers page; Spec-021 §Signature Feature Composition Sketches (the MCP Servers View sketch)
  - **Verifies invariant:** none (read-and-steer view layer; the authorization it surfaces is enforced daemon-side by Phase 4)
  - **Tests:** an effective idempotency class rendered from the daemon read is not recomputed when the underlying trust chip changes — asserted by mutating trust and checking the class re-renders only on the daemon's own row, since the failure mode is a plausible local re-derivation; a refused safety-weakening override renders the daemon's reason and the control was not pre-disabled; the page issues no `mcp.list` call on a timer with the subscription live; and no value the daemon withholds — env-var value, header value, token, or URL query value — reaches a rendered node, asserted against a served `McpServerConfigView` whose name-only fields are present, so the assertion distinguishes withheld values from absent configuration rather than passing vacuously. A credential-bearing form value is absent from serialized renderer state and cleared after submit, asserted by snapshotting that state rather than by inspecting the request — the same snapshot asserting that a rendered authorization URL is absent from it and gone after settlement, while a token, authorization code, and PKCE value are absent from every bridge payload the page ever receives; and every mutating control is **offered** on a binding the daemon will refuse — an untrusted server's safety-weakening override among them — with the refusal rendered, the assertion that the page projects no eligibility of its own.
  - **Consumes:** the `window.desktopBridge` bridge stub + renderer substrate ← Plan-021-partial (shipped).

- **T28.5.8 — End-to-end acceptance sweep against Spec-025 §Acceptance Criteria.**
  - Files: `packages/runtime-daemon/src/mcp/__tests__/acceptance.test.ts` (CREATE)
  - One assertion per Spec-025 §Acceptance Criteria bullet, fixture-driven against fake provider wires for both CLIs, plus the Adversarial-Tampering sweep: credential echo over every payload / error code / the config view / receipt rows / logs / helper command lines / renderer state **and the two Phase-5 egress surfaces (CLI stdout and the renderer bridge payloads)** — credential material asserted absent at both, and `authorizationUrl` asserted by destination per the boundary sweep above: absent from the subscription, the events, the receipt row, and the logs, and present only on the login reply each client consumes; raw-`scopeRef` absence; provider-file byte-identity after every refused mutation; canonicalization round-trip; and the hash-brute-force negative control (no served or stored digest is reproducible from a database copy alone). Every error code reachable and absent from success paths.
  - **Spec coverage:** Spec-025 §Acceptance Criteria
  - **Verifies invariant:** I-025-1, I-025-2, I-025-3, I-025-4, I-025-5
  - **Consumes:** every Phase 1–4 surface (same plan, merged).

- **T28.5.9 — The daemon's own MCP client.**
  - Files: `packages/runtime-daemon/src/mcp/client/` (CREATE)
  - One module on `@modelcontextprotocol/client` 2.1.0, the one maintained MCP client that signs DPoP proofs; `@modelcontextprotocol/sdk` stays only to host Playwright's tool server. It makes a call task-augmented wherever the tool allows one (`taskSupport` `required` or `optional`), writes the `taskId` to `command_receipts.mcp_task_id` before answering anything else, and polls with Claude Code's figures (2 s by default, the server's `pollInterval` held between 100 ms and 60 s, a halt after 10 failures in a row with the handle kept). It starts a stdio server with the environment values its declaration holds, or connects to an address with its headers, reading those values from the provider's config only for the connection. It serves the fronted route (T28.5.10), Codex's prompt list over the connection it already holds for the server, so listing prompts never starts a second copy of it, the workflow MCP-tool step's `tools/call`, and Plan-013's recovery sweep, which resumes every receipt with a handle to a server reached at an address (`tasks/get` to a terminal status, then `tasks/result`).
  - **Spec coverage:** Spec-025 §Long tool calls and the fronted route, Spec-025 §Implementation Notes
  - **Verifies invariant:** I-025-1
  - **Consumes:** `command_receipts.mcp_task_id` ← Plan-004 T5.1.
  - **Not built:** the client.

- **T28.5.10 — The fronted route and background long calls.**
  - Files: `packages/runtime-daemon/src/mcp/client/fronted-route.ts` (CREATE)
  - On a Codex session, rewrite each entry of T28.3.9's table as a `url` entry on the daemon's route under the server's own name, keeping its `enabled` flag; the client holds the real connection, one stdio copy per conversation. Answer a call normally when it ends within 120 s; past 120 s, or when the daemon steers the conversation while it runs, answer with Claude Code's handle text and keep the call running. Serve `task_output {task_id, wait_seconds?}` (waiting at most 10 s) and `task_stop {task_id}` (`tasks/cancel` for a task-augmented call, `notifications/cancelled` for a plain one). When the call ends, deliver `MCP task <id> (<server>/<tool>) completed.` with the result by `turn/steer` into a running turn or `turn/start` into an idle one, and set `delivered` on the receipt so a result after a restart is delivered once. Apply Codex's per-tool approval on the route from the session's permission level and the server's `tools.<t>.approval_mode`; hand an elicitation on as the session's question card and a progress notice as the row's progress line. Front a server behind a sign-in on the daemon's sign-in. On a Claude Code session front only a DPoP server, signing a proof per request, a long call there taking the client's own task handling. Budget: at most 5 ms added to a fronted call against a direct one, measured at build.
  - **Tests:** a probe server's long call with the route's delay lowered is answered with the handle text, `task_output` returns its result once it ends, and the result is delivered exactly once by `turn/steer` into a running turn and by `turn/start` into an idle one; `task_stop` cancels it; after a daemon restart a task-augmented call's result is delivered once and a stdio server's task halts.
  - **Spec coverage:** Spec-025 §Long tool calls and the fronted route
  - **Verifies invariant:** I-025-1
  - **Consumes:** the client ← T28.5.9 (same phase); the session table ← T28.3.9 (Phase 3, merged); `turn/steer` / `turn/start` delivery ← Plan-004's Codex driver; the Claude Code side (`CLAUDE_AUTO_BACKGROUND_TASKS=1` at process start) ← Plan-004's Claude Code driver.
  - **Not built:** the route, `task_output`, `task_stop`, delivery and the `delivered` flag.

- **T28.5.11 — `mcp.oauthLogout`.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-sign-in-service.ts` (EXTEND) + `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (EXTEND)
  - Cedar-gated and receipted. Delete the daemon's refresh-token item for the server, and its DPoP signing-key item where it has one, and stop answering the helpers for it, so each provider's next call gets no token; each connected leg's transition to `needs-auth` emits `mcp.server_status_changed`, and the operation mints no event of its own.
  - **Tests:** after sign-out both credential-store items are gone, a helper asked for that server prints nothing, and every leg on both providers reads `needs-auth` on its next call.
  - **Spec coverage:** Spec-025 §OAuth Orchestration, Spec-025 §Authorization
  - **Verifies invariant:** I-025-1, I-025-4
  - **Consumes:** the sign-in service ← T28.5.1 (same phase).
  - **Not built:** the operation.

- **T28.5.12 — A session's own tool servers.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/session-mcp-handlers.ts` (CREATE)
  - `session.mcpServerList {sessionId}`: a live list of the servers the session was started with, each row from the inventory — name, binding, status and reason, whether it is on for the session, whether a switch waits for the next turn — with only names and statuses, never a config value. `session.mcpServerUpdate {sessionId, serverName, enabled}`: a session-level switch that only narrows what governance allows, kept with the session, applied at the next turn — on Claude Code another full-set `mcp_set_servers` call, on Codex the conversation's `enabled` flag — and sent again after each resume; a new session starts with every server on; no governance event. `session.mcpResourceList {sessionId, serverName}`: what a working server offers, for the composer's attachment row (on Codex through `mcpServer/resource/read`), refused for a server that is off or not working.
  - **Spec coverage:** Spec-025 §A session's own tool servers
  - **Verifies invariant:** none (session reads and a narrowing switch; asserted at T28.5.8)
  - **Consumes:** the inventory ← T28.2.4 (Phase 2, merged); the session sets ← T28.3.3 and T28.3.9 (Phase 3, merged).
  - **Not built:** all these operations.

## Rollout Order

1. Phases 1–5 as sequenced above.

## Rollback Or Fallback

- All the plan's tables are additive and Plan-025-only — rollback of any phase is a revert; no other plan reads or writes them.
- The `MethodRegistry` feature gate keeps `mcp.*` and `session.mcp*` operations `not_implemented` until their backing phase, so a mid-sequence pause leaves no half-authorized surface.
- Provider-side state needs no rollback by construction: I-025-3 means the daemon's writes are always provider-valid config the person could have made by hand.

## Risks And Blockers

- **Provider drift beyond the pins.** The provider-wire reference re-pins on its own cadence and `0.141.0` is the Codex **floor** rather than the pin; the config-method introduction versions remain unresolvable from upstream docs (bounded ≥ `0.141.0`). Mitigation: the per-capability detection + re-verify-at-execution rule (Spec-025 §Implementation Notes) is a hard phase-entry step, and Spec-004 §Required Behavior makes per-capability declared detection the driver-wide rule — so drift above the pin degrades one capability instead of a session, and the nightly compatibility check reports the drift without gating anything.
- **MCP 2026-07-28 revision.** Lands mid-execution window; binds here only through provider releases (Spec-025 binds provider surfaces, not the MCP wire). Watch item, not a blocker.
- **A Claude Code session that refuses the live reconcile.** Every build Spec-004 §Required Behavior admits (`2.1.234` and later) answers the reconcile control request on the driver's streaming-input transport: measured, it answers `success` at `2.1.234`, `2.1.245` and `2.1.246`, and an unknown subtype is refused. The measurement uses an **empty** desired set against a scratch session, out of band, so it shows the subtype dispatches and returns the documented reconcile envelope, not that a non-empty set lands; T28.3.2's own reconcile, run against the server set it is about to install, confirms that. The live path is the default on every admitted build. The risk is reachability, not version: a session the CLI treats as cloud-hosted refuses control requests a local one answers. Such a session gets its servers no other way: they read `Failed` with the refusal as their reason, and a change made meanwhile answers with grade `user_config_write` ([Spec-025 §Fallback Behavior](../specs/025-mcp-server-configuration-and-governance.md#fallback-behavior)). So T28.3.2 treats the reconcile as detection, and its `{control-channel reachable, control-channel unreachable-on-an-admitted-build}` fixture arms exercise a reconcile refusal rather than a version comparison.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
