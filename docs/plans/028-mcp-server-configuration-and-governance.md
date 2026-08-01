# Plan-028: MCP Server Configuration and Governance

| Field | Value |
| --- | --- |
| **Status** | `draft` |
| **NNN** | `028` |
| **Slug** | `mcp-server-configuration-and-governance` |
| **Date** | `2026-07-22` |
| **Author(s)** | Capability-enhancement campaign (B18) |
| **Spec** | [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) |
| **Required ADRs** | [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-004](./004-queue-steer-pause-resume.md) (Tier 5 — the `RunSetupGate` registration seam per CP-004-8, carrying the run-admission drift gate per CP-028-5), [Plan-005](./005-provider-driver-contract-and-capabilities.md) (driver seams: `onMcpServerStatus` producer, `driver_tools` metadata store, capability probe), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (event registry + append path; T1.10 registers the five `mcp.*` literals), [Plan-007](./007-local-ipc-and-daemon-control.md) (partial — `MethodRegistry` dispatch substrate + the streaming primitive `mcp.subscribe` rides), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (Cedar `PermissionCheckService`), [Plan-015](./015-persistence-recovery-and-replay.md) (the startup-recovery attach admission seam — T15.3's vacuous-default gate that CP-028-5's composition-root wiring fills; order-independent, no YAML gate: the default is honestly vacuous until Plan-028 ships), [Plan-023](./023-desktop-shell-and-renderer.md)-partial (shipped Tier 1 — renderer substrate + `window.sidekicks` bridge stub consumed by the Phase 5 desktop MCP panel views; live bridge verification at Plan-023 Tier 8, per the cross-plan graph's Plan-028 row) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Deliver V1 feature #18: the daemon's MCP governance layer per [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) — unified server inventory over scope-qualified bindings, provider-native configuration mutation (Claude sanctioned user-scope CLI writes + opportunistic live reconcile; Codex user-config CRUD + reload), the base-config-hash-bound trust store, tool-level overrides feeding the Plan-005 tool-metadata resolution layer, OAuth orchestration, normalized status observation, and the five-event `mcp_governance` audit surface — all Cedar-gated at node-operator scope.

## Scope

- `packages/contracts`: `mcp.*` operation payload schemas (the `McpServerBindingRef` discriminated union, the redacted `McpServerConfigView`, per-leg `McpServerLegStatus` / `McpLiveApplicationResult`, the mandatory `clientIdempotencyKey`), the five `McpGovernanceEventPayload` schemas (emitter-authors-payload precedent — the type literals and category themselves are Plan-006-owned, registered by Plan-006 T1.10), error-code constants.
- `packages/runtime-daemon`: migration for `mcp_server_trust` + `mcp_tool_overrides` + `mcp_mutation_receipts`; the `McpGovernanceService` (inventory, trust, overrides, idempotency receipts), provider config adapters (Claude sanctioned `claude mcp` user-scope CLI writer + ephemeral-config composer + live-reconcile client; Codex config CRUD client), status normalizer consuming the Plan-005 `onMcpServerStatus` seam, the drift-admission service registered through Plan-004's `RunSetupGate` seam and wired into Plan-015's recovery attach seam (CP-028-5), OAuth orchestrator, Cedar `mcp` action family wiring, `mcp.*` `MethodRegistry` handlers incl. the `mcp.subscribe` live-tail stream.
- `packages/client-sdk` + CLI/desktop surfaces: typed `mcp.*` client methods; CLI `ai-sidekicks mcp …` command group (the Plan-007 registered bin name); desktop MCP panel data hooks over `mcp.list`/`mcp.get` + the `mcp.subscribe` stream.
- Doc mirrors: [api-payload-contracts.md §Plan-028 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-028--mcp-governance-contract-surfaces), [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance), [local-sqlite-schema.md §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028) (all landed with the B18 doc PR; code phases keep them true).

## Non-Goals

- Everything Spec-028 §Non-Goals excludes: no MCP protocol implementation or proxying, no token custody, no provider-config-store ownership, no server registry/marketplace, no remote governance mutation ([BL-141](../backlog.md) model is V1.1), no session-role matrix extension, no Codex project-local config writes.
- No new `ApprovalCategory` value — governance mutations are direct Cedar decisions, not interactive approvals.
- No emitter code for any non-`mcp.*` event literal minted by the Spec-006 B18 amendment (`session.*` / `run.*` / `usage.*` / `user.message` emitters belong to Plan-004 / Plan-005 per [Plan-006 §Event Taxonomy Coverage](./006-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)).

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-028 PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)).

### I-028-1 — No credential custody

The daemon never persists, logs, relays, or embeds in events/errors any OAuth token, authorization code, PKCE material, bearer-token value, or env-var value belonging to an MCP server. The `mcp.oauthLogin` idempotency receipt stores its acknowledgment with `authorizationUrl` structurally omitted — launch URLs embed single-use PKCE state, so they are never durable and its replay is a URL-free acknowledgment. The only durable auth trace is the `mcp.server_oauth_completed` event (identity + outcome).

