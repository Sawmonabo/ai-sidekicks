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
| **Dependencies** | [Plan-005](./005-provider-driver-contract-and-capabilities.md) (driver seams: `onMcpServerStatus` producer, `driver_tools` metadata store, capability probe), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (event registry + append path; T1.10 registers the five `mcp.*` literals), [Plan-007](./007-local-ipc-and-daemon-control.md) (partial — `MethodRegistry` dispatch substrate), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (Cedar `PermissionCheckService`) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Deliver V1 feature #18: the daemon's MCP governance layer per [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) — unified server inventory, provider-native configuration mutation (Claude live-reconcile / next-run pair; Codex user-config CRUD + reload), the config-hash-bound trust store, tool-level overrides feeding the Plan-005 tool-metadata resolution layer, OAuth orchestration, normalized status observation, and the five-event `mcp_governance` audit surface — all Cedar-gated at node-operator scope.

## Scope

- `packages/contracts`: `mcp.*` operation payload schemas, the five `McpGovernanceEventPayload` schemas (emitter-authors-payload precedent — the type literals and category themselves are Plan-006-owned, registered by Plan-006 T1.10), error-code constants.
- `packages/runtime-daemon`: migration for `mcp_server_trust` + `mcp_tool_overrides`; the `McpGovernanceService` (inventory, trust, overrides), provider config adapters (Claude ephemeral-config composer + live-reconcile client; Codex config CRUD client), status normalizer consuming the Plan-005 `onMcpServerStatus` seam, OAuth orchestrator, Cedar `mcp` action family wiring, `mcp.*` `MethodRegistry` handlers.
- `packages/client-sdk` + CLI/desktop surfaces: typed `mcp.*` client methods; CLI `sidekicks mcp …` command group; desktop MCP panel data hooks.
- Doc mirrors: [api-payload-contracts.md §Plan-028 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-028--mcp-governance-contract-surfaces), [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance), [local-sqlite-schema.md §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028) (all landed with the B18 doc PR; code phases keep them true).

## Non-Goals

- Everything Spec-028 §Non-Goals excludes: no MCP protocol implementation or proxying, no token custody, no provider-config-store ownership, no server registry/marketplace, no remote governance mutation ([BL-141](../backlog.md) model is V1.1), no session-role matrix extension, no Codex project-local config writes.
- No new `ApprovalCategory` value — governance mutations are direct Cedar decisions, not interactive approvals.
- No emitter code for any non-`mcp.*` event literal minted by the Spec-006 B18 amendment (`session.*` / `run.*` / `usage.*` / `user.message` emitters belong to Plan-004 / Plan-005 per [Plan-006 §Event Taxonomy Coverage](./006-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)).

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-028 PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)).

### I-028-1 — No credential custody

The daemon never persists, logs, relays, or embeds in events/errors any OAuth token, authorization code, PKCE material, bearer-token value, or env-var value belonging to an MCP server. The only durable auth trace is the `mcp.server_oauth_completed` event (identity + outcome).

**Why load-bearing.** Token custody would put the daemon in the credential blast radius and contradict the provider-owned-auth posture Spec-028 §Non-Goals declares as a one-way-door refusal; Plan-022's PII/retention model assumes no credential columns exist.

**Verification.** Schema-level adversarial test sweeping all five event payload schemas + all nine error codes + both table DDLs for credential-shaped fields; integration test asserting OAuth flows leave no new rows beyond the completion event.

### I-028-2 — Untrusted by default; trust is hash-bound and drift-revoked

Every observed server gets a `trusted = 0` trust row on first observation; `trusted = 1` is reachable only via operator `mcp.setTrust`; a trusted server whose config hash diverges from the bound hash is auto-revoked (`revoked_reason = 'config_drift'`) before the changed config informs any decision surface.

**Why load-bearing.** This is the operator-managed trusted-server store ADR-015 binds the MCP annotation-trust MUST to; a default-trust or stale-hash path would let a mutated server inherit trust granted to a different configuration.

**Verification.** Unit tests over the trust service state machine (observe → grant → drift → re-grant); integration test mutating a trusted server's config between observations and asserting revocation precedes use.

### I-028-3 — Provider-sanctioned writes only

Configuration mutations go exclusively through each provider's sanctioned mechanism (Claude: `setMcpServers` live path or regenerated ephemeral `--mcp-config`; Codex: `config/value/write` / `config/batchWrite` at user scope with `expected_version`, followed by reload). The daemon never rewrites provider config files directly and never writes Codex project-local config.