**Why load-bearing.** Token custody would put the daemon in the credential blast radius and contradict the provider-owned-auth posture Spec-028 §Non-Goals declares as a one-way-door refusal; Plan-022's PII/retention model assumes no credential columns exist.

**Verification.** Schema-level adversarial test sweeping all five event payload schemas + all ten error codes + all three table DDLs for credential-shaped fields (incl. the `McpServerConfigView` read model — env/header/query-param names only, never values, the URL served query-redacted — and the receipts row: the digest is keyed under the receipt-digest subkey of the daemon-held master key that never enters the database, the stored `response_json` is a sanitized wire payload by construction, and the `mcp.oauthLogin` row is asserted URL-free); integration test asserting OAuth flows leave no new rows beyond the completion event and its receipt.

### I-028-2 — Untrusted by default; trust is hash-bound and drift-revoked

Every observed binding `(provider, scope, scopeRef, serverName)` gets a `trusted = 0` trust row on first observation; `trusted = 1` is reachable only via operator `mcp.setTrust`; a trusted binding whose base-config hash (keyed BLAKE3 under the binding's config-hash subkey, derived from the daemon-held master key that never enters SQLite; daemon-managed override-projection fields excluded) diverges from the bound hash is auto-revoked (`revoked_reason = 'config_drift'`) before the changed config informs any decision surface, with safety-weakening override facets neutralized in the same operation (Spec-028 §Trust Governance — revocation neutralizes weakening). Drift evaluation is **hash-plus-projection**: the hash-excluded override-projection fields are reconciled on every evaluation against the expected native state — the preserved `native_tool_baseline_json` baseline overlaid with the materialized facets (Spec-028 §Trust Governance) — so a projection-field-only out-of-band edit drifts too, never rides under an unchanged base hash, and the trusted-no-override corner is covered (the baseline snapshots at trust grant, not only at first materialization). "Before use" is admission-enforced at both call sites: the CP-028-5 drift-admission service completes a fresh provider-config read and full drift processing before any provider process spawns against the affected bindings — at run starts via the `RunSetupGate` registration and at daemon-restart recovery via the Plan-015 attach seam — so out-of-band edits can never race a run start or a recovery resume past drift detection.

**Why load-bearing.** This is the operator-managed trusted-server store ADR-015 binds the MCP annotation-trust MUST to; a default-trust or stale-hash path would let a mutated server inherit trust granted to a different configuration.

**Verification.** Unit tests over the trust service state machine (observe → grant → drift → re-grant); integration test mutating a trusted server's config between observations and asserting revocation precedes use.

### I-028-3 — Provider-sanctioned writes only

Configuration mutations go exclusively through each provider's sanctioned mechanism (Claude: the `claude mcp add-json` / `claude mcp remove` user-scope CLI as the unconditional durable leg, `setMcpServers` as the opportunistic live leg, and the regenerated ephemeral `--mcp-config` snapshot as the run-declaration surface; Codex: `config/value/write` / `config/batchWrite` at user scope with `expected_version`, followed by reload). The daemon never rewrites provider config files directly and never writes any non-user scope on either provider.

**Why load-bearing.** Blind file rewrites race the provider's own writes, corrupt layered scopes, and break the inventory's source-of-truth model; Codex project-path writes are rejected upstream.

**Verification.** Integration tests asserting provider files are byte-identical after every daemon mutation except through the sanctioned path; the project-scope refusal test from Spec-028 §Acceptance Criteria.

### I-028-4 — Every governance mutation is Cedar-authorized and audited exactly once

Each of the eight non-read `mcp.*` operations (of the eleven; `mcp.list`/`mcp.get`/`mcp.subscribe` are the reads) evaluates the Cedar `mcp` action family before any provider call or store write, and each of the **six governance mutations** emits its defined `mcp_governance` event set exactly once — a single event for most mutations; a weakening-facet trust revocation appends its atomic batch, the trust event plus one `mcp.tool_override_changed` per reverted facet (sentinel-bound for node-scope events per [Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring](../specs/006-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding-and-node-scope-anchoring)) — exactly-once made durable by the mandatory `clientIdempotencyKey` + the **two-phase** `mcp_mutation_receipts` (a `pending` intent commits before the provider leg; finalization, store writes, and the event set commit in one SQLite transaction; startup reconciliation completes any crash-window intent so a durable provider write is never left unaudited — the Plan-015 `command_receipts` discipline; an identical retry replays the receipt, a divergent reuse fails `mcp.idempotency_conflict`, and neither re-emits). The two Cedar-gated operational commands sit outside the atomic mutation set (Spec-028 §Authorization): `mcp.reconnect` changes no store or config and audits through the `mcp.server_status_changed` transitions it induces; `mcp.oauthLogin` is receipted but its durable trace — `mcp.server_oauth_completed` — is provider-asynchronous and cannot commit with the launch acknowledgment, so it is emitted exactly once per **observed** completion (an abandoned or unobserved flow leaves only the expiring receipt, the auth outcome still surfacing via the next status transition).

**Why load-bearing.** The audit trail is the governance feature — an unaudited mutation path is indistinguishable from tampering; authorization-after-mutation would be TOCTOU (the D-012-18 lesson).

**Verification.** Per-operation integration tests asserting deny-before-effect and one-event-set-per-mutation (incl. the revocation-batch count); event-count assertions on retry paths (the Codex conflict retry must not double-emit) and the crash-window reconciliation fixture (durable provider write + lost finalization → startup appends the event exactly once).

### I-028-5 — The idempotency floor moves only through governed override

MCP-sourced tools resolve to `manual_reconcile_only` unless an `mcp_tool_overrides` row assigns `idempotent` / `compensable`; assignment requires a trusted server and Cedar authorization; the resolution layer (Plan-005's) is the only reader — downstream consumers never read the override table directly.

**Why load-bearing.** [Spec-005 §Tool Metadata](../specs/005-provider-driver-contract-and-capabilities.md#tool-metadata) makes the conservative floor the safety spine of Spec-015 recovery; an ungoverned or untrusted path off it would let recovery replay non-idempotent tools.

**Verification.** Resolver unit tests (floor absent override; override applied; override ignored when trust revoked mid-session); the `mcp.trust_required` acceptance test.

## Cross-Plan Obligations

### CP-028-1 — Event registration rides Plan-006 T1.10

The five `mcp.*` event literals and the `mcp_governance` category are Plan-006-owned registry surface, registered by [Plan-006 §Event Taxonomy Coverage](./006-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)'s T1.10 census-closure task (authored with this plan in the 2026-07-22 B18 PR). Plan-028 authors the payload schemas (emitter-authors-payload precedent, the Plan-012 `ApprovalFlowEventPayloadSchema` shape) and MUST NOT add the literals to `packages/contracts/src/event.ts` itself.

**Resolution.** Plan-006 T1.10 — the census-closure task this obligation rides, shipped 2026-07-25 via PR #247 — merges before Plan-028 Phase 1; the phase-scoped precondition below enforces it (Plan-006 Phase 1's declared set grew to T1.1–T1.12 on 2026-08-01 via the T4.10 targeted readiness-audit delta, so under declared-⊆-shipped the gate additionally holds until the T1.11/T1.12 remainder ships).

### CP-028-2 — Plan-005 seam consumption (status producer + tool-metadata resolution)

Plan-028 is the declared consumer of two Plan-005 surfaces: (a) the B10 `onMcpServerStatus` producer seam (`McpServerStatusEmission` → `McpServerStatusUpdate`; Plan-005 records "the consumer lands with Spec-028/B18"), consumed by the Phase 2 status normalizer; (b) the tool-metadata resolution layer over the `driver_tools` store, which Phase 4 extends with the `mcp_tool_overrides` overlay — Plan-028 EXTENDs the resolver's inputs through Plan-005's seam, never Plan-005's owned symbols directly. The overlay is **binding-keyed**: the Plan-005 store resolves by `(driver_name, tool_name)`, which cannot disambiguate the same `serverName` bound in two scopes, so the decorator widens the resolution input with the session's effective `McpServerBindingRef` (carried through tool invocation and recovery-receipt resolution — Spec-028 §Tool-Level Overrides) and keys the override lookup by the full binding plus `toolName`.

**Resolution.** Plan-005 Phase 3 merged is the Phase 2 precondition; the overlay lands as a Plan-028-owned decorator around the Plan-005 resolver surface in Phase 4. Reciprocal Plan-005 return-cite: its `onMcpServerStatus` consumer note names Plan-028 (trued in the same B18 PR).

### CP-028-3 — Cedar `mcp` action family via Plan-012's policy surface

Plan-028 consumes `PermissionCheckService` and registers the `mcp` Cedar action family through the Plan-012 `policy/` services — the same consumer pattern as Plan-017's Cedar policy reuse in Plan-012's CP-012-4. No Plan-012-owned symbol is modified; the action family is additive policy-module registration.

**Resolution.** Plan-012 Phase 2 merged is the Phase 4 precondition; the Plan-012 return-cite (its CP-012-4 consumer enumeration) is owed at Plan-028's readiness audit per that clause's consumer-registration pattern.

### CP-028-4 — `mcp.*` namespace registration against the Plan-007 substrate

The eleven `mcp.*` operations register against `MethodRegistry.register()` (`packages/contracts/src/jsonrpc-registry.ts`, shipped Tier 1) at this plan's tier — the Plan-007 CP-007-3 late-namespace pattern (`presence.*` precedent: namespace owners register at their own tier against the stable substrate); `mcp.subscribe` additionally rides Plan-007's streaming primitive (the `session.subscribe` long-lived consumer shape).

**Resolution.** Plan-007 Phase 2 merged is the Phase 1 precondition; the handlers land in Phase 2–5 as each operation's backing service exists. Plan-007 return-cite owed at Plan-028's readiness audit.

### CP-028-5 — Drift admission at run start (Plan-004 `RunSetupGate`) and recovery attach (Plan-015 seam)

The Spec-028 §Trust Governance drift gate is one Plan-028-owned admission service — fresh provider-config read, keyed base-config hash recompute, projection-field reconciliation against the baseline-anchored expected native state, and full drift processing (auto-revocation + weakening neutralization incl. Codex native-field re-assertion) — invoked from **two admission points**. (a) Run/thread starts: registered through Plan-004's `RunSetupGate` registration seam (`{ assertRunReady, onRunTerminal? }`, the ordered gate array on `run-engine.ts` per CP-004-8) — a registration call, never an edit to Plan-004's owned files (the CP-010-9 precedent); `assertRunReady` completes drift processing before the run leaves `starting`, and the Claude composed snapshot is then built from the post-drift state. (b) Daemon-restart recovery: Plan-015's startup attach sequence — adoption and cold resume alike — invokes the same service through the vacuous-default admission seam on `startup-recovery-service.ts` (T15.3's B18 clause) before any `resumeSession` dispatch; Plan-028's Phase 4 ships the **composition-root wiring** that replaces the vacuous default with the real service (the Plan-004 T3.14 `RollbackAttributionSource` composition-root precedent), plus the runtime assertion that a production daemon carrying Plan-028 never constructs recovery with the vacuous default. Before Plan-028 ships, the vacuous default is honest — no trust store exists, so there is no drift to process.

**Resolution.** Plan-004 Phase 3 merged is the Phase 4 precondition (the gate lands with the trust machinery it enforces); the Plan-015 seam is order-independent (vacuous until Plan-028's wiring lands — whichever plan executes first, the composed behavior activates once both have shipped, enforced by the Phase-4 runtime assertion). Plan-004 + Plan-015 return-cites (the CP-004-8 extender enumeration; T15.3's B18 clause) owed at Plan-028's readiness audit.

### CP-028-6 — Renderer substrate via Plan-023-partial

The Phase 5 desktop MCP panel views consume daemon state only via the `window.sidekicks` bridge over the Plan-023-partial renderer substrate (shipped Tier 1; live bridge verification at Plan-023 Tier 8) — the CP-016-11 pattern.

**Resolution.** Declared in the plan header; Phase 5's precondition names it. No YAML gate: the substrate shipped with Tier 1, so the machine-checkable preconditions carry only unshipped upstreams.

## Preconditions

- [x] Paired spec is approved — [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) promoted `approved` 2026-07-22 via the campaign's W3 gate (PR #246), after the Spec-006 census-amendment restoration (PR #245)
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred (the Codex thread-config question is explicitly deferred, non-blocking, per Spec-028 §Open Questions)
- [ ] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Plan-028 joins Tier 7 after that tier's audit (PR #160) closed, so it takes the runbook's new-plan invocation path (targeted, the Plan-014-delta shape): the audit runs against this `draft`, its pass ticks this box and gates `draft → review`, and the subsequent `review → approved` promotion cites the same audit's REVIEW.md once review notes are addressed — no code PR before both promotions complete

## Target Areas

- `packages/contracts/src/mcp-governance.ts` (CREATE) — operation payload schemas (incl. the `McpServerConfigInput` transport-discriminated union with provider-conditional refinements and the Codex auth references `envHttpHeaders`/`oauthScopes`/`oauthResource`, the `McpServerBindingRef` scope-discriminated union with the Claude-only `local` refinement, the redacted `McpServerConfigView` with the query-redacted URL, the discriminated degraded inventory arm, the mandatory `clientIdempotencyKey` on every mutation, the ≥ 1-facet override refinement, and the session-feed `bindingId` conditionality on the status payload), event payload schemas, error-code consts, `McpApplicationGrade` (`live_reconcile | user_config_write | next_run | daemon_enforced`), override facet + per-facet application types, per-leg `McpServerLegStatus` / `McpLiveApplicationResult`.
- `packages/runtime-daemon/src/mcp/` (CREATE) — `McpGovernanceService`, `McpInventoryService`, provider adapters (`claudeMcpConfigAdapter`, `codexMcpConfigAdapter`), `McpStatusNormalizer`, `McpOauthOrchestrator`, trust + override stores, the drift-admission service (both CP-028-5 call sites + the recovery composition-root wiring), config-hash canonicalizer (BLAKE3 over RFC 8785 JCS — reusing the Plan-006 canonicalization substrate), and the daemon-held MCP governance master-key custody (one 32-byte node-local key file beside the daemon's other node key material — the same custody class as the event-signing key, never in SQLite) with purpose- and binding-separated BLAKE3 keyed-PRF subkeys (config-hash, scope-ref, receipt-digest), plus the startup receipt-intent reconciler.
- `packages/runtime-daemon/src/policy/` (EXTEND via Plan-012's policy-module surface) — `mcp` Cedar action family registration (CP-028-3).
- `packages/runtime-daemon/src/migrations/NNNN-mcp-governance.ts` (CREATE) — the three tables per [local-sqlite-schema.md §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028), as a TypeScript string-constant migration module (the runner sources SQL as TS constants, never sibling `.sql` files — `tsc -b` does not copy non-TS assets into `dist/`); the version number is the next free `schema_version` integer at execution time (Plan-006/-015/-016/-022 migrations may land first).
- `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND) — the migration's guarded block (`hasMigrationApplied` + `db.transaction(...).immediate()`, the pinned version-1 primitive verbatim) + import, per the runner's registered-block convention (the Plan-016 `session_budgets` pattern), with the migration-shape tests in `packages/runtime-daemon/src/session/__tests__/` extended to cover the new version.
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND) — the `mcp.*` namespace handler files per CP-028-4.
- `packages/client-sdk/src/mcpClient.ts` (CREATE) + the package-root barrel line — typed `mcp.*` client methods.
- `apps/desktop/src/renderer/src/mcp-governance/` (CREATE) — MCP panel views over the SDK surface.
- `apps/cli/src/commands/` `mcp-*.ts` (CREATE) + the `main.ts` `.register()` EXTENDs — the `ai-sidekicks mcp` command group (`list` / `add` / `remove` / `trust` / `override` / `login` / `watch` — `watch` tails `mcp.subscribe`) under the Plan-007 registered bin name (`bin: { "ai-sidekicks": … }`, the Plan-016 command precedent; exact per-subcommand filenames pinned at the targeted readiness audit).

## Data And Storage Changes

- `mcp_server_trust` — `(provider, scope, scope_ref, server_name)` binding PK with the structural-validity CHECKs (user ⇔ empty `scope_ref`; no `(codex, local)`); `trusted` INTEGER; keyed base-config `config_hash` TEXT `CHECK(config_hash GLOB 'b3:*')` (no key material in the database — every digest key derives from the daemon-held master key); the `enabled_override` Claude overlay; the `native_tool_baseline_json` pre-governance snapshot (Codex-materialized bindings — the restore/reconciliation anchor per Spec-028 §Trust Governance); grant/revoke provenance columns. Owner: Plan-028 (CREATE).
- `mcp_tool_overrides` — `(provider, scope, scope_ref, server_name, tool_name)` PK; nullable facets `enabled` / `approval_mode` / `idempotency_class` (≥ 1 non-NULL); binding-validity CHECKs mirrored; FK-cascade to the trust row. Owner: Plan-028 (CREATE).
- `mcp_mutation_receipts` — `client_idempotency_key` PK; operation, request digest (keyed under the receipt-digest subkey of the daemon-held master key — never in the database, so a database copy cannot verify secret guesses offline), two-phase `status` (`pending` intent before the provider leg → `committed` at finalization, with `response_json` nullable until committed and startup reconciliation of crash-window intents), `created_at` (24 h opportunistic prune of `committed` rows). Owner: Plan-028 (CREATE).
- SQLite census 52 → 55 (applied with the B18 doc PR; the migration lands in Phase 1).
- Events append through the Plan-006 `EventLogService` path — no bespoke audit storage.

## API And Transport Changes

- Eleven `mcp.*` JSON-RPC operations (`mcp.list`, `mcp.get`, `mcp.subscribe`, `mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setTrust`, `mcp.setToolOverride`, `mcp.clearToolOverride`, `mcp.oauthLogin`, `mcp.reconnect`) registered per CP-028-4; typed mirrors in [api-payload-contracts.md §Plan-028 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-028--mcp-governance-contract-surfaces).
- Five `mcp_governance` events (registered via CP-028-1); ten `mcp.*` error codes per [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance).
- Provider wire consumption: Claude `claude mcp add-json` / `claude mcp remove` / `claude mcp get` (`--scope user`, the sanctioned durable-write CLI) + `setMcpServers` / `toggleMcpServer` / `reconnectMcpServer` / `mcpServerStatus` (SDK) + ephemeral `--mcp-config` / `--strict-mcp-config`; Codex `config/read` / `config/value/write` / `config/batchWrite` / `config/mcpServer/reload` / `mcpServer/refresh` / `mcpServerStatus/list` / `mcpServer/oauth/login` (+ `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed` notifications). All floors capability-probed at spawn and re-verified against then-installed binaries per the [provider-wire trust model](../reference/provider-wire/README.md).

## Implementation Steps

1. **Phase 1 — Contracts + storage.** Author `packages/contracts/src/mcp-governance.ts` (operation + event payload schemas incl. the binding-ref discriminated union, config view, per-leg types, `clientIdempotencyKey`, error consts, grades, facets; `--isolatedDeclarations`-clean); the three-table TS migration module + its `migration-runner.ts` guarded block; wire the error codes into the daemon error substrate. Register the eleven method names + schemas against `MethodRegistry` with `not_implemented` handlers behind a feature gate so the namespace shape ships reviewable before behavior.
2. **Phase 2 — Inventory + status observation.** Provider config readers (Claude `~/.claude.json` user + project-keyed `local` scopes + `.mcp.json`; Codex `config/read` with layer attribution incl. project-local read-only rows) resolving scope-qualified bindings with `effectiveInRuns` attribution; `McpInventoryService.list/get` merging config + status + trust + overrides; `McpStatusNormalizer` consuming the Plan-005 `onMcpServerStatus` seam and the Codex status wire, attributing observations to the effective binding; untrusted-trust-row upsert on first observation (I-028-2); per-leg status retention (`legs[]` + the aggregate rule, `unknown` ranked in the fixed order) keyed by the Plan-005 runtime-binding leg, with leg retirement on runtime-binding close (a terminated session's leg leaves the aggregate); the degraded inventory arm when the trust store is unreachable (`trustUnavailable: true`, trust-/override-dependent fields structurally absent, the key-derived `scopeRefDigest` still served); `mcp.server_status_changed` emission with per-event binding (the path-free audit ref — `scopeRefDigest`, never raw `scopeRef`; `origin: 'session_feed'` payloads carrying the observing leg's `bindingId`); the `mcp.subscribe` live-tail fan-out off the append path (registration live before first delivery — the I-007-10 ordering the gap-free subscribe-then-list handshake relies on).
3. **Phase 3 — Configuration mutation engines.** Claude: the unconditional durable leg (`claude mcp add-json` / `claude mcp remove` at user scope, write-verified before acknowledgment) + the capability probe (CLI ≥ `2.1.210` + SDK ≥ `0.3.166` + streaming mode) selecting the opportunistic live `setMcpServers` leg (full-set semantics, per-server error reconciliation) + the enabled overlay and composed-snapshot regeneration; Codex: `config/batchWrite` with `expected_version`, single silent retry, reload trigger, `mcp.config_write_conflict` on double conflict; validation-first ordering (`mcp.config_invalid` strictly pre-commit) with per-leg `liveResults[]` partial-outcome reporting; the two-phase `mcp_mutation_receipts` idempotency layer (`pending` intent committed before the provider leg; finalization + event set + store writes in one transaction; startup reconciliation of crash-window intents — the Plan-015 `command_receipts` precedent; replay / `mcp.idempotency_conflict`); `mcp.server_config_changed` emission with application grade and the removal-payload conditionality (I-028-3, I-028-4).
4. **Phase 4 — Trust, overrides, and Cedar gating.** Cedar `mcp` action family registration (CP-028-3); trust service (grant/revoke/drift-revoke over the keyed config-hash canonicalizer, hash-plus-projection: the excluded override-projection fields reconciled on every evaluation against the baseline-anchored expected state — `native_tool_baseline_json` snapshotted at grant or first materialization, governed portions re-asserted on divergence, ungoverned portions adopted, revocation rewriting weakening fields to baseline ⊕ surviving tightening facets); the drift-admission service at both CP-028-5 call sites — the Plan-004 `RunSetupGate` registration and the Plan-015 recovery-attach composition-root wiring with its production non-vacuous runtime assertion; override service with the safety-weakening-requires-trust rule (`mcp.trust_required`, the weakening set incl. `enabled: true`), baseline capture/restore on facet materialization and clear (a user's native entries survive a set → clear round-trip), and the per-operation scope-applicability matrix (Spec-028 §Configuration Mutation); the binding-keyed tool-metadata resolver overlay (CP-028-2 — the effective `McpServerBindingRef` carried through invocation and recovery resolution); `mcp.server_trust_changed` + `mcp.tool_override_changed` emission; retrofit Phases 2–3 handlers from the feature gate to full authorization (every mutating op deny-before-effect).
5. **Phase 5 — OAuth orchestration + client delivery.** `McpOauthOrchestrator` (Codex login flow + completion notification; Claude status-flip observation + out-of-band guidance path; the URL-free `mcp.oauthLogin` receipt representation per I-028-1; completion-event dedup — exactly once per observed completion, nothing for abandoned flows); `mcp.server_oauth_completed`; `mcp.reconnect`; client-sdk methods, CLI `ai-sidekicks mcp list/add/remove/trust/override/login/watch`, desktop panel hooks (reads + the `mcp.subscribe` stream over the Plan-023-partial bridge, CP-028-6); end-to-end acceptance sweep against Spec-028 §Acceptance Criteria.

## Parallelization Notes

- Phase 1 contracts and the migration are independent files — parallelizable within the phase.
- Phases 2 and 3 both depend on Phase 1 but not on each other (read path vs write path) — parallelizable as separate PRs after Phase 1 merges; both must merge before Phase 4 (which gates their handlers).
- Phase 5 is strictly after Phase 4 (OAuth and client surfaces assume authorization is live).
- The two provider adapters within any phase are parallel work units (no shared state beyond the service interfaces).

## Test And Verification Plan

- Unit: payload/DDL schema tests incl. the removal-payload conditionality (`configHash` absent + `previousConfigHash` required for `removed`), the `McpServerConfigInput` provider-conditional refinements, the binding-ref discriminated union (scopeRef forbidden/required per scope; `(codex, local)` rejected — typed validation, with the DDL CHECKs as the negative-control mirror), and the ≥ 1-facet override refinement; keyed base-config-hash canonicalization (reorder-stable, semantic-change-sensitive incl. secret-value drift, override-projection fields excluded, distinct bindings ⇒ distinct derived subkeys ⇒ distinct hashes for identical configs); audit-ref payload identity (`scopeRefDigest` present on project/local event payloads, raw `scopeRef` structurally absent from all five schemas; digest stable under the binding's derived subkey, distinct across bindings); `McpServerConfigView` redaction (env/header names round-trip, values structurally absent; the URL served query-redacted with query-parameter names, the full URL confined to the hash input); leg-status aggregation (severity ranking with `unknown` ranked between `needs-auth` and `starting`, node-probe fallback, no-source `unknown` floor, and retirement — a closed session's leg leaves `legs[]` and the aggregate recomputes); the degraded inventory arm (trust store unreachable → `trustUnavailable: true` with trust-/override-dependent fields structurally absent, provider-observed fields and the key-derived `scopeRefDigest` intact); status normalization maps (Claude `pending`/`disabled`, Codex `Starting|Ready|Failed|Cancelled` → `McpServerStatus`); trust state machine incl. revocation-neutralizes-weakening, the `enabled: true`-is-weakening rule, and the baseline lifecycle (snapshot at grant or first materialization — whichever first, never refreshed while held; dropped only untrusted-and-facet-free); resolver overlay floor semantics under trust flips.
- Integration (fixture-driven fake provider wires for both CLIs): full mutation matrix × {above-floor, below-floor} Claude with restart-durability assertions (an acknowledged mutation survives a daemon restart via the provider store); scope-collision fixtures (same `serverName` in two scopes — independent status/trust/overrides, no drift ping-pong); per-operation scope-applicability matrix (provider-config writes refuse non-user; `setTrust`/`idempotencyClass` succeed on an effective Codex project binding while its native-write facets refuse; Claude project/local governance refuses); Codex conflict-retry-once; drift auto-revoke ordering incl. native-field reversion; the drift-admission service (out-of-band edit → run start: revocation + neutralization complete pre-spawn, composed snapshot reflects post-drift state; a projection-field-only edit — unchanged base hash — revokes and reverts at the gate; the daemon-restart variant: edit-while-down processes drift before recovery adopts or resumes, via the Plan-015 attach-seam wiring, with the vacuous-default pass-through as the pre-Plan-028 negative control); idempotency (identical retry replays with zero provider calls/writes/events — asserted across a daemon restart; divergent key reuse fails `mcp.idempotency_conflict`; receipt prune at the 24 h bound; the `mcp.oauthLogin` receipt stores and replays a URL-free acknowledgment; the two-phase crash windows — pending intent with no provider effect expires at startup, pending intent with a durable provider write reconciles to a finalized receipt + exactly-once late event); unmodeled-field preservation (a Codex server table carrying fields the input does not model is byte-identical on them after an update); durable-success/live-failure partial outcomes (`applied: 'user_config_write'` + failing `liveResults[]` entry, never a post-commit error); two-session leg divergence (per-leg statuses + scoped `mcp.reconnect` — `{sessionId}` restarts that session's legs, `{bindingId}` exactly one leg); resolver-overlay two-scope disambiguation (same `serverName` in user + project bindings: each session's invocation resolves its own effective binding's override); `mcp.subscribe` live-tail delivery (governance + status envelopes, no replay before the acknowledgment) + the gap-free handshake (an event appended between the subscribe acknowledgment and the `mcp.list` read arrives on the stream); deny-before-effect per non-read op; one-event-set-per-mutation over the six governance mutations incl. retry paths and the revocation-batch assertion (trust event + per-facet reversion events, atomic, never re-emitted on replay), plus the reconnect no-event negative control and the `mcp.server_oauth_completed` exactly-once-per-observed-completion dedup (abandoned flow: no event, receipt expires; unobserved completion: the status transition is the surviving trace); native-baseline round-trip (a Codex user config with pre-existing `enabled_tools`/`tools.<t>.approval_mode` values survives override set → clear with the native values restored; revocation rewrites to baseline ⊕ surviving tightening facets); async OAuth completion failure delivered as the `outcome: 'failure'` event (launch failure keeps `mcp.oauth_flow_failed` reachable); required-server thread-start failure mapping.
- Adversarial-Tampering Boundary: credential-echo sweep over all five event payloads, ten error codes, the `McpServerConfigView`, receipt rows (the `mcp.oauthLogin` row URL-free), and logs (I-028-1); raw-`scopeRef` absence from every event payload (the audit-ref negative control); provider-file byte-identity after refused mutations (project-scope, Cedar-denied, trust-required, idempotency-conflict); spoofed `serverName` from the status seam stays `wireFreeFormString`-bounded (the Plan-005 twelve-string rule); canonicalization round-trip on the config-hash input; hash-brute-force negative control (no served or stored digest — `configHash`, `scopeRefDigest`, or a receipt `request_digest` — is reproducible or verifiable from a database copy alone: the master key and its derived subkeys never enter SQLite).
- CI-Pinned Tool Versions: provider fixtures name the wire pins they encode (`claude` `2.1.198` + version-anchored `2.1.210` floor behaviors; `codex-cli 0.141.0` + the `0.145.0` re-verification target); `gitleaks v8.30.1` per [ADR-023 §Axis 4 — Supply-Chain Hygiene](../decisions/023-v1-ci-cd-and-release-automation.md#axis-4--supply-chain-hygiene) on every PR.
- Manual: real-provider smoke on one machine per OS tier before Phase 5 completion (OAuth browser round-trip cannot be fixture-verified end to end).

## Implementation Phase Sequence

Plan-028 implementation lands as five PRs (one per phase). Each PR carries a `**Precondition:**` line so the merge order is reviewer-checkable. All five additionally gate on this plan's readiness audit (the unchecked §Preconditions box) — the audit will re-derive these phases into audit-grade `#### Tasks` blocks per the runbook.

### Phase 1 — Contracts + storage

**Precondition:** Plan-006 Phase 1 merged; Plan-007 Phase 2 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 6, phase: 1, status: merged }
  - { type: plan_phase, plan: 7, phase: 2, status: merged }
```

**Goal:** contracts + migration + registered-but-gated namespace compile, migrate, and round-trip; schema tests green. Satisfies the storage halves of I-028-1/I-028-2; stages CP-028-1/CP-028-4.

### Phase 2 — Inventory + status observation

**Precondition:** Phase 1 merged; Plan-005 Phase 3 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 1, status: merged }
  - { type: plan_phase, plan: 5, phase: 3, status: merged }
```

**Goal:** `mcp.list` / `mcp.get` serve the merged read model from both providers; status events flow with correct binding; first-observation trust rows appear untrusted. Satisfies CP-028-2(a) and the observation half of I-028-2.

### Phase 3 — Configuration mutation engines

**Precondition:** Phase 1 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 1, status: merged }
```

**Goal:** both mutation engines pass the fixture matrix with honest application grades; conflict and scope refusals surface the right codes; config events emit exactly once. Satisfies I-028-3 and the mutation half of I-028-4 (behind the Phase 4 authorization gate).

### Phase 4 — Trust, overrides, and Cedar gating

**Precondition:** Phase 2 merged; Phase 3 merged; Plan-012 Phase 2 merged; Plan-004 Phase 3 merged (the `RunSetupGate` seam the CP-028-5 drift gate registers against).

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 2, status: merged }
  - { type: plan_phase, plan: 28, phase: 3, status: merged }
  - { type: plan_phase, plan: 12, phase: 2, status: merged }
  - { type: plan_phase, plan: 4, phase: 3, status: merged }
```

**Goal:** every mutating operation is deny-before-effect; trust lifecycle incl. drift revocation is live; the resolver overlay moves the floor only under trust + authorization. Satisfies I-028-4, I-028-5, CP-028-2(b), CP-028-3.

### Phase 5 — OAuth orchestration + client delivery

**Precondition:** Phase 4 merged; Plan-023-partial renderer substrate (shipped Tier 1 — prose-only precondition per CP-028-6: shipped upstreams carry no YAML gate).

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 4, status: merged }
```

**Goal:** OAuth flows complete (or degrade honestly) on both providers; CLI + desktop surfaces ship; the Spec-028 §Acceptance Criteria sweep is green end to end. Satisfies I-028-1's flow-level verification.

## Rollout Order

1. Doc PR (this plan + Spec-028 + the Spec-006 B18 amendment — landed together, campaign W3).
2. Targeted readiness audit against the draft (the runbook's new-plan invocation path) → `draft → review` carrying the audit attestation; then `review → approved` as its own promotion, citing the same audit's REVIEW.md with review notes addressed.
3. Phases 1–5 as sequenced above, in tier order behind Tiers 1–6 execution.

## Rollback Or Fallback

- All three tables are additive and Plan-028-only — rollback of any phase is a revert plus (for Phase 1) a down-migration; no other plan reads or writes them.
- The `MethodRegistry` feature gate keeps `mcp.*` operations `not_implemented` until their backing phase, so a mid-sequence pause leaves no half-authorized surface.
- Provider-side state needs no rollback by construction: I-028-3 means the daemon's writes are always provider-valid config the operator could have made by hand.

## Risks And Blockers

- **Provider drift beyond the pins.** Codex stable is `0.145.0` vs the `0.141.0` pin; the config-method introduction versions are unresolvable from upstream docs (bounded ≥ `0.141.0`). Mitigation: the capability probe + re-verify-at-execution rule (Spec-028 §Implementation Notes) is a hard phase-entry step, not a hope.
- **MCP 2026-07-28 revision.** Lands mid-execution window; binds here only through provider releases (Spec-028 binds provider surfaces, not the MCP wire). Watch item, not a blocker.
- **Claude live-reconcile floor above the pin** (`2.1.210` > `2.1.198`): until the workstation pin advances, the live path is fixture-tested only and the next-run path is the real-machine default — honest per the application grade; the floor probe makes this self-correcting.
- **Readiness-audit scheduling.** The targeted audit (Preconditions box) is the promotion gate; it queues with the pending Tier 8–9 audit work per the README census.

## Progress Log

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human-readable commentary appended by the orchestrator at Phase E. -->

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