**Why load-bearing.** Blind file rewrites race the provider's own writes, corrupt layered scopes, and break the inventory's source-of-truth model; Codex project-path writes are rejected upstream.

**Verification.** Integration tests asserting provider files are byte-identical after every daemon mutation except through the sanctioned path; the project-scope refusal test from Spec-028 §Acceptance Criteria.

### I-028-4 — Every governance mutation is Cedar-authorized and audited exactly once

Each of the eight mutating `mcp.*` operations evaluates the Cedar `mcp` action family before any provider call or store write, and every applied mutation emits its `mcp_governance` event exactly once (sentinel-bound for node-scope events per [Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring](../specs/006-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding-and-node-scope-anchoring)).

**Why load-bearing.** The audit trail is the governance feature — an unaudited mutation path is indistinguishable from tampering; authorization-after-mutation would be TOCTOU (the D-012-18 lesson).

**Verification.** Per-operation integration tests asserting deny-before-effect and one-event-per-mutation; event-count assertions on retry paths (the Codex conflict retry must not double-emit).

### I-028-5 — The idempotency floor moves only through governed override

MCP-sourced tools resolve to `manual_reconcile_only` unless an `mcp_tool_overrides` row assigns `idempotent` / `compensable`; assignment requires a trusted server and Cedar authorization; the resolution layer (Plan-005's) is the only reader — downstream consumers never read the override table directly.

**Why load-bearing.** [Spec-005 §Tool Metadata](../specs/005-provider-driver-contract-and-capabilities.md#tool-metadata) makes the conservative floor the safety spine of Spec-015 recovery; an ungoverned or untrusted path off it would let recovery replay non-idempotent tools.

**Verification.** Resolver unit tests (floor absent override; override applied; override ignored when trust revoked mid-session); the `mcp.trust_required` acceptance test.

## Cross-Plan Obligations

### CP-028-1 — Event registration rides Plan-006 T1.10

The five `mcp.*` event literals and the `mcp_governance` category are Plan-006-owned registry surface, registered by [Plan-006 §Event Taxonomy Coverage](./006-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)'s T1.10 census-closure task (authored with this plan in the 2026-07-22 B18 PR). Plan-028 authors the payload schemas (emitter-authors-payload precedent, the Plan-012 `ApprovalFlowEventPayloadSchema` shape) and MUST NOT add the literals to `packages/contracts/src/event.ts` itself.

**Resolution.** Plan-006 Phase 1 (T1.1–T1.10) merges before Plan-028 Phase 1; the Phase 1 precondition below enforces it.

### CP-028-2 — Plan-005 seam consumption (status producer + tool-metadata resolution)

Plan-028 is the declared consumer of two Plan-005 surfaces: (a) the B10 `onMcpServerStatus` producer seam (`McpServerStatusEmission` → `McpServerStatusUpdate`; Plan-005 records "the consumer lands with Spec-028/B18"), consumed by the Phase 2 status normalizer; (b) the tool-metadata resolution layer over the `driver_tools` store, which Phase 4 extends with the `mcp_tool_overrides` overlay — Plan-028 EXTENDs the resolver's inputs through Plan-005's seam, never Plan-005's owned symbols directly.

**Resolution.** Plan-005 Phase 3 merged is the Phase 2 precondition; the overlay lands as a Plan-028-owned decorator around the Plan-005 resolver surface in Phase 4. Reciprocal Plan-005 return-cite: its `onMcpServerStatus` consumer note names Plan-028 (trued in the same B18 PR).

### CP-028-3 — Cedar `mcp` action family via Plan-012's policy surface

Plan-028 consumes `PermissionCheckService` and registers the `mcp` Cedar action family through the Plan-012 `policy/` services — the same consumer pattern as Plan-017's Cedar policy reuse in Plan-012's CP-012-4. No Plan-012-owned symbol is modified; the action family is additive policy-module registration.

**Resolution.** Plan-012 Phase 2 merged is the Phase 4 precondition; the Plan-012 return-cite (its CP-012-4 consumer enumeration) is owed at Plan-028's readiness audit per that clause's consumer-registration pattern.

### CP-028-4 — `mcp.*` namespace registration against the Plan-007 substrate

The ten `mcp.*` operations register against `MethodRegistry.register()` (`packages/contracts/src/jsonrpc-registry.ts`, shipped Tier 1) at this plan's tier — the Plan-007 CP-007-3 late-namespace pattern (`presence.*` precedent: namespace owners register at their own tier against the stable substrate).

**Resolution.** Plan-007 Phase 2 merged is the Phase 1 precondition; the handlers land in Phase 2–5 as each operation's backing service exists. Plan-007 return-cite owed at Plan-028's readiness audit.

## Preconditions

- [ ] Paired spec is approved — [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) is at `review`; promotion is the campaign's W3 gate after the Spec-006 census amendment restores
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred (the Codex thread-config question is explicitly deferred, non-blocking, per Spec-028 §Open Questions)
- [ ] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Plan-028 joins Tier 7 after that tier's audit (PR #160) closed, so it requires a targeted readiness-audit pass (the Plan-014-delta shape) before any code PR; this is the gate that promotes this plan `draft → review`

## Target Areas

- `packages/contracts/src/mcp-governance.ts` (CREATE) — operation payload schemas, event payload schemas, error-code consts, `McpApplicationGrade` (`live_reconcile | next_run | user_config_write`), override facet types.
- `packages/runtime-daemon/src/mcp/` (CREATE) — `McpGovernanceService`, `McpInventoryService`, provider adapters (`claudeMcpConfigAdapter`, `codexMcpConfigAdapter`), `McpStatusNormalizer`, `McpOauthOrchestrator`, trust + override stores, config-hash canonicalizer (BLAKE3 over RFC 8785 JCS — reusing the Plan-006 canonicalization substrate).
- `packages/runtime-daemon/src/policy/` (EXTEND via Plan-012's policy-module surface) — `mcp` Cedar action family registration (CP-028-3).
- `packages/runtime-daemon` migration `NNNN_mcp_governance.sql` (CREATE) — the two tables per [local-sqlite-schema.md §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028).
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND) — the `mcp.*` namespace handler files per CP-028-4.
- `packages/client-sdk/src/mcpClient.ts` (CREATE) + the package-root barrel line — typed `mcp.*` client methods.
- `apps/desktop/src/renderer/src/mcp-governance/` (CREATE) — MCP panel views over the SDK surface.
- `apps/cli/src/commands/` `mcp-*.ts` (CREATE) + the `main.ts` `.register()` EXTENDs — the `sidekicks mcp` command group (exact per-subcommand filenames pinned at the targeted readiness audit).

## Data And Storage Changes

- `mcp_server_trust` — `(provider, server_name)` PK; `trusted` INTEGER; `config_hash` TEXT `CHECK(config_hash GLOB 'b3:*')`; grant/revoke provenance columns. Owner: Plan-028 (CREATE).
- `mcp_tool_overrides` — `(provider, server_name, tool_name)` PK; nullable facets `enabled` / `approval_mode` / `idempotency_class`; FK-cascade to the trust row. Owner: Plan-028 (CREATE).
- SQLite census 52 → 54 (applied with the B18 doc PR; the migration lands in Phase 1).
- Events append through the Plan-006 `EventLogService` path — no bespoke audit storage.

## API And Transport Changes

- Ten `mcp.*` JSON-RPC operations (`mcp.list`, `mcp.get`, `mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setTrust`, `mcp.setToolOverride`, `mcp.clearToolOverride`, `mcp.oauthLogin`, `mcp.reconnect`) registered per CP-028-4; typed mirrors in [api-payload-contracts.md §Plan-028 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-028--mcp-governance-contract-surfaces).
- Five `mcp_governance` events (registered via CP-028-1); nine `mcp.*` error codes per [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance).
- Provider wire consumption: Claude `setMcpServers` / `toggleMcpServer` / `reconnectMcpServer` / `mcpServerStatus` (SDK) + ephemeral `--mcp-config` / `--strict-mcp-config`; Codex `config/read` / `config/value/write` / `config/batchWrite` / `config/mcpServer/reload` / `mcpServer/refresh` / `mcpServerStatus/list` / `mcpServer/oauth/login` (+ `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed` notifications). All floors capability-probed at spawn and re-verified against then-installed binaries per the [provider-wire trust model](../reference/provider-wire/README.md).

## Implementation Steps

1. **Phase 1 — Contracts + storage.** Author `packages/contracts/src/mcp-governance.ts` (operation + event payload schemas, error consts, grades, facets; `--isolatedDeclarations`-clean); the two-table migration; wire the error codes into the daemon error substrate. Register the ten method names + schemas against `MethodRegistry` with `not_implemented` handlers behind a feature gate so the namespace shape ships reviewable before behavior.
2. **Phase 2 — Inventory + status observation.** Provider config readers (Claude `~/.claude.json` scopes + `.mcp.json` + ephemeral-set records; Codex `config/read` with layer attribution incl. project-local read-only rows); `McpInventoryService.list/get` merging config + status + trust + overrides; `McpStatusNormalizer` consuming the Plan-005 `onMcpServerStatus` seam and the Codex status wire; untrusted-trust-row upsert on first observation (I-028-2); `mcp.server_status_changed` emission with per-event binding.
3. **Phase 3 — Configuration mutation engines.** Claude: capability probe (CLI ≥ `2.1.210` + SDK ≥ `0.3.166` + streaming mode) selecting live `setMcpServers` (full-set semantics, per-server error reconciliation) vs next-run ephemeral-config regeneration; Codex: `config/batchWrite` with `expected_version`, single silent retry, reload trigger, `mcp.config_write_conflict` on double conflict; `mcp.server_config_changed` emission with application grade (I-028-3, I-028-4).
4. **Phase 4 — Trust, overrides, and Cedar gating.** Cedar `mcp` action family registration (CP-028-3); trust service (grant/revoke/drift-revoke over the config-hash canonicalizer); override service with the safety-weakening-requires-trust rule (`mcp.trust_required`); the tool-metadata resolver overlay (CP-028-2); `mcp.server_trust_changed` + `mcp.tool_override_changed` emission; retrofit Phases 2–3 handlers from the feature gate to full authorization (every mutating op deny-before-effect).
5. **Phase 5 — OAuth orchestration + client delivery.** `McpOauthOrchestrator` (Codex login flow + completion notification; Claude status-flip observation + out-of-band guidance path); `mcp.server_oauth_completed`; `mcp.reconnect`; client-sdk methods, CLI `sidekicks mcp list/add/remove/trust/override/login`, desktop panel hooks; end-to-end acceptance sweep against Spec-028 §Acceptance Criteria.

## Parallelization Notes

- Phase 1 contracts and the migration are independent files — parallelizable within the phase.
- Phases 2 and 3 both depend on Phase 1 but not on each other (read path vs write path) — parallelizable as separate PRs after Phase 1 merges; both must merge before Phase 4 (which gates their handlers).
- Phase 5 is strictly after Phase 4 (OAuth and client surfaces assume authorization is live).
- The two provider adapters within any phase are parallel work units (no shared state beyond the service interfaces).

## Test And Verification Plan

- Unit: payload/DDL schema tests; config-hash canonicalization (reorder-stable, semantic-change-sensitive); status normalization maps (Claude `pending`/`disabled`, Codex `Starting|Ready|Failed|Cancelled` → `McpServerStatus`); trust state machine; resolver overlay floor semantics.
- Integration (fixture-driven fake provider wires for both CLIs): full mutation matrix × {above-floor, below-floor} Claude; Codex conflict-retry-once; drift auto-revoke ordering; deny-before-effect per mutating op; one-event-per-mutation incl. retry paths; required-server thread-start failure mapping.
- Adversarial-Tampering Boundary: credential-echo sweep over all five event payloads, nine error codes, and logs (I-028-1); provider-file byte-identity after refused mutations (project-scope, Cedar-denied, trust-required); spoofed `serverName` from the status seam stays `wireFreeFormString`-bounded (the Plan-005 twelve-string rule); canonicalization round-trip on the config-hash input.
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

**Precondition:** Phase 2 merged; Phase 3 merged; Plan-012 Phase 2 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 2, status: merged }
  - { type: plan_phase, plan: 28, phase: 3, status: merged }
  - { type: plan_phase, plan: 12, phase: 2, status: merged }
```

**Goal:** every mutating operation is deny-before-effect; trust lifecycle incl. drift revocation is live; the resolver overlay moves the floor only under trust + authorization. Satisfies I-028-4, I-028-5, CP-028-2(b), CP-028-3.

### Phase 5 — OAuth orchestration + client delivery

**Precondition:** Phase 4 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 4, status: merged }
```

**Goal:** OAuth flows complete (or degrade honestly) on both providers; CLI + desktop surfaces ship; the Spec-028 §Acceptance Criteria sweep is green end to end. Satisfies I-028-1's flow-level verification.

## Rollout Order

1. Doc PR (this plan + Spec-028 + the Spec-006 B18 amendment — landed together, campaign W3).
2. Targeted readiness audit → this plan `draft → review → approved`.
3. Phases 1–5 as sequenced above, in tier order behind Tiers 1–6 execution.

## Rollback Or Fallback

- Both tables are additive and unreferenced until Phase 4 — rollback of any phase is a revert plus (for Phase 1) a down-migration; no other plan writes them.
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
