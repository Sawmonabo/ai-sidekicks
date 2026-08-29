# Plan-028: MCP Server Configuration and Governance

| Field | Value |
| --- | --- |
| **Status** | `approved` |
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
- `packages/client-sdk` + CLI/desktop surfaces: typed `mcp.*` client methods; CLI `sidekicks mcp …` command group (the Plan-007 registered bin name); desktop MCP panel data hooks over `mcp.list`/`mcp.get` + the `mcp.subscribe` stream.
- Doc mirrors: [api-payload-contracts.md §Plan-028 — MCP Governance Contract Surfaces](../architecture/contracts/api-payload-contracts.md#plan-028--mcp-governance-contract-surfaces), [error-contracts.md §MCP Governance](../architecture/contracts/error-contracts.md#mcp-governance), [local-sqlite-schema.md §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028) (all landed with the B18 doc PR; code phases keep them true).

## Non-Goals

- Everything Spec-028 §Non-Goals excludes: no MCP protocol implementation or proxying **on the governed plane** (the daemon's own ephemeral callback-tool host of `Spec-005 §Required Behavior` sits outside this governance model and is never trusted, drift-evaluated, or override-governed), no token custody, no provider-config-store ownership, no server registry/marketplace, no remote governance mutation (the relayed-caller authorization model is a V1.1 ADR trigger per `Spec-028 §ADR Triggers`), no session-role matrix extension, no Codex project-local config writes.
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

Each of the eight non-read `mcp.*` operations (of the eleven; `mcp.list`/`mcp.get`/`mcp.subscribe` are the reads) evaluates the Cedar `mcp` action family before any provider call or store write, and each of the **six governance mutations** (`mcp.upsertServer`, `mcp.removeServer`, `mcp.setEnabled`, `mcp.setTrust`, `mcp.setToolOverride`, `mcp.clearToolOverride`) emits its defined `mcp_governance` event set exactly once — a single event for most mutations; a weakening-facet trust revocation appends its atomic batch, the trust event plus one `mcp.tool_override_changed` per reverted facet (sentinel-bound for node-scope events per [Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring](../specs/006-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding-and-node-scope-anchoring)) — exactly-once made durable by the mandatory `clientIdempotencyKey` + the **two-phase** `mcp_mutation_receipts` (a `pending` intent commits before the provider leg; finalization, store writes, and the event set commit in one SQLite transaction; startup reconciliation completes any crash-window intent so a durable provider write is never left unaudited — the Plan-015 `command_receipts` discipline; an identical retry replays the receipt, a divergent reuse fails `mcp.idempotency_conflict`, and neither re-emits). The two Cedar-gated operational commands sit outside the atomic mutation set (Spec-028 §Authorization): `mcp.reconnect` changes no store or config and audits through the `mcp.server_status_changed` transitions it induces; `mcp.oauthLogin` is receipted but its durable trace — `mcp.server_oauth_completed` — is provider-asynchronous and cannot commit with the launch acknowledgment, so it is emitted exactly once per **observed** completion (an abandoned or unobserved flow leaves only the expiring receipt, the auth outcome still surfacing via the next status transition).

**Why load-bearing.** The audit trail is the governance feature — an unaudited mutation path is indistinguishable from tampering; authorization-after-mutation would be TOCTOU (the D-012-18 lesson).

**Verification.** Per-operation integration tests asserting deny-before-effect and one-event-set-per-mutation (incl. the revocation-batch count); event-count assertions on retry paths (the Codex conflict retry must not double-emit) and the crash-window reconciliation fixture (durable provider write + lost finalization → startup appends the event exactly once).

### I-028-5 — The idempotency floor moves only through governed override

MCP-sourced tools resolve to `manual_reconcile_only` unless an `mcp_tool_overrides` row assigns `idempotent` / `compensable`; assignment requires a trusted server and Cedar authorization; the resolution layer (Plan-005's) is the only reader — downstream consumers never read the override table directly.

**Why load-bearing.** [Spec-005 §Tool Metadata](../specs/005-provider-driver-contract-and-capabilities.md#tool-metadata) makes the conservative floor the safety spine of Spec-015 recovery; an ungoverned or untrusted path off it would let recovery replay non-idempotent tools.

**Verification.** Resolver unit tests (floor absent override; override applied; override ignored when trust revoked mid-session); the `mcp.trust_required` acceptance test.

### I-028-6 — Trust revocation neutralizes the durable surface, not only the live one

A trust revocation — operator-initiated or drift-driven — rewrites every non-terminal `command_receipts` row stamped with the revoked binding's `mcp_binding_digest` to the `manual_reconcile_only` floor, inside the revocation's own transaction. Recovery keeps dispatching on the stamped `idempotency_class` and never re-resolves an override. **The digest is keyed, so its key is part of this invariant.** `mcp_binding_digest` is a keyed BLAKE3 over the binding tuple, and a revocation matches receipts by recomputing that digest — so if the binding-identity subkey becomes unavailable (host re-key, keystore loss, a restore onto a host whose governance master key differs), the daemon can no longer prove which stamped receipts a revocation covers. In that state it MUST neutralize **every** non-terminal receipt carrying a non-`NULL` `mcp_binding_digest` to the `manual_reconcile_only` floor, and refuse to stamp new digests until a key is available. Unmatchable is treated as revoked, never as untouched: the alternative leaves `compensable` receipts dispatching under an authority the daemon can no longer even identify.

**Why load-bearing.** I-028-5 moves the floor only while trust holds, but the floor is _stamped_ into a durable row at accept time, and [Spec-015](../specs/015-persistence-recovery-and-replay.md) recovery dispatches on that stamp with no session to re-resolve against. Without this, a receipt stamped `compensable` under a trust revoked minutes later would be auto-compensated by a post-crash recovery under an authority that no longer exists — a governed weakening outliving its governance, which is the failure I-028-5 exists to prevent, displaced in time. Neutralizing inside the revocation's transaction is what keeps the durable and live surfaces agreeing at every instant; the alternative — having recovery re-resolve — is precisely the re-resolution Spec-015's dispatch contract forbids, and would also be impossible, since the binding's scope is a session-scoped fact recovery does not have.

**Verification.** A revoke-then-recover integration fixture **per entry point** (operator `mcp.setTrust` to untrusted; drift auto-revoke): stamp a `compensable` receipt, revoke, kill the daemon, recover, and assert the tool halts at the floor instead of compensating. A transactional-atomicity test asserting a revocation that fails after the trust write leaves no receipt rewritten and no event appended. A negative control asserting terminal receipts and `NULL`-digest receipts are untouched by either entry. A key-loss fixture: stamp a `compensable` receipt, make the binding-identity subkey unavailable, restart, and assert every non-terminal digest-bearing receipt is at the floor and that a new tool acceptance refuses to stamp rather than writing an unverifiable digest.

## Cross-Plan Obligations

### CP-028-1 — Event registration rides Plan-006 T1.10

The five `mcp.*` event literals and the `mcp_governance` category are Plan-006-owned registry surface, registered by [Plan-006 §Event Taxonomy Coverage](./006-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage)'s T1.10 census-closure task (authored with this plan in the 2026-07-22 B18 PR). Plan-028 authors the payload schemas (emitter-authors-payload precedent, the Plan-012 `ApprovalFlowEventPayloadSchema` shape) and MUST NOT add the literals to `packages/contracts/src/event.ts` itself.

**Resolution.** Plan-006 T1.10 — the census-closure task this obligation rides, shipped 2026-07-25 via PR #247 — merges before Plan-028 Phase 1; the phase-scoped precondition below enforces it (Plan-006 Phase 1's declared set grew to T1.1–T1.12 on 2026-08-01 via the T4.10 targeted readiness-audit delta, and that T1.11/T1.12 remainder shipped 2026-08-03, closing the declared set — so the declared-⊆-shipped gate resolves Phase 1 merged).

### CP-028-2 — Plan-005 seam consumption (status producer + tool-metadata resolution)

Plan-028 is the declared consumer of two Plan-005 surfaces: (a) the B10 `onMcpServerStatus` producer seam (`McpServerStatusEmission` → `McpServerStatusUpdate`; Plan-005 records "the consumer lands with Spec-028/B18"), consumed by the Phase 2 status normalizer; (b) the tool-metadata resolution layer over the `driver_tools` store, which Phase 4 extends with the `mcp_tool_overrides` overlay — Plan-028 reads that store's resolution output, never Plan-005's owned symbols directly. The overlay is **binding-keyed**: the Plan-005 store resolves by `(driver_name, tool_name)`, which cannot disambiguate the same `serverName` bound in two scopes, so the Plan-028-owned overlay keys its lookup by the full `McpServerBindingRef` plus `toolName`. Plan-005 exposes no named resolver service — `Spec-005 §Tool Metadata` states the floor as a rule over the `driver_tools` store — so the overlay is a Plan-028-owned module reading that store's output, never a decorator over a Plan-005 symbol. The **effective binding** the lookup needs was originally expected to arrive as a carrier from Plan-005 or Plan-015; neither declares one, and neither is needed. Since 2026-08-26 (§6 node NS-86) the binding is **derived in-plan** by T28.4.11 from the post-drift composed snapshot T28.4.6 already builds, and the recovery-receipt surface is served by the stamped `command_receipts.mcp_binding_digest` under CP-028-7 / I-028-6 rather than by re-resolution, which `Spec-015 §Required Behavior` forbids. The §Preconditions box that held T28.4.9 is discharged and that task is dispatch-eligible on Phase 4's ordinary gates.

**Resolution.** Plan-005 Phase 3 merged is the Phase 2 precondition; the overlay lands as a Plan-028-owned decorator around the Plan-005 resolver surface in Phase 4. Reciprocal Plan-005 return-cite: its `onMcpServerStatus` consumer note names Plan-028 (trued in the same B18 PR).

### CP-028-3 — Cedar `mcp` action family via Plan-012's policy surface

Plan-028 consumes `PermissionCheckService` and registers the `mcp` Cedar action family through the Plan-012 `policy/` services — the same consumer pattern as Plan-017's Cedar policy reuse in Plan-012's CP-012-4. No Plan-012-owned symbol is modified; the action family is additive policy-module registration.

**Resolution.** Plan-012 Phase 2 merged is the Phase 4 precondition; the Plan-012 return-cite (its CP-012-4 consumer enumeration) landed at this plan's 2026-08-12 targeted readiness audit per that clause's consumer-registration pattern.

### CP-028-4 — `mcp.*` namespace registration against the Plan-007 substrate

The eleven `mcp.*` operations register against `MethodRegistry.register()` (`packages/contracts/src/jsonrpc-registry.ts`, shipped Tier 1) at this plan's tier — the Plan-007 CP-007-3 late-namespace pattern (`presence.*` precedent: namespace owners register at their own tier against the stable substrate); `mcp.subscribe` additionally rides Plan-007's streaming primitive (the `session.subscribe` long-lived consumer shape).

**Resolution.** Plan-007 Phase 2 merged is the Phase 1 precondition; the handlers land in Phase 2–5 as each operation's backing service exists. The Plan-007 return-cite (the CP-007-3 heading + registry-surface enumeration) landed at this plan's 2026-08-12 targeted readiness audit.

### CP-028-5 — Drift admission at run start (Plan-004 `RunSetupGate`) and recovery attach (Plan-015 seam)

The Spec-028 §Trust Governance drift gate is one Plan-028-owned admission service — fresh provider-config read, keyed base-config hash recompute, projection-field reconciliation against the baseline-anchored expected native state, and full drift processing (auto-revocation + weakening neutralization incl. Codex native-field re-assertion) — invoked from **two admission points**. (a) Run/thread starts: registered through Plan-004's `RunSetupGate` registration seam (`{ assertRunReady, onRunTerminal? }`, the ordered gate array on `run-engine.ts` per CP-004-8) — a registration call, never an edit to Plan-004's owned files (the CP-010-9 precedent); `assertRunReady` completes drift processing before the run leaves `starting`, and the Claude composed snapshot is then built from the post-drift state. (b) Daemon-restart recovery: Plan-015's startup attach sequence — adoption and cold resume alike — invokes the same service through the vacuous-default admission seam on `startup-recovery-service.ts` (T15.3's B18 clause) before any `resumeSession` dispatch; Plan-028's Phase 4 ships the **composition-root wiring** that replaces the vacuous default with the real service (the Plan-004 T3.14 `RollbackAttributionSource` composition-root precedent), plus the runtime assertion that a production daemon carrying Plan-028 never constructs recovery with the vacuous default. Before Plan-028 ships, the vacuous default is honest — no trust store exists, so there is no drift to process.

**Resolution.** Plan-004 Phase 3 merged is the Phase 4 precondition (the gate lands with the trust machinery it enforces); the Plan-015 seam is order-independent (vacuous until Plan-028's wiring lands — whichever plan executes first, the composed behavior activates once both have shipped, enforced by the Phase-4 runtime assertion). Both reciprocals are in place: Plan-015 T15.3's B18 clause names this obligation, and Plan-004's CP-004-8 extender enumeration was trued at this plan's 2026-08-12 targeted readiness audit.

### CP-028-6 — Renderer substrate via Plan-023-partial

The Phase 5 desktop MCP panel views consume daemon state only via the `window.sidekicks` bridge over the Plan-023-partial renderer substrate (shipped Tier 1; live bridge verification at Plan-023 Tier 8) — the [Plan-016 §Cross-Plan Obligations](./016-multi-agent-channels-and-orchestration.md#cross-plan-obligations) CP-016-11 renderer-bridge pattern. **Tasks:** T28.5.7.

**Resolution.** Declared in the plan header; Phase 5's precondition names it. No YAML gate: the substrate shipped with Tier 1, so the machine-checkable preconditions carry only unshipped upstreams.

### CP-028-7 — `command_receipts.mcp_binding_digest` EXTEND (Plan-004 owner)

Plan-028 EXTENDs the Plan-004-owned `command_receipts` table with one additive nullable column, `mcp_binding_digest`, carrying the governed binding a receipt's tool resolved from as a path-free keyed digest — the durable half of I-028-6. This follows the table's established EXTEND pattern exactly: Plan-015 added the BL-051 two-phase columns and Plan-005 added the additive nullable `mcp_task_id`, each under its **own** migration and neither editing a Plan-004 migration. The column is written from the same Plan-028 resolution output that already supplies `idempotency_class` to the receipt write, so no new write seam is introduced and no Plan-004-owned or Plan-015-owned file is modified. No [§Lock Ordering Across Shared Tables](../architecture/cross-plan-dependencies.md#lock-ordering-across-shared-tables) row is owed: every registrant there locks control-plane Postgres rows, whereas `command_receipts` and the `mcp_*` tables are local SQLite, whose single-writer transactions cannot deadlock across plans.

**Resolution.** Registered on the [cross-plan-dependencies.md §1](../architecture/cross-plan-dependencies.md#1-table-ownership-map) `command_receipts` contested-table row (Plan-028 joins Plan-015 and Plan-005 as an extender) and on the [local SQLite schema](../architecture/schemas/local-sqlite-schema.md) `command_receipts` block, both in the 2026-08-26 swap. Plan-004's Status does not move: the reciprocal is an extender-list entry on a table it owns — the [CP-007-15 consumer-row precedent](./007-local-ipc-and-daemon-control.md#cross-plan-obligations) for an obligation that rides ownership rows rather than minting a reciprocal into the owner. The column lands with Plan-028's own Phase 4 migration, after Plan-004 Phase 1 has CREATEd the table — the same ordering Plan-005's `mcp_task_id` EXTEND already carries.

### CP-028-8 — MCP-governance settings page authored here, mounted by [Plan-023](./023-desktop-shell-and-renderer.md) (reciprocal of CP-023-7)

`Spec-028 §The operator surface` names the settings-level MCP Servers page and `Spec-023 §Signature Feature Composition Sketches` sketches it. The split is the NS-73 one, unchanged: **this plan authors** the page's components and their projection in its own `apps/desktop/src/renderer/src/mcp-governance/` subtree (T28.5.7, EXTENDed 2026-08-29 from panel views to the full page), and **Plan-023 mounts** that subtree into the renderer shell's settings surface and router at its Phase 6, owning nothing inside it. The reason the split runs this way rather than the reverse is the fail-closed-projection rule: the page must derive no trust state and no effective idempotency class of its own, and an eligibility projection authored in the shell — away from the plan that owns the governance rules and their drift semantics — is exactly how a second source of truth for those decisions gets written. This is distinct from CP-028-6, which is the substrate obligation (the `window.sidekicks` bridge these components read through); CP-028-8 is the mount-point obligation.

**Resolution.** Registered 2026-08-29 with the reciprocal at Plan-023 CP-023-7 in the same swap. Plan-023 gains no task — the mount is a route-table plus settings-slot registration of the shape its Phase 6 already performs for every plan-owned subtree — and this plan's dispatch order is unchanged: T28.5.7 already sits in Phase 5 and already carries the Plan-023-partial substrate as its prose-only precondition. No YAML gate is added; a page mounted before Plan-023's Tier-8 shell exists is not a hazard the DAG needs to encode, because the components are unreachable rather than wrong.

## Preconditions

- [x] Paired spec is approved — [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) promoted `approved` 2026-07-22 via the campaign's W3 gate (PR #246), after the Spec-006 census-amendment restoration (PR #245) **Re-opened and re-checked in one swap 2026-08-26 (live-reconcile deferral ruled):** Spec-028 flipped `approved → review` under the audit runbook's spec-amendment rule for the §Fallback Behavior re-scoping (the "below the live-reconcile floor" arm re-selected by probe refusal rather than by a version comparison) and the §Implementation Notes re-verify-at-execution narrowing, and is restored `approved` by this plan's targeted readiness-audit delta riding this same diff ([cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-85); this plan flips with it and is likewise restored. The delta audits exactly that growth against T28.3.2 — which probed rather than version-sniffed as authored, so no task body changes behavior — and mints **no** born-unchecked box. **Re-opened 2026-08-29** by the desktop-console parity amendment, scoped to `Spec-028 §The operator surface` and the T28.5.7 page growth; **re-checked in the same diff** by its targeted readiness-audit delta ([cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-93).
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred (the Codex thread-config question is explicitly deferred, non-blocking, per Spec-028 §Open Questions)
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Plan-028 joins Tier 7 after that tier's audit (PR #160) closed, so it takes the runbook's new-plan invocation path (targeted, the Plan-014-delta shape): the audit runs against this `draft`, its pass ticks this box and gates `draft → review`, and the subsequent `review → approved` promotion cites the same audit's REVIEW.md once review notes are addressed — no code PR before both promotions complete. **Delivered 2026-08-12** — the targeted readiness audit ran against the `draft` and ticked this box in the same swap as `draft → review`; registered as [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-61 (born-`completed`). Ledger: 14 findings — 2 critical (F-028-01, no `#### Tasks` block at any Phase → the five audit-grade blocks under §Implementation Phase Sequence, 43 tasks; F-028-02, the CP-028-2(b) effective-binding carrier unowned → the born-unchecked scoped box below, holding T28.4.9 alone), 5 major, 7 minor — every finding repaired in the same swap. The `review → approved` promotion remains its own PR, citing this audit's REVIEW.md once review notes are addressed. (Discharged 2026-08-14 by PR #330 — review notes addressed: all 14 findings were repaired in the audit swap itself and the audit PR merged with no further reviewer notes; Status promoted `review → approved` citing that REVIEW.md, so both promotions this box requires are complete and code dispatch rides tier order plus this section's remaining boxes.) **Re-opened and re-checked in one swap 2026-08-26, scoped to the live-reconcile ruling:** the amendment adds no task, no invariant, and no obligation of this plan's own — it records the collapse of a deferral's version premise on T28.3.2's `Consumes:` line, re-scopes one §Risks And Blockers bullet from a deferral to a resolution, and re-points two pin restatements at the provider-wire reference family. The restoring targeted readiness-audit delta is taken **in this same PR** against exactly that growth (the 2026-08-18 self-audit shape); every task the 2026-08-12 audit certified stays audit-covered, and the one cross-plan datum the ruling names — Plan-005's driver-spawn capability-probe result — is now registered as **CP-005-11** on the producing side, closing a consumption this task declared against no obligation. **Re-opened and re-checked in one swap 2026-08-26 again, scoped to the effective-binding discharge ([cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-86):** this swap grows the audited surface by one task and one invariant — T28.4.11 and I-028-6, the durable half of revocation-neutralization — so the box is re-opened rather than left standing on the 2026-08-12 certification, and re-checked by the targeted readiness-audit delta riding the same diff, which audits exactly that growth. The carrier box below is discharged in the same swap. **Re-opened 2026-08-29** by the desktop-console parity amendment, scoped to `Spec-028 §The operator surface` and the T28.5.7 page growth; **re-checked in the same diff** by its targeted readiness-audit delta ([cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-93).
- [x] **Effective-binding carrier registered for the tool-metadata overlay** — CP-028-2(b) requires the session's effective `McpServerBindingRef` to travel with a tool through invocation and recovery-receipt resolution, but no upstream plan declares that carrier: Plan-005's `driver_tools` store keys `(driver_name, tool_name)` and its status seam carries the _runtime-binding leg_ (`sessionId` + `bindingId`), a different grain (Spec-028 §Unified Inventory); Plan-015's recovery path dispatches on `command_receipts.idempotency_class`, stamped at dispatch time. This box holds **T28.4.9** only — every other Phase-4 task is dispatch-eligible (born unchecked at the 2026-08-12 targeted readiness audit). **Re-specified and Delivered 2026-08-26** ([cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-86): the box was authored expecting one carrier threaded through two surfaces, and the two surfaces turned out to need different things, so its criterion is restated as what actually closes each. (i) On the **invocation** surface no carrier is needed at all: the effective binding is a pure function of the post-drift composed-config snapshot **this plan already builds** at T28.4.6, so **T28.4.11** derives it in-plan rather than importing it — the box is met by making the carrier unnecessary, not by registering one (the NS-64 precedent). (ii) On the **receipt-resolution** surface a carrier would not have helped: recovery runs with no session, and re-resolution is precisely what Spec-015 forbids — so the binding's identity is **stamped** at receipt write as the path-free `command_receipts.mcp_binding_digest`, riding the same Plan-028 resolution output that already supplies `idempotency_class`, and trust revocation rewrites every non-terminal receipt of the revoked binding to the floor inside its own transaction (**I-028-6**, **CP-028-7**). Plan-015's recovery contract is unchanged — it still dispatches on the stamped class, which is now guaranteed current rather than merely current-at-stamp-time. **T28.4.9 is released**

## Target Areas

- `packages/contracts/src/mcp-governance.ts` (CREATE) — operation payload schemas (incl. the `McpServerConfigInput` transport-discriminated union with provider-conditional refinements and the Codex auth references `envHttpHeaders`/`oauthScopes`/`oauthResource`, the `McpServerBindingRef` scope-discriminated union with the Claude-only `local` refinement, the redacted `McpServerConfigView` with the query-redacted URL, the discriminated degraded inventory arm, the mandatory `clientIdempotencyKey` on every mutation, the ≥ 1-facet override refinement, and the session-feed `bindingId` conditionality on the status payload), event payload schemas, error-code consts, `McpApplicationGrade` (`live_reconcile | user_config_write | next_run | daemon_enforced`), override facet + per-facet application types, per-leg `McpServerLegStatus` / `McpLiveApplicationResult`.
- `packages/runtime-daemon/src/mcp/` (CREATE) — `McpGovernanceService`, `McpInventoryService`, provider adapters (`claudeMcpConfigAdapter`, `codexMcpConfigAdapter`), `McpStatusNormalizer`, `McpOauthOrchestrator`, trust + override stores, the typed `mcp.*` refusal classes in `mcp-errors.ts` (T28.1.5 — the BL-143 subclass-in-own-file design over Plan-007's `DaemonDomainError` base), the drift-admission service (both CP-028-5 call sites + the recovery composition-root wiring), config-hash canonicalizer (BLAKE3 over RFC 8785 JCS — reusing the Plan-006 canonicalization substrate), and the daemon-held MCP governance master-key custody (one 32-byte node-local key file beside the daemon's other node key material — the same custody class as the event-signing key, never in SQLite) with purpose- and binding-separated BLAKE3 keyed-PRF subkeys (config-hash, scope-ref, receipt-digest), plus the startup receipt-intent reconciler.
- `packages/runtime-daemon/src/policy/` (EXTEND via Plan-012's policy-module surface) — `mcp` Cedar action family registration (CP-028-3).
- `packages/runtime-daemon/src/migrations/NNNN-mcp-governance.ts` (CREATE) — the three tables per [local-sqlite-schema.md §MCP Governance Tables (Plan-028)](../architecture/schemas/local-sqlite-schema.md#mcp-governance-tables-plan-028), as a TypeScript string-constant migration module (the runner sources SQL as TS constants, never sibling `.sql` files — `tsc -b` does not copy non-TS assets into `dist/`); the version number is the next free `schema_version` integer at execution time (Plan-006/-015/-016/-022 migrations may land first).
- `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND) — the migration's guarded block (`hasMigrationApplied` + `db.transaction(...).immediate()`, the pinned version-1 primitive verbatim) + import, per the runner's registered-block convention (the Plan-016 `session_budgets` pattern), with the migration-shape tests in `packages/runtime-daemon/src/session/__tests__/` extended to cover the new version.
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND) — the `mcp.*` namespace handler files per CP-028-4.
- `packages/runtime-daemon/src/bootstrap/index.ts` (EXTEND — touched, not owned) — one sanctioned recovery-attach wiring call per T28.4.7, registered on the [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §2 `bootstrap/` row at the 2026-08-12 targeted readiness audit (the Plan-010 `wireTurnSnapshotRetentionSweep` / Plan-016 `wireChannelDirectoryPublisher` class).
- `packages/client-sdk/src/mcpClient.ts` (CREATE) + the package-root barrel line — typed `mcp.*` client methods.
- `apps/desktop/src/renderer/src/mcp-governance/` (CREATE) — MCP panel views over the SDK surface.
- `apps/cli/src/commands/` `mcp-*.ts` (CREATE) + the `main.ts` `.register()` EXTENDs — the `sidekicks mcp` command group (`list` / `add` / `remove` / `trust` / `override` / `login` / `watch` — `watch` tails `mcp.subscribe`) under the Plan-007 registered bin name (`bin: { "sidekicks": … }`, the Plan-016 command precedent; per-subcommand filenames pinned at the 2026-08-12 targeted readiness audit: `mcp-list.ts`, `mcp-add.ts`, `mcp-remove.ts`, `mcp-trust.ts`, `mcp-override.ts`, `mcp-login.ts`, `mcp-watch.ts`).

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
3. **Phase 3 — Configuration mutation engines.** Claude: the unconditional durable leg (`claude mcp add-json` / `claude mcp remove` at user scope, write-verified before acknowledgment) + the opportunistic live `setMcpServers` leg selected by its own full-desired-set reconcile rather than by a driver-side probe (a typed refusal on that call selects the `user_config_write` grade and withdraws no capability flag; the CLI-version conjunct is subsumed by the ratified `2.1.234` admission floor, while SDK ≥ `0.3.166` + streaming mode remain reachability preconditions) (full-set semantics, per-server error reconciliation) + the enabled overlay and composed-snapshot regeneration; Codex: `config/batchWrite` with `expected_version`, single silent retry, reload trigger, `mcp.config_write_conflict` on double conflict; validation-first ordering (`mcp.config_invalid` strictly pre-commit) with per-leg `liveResults[]` partial-outcome reporting; the two-phase `mcp_mutation_receipts` idempotency layer (`pending` intent committed before the provider leg; finalization + event set + store writes in one transaction; startup reconciliation of crash-window intents — the Plan-015 `command_receipts` precedent; replay / `mcp.idempotency_conflict`); `mcp.server_config_changed` emission with application grade and the removal-payload conditionality (I-028-3, I-028-4).
4. **Phase 4 — Trust, overrides, and Cedar gating.** Cedar `mcp` action family registration (CP-028-3); in-plan effective-binding derivation off the post-drift composed snapshot (T28.4.11 — the invocation-side answer to the discharged carrier box), the binding-digest migration and receipt stamping that make its output durable (T28.4.12); trust service (grant/revoke/drift-revoke over the keyed config-hash canonicalizer, hash-plus-projection: the excluded override-projection fields reconciled on every evaluation against the baseline-anchored expected state — `native_tool_baseline_json` snapshotted at grant or first materialization, governed portions re-asserted on divergence, ungoverned portions adopted, revocation rewriting weakening fields to baseline ⊕ surviving tightening facets); the drift-admission service at both CP-028-5 call sites — the Plan-004 `RunSetupGate` registration and the Plan-015 recovery-attach composition-root wiring with its production non-vacuous runtime assertion; override service with the safety-weakening-requires-trust rule (`mcp.trust_required`, the weakening set incl. `enabled: true`), baseline capture/restore on facet materialization and clear (a user's native entries survive a set → clear round-trip), and the per-operation scope-applicability matrix (Spec-028 §Configuration Mutation); the binding-keyed tool-metadata resolver overlay (CP-028-2 — the effective `McpServerBindingRef` carried through invocation and recovery resolution); `mcp.server_trust_changed` + `mcp.tool_override_changed` emission; retrofit Phases 2–3 handlers from the feature gate to full authorization (every mutating op deny-before-effect).
5. **Phase 5 — OAuth orchestration + client delivery.** `McpOauthOrchestrator` (Codex login flow + completion notification; Claude status-flip observation + out-of-band guidance path; the URL-free `mcp.oauthLogin` receipt representation per I-028-1; completion-event dedup — exactly once per observed completion, nothing for abandoned flows); `mcp.server_oauth_completed`; `mcp.reconnect`; client-sdk methods, CLI `sidekicks mcp list/add/remove/trust/override/login/watch`, desktop panel hooks (reads + the `mcp.subscribe` stream over the Plan-023-partial bridge, CP-028-6); end-to-end acceptance sweep against Spec-028 §Acceptance Criteria.

## Parallelization Notes

- Phase 1 contracts and the migration are independent files — parallelizable within the phase.
- Phases 2 and 3 both depend on Phase 1 but not on each other (read path vs write path) — parallelizable as separate PRs after Phase 1 merges; both must merge before Phase 4 (which gates their handlers).
- Phase 5 is strictly after Phase 4 (OAuth and client surfaces assume authorization is live).
- The two provider adapters within any phase are parallel work units (no shared state beyond the service interfaces).

## Test And Verification Plan

- Unit: payload/DDL schema tests incl. the removal-payload conditionality (`configHash` absent + `previousConfigHash` required for `removed`), the `McpServerConfigInput` provider-conditional refinements, the binding-ref discriminated union (scopeRef forbidden/required per scope; `(codex, local)` rejected — typed validation, with the DDL CHECKs as the negative-control mirror), and the ≥ 1-facet override refinement; keyed base-config-hash canonicalization (reorder-stable, semantic-change-sensitive incl. secret-value drift, override-projection fields excluded, distinct bindings ⇒ distinct derived subkeys ⇒ distinct hashes for identical configs); audit-ref payload identity (`scopeRefDigest` present on project/local event payloads, raw `scopeRef` structurally absent from all five schemas; digest stable under the binding's derived subkey, distinct across bindings); `McpServerConfigView` redaction (env/header names round-trip, values structurally absent; the URL served query-redacted with query-parameter names, the full URL confined to the hash input); leg-status aggregation (severity ranking with `unknown` ranked between `needs-auth` and `starting`, node-probe fallback, no-source `unknown` floor, and retirement — a closed session's leg leaves `legs[]` and the aggregate recomputes); the degraded inventory arm (trust store unreachable → `trustUnavailable: true` with trust-/override-dependent fields structurally absent, provider-observed fields and the key-derived `scopeRefDigest` intact); status normalization maps (Claude `pending`/`disabled`, Codex `Starting|Ready|Failed|Cancelled` → `McpServerStatus`); trust state machine incl. revocation-neutralizes-weakening, the `enabled: true`-is-weakening rule, and the baseline lifecycle (snapshot at grant or first materialization — whichever first, never refreshed while held; dropped only untrusted-and-facet-free); resolver overlay floor semantics under trust flips.
- Integration (fixture-driven fake provider wires for both CLIs): full mutation matrix × {control-channel reachable, control-channel unreachable-on-an-admitted-build} Claude with restart-durability assertions (an acknowledged mutation survives a daemon restart via the provider store); scope-collision fixtures (same `serverName` in two scopes — independent status/trust/overrides, no drift ping-pong); per-operation scope-applicability matrix (provider-config writes refuse non-user; `setTrust`/`idempotencyClass` succeed on an effective Codex project binding while its native-write facets refuse; Claude project/local governance refuses); Codex conflict-retry-once; drift auto-revoke ordering incl. native-field reversion; the drift-admission service (out-of-band edit → run start: revocation + neutralization complete pre-spawn, composed snapshot reflects post-drift state; a projection-field-only edit — unchanged base hash — revokes and reverts at the gate; the daemon-restart variant: edit-while-down processes drift before recovery adopts or resumes, via the Plan-015 attach-seam wiring, with the vacuous-default pass-through as the pre-Plan-028 negative control); idempotency (identical retry replays with zero provider calls/writes/events — asserted across a daemon restart; divergent key reuse fails `mcp.idempotency_conflict`; receipt prune at the 24 h bound; the `mcp.oauthLogin` receipt stores and replays a URL-free acknowledgment; the two-phase crash windows — pending intent with no provider effect expires at startup, pending intent with a durable provider write reconciles to a finalized receipt + exactly-once late event); unmodeled-field preservation (a Codex server table carrying fields the input does not model is byte-identical on them after an update); durable-success/live-failure partial outcomes (`applied: 'user_config_write'` + failing `liveResults[]` entry, never a post-commit error); two-session leg divergence (per-leg statuses + scoped `mcp.reconnect` — `{sessionId}` restarts that session's legs, `{bindingId}` exactly one leg); resolver-overlay two-scope disambiguation (same `serverName` in user + project bindings: each session's invocation resolves its own effective binding's override); `mcp.subscribe` live-tail delivery (governance + status envelopes, no replay before the acknowledgment) + the gap-free handshake (an event appended between the subscribe acknowledgment and the `mcp.list` read arrives on the stream); deny-before-effect per non-read op; one-event-set-per-mutation over the six governance mutations incl. retry paths and the revocation-batch assertion (trust event + per-facet reversion events, atomic, never re-emitted on replay), plus the reconnect no-event negative control and the `mcp.server_oauth_completed` exactly-once-per-observed-completion dedup (abandoned flow: no event, receipt expires; unobserved completion: the status transition is the surviving trace); native-baseline round-trip (a Codex user config with pre-existing `enabled_tools`/`tools.<t>.approval_mode` values survives override set → clear with the native values restored; revocation rewrites to baseline ⊕ surviving tightening facets); async OAuth completion failure delivered as the `outcome: 'failure'` event (launch failure keeps `mcp.oauth_flow_failed` reachable); required-server thread-start failure mapping.
- Adversarial-Tampering Boundary: credential-echo sweep over all five event payloads, ten error codes, the `McpServerConfigView`, receipt rows (the `mcp.oauthLogin` row URL-free), and logs (I-028-1); raw-`scopeRef` absence from every event payload (the audit-ref negative control); provider-file byte-identity after refused mutations (project-scope, Cedar-denied, trust-required, idempotency-conflict); spoofed `serverName` from the status seam stays `wireFreeFormString`-bounded (the Plan-005 twelve-string rule); canonicalization round-trip on the config-hash input; hash-brute-force negative control (no served or stored digest — `configHash`, `scopeRefDigest`, or a receipt `request_digest` — is reproducible or verifiable from a database copy alone: the master key and its derived subkeys never enter SQLite); and the Phase-5 egress sweep — no `authorizationUrl`, token, authorization code, or PKCE material reaches CLI stdout/stderr, the `mcp.subscribe` stream, or any `window.sidekicks` bridge payload, asserted at each of the three new egress surfaces the OAuth + client phase opens (I-028-1 beyond the daemon boundary).
- CI-Pinned Tool Versions: provider fixtures name the wire pins they encode, read from the [provider-wire reference](../reference/provider-wire/README.md) family's §Version pin tables rather than restated here, plus the version-anchored `2.1.210` `mcp_set_servers` behavior (an upstream feature anchor, not a pin); `gitleaks v8.30.1` per [ADR-023 §Axis 4 — Supply-Chain Hygiene](../decisions/023-v1-ci-cd-and-release-automation.md#axis-4--supply-chain-hygiene) on every PR.
- Manual: real-provider smoke on one machine per OS tier before Phase 5 completion (OAuth browser round-trip cannot be fixture-verified end to end).

## Implementation Phase Sequence

Plan-028 implementation lands as five PRs (one per phase). Each PR carries a `**Precondition:**` line so the merge order is reviewer-checkable. The 2026-08-12 targeted readiness audit re-derived these phases into the audit-grade `#### Tasks` blocks below per the runbook; code dispatch now rides tier order and this plan's §Preconditions alone: the `review → approved` promotion landed 2026-08-14 (PR #330) and the effective-binding carrier box that formerly held T28.4.9 was discharged 2026-08-26 ([cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-86) by T28.4.11 + I-028-6 + CP-028-7, so no task carries an additional hold.

### Phase 1 — Contracts + storage

**Precondition:** Plan-006 Phase 1 merged; Plan-007 Phase 2 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 6, phase: 1, status: merged }
  - { type: plan_phase, plan: 7, phase: 2, status: merged }
```

**Goal:** contracts + migration + registered-but-gated namespace compile, migrate, and round-trip; schema tests green. Satisfies the storage halves of I-028-1/I-028-2; stages CP-028-1/CP-028-4.

#### Tasks

- **T28.1.1 — Binding-ref and config-input discriminated unions.**
  - Files: `packages/contracts/src/mcp-governance.ts` (CREATE)
  - Author `McpServerBindingRef` as a discriminated union on `scope`: `user` (no `scopeRef`), `project` (non-empty `scopeRef`), `local` (non-empty `scopeRef`, provider `claude` only — `(codex, local)` rejected at the type layer). Author `McpServerConfigInput` as a transport-discriminated union with provider-conditional refinements carrying the Codex auth references `envHttpHeaders` / `oauthScopes` / `oauthResource`. `--isolatedDeclarations`-clean (explicit type annotations on every exported const — repo-wide `tsconfig.base.json` rule).
  - **Spec coverage:** Spec-028 §Unified Inventory, Spec-028 §Interfaces And Contracts
  - **Verifies invariant:** I-028-1
  - **Consumes:** none (leaf contract module).

- **T28.1.2 — Redacted read model: config view, inventory entry, legs, degraded arm.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - `McpServerConfigView` serving transport, command/args, the query-redacted URL (scheme + host + path plus query-parameter **names**), timeouts, `required`, `bearerTokenEnvVar`, the Codex auth references, and env-var/header **names only**. `McpServerLegStatus` (leg identity, status, `observedAt`); the inventory entry with `legs[]`, the aggregate `status`, `effectiveInRuns`, and `scopeRefDigest`; the discriminated `trustUnavailable: true` degraded arm with trust-/override-dependent fields structurally absent.
  - **Spec coverage:** Spec-028 §Unified Inventory, Spec-028 §Fallback Behavior
  - **Verifies invariant:** I-028-1
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).

- **T28.1.3 — Mutation request/response payloads, grades, and the idempotency key.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - Request/response shapes for the eight non-read operations; mandatory requester-generated UUID `clientIdempotencyKey` on all six governance mutations and on `mcp.oauthLogin` (`mcp.reconnect` unreceipted); `McpApplicationGrade` (`live_reconcile | user_config_write | next_run | daemon_enforced`); `McpLiveApplicationResult` per-leg entries; the per-facet `McpToolOverrideApplication`; the ≥ 1-facet override refinement mirroring the DDL's all-NULL prohibition.
  - **Spec coverage:** Spec-028 §Configuration Mutation, Spec-028 §Authorization, Spec-028 §Tool-Level Overrides
  - **Verifies invariant:** I-028-4
  - **Consumes:** `McpServerBindingRef` ← T28.1.1 (same phase).

- **T28.1.4 — The five `mcp_governance` event payload schemas.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND)
  - Author the five payloads over a shared `McpServerBindingAuditRef` (path-free: `scopeRefDigest`, never raw `scopeRef`). `mcp.server_config_changed` carries the removal conditionality — `previousConfigHash` required and `configHash` structurally absent for `removed`. `mcp.server_status_changed` carries `origin: 'session_feed' | 'node_probe'` with `bindingId` required for `session_feed` and absent for `node_probe`. Author payloads only — the type literals and the `mcp_governance` category are Plan-006-owned (CP-028-1); this task MUST NOT edit `packages/contracts/src/event.ts`.
  - **Spec coverage:** Spec-028 §Status Observation and Events
  - **Verifies invariant:** I-028-1
  - **Consumes:** the five `mcp.*` type literals + the `mcp_governance` category ← Plan-006 T1.10 (shipped 2026-07-25); `EventEnvelope` ← Plan-006 Phase 1 (shipped).

- **T28.1.5 — Error-code constants and typed daemon error classes.**
  - Files: `packages/contracts/src/mcp-governance.ts` (EXTEND) + `packages/runtime-daemon/src/mcp/mcp-errors.ts` (CREATE)
  - The ten `mcp.*` codes as typed constants matching error-contracts.md §MCP Governance byte-for-byte, plus the typed refusal classes subclassing `DaemonDomainError` in this Plan-028-owned module — the BL-143 design keeps per-namespace classes out of the Plan-007 substrate (no per-namespace mapping-table maintenance; the Plan-010 `worktree-errors.ts` precedent), so each refusal reaches the wire as `data.type` with sanitized `data.fields` through the existing discriminator branch and `packages/runtime-daemon/src/ipc/domain-error.ts` is never edited.
  - **Spec coverage:** Spec-028 §Interfaces And Contracts
  - **Verifies invariant:** none (contract-registration task; the reachability assertion is T28.5.8's)
  - **Consumes:** `DaemonDomainError` ← Plan-007 substrate via BL-143 (`completed`).

- **T28.1.6 — Three-table migration module and runner registration.**
  - Files: `packages/runtime-daemon/src/migrations/NNNN-mcp-governance.ts` (CREATE) + `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND) + `packages/runtime-daemon/src/session/__tests__/` (EXTEND)
  - `mcp_server_trust`, `mcp_tool_overrides`, `mcp_mutation_receipts` per local-sqlite-schema.md §MCP Governance Tables (Plan-028), authored as a TypeScript string-constant module (the runner sources SQL as TS constants — `tsc -b` copies no non-TS assets into `dist/`). Version integer is next-free at write time. Runner edit is the pinned guarded block (`hasMigrationApplied` + `db.transaction(...).immediate()`) plus its import, landing in the same commit as the migration file per the §2 `migrations/` row's registration rule. DDL CHECKs mirror the type-layer binding rules as defence in depth: user ⇔ empty `scope_ref`; no `(codex, local)`; `config_hash GLOB 'b3:*'`; ≥ 1 non-NULL override facet; FK-cascade from overrides to the trust row. **No column stores key material.**
  - **Spec coverage:** Spec-028 §State And Data Implications
  - **Verifies invariant:** I-028-1, I-028-2, I-028-5
  - **Consumes:** `migration-runner.ts` guarded-block convention ← Plan-001 Tier 1 (shipped, PR #9).

- **T28.1.7 — Register the eleven `mcp.*` methods behind a `not_implemented` feature gate.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (CREATE)
  - Register all eleven names + schemas against `MethodRegistry.register()` with `not_implemented` handlers behind a feature gate, so the namespace shape ships reviewable before behavior and a mid-sequence pause leaves no half-authorized surface. Registration only — no substrate file's semantics change (CP-028-4, the CP-007-3 late-namespace pattern).
  - **Spec coverage:** Spec-028 §Interfaces And Contracts
  - **Verifies invariant:** none (namespace-shape staging; authorization lands at T28.4.3)
  - **Consumes:** `MethodRegistry.register()` ← Plan-007-partial Tier 1, `packages/contracts/src/jsonrpc-registry.ts` (shipped; `METHOD_NAME_FORMAT` admits every `mcp.*` name).

### Phase 2 — Inventory + status observation

**Precondition:** Phase 1 merged; Plan-005 Phase 3 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 1, status: merged }
  - { type: plan_phase, plan: 5, phase: 3, status: merged }
```

**Goal:** `mcp.list` / `mcp.get` serve the merged read model from both providers; status events flow with correct binding; first-observation trust rows appear untrusted. Satisfies CP-028-2(a) and the observation half of I-028-2.

#### Tasks

- **T28.2.1 — Claude config reader across user, project, and local scopes.**
  - Files: `packages/runtime-daemon/src/mcp/claude-mcp-config-adapter.ts` (CREATE)
  - Read `~/.claude.json` user scope + the project-keyed `local` scope + `.mcp.json`, yielding scope-qualified declarations. Credential-bearing values are handled transiently in memory and never persisted, logged, or served (Spec-028 §Implementation Notes transient-secret rule).
  - **Spec coverage:** Spec-028 §Unified Inventory
  - **Verifies invariant:** I-028-1
  - **Consumes:** `McpServerConfigView` ← T28.1.2 (Phase 1, merged).

- **T28.2.2 — Codex config reader with layer attribution.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (CREATE)
  - `config/read` yielding user-scope (`$CODEX_HOME/config.toml`) and cwd-resolved project-local rows with layer attribution; project rows are read-only in V1.
  - **Spec coverage:** Spec-028 §Unified Inventory
  - **Verifies invariant:** I-028-1
  - **Consumes:** `McpServerConfigView` ← T28.1.2 (Phase 1, merged).

- **T28.2.3 — Binding resolution and `effectiveInRuns` attribution.**
  - Files: `packages/runtime-daemon/src/mcp/binding-resolver.ts` (CREATE)
  - Resolve `(provider, scope, scopeRef, serverName)` bindings without merging same-named servers across providers or scopes; stamp `effectiveInRuns` (Codex `user` + `project` true; Claude `user` true; Claude `project` + `local` false in V1).
  - **Spec coverage:** Spec-028 §Unified Inventory
  - **Verifies invariant:** none (identity resolution; the no-merge assertion rides T28.5.8)
  - **Consumes:** declarations ← T28.2.1 + T28.2.2 (same phase).

- **T28.2.4 — `McpInventoryService.list/get` four-source merge and degraded arm.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-inventory-service.ts` (CREATE)
  - Merge declared config + normalized status + trust row + override rows per binding. `refresh: true` forces a provider round-trip; default serves most-recent observations. On trust-store unreachability serve the `trustUnavailable: true` arm with trust-/override-dependent fields structurally absent, provider-observed fields and the key-derived `scopeRefDigest` intact.
  - **Spec coverage:** Spec-028 §Unified Inventory, Spec-028 §Fallback Behavior
  - **Verifies invariant:** I-028-1
  - **Consumes:** bindings ← T28.2.3 (same phase); trust/override rows ← T28.1.6 (Phase 1, merged).

- **T28.2.5 — `McpStatusNormalizer` over the Plan-005 seam and the Codex wire.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-status-normalizer.ts` (CREATE)
  - Consume `McpServerStatusUpdate` values from the daemon-injected `onMcpServerStatus` producer and the Codex `mcpServerStatus/list` + `mcpServer/startupStatus/updated` wire; map Claude `pending` → `starting` and Claude `disabled` → `enabled: false` with last-observed status; absence of any source → `unknown`. Attribute each observation to the effective binding (session cwd for Codex, composed set for Claude). `serverName` stays `wireFreeFormString`-bounded — untrusted provider output.
  - **Spec coverage:** Spec-028 §Unified Inventory, Spec-028 §Status Observation and Events
  - **Verifies invariant:** none (normalization mapping; the spoof-bound assertion rides T28.5.8)
  - **Consumes:** `onMcpServerStatus` / `McpServerStatusUpdate` ← Plan-005 Phase 3 (§Precondition, `{plan: 5, phase: 3, status: merged}`; reciprocal at Plan-005's seam bullet naming Plan-028 CP-028-2).

- **T28.2.6 — Node-scope status probe (the `node_probe` origin producer).**
  - Files: `packages/runtime-daemon/src/mcp/node-status-probe.ts` (CREATE)
  - Produce node-scope, session-independent status observations for bindings with no live leg, on demand only — driven by `mcp.list` / `mcp.get` with `refresh: true`, never by a poll loop (Spec-028 §Default Behavior forbids busy-polling). Claude leg: the zero-billed-turn `claude mcp list` read. Codex leg: `mcpServerStatus/list` unscoped by `thread_id`. Observations are stamped `origin: 'node_probe'` with `bindingId` structurally absent and bind to the daemon-scope sentinel session. **This task closes audit finding F-028-04 — the `node_probe` arm was a wire value with no producer.**
  - **Spec coverage:** Spec-028 §Unified Inventory, Spec-028 §Default Behavior
  - **Verifies invariant:** none (observation producer; the fallback-ordering assertion is T28.2.7's)
  - **Consumes:** the daemon-scope sentinel session id ← Plan-006 (`Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring`, shipped).

- **T28.2.7 — Per-leg retention, deterministic aggregate, and leg retirement.**
  - Files: `packages/runtime-daemon/src/mcp/leg-status-store.ts` (CREATE)
  - Retain per-leg observations in `legs[]` keyed by the Plan-005 runtime-binding leg; compute the top-level aggregate as the most severe **current live-leg** status under the fixed order `failed > needs-auth > unknown > starting > connected`; fall back to the newest node-probe observation when no live leg exists, then to `unknown`. Retire a leg when its backing runtime binding closes and recompute — a terminated session's `failed` leg never pins the aggregate.
  - **Spec coverage:** Spec-028 §Unified Inventory
  - **Verifies invariant:** none (aggregation rule; asserted at T28.5.8 against the AC)
  - **Consumes:** normalized observations ← T28.2.5; node-probe observations ← T28.2.6 (same phase).

- **T28.2.8 — Untrusted-row upsert on first observation.**
  - Files: `packages/runtime-daemon/src/mcp/trust-store.ts` (CREATE)
  - First observation of a binding the trust store has never seen upserts `trusted = 0`. No code path on this task may write `trusted = 1` — observation creates the governance anchor, never trust.
  - **Spec coverage:** Spec-028 §Unified Inventory, Spec-028 §Default Behavior
  - **Verifies invariant:** I-028-2
  - **Consumes:** `mcp_server_trust` ← T28.1.6 (Phase 1, merged).

- **T28.2.9 — `mcp.server_status_changed` emission with the path-free audit ref.**
  - Files: `packages/runtime-daemon/src/mcp/status-event-emitter.ts` (CREATE)
  - Emit on transition only (an unchanged re-observation emits nothing). Payloads carry `scopeRefDigest`, never raw `scopeRef`. `origin: 'session_feed'` rows bind to the observing session's real `session_id` and carry the leg's `bindingId`; `origin: 'node_probe'` rows bind to the daemon-scope sentinel and omit `bindingId`. Append through the Plan-006 `EventLogService` path — no bespoke audit storage.
  - **Spec coverage:** Spec-028 §Status Observation and Events
  - **Verifies invariant:** I-028-1, I-028-4
  - **Consumes:** `EventLogService.append` ← Plan-006 Phase 4 (sole append path); `scopeRefDigest` derivation ← T28.4.1 **when trust machinery lands**; until then the digest derives from the same master-key file this task creates on first use if absent (the key artifact is single, per Spec-028 §Implementation Notes).

- **T28.2.10 — `mcp.subscribe` live-tail fan-out with the gap-free handshake.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-subscribe-handler.ts` (CREATE)
  - Long-lived operator-readable subscription delivering every `mcp_governance` envelope — sentinel-bound and session-bound alike — as the daemon appends it. Registration MUST be live before the first delivery so the subscribe-acknowledgment-then-`mcp.list` handshake is gap-free (the Plan-007 I-007-10 wire-ordering invariant). Live-tail only: nothing appended before the acknowledgment is delivered; history remains the locally-verified sentinel chain.
  - **Spec coverage:** Spec-028 §Status Observation and Events
  - **Verifies invariant:** none (delivery ordering; the gap-free assertion rides T28.5.8's AC sweep)
  - **Consumes:** the streaming primitive + I-007-10 ordering guarantee ← Plan-007-partial Tier 1 `streaming-primitive.ts` (shipped, PR #17/#19).

### Phase 3 — Configuration mutation engines

**Precondition:** Phase 1 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 1, status: merged }
```

**Goal:** both mutation engines pass the fixture matrix with honest application grades; conflict and scope refusals surface the right codes; config events emit exactly once. Satisfies I-028-3 and the mutation half of I-028-4 (behind the Phase 4 authorization gate).

#### Tasks

- **T28.3.1 — Claude durable leg: sanctioned user-scope CLI write, verified before acknowledgment.**
  - Files: `packages/runtime-daemon/src/mcp/claude-mcp-config-adapter.ts` (EXTEND)
  - `claude mcp add-json <name> <json> --scope user` / `claude mcp remove <name> --scope user`, unconditional on every `mcp.upsertServer` / `mcp.removeServer`. Re-read via `claude mcp get` (or user-scope observation) to verify the write took effect **before** the config event is emitted. Upserts are read-modify-write over the observed current declaration so provider fields the input does not model survive byte-identical. The daemon never rewrites `~/.claude.json` bytes directly and never writes a non-user scope.
  - **Spec coverage:** Spec-028 §Configuration Mutation
  - **Verifies invariant:** I-028-3
  - **Consumes:** observed declarations ← T28.2.1 (Phase 2, merged).

- **T28.3.2 — Claude opportunistic live `setMcpServers` leg, detected by its own reconcile.**
  - Files: `packages/runtime-daemon/src/mcp/claude-live-reconcile.ts` (CREATE)
  - Select the live leg by **this task's own full-desired-set reconcile**, never by a CLI-version comparison and never by a driver-side probe (2026-08-26 — the CLI conjunct is subsumed by the ratified `2.1.234` admission floor). There is deliberately no driver-side `mcp_set_servers` probe to consult: `mcp_set_servers` is a control-request subtype rather than one of Spec-005's fourteen capability flags, and Plan-005 guarantees the driver never issues it, because the operation replaces the full named-server set and an empty-set probe would clear this session's servers (CP-005-11). Availability is therefore established by the reconcile call this task already makes — the first full-set send **is** the detection, and a typed `Unsupported control request subtype` refusal on it falls through to `user_config_write` and withdraws **no** capability flag — in particular not `mcp`, which denotes MCP tool invocation and is unaffected, with the negative control asserted in the driver's own suite rather than issued here. SDK ≥ `0.3.166` and streaming-input mode stay stated reachability preconditions — the SDK version is not covered by the CLI admission floor — probed, never assumed from the pin. When satisfied, send the **full desired named-server set** (never a delta — a delta silently removes every unsent server) and reconcile the returned `{added, removed, errors}` against the requested delta. Grade `live_reconcile` only when every attempted live leg applied; `user_config_write` otherwise. Emit one `liveResults[]` entry per attempted leg (`sessionId` + the Plan-005 leg key, `outcome`, sanitized per-leg code).
  - **Spec coverage:** Spec-028 §Configuration Mutation, Spec-028 §Provider Capability Model
  - **Verifies invariant:** I-028-3
  - **Consumes:** the driver-spawn capability report ← Plan-005 T3.24 under **CP-005-11** (§Precondition on Phase 2, transitively merged) — the per-capability capability report carrying each flag's detection source, which covers the fourteen Spec-005 capability flags and does **not** include `mcp_set_servers` — that is a control-request subtype, not a flag, and Plan-005 guarantees no driver-side probe issues it (the operation replaces the full named-server set, so an empty-set probe would clear this task's servers) — so establishing its live value is this task's own reconcile. **The version premise of this leg's deferral has collapsed (2026-08-26)** without changing this task: `2.1.210` now sits below the floor Spec-005 admits, so the reconcile is upstream-available on every admitted build and the driver already runs in streaming-input mode, but this task probed rather than version-sniffed from the day it was authored, so the collapse removes a fixture-only caveat rather than a line of behavior.

- **T28.3.3 — Claude enabled overlay and composed-snapshot regeneration.**
  - Files: `packages/runtime-daemon/src/mcp/claude-snapshot-composer.ts` (CREATE)
  - `mcp.setEnabled` on a Claude binding records the daemon's per-server enabled overlay (user scope has no enabled field; removal would destroy the declaration). Regenerate the ephemeral `--mcp-config` + `--strict-mcp-config` snapshot as a composition of the observed user scope plus governance overlays; grade `next_run`, or `live_reconcile` when `toggleMcpServer` is available. Claude `project` / `local` scopes are deliberately excluded from composition (auto-including them would launder project-file trust).
  - **Spec coverage:** Spec-028 §Configuration Mutation, Spec-028 §Implementation Notes
  - **Verifies invariant:** I-028-3
  - **Consumes:** the enabled-overlay column ← T28.1.6 (Phase 1, merged).

- **T28.3.4 — Codex batched user-scope write with optimistic concurrency and reload.**
  - Files: `packages/runtime-daemon/src/mcp/codex-mcp-config-adapter.ts` (EXTEND)
  - `config/batchWrite` (multi-field mutations MUST be batched — one version check, one reload) with `expected_version` from the immediately preceding `config/read`. On `configVersionConflict`: re-read and retry exactly once, then surface `mcp.config_write_conflict` carrying both version tokens. Trigger `config/mcpServer/reload` (or per-server `mcpServer/refresh`) after a successful write. Writes are field-granular `config/value` paths, so unmodeled sibling fields stay byte-identical. Grade `user_config_write`. User scope only — project paths are rejected upstream.
  - **Spec coverage:** Spec-028 §Configuration Mutation, Spec-028 §Fallback Behavior
  - **Verifies invariant:** I-028-3
  - **Consumes:** `config/read` layer attribution ← T28.2.2 (Phase 2, merged).

- **T28.3.5 — Validation-first ordering and the per-operation scope-applicability matrix.**
  - Files: `packages/runtime-daemon/src/mcp/mutation-preflight.ts` (CREATE)
  - Every check that can fail a mutation outright runs **before** the durable leg commits; `mcp.config_invalid` is exclusively a pre-commit refusal. Once the durable leg commits, the mutation never converts to a thrown error — later per-leg failures report inside the successful response. Implement the scope matrix: the three config mutations refuse non-`user` on both providers (`mcp.setEnabled` additionally refuses Claude `project`/`local`); trust / override / OAuth / reconnect apply to any `effectiveInRuns` binding; governance mutations on never-materialized bindings (Claude `project`/`local`) refuse; Codex `enabled`/`approvalMode` facets refuse on `project` bindings. All refusals carry `mcp.config_scope_unsupported` with the file path in message guidance only, never in an event payload.
  - **Spec coverage:** Spec-028 §Configuration Mutation, Spec-028 §Fallback Behavior
  - **Verifies invariant:** I-028-3
  - **Consumes:** `effectiveInRuns` ← T28.2.3 (Phase 2, merged).

- **T28.3.6 — Two-phase `mcp_mutation_receipts` idempotency layer.**
  - Files: `packages/runtime-daemon/src/mcp/mutation-receipt-store.ts` (CREATE)
  - Commit a `pending` **intent** (key, operation, keyed request digest) in its own transaction **before** any provider leg runs; finalize (`committed`, response recorded) in the **same SQLite transaction** as the mutation's store writes and event append. An identical retry (same key, same digest) replays the recorded response with no provider call, no store write, no second event; a differing digest refuses `mcp.idempotency_conflict` leaving the original untouched. `committed` rows older than 24 h prune opportunistically on later mutation writes; `pending` intents are never silently pruned. The request digest is keyed under the receipt-digest subkey of the daemon-held master key — never a value colocated with the row.
  - **Spec coverage:** Spec-028 §Authorization
  - **Verifies invariant:** I-028-4
  - **Consumes:** `mcp_mutation_receipts` ← T28.1.6 (Phase 1, merged); the receipt-digest subkey ← T28.4.1 (Phase 4) — until Phase 4 lands, this task creates the master-key artifact on first use per Spec-028 §Implementation Notes' single-artifact rule.

- **T28.3.7 — Startup receipt-intent reconciler.**
  - Files: `packages/runtime-daemon/src/mcp/receipt-reconciler.ts` (CREATE)
  - At startup, resolve every `pending` intent by observing provider state: an intent with no provider effect expires; an intent whose durable provider write landed is completed — store writes applied, the event appended, the receipt finalized — so the audit event lands **late but exactly once, never lost and never doubled**. An identical-key retry meeting a pending intent drives reconciliation first, then replays (the Plan-015 `command_receipts` two-phase discipline).
  - **Spec coverage:** Spec-028 §Authorization
  - **Verifies invariant:** I-028-4
  - **Consumes:** the two-phase receipt discipline ← Plan-015 `command_receipts` (pattern reuse, not a symbol import — Plan-028 owns its own store).

- **T28.3.8 — `mcp.server_config_changed` emission with removal conditionality.**
  - Files: `packages/runtime-daemon/src/mcp/config-event-emitter.ts` (CREATE)
  - Emit on every applied mutation with binding identity, change kind, application grade, and post-change `configHash` — except removals, whose payload carries `previousConfigHash` and structurally omits `configHash`. Sentinel-bound (node scope) with `initiatingSessionId` when a session-scoped caller initiated. Payloads carry no config values, env vars, headers, or URLs.
  - **Spec coverage:** Spec-028 §Configuration Mutation, Spec-028 §Status Observation and Events
  - **Verifies invariant:** I-028-4
  - **Consumes:** `EventLogService.append` ← Plan-006 Phase 4 (shipped path).

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

**Goal:** every mutating operation is deny-before-effect; trust lifecycle incl. drift revocation is live; the resolver overlay moves the floor only under trust + authorization, and a revocation neutralizes the durable receipt surface as well as the live one. Satisfies I-028-4, I-028-5, I-028-6, CP-028-2(b), CP-028-3, CP-028-7.

#### Tasks

- **T28.4.1 — MCP governance master-key custody and subkey derivation.**
  - Files: `packages/runtime-daemon/src/mcp/governance-key-custody.ts` (CREATE)
  - One 32-byte node-local key file beside the daemon's other node key material (the same custody class as the event-signing key), generated at first governance use and **never entering SQLite**. Derive purpose- and binding-separated subkeys via BLAKE3 keyed-PRF over a purpose tag plus the canonical binding identity: the config-hash, scope-ref, and receipt-digest subkeys. Losing the master key is fail-closed by construction — no key, no comparable hash, no trust.
  - **Spec coverage:** Spec-028 §Implementation Notes, Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-1
  - **Consumes:** BLAKE3 keyed mode ← the Plan-006 canonicalization substrate (shipped Phase 2).

- **T28.4.2 — Keyed base-config hash canonicalizer with projection-field exclusion.**
  - Files: `packages/runtime-daemon/src/mcp/config-hash-canonicalizer.ts` (CREATE)
  - `b3:`-prefixed BLAKE3 in keyed mode (key = the binding's config-hash subkey) over the RFC 8785 JCS canonicalization of the normalized server config. Reorder-stable; sensitive to any semantic change including credential-bearing env-var and header **values**. Computed **excluding** the daemon-managed override-projection fields (`enabled_tools` / `disabled_tools` / `tools.<t>.approval_mode`) so a governed override write never self-revokes the trust that authorized it. Inputs are transient in memory — parse, canonicalize, hash, discard.
  - **Spec coverage:** Spec-028 §Trust Governance, Spec-028 §Implementation Notes
  - **Verifies invariant:** I-028-2
  - **Consumes:** the config-hash subkey ← T28.4.1 (same phase).

- **T28.4.3 — Cedar `mcp` action family registration and the deny-before-effect retrofit.**
  - Files: `packages/runtime-daemon/src/policy/mcp-action-family.ts` (CREATE) + `packages/runtime-daemon/src/ipc/handlers/mcp-handlers.ts` (EXTEND)
  - Register the `mcp` action family additively through Plan-012's policy-module surface — no Plan-012-owned file is modified (CP-028-3, the CP-012-4 consumer pattern). Every one of the eight non-read operations evaluates `PermissionCheckService` **before any provider call or store write**; authorization is evaluated **before existence checks** so a deny is stable and leaks no inventory contents. A deny returns `mcp.governance_denied`; a relay-originated caller returns `mcp.operator_scope_required` before any store or provider mutation. Retrofit the Phase 2–3 handlers off the `not_implemented` feature gate to full authorization in this task.
  - **Spec coverage:** Spec-028 §Authorization
  - **Verifies invariant:** I-028-4
  - **Consumes:** `PermissionCheckService.check()` ← Plan-012 Phase 2 (§Precondition, `{plan: 12, phase: 2, status: merged}`; reciprocal return-cite added to Plan-012 CP-012-4 by this audit — see F-028-03).

- **T28.4.4 — Trust service: grant, revoke, and the native-field baseline lifecycle.**
  - Files: `packages/runtime-daemon/src/mcp/trust-store.ts` (EXTEND)
  - `mcp.setTrust` grants bind to the binding's **current** base-config hash; revocation is operator or drift-driven. Snapshot `native_tool_baseline_json` from the observed native values at trust grant **or** at first facet materialization, whichever comes first; never silently refresh it while held; drop it only once the binding is untrusted with no materialized facets. Same-named bindings in different scopes carry independent trust. Revocation by **either** entry — operator (`mcp.setTrust` to untrusted) or drift (T28.4.5) — additionally neutralizes the **durable** surface in the same transaction: every non-terminal `command_receipts` row stamped with the revoked binding's `mcp_binding_digest` has its `idempotency_class` rewritten to the `manual_reconcile_only` floor (**I-028-6**, CP-028-7). This service is the single revocation writer both entries funnel through — the drift evaluator owns detection and calls **here** to write `trusted = 0` rather than writing trust rows itself — so neither entry can reach revocation without the neutralization, and a third entry added later inherits it by construction rather than by remembering to.
  - **Spec coverage:** Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-2, I-028-6
  - **Consumes:** the keyed hash ← T28.4.2 (same phase).

- **T28.4.5 — Drift evaluation (hash-plus-projection) with the atomic neutralization batch.**
  - Files: `packages/runtime-daemon/src/mcp/drift-evaluator.ts` (CREATE)
  - On any observation of a trusted binding: recompute the base-config hash and, **additionally**, reconcile the hash-excluded projection fields against the expected native state (the preserved baseline overlaid with materialized facets) — so a projection-field-only out-of-band edit drifts under an unchanged base hash. Any divergence auto-revokes (`trusted = 0`, `revoked_reason = 'config_drift'`) **before the changed config informs any decision surface**. Revocation neutralizes weakening in the same operation: daemon-enforced weakenings lapse at resolution time; Codex-materialized native weakening fields are rewritten to the **baseline-anchored safe state** (baseline ⊕ surviving tightening facets, never an invented default); governed portions of the projection fields are re-asserted while ungoverned portions adopt observed values. The trust event plus one `mcp.tool_override_changed` per reverted facet append as one **atomic batch** in the revocation's transaction under its receipt, never re-emitted on replay.
  - **Spec coverage:** Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-2, I-028-4
  - **Consumes:** baseline + trust rows ← T28.4.4 (same phase).

- **T28.4.6 — Drift-admission service registered through the Plan-004 `RunSetupGate` seam.**
  - Files: `packages/runtime-daemon/src/mcp/drift-admission-service.ts` (CREATE)
  - One admission service — fresh provider-config read, keyed hash recompute, projection reconciliation, full drift processing — exposed as a `RunSetupGate` (`{ assertRunReady, onRunTerminal? }`) and **registered** into the ordered gate array. A registration call, never an edit to `run-engine.ts` (the CP-010-9 precedent; §2 row for `run-engine.ts` records Plan-028 as a registrant, not an extender). `assertRunReady` completes drift processing before the run leaves `starting`, and the Claude composed snapshot is built **from** the post-drift read.
  - **Spec coverage:** Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-2
  - **Consumes:** the `RunSetupGate` registration seam ← Plan-004 Phase 3, CP-004-8 (§Precondition, `{plan: 4, phase: 3, status: merged}`; reciprocal extender enumeration added to Plan-004 CP-004-8 by this audit — see F-028-03).

- **T28.4.7 — Recovery-attach composition-root wiring and the non-vacuous production assertion.**
  - Files: `packages/runtime-daemon/src/bootstrap/index.ts` (EXTEND — the sanctioned wiring-call edit, registered on the [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §2 `bootstrap/` row at the 2026-08-12 targeted readiness audit)
  - Replace the vacuous default on Plan-015's `startup-recovery-service.ts` attach seam (`{ assertAttachAdmissible(context): Promise<void> }`) with the real drift-admission service at the daemon composition root (the Plan-004 T3.14 `RollbackAttributionSource` precedent), so an edit made while the daemon was down processes drift before any adoption or cold resume. Ship the runtime assertion that a production daemon carrying Plan-028 never constructs recovery with the vacuous default.
  - **Spec coverage:** Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-2
  - **Consumes:** the `assertAttachAdmissible` vacuous-default seam ← Plan-015 T15.3 (order-independent, no YAML gate; reciprocal already present in Plan-015's T15.3 B18 clause naming Plan-028 CP-028-5).

- **T28.4.8 — Override service: weakening-requires-trust, baseline restore, scope matrix.**
  - Files: `packages/runtime-daemon/src/mcp/tool-override-service.ts` (CREATE)
  - `mcp.setToolOverride` / `mcp.clearToolOverride` over the three optional facets. Safety-weakening facets require a trusted binding — `mcp.trust_required` otherwise; the weakening set is idempotency-class assignment off the floor, approval modes weaker than the provider default, **and `enabled: true`** (broadening the executable tool set is capability expansion, never neutral). Safety-tightening facets succeed regardless of trust. Codex `enabled`/`approvalMode` materialize into native fields at `user` scope (grade `user_config_write`); Claude equivalents are `daemon_enforced`; `idempotencyClass` is always `daemon_enforced`. Clearing restores the cleared facet's portions from the baseline; clearing the last facet of an untrusted binding restores it verbatim and drops it, so a user's own native entries survive a set → clear round-trip.
  - **Spec coverage:** Spec-028 §Tool-Level Overrides, Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-5
  - **Consumes:** baseline ← T28.4.4; trust state ← T28.4.4 (same phase).

- **T28.4.9 — Binding-keyed tool-metadata overlay (CP-028-2(b)).**
  - Files: `packages/runtime-daemon/src/mcp/tool-metadata-overlay.ts` (CREATE)
  - Overlay `mcp_tool_overrides` onto the `driver_tools`-sourced metadata so an operator-assigned `idempotencyClass` reaches the resolution output and absence resolves to the `manual_reconcile_only` floor. The lookup keys on the full `(provider, scope, scopeRef, serverName, toolName)` binding, not `(driver_name, tool_name)`, so two sessions resolving the same tool name from user- and project-scope bindings each get their own scope's override. Weakening facets resolve only while the binding's trust holds. Downstream consumers read the resolution output, never the override table.
  - **Spec coverage:** Spec-028 §Tool-Level Overrides
  - **Verifies invariant:** I-028-5
  - **Consumes:** `driver_tools` metadata ← Plan-005 Phase 2 (T2.1/T2.4); the full `(provider, scope, scopeRef, serverName)` lookup key ← **T28.4.11** (same phase). The §Preconditions carrier box that held this task (audit finding F-028-02) is **discharged 2026-08-26** — the effective binding is derived in-plan from the T28.4.6 composed snapshot rather than carried in from Plan-005 or Plan-015, so no upstream registration gates this task and it is dispatch-eligible on Phase 4's ordinary gates.
  - **Ownership note:** `driver_tools` is Owner=Plan-005. This overlay is a Plan-028-owned module reading that store's output; it MUST NOT edit any Plan-005-owned file.

- **T28.4.10 — `mcp.server_trust_changed` and `mcp.tool_override_changed` emission.**
  - Files: `packages/runtime-daemon/src/mcp/governance-event-emitter.ts` (CREATE)
  - Sentinel-bound with `initiatingSessionId` when applicable (**absent on drift auto-revoke** — no operator initiated it). Every override mutation emits on set and clear alike. The revocation batch appends atomically per T28.4.5. Payloads carry `scopeRefDigest`, never raw `scopeRef`.
  - **Spec coverage:** Spec-028 §Status Observation and Events
  - **Verifies invariant:** I-028-4
  - **Consumes:** `EventLogService.append` ← Plan-006 Phase 4 (shipped path).

- **T28.4.11 — Effective-binding derivation for a session's tool namespace.**
  - Files: `packages/runtime-daemon/src/mcp/effective-binding-resolver.ts` (CREATE)
  - Resolve `(sessionId, toolName)` to an `McpServerBindingRef` **or** to `null`, from the post-drift composed-config snapshot T28.4.6 already builds, applying the same scope precedence the provider applies — so the answer is the binding the provider actually served the tool from, not a plausible reconstruction. `null` is a first-class answer meaning _no governed binding_ (a provider built-in, or a daemon-hosted callback tool), never an error and never a guess; it is what makes a `NULL` `mcp_binding_digest` meaningful rather than merely missing. This is **derivation, not registration**: nothing is threaded in from Plan-005 or Plan-015, which is exactly what discharges the §Preconditions carrier box. **Never key on the delivered wire tool name's shape** — provider-side tool-name prefixing and collision-suffixing are provider defaults rather than wire invariants, so the mapping runs off the daemon's own registration identity, never off parsing the delivered name. Emit the binding-identity digest here too, so T28.4.4's neutralization lookup and the receipt write are two readers of **one** derivation rather than two implementations that can disagree.
  - **Spec coverage:** Spec-028 §Tool-Level Overrides, Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-5, I-028-6
  - **Consumes:** the post-drift composed snapshot ← T28.4.6 (same phase).
- **T28.4.12 — Binding-digest migration and receipt stamping.**
  - Files: `packages/runtime-daemon/src/migrations/0NNN-command-receipts-mcp-binding-digest.ts` (CREATE — NNN = next free version at PR-open time), `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND — version-guarded block), `packages/runtime-daemon/src/persistence/sqlite/command-receipt-store.ts` (EXTEND — the receipt INSERT gains the digest argument; the directory Plan-015 T15.1 declares for the receipt store, not a `recovery/` sibling).
  - The column and its partial index have a defining DDL in `local-sqlite-schema.md` and an invariant that reads them, but until this task no code creates either and no writer populates them — a governed-binding provenance column that is always `NULL` would make I-028-6's neutralization sweep silently vacuous, matching nothing and reporting success. This task adds the additive nullable `mcp_binding_digest` column plus `idx_command_receipts_mcp_binding` under CP-028-7, and threads the digest T28.4.11 derives into the existing receipt write **as an argument to the current INSERT**, opening no second write path — the Plan-015-owned store keeps its single writer, and this plan supplies a value rather than authoring a seam.
  - **Ownership note:** `command_receipts` is Owner=Plan-004 and its receipt store is Owner=Plan-015. This task adds one column and one call-site argument under CP-028-7 and edits nothing else in either surface.
  - **Spec coverage:** Spec-028 §Trust Governance
  - **Verifies invariant:** I-028-6
  - **Consumes:** the derived digest ← T28.4.11 (same phase); the receipt write path ← Plan-015 (shipped).

### Phase 5 — OAuth orchestration + client delivery

**Precondition:** Phase 4 merged; Plan-023-partial renderer substrate (shipped Tier 1 — prose-only precondition per CP-028-6: shipped upstreams carry no YAML gate).

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 28, phase: 4, status: merged }
```

**Goal:** OAuth flows complete (or degrade honestly) on both providers; CLI + desktop surfaces ship; the Spec-028 §Acceptance Criteria sweep is green end to end. Satisfies I-028-1's flow-level verification.

#### Tasks

- **T28.5.1 — `McpOauthOrchestrator`: Codex login flow and URL-free receipt.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-oauth-orchestrator.ts` (CREATE)
  - `mcpServer/oauth/login` returns the provider's `authorization_url` to the caller; the daemon then observes `mcpServer/oauthLogin/completed`. The idempotency receipt persists the acknowledgment with `authorizationUrl` **structurally omitted** — launch URLs embed single-use PKCE state and are never durable — so an identical-key retry replays a URL-free acknowledgment. The daemon never stores, logs, or relays tokens, authorization codes, or PKCE material, at any egress including CLI stdout and the renderer bridge.
  - **Spec coverage:** Spec-028 §OAuth Orchestration
  - **Verifies invariant:** I-028-1
  - **Consumes:** the receipt store ← T28.3.6 (Phase 3, merged).

- **T28.5.2 — Claude OAuth: status-flip observation and out-of-band degradation.**
  - Files: `packages/runtime-daemon/src/mcp/mcp-oauth-orchestrator.ts` (EXTEND)
  - Interactive contexts route to `claude mcp login <server>`; completion is observed as the server-status flip (this provider has no dedicated completion event). In a mode where the flow cannot run in-band (Claude non-interactive), fail `mcp.oauth_unsupported` with guidance naming the out-of-band command; the server's `needs-auth` status remains the visible state.
  - **Spec coverage:** Spec-028 §OAuth Orchestration, Spec-028 §Fallback Behavior
  - **Verifies invariant:** I-028-1
  - **Consumes:** normalized status transitions ← T28.2.5 (Phase 2, merged).

- **T28.5.3 — `mcp.server_oauth_completed` exactly-once-per-observed-completion.**
  - Files: `packages/runtime-daemon/src/mcp/oauth-completion-emitter.ts` (CREATE)
  - Emit exactly once per **observed** completion (Codex notification; Claude on-transition status flip, which dedups by construction). An abandoned or never-observed flow emits nothing and leaves only its expiring receipt; a completion the daemon missed surfaces as the next observed status transition. Launch failures are the error `mcp.oauth_flow_failed` on the still-open call; asynchronous completion failures are the event with `outcome: 'failure'` and a sanitized `failureReason` — never a late JSON-RPC error on a closed request.
  - **Spec coverage:** Spec-028 §OAuth Orchestration, Spec-028 §Authorization
  - **Verifies invariant:** I-028-4
  - **Consumes:** `EventLogService.append` ← Plan-006 Phase 4 (shipped path).

- **T28.5.4 — `mcp.reconnect` leg-addressable handler.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/mcp-reconnect-handler.ts` (CREATE)
  - Claude `reconnectMcpServer()` / Codex `mcpServer/refresh`. Leg-addressable: a `bindingId` reconnects exactly one leg (with `sessionId`, both must name the same leg), a `sessionId` alone reconnects that session's legs, neither reconnects every live leg. Unreceipted and Cedar-evaluated; changes no store and no provider config, so it emits **no** dedicated governance event — its observable effect is audited through the `mcp.server_status_changed` transitions it induces, and an attempt producing no transition intentionally leaves no governance row.
  - **Spec coverage:** Spec-028 §Authorization
  - **Verifies invariant:** none (no-event negative control is asserted at T28.5.8)
  - **Consumes:** per-leg statuses ← T28.2.7 (Phase 2, merged).

- **T28.5.5 — Client SDK `mcp.*` surface.**
  - Files: `packages/client-sdk/src/mcpClient.ts` (CREATE) + `packages/client-sdk/src/index.ts` (EXTEND — barrel line)
  - Typed client methods for all eleven operations over the `JsonRpcClient` transport, including the `mcp.subscribe` stream consumer.
  - **Spec coverage:** Spec-028 §Interfaces And Contracts
  - **Verifies invariant:** none (transport surface)
  - **Consumes:** `JsonRpcClient` ← Plan-007-partial Tier 1 `transport/jsonRpcClient.ts` (shipped, CP-007-4).

- **T28.5.6 — CLI `sidekicks mcp` command group.**
  - Files: `apps/cli/src/commands/mcp-list.ts`, `mcp-add.ts`, `mcp-remove.ts`, `mcp-trust.ts`, `mcp-override.ts`, `mcp-login.ts`, `mcp-watch.ts` (all CREATE) + `apps/cli/src/main.ts` (EXTEND — seven `.register()` calls)
  - Seven subcommands under the Plan-007 registered bin name; `mcp-watch.ts` tails `mcp.subscribe`. clipanion has no auto-discovery, so each file needs an explicit `.register()` on the `Cli` instance. Honors Plan-007's I-007-13 import isolation (only `@ai-sidekicks/client-sdk` / `@ai-sidekicks/contracts` / `clipanion` / Node built-ins), enforced by `apps/cli/eslint.config.mjs`. **These seven filenames are the pin audit finding F-028-12 discharges.**
  - **Spec coverage:** Spec-028 §Interfaces And Contracts
  - **Verifies invariant:** none (client reachability surface)
  - **Consumes:** the `apps/cli/` scaffold + `src/commands/` directory + `main.ts` `Cli` builder ← Plan-007 Phase R3 (T-007r-3-1 / T-007r-3-2).

- **T28.5.7 — Desktop MCP-governance settings page (CP-028-6, CP-028-8).**
  - Files: `apps/desktop/src/renderer/src/mcp-governance/` (CREATE)
  - Panel views reading `mcp.list` / `mcp.get` and the `mcp.subscribe` stream **only** via the `window.sidekicks` bridge — no direct daemon access from the renderer (the CP-016-11 pattern; live bridge verification arrives at Plan-023 Tier 8).
  - **EXTEND (2026-08-29 — the operator surface).** The views become the full settings-level page `Spec-028 §The operator surface` and the MCP Servers View sketch under `Spec-023 §Signature Feature Composition Sketches` specify: the two-pane server list and detail, the trust chip carrying the daemon's own revoke reason (config-drift included), the per-tool effective idempotency class marked as native baseline or operator override, and the mutating controls — add / update, remove, enable / disable, trust / revoke, set / clear a tool override, OAuth login, and reconnect — **one wire mutation per explicit operator action**, over the eleven `mcp.*` operations this plan already registers. Three properties are obligations rather than styling: the page updates from `mcp.subscribe` and **never** polls `mcp.list` on a timer; it renders **no** configuration value, env-var value, header value, token, or command argument, and reads no provider config file; and it **derives no eligibility** — trust state, connection status, effective class, and control availability are all wire-verbatim, with a control disabled where the daemon reports nothing and a daemon refusal rendered rather than pre-filtered away. Plan-023 mounts this subtree and owns nothing inside it (CP-028-8 ⇄ CP-023-7).
  - **Spec coverage:** Spec-028 §Status Observation and Events; Spec-028 §The operator surface; Spec-023 §Signature Feature Composition Sketches (the MCP Servers View sketch)
  - **Verifies invariant:** none (read-and-steer view layer; the authorization it surfaces is enforced daemon-side by Phase 4)
  - **Tests:** an effective idempotency class rendered from the daemon read is not recomputed when the underlying trust chip changes — asserted by mutating trust and checking the class re-renders only on the daemon's own row, since the failure mode is a plausible local re-derivation; a refused safety-weakening override renders the daemon's reason and the control was not pre-disabled; the page issues no `mcp.list` call on a timer with the subscription live; and no payload field carrying a configuration value reaches a rendered node.
  - **Consumes:** the `window.sidekicks` bridge stub + renderer substrate ← Plan-023-partial Tier 1 (shipped; prose-only precondition — shipped upstreams carry no YAML gate).

- **T28.5.8 — End-to-end acceptance sweep against Spec-028 §Acceptance Criteria.**
  - Files: `packages/runtime-daemon/src/mcp/__tests__/acceptance.test.ts` (CREATE)
  - One assertion per Spec-028 §Acceptance Criteria bullet, fixture-driven against fake provider wires for both CLIs, plus the Adversarial-Tampering sweep: credential echo over all five payloads / ten error codes / the config view / receipt rows / logs **and the two Phase-5 egress surfaces (CLI stdout and the renderer bridge payloads)**; raw-`scopeRef` absence; provider-file byte-identity after every refused mutation; canonicalization round-trip; and the hash-brute-force negative control (no served or stored digest is reproducible from a database copy alone). All ten error codes reachable and absent from success paths.
  - **Spec coverage:** Spec-028 §Acceptance Criteria
  - **Verifies invariant:** I-028-1, I-028-2, I-028-3, I-028-4, I-028-5
  - **Consumes:** every Phase 1–4 surface (same plan, merged).

## Rollout Order

1. Doc PR (this plan + Spec-028 + the Spec-006 B18 amendment — landed together, campaign W3).
2. Targeted readiness audit against the draft (the runbook's new-plan invocation path) — completed 2026-08-12, ticking the §Preconditions audit box and carrying `draft → review` in the same swap; `review → approved` follows as its own promotion, citing this audit's REVIEW.md once review notes are addressed. (Both legs complete: the audit landed via PR #329 and the promotion via PR #330, 2026-08-14.)
3. Phases 1–5 as sequenced above, in tier order behind Tiers 1–6 execution.

## Rollback Or Fallback

- All three tables are additive and Plan-028-only — rollback of any phase is a revert plus (for Phase 1) a down-migration; no other plan reads or writes them.
- The `MethodRegistry` feature gate keeps `mcp.*` operations `not_implemented` until their backing phase, so a mid-sequence pause leaves no half-authorized surface.
- Provider-side state needs no rollback by construction: I-028-3 means the daemon's writes are always provider-valid config the operator could have made by hand.

## Risks And Blockers

- **Provider drift beyond the pins.** The reference family re-pins on its own cadence and `0.141.0` is now the Codex **floor** rather than the pin (2026-08-26); the config-method introduction versions remain unresolvable from upstream docs (bounded ≥ `0.141.0`). Mitigation, unchanged in kind and now stronger in mechanism: the per-capability detection + re-verify-at-execution rule (Spec-028 §Implementation Notes) is a hard phase-entry step, and Spec-005 §Required Behavior makes per-capability declared detection the driver-wide rule rather than this plan's local precaution — so drift above the pin degrades one capability instead of a session, and the nightly compatibility check reports the drift without gating anything.
- **MCP 2026-07-28 revision.** Lands mid-execution window; binds here only through provider releases (Spec-028 binds provider surfaces, not the MCP wire). Watch item, not a blocker.
- **Claude live-reconcile floor above the pin — resolved 2026-08-26, not deferred.** The premise (`2.1.210` > the then-current `2.1.198`) is void twice over: Spec-005 §Required Behavior now admits no build below `2.1.234`, and the control request was measured answering `success` at `2.1.234`, `2.1.245`, and `2.1.246` on the driver's own streaming-input transport, with a negative control still refusing an unknown subtype. That measurement's reach is bounded and stated so: it was taken **out of band, at authoring time, against a scratch session**, and it sent an **empty** desired set — which establishes that the subtype dispatches and returns the documented reconcile envelope, not that a non-empty mutation lands. It is authoring-time evidence, and it is precisely the call the non-mutating conjunct forbids the driver to issue against a live session. Confirming the full-desired-set reconcile T28.3.2 specifies is that task's own reconcile, run against the server set it is about to install. The live path is therefore the real-machine default on every admitted build, and `user_config_write` becomes the **fallback** grade rather than the expected one. What survives is not a version caveat but a reachability one — a cloud-hosted session refuses control requests a local one answers — which is why T28.3.2's reconcile-is-detection rule stays and why its `{control-channel reachable, control-channel unreachable-on-an-admitted-build}` fixture arms stay: they exercise a reconcile refusal rather than a version comparison.

- **Claude live-reconcile floor above the pin** (`2.1.210` > `2.1.198`): until the workstation pin advances, the live path is fixture-tested only and the next-run path is the real-machine default — honest per the application grade; the floor probe makes this self-correcting.
- **Promotion sequencing.** The targeted audit completed 2026-08-12 ([cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-61), ticking its §Preconditions box. Both gates it left have since closed: the `review → approved` promotion landed 2026-08-14 (PR #330, citing that audit's REVIEW.md), and the effective-binding carrier box holding T28.4.9 was discharged 2026-08-26 ([cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-86). No promotion or box gate remains; dispatch rides tier order.

## Progress Log

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human-readable commentary appended by the orchestrator at Phase E. -->

- **2026-08-29 — The operator surface (§6 node NS-93).** Status flipped `approved → review` and restored `approved` in the same diff, jointly with Spec-028, by the targeted readiness-audit delta riding the [Spec-005](./005-provider-driver-contract-and-capabilities.md) desktop-console parity amendment's own swap. This spec had specified a complete governance plane and named its operator surface exactly once, in passing, inside a bullet about a subscription. **Delivered in-diff:** `Spec-028 §The operator surface`, the [Spec-023](../specs/023-desktop-shell-and-renderer.md) MCP Servers View sketch (an operator-plane view on the 2026-08-26 Provider Accounts precedent, not a V1 Signature Feature), **CP-028-8** ⇄ Plan-023 CP-023-7 registering the owner-authors / host-mounts split on the NS-73 precedent, and the T28.5.7 EXTEND taking that task from panel views to the full settings page with its four tests. **No wire surface is added**: the operation count stays **eleven**, the event count **five**, and the error registry **ten**, so no census moves and no table or column is minted. Dispatch order is unchanged — T28.5.7 already sat in Phase 5 behind the Plan-023-partial substrate, and CP-028-8 adds no YAML gate, since a page mounted before Plan-023's Tier-8 shell exists is unreachable rather than wrong.

- **2026-08-12 — Targeted readiness audit (PR #329, [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-61).** The `draft → review` promotion gate ran per §Preconditions' audit box: 14 findings — 2 critical (F-028-01, no `#### Tasks` block at any Phase; F-028-02, the CP-028-2(b) effective-binding carrier unowned by any upstream plan), 5 major, 7 minor — every one repaired in the same swap. The five audit-grade Tasks blocks (43 tasks, T28.1.1–T28.5.8) landed under §Implementation Phase Sequence; the born-unchecked §Preconditions carrier box holds T28.4.9 alone. Status moved `draft → review`; the `review → approved` promotion remains its own PR citing this audit's REVIEW.md, which rides the audit PR's body per the targeted-delta convention (PR #326/#327 precedent), per §Rollout Order step 2.
- **2026-08-14 — `review → approved` promotion (PR #330).** The §Rollout Order step-2 promotion PR: review notes addressed — the audit's 14 findings were repaired in the audit swap itself, and PR #329 merged with no further reviewer notes — so Status moves `review → approved` citing the NS-61 audit's REVIEW.md (the PR #329 body). Both promotions the §Preconditions audit box requires are complete; code dispatch now rides tier order and this plan's §Preconditions — the born-unchecked carrier box still holds T28.4.9 alone, and every other task is dispatch-eligible in phase order behind Tiers 1–6 execution.
- **2026-08-25 — BL-141 pointer restatement (no Status flip).** §Non-Goals now cites `Spec-028 §ADR Triggers` for the V1.1 relayed-caller authorization model instead of BL-141, which is withdrawn to the backlog archive as a duplicate tracking surface; ADR-025 decides the `runtimenode.*` procedures only and never covered relayed governance mutation, so the trigger stays this spec's own. No task, invariant, or scope change.
- **2026-08-26 — Live-reconcile deferral ruled, not restated ([cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-85).** Status flipped `approved → review` and restored `approved` in the same diff, jointly with Spec-028; both audit-relevant §Preconditions boxes were Re-opened and Delivered in-diff. **Classification: FLIP** per the runbook [§Status Flip Rule](../operations/plan-implementation-readiness-audit-runbook.md) row 4 (behavior change — the live path stops being fixture-only). The deferral's premise was `2.1.210 > 2.1.198`; Spec-005's 2026-08-26 amendment ratifies an admission floor of `2.1.234`, and the control request was measured answering `success` at `2.1.234`, `2.1.245`, and `2.1.246` beside a still-refusing negative control. What survives is a **reachability** caveat, not a version one — a cloud-hosted session refuses control requests a local one answers — so T28.3.2's live-reconcile leg stays, but its fixture arms are **re-cut**: under the ratified floor a below-floor build never reaches this plan's probe at all, because Plan-005's admission gate refuses the attach first, so a `below-floor` arm here would assert against a session that cannot exist and would test that gate rather than this fallback. The arms become `{control-channel reachable, control-channel unreachable-on-an-admitted-build}`, the second instantiated by the documented reachability cases (cloud-hosted / non-streaming / old-SDK), which is what actually drives the live-reconcile fallback; the below-floor refusal is Plan-005 T3.23's test and is not restated here. **This plan also owns the runtime detection of `mcp_set_servers` itself:** Plan-005 keeps `mcp_set_servers` out of the capability-flag set — it is a control-request subtype, not one of the fourteen flags — and guarantees that no driver-side probe issues it, because the operation replaces the full named-server set and an empty-set probe would clear a live session's servers; its live value is obtained here, from this plan's own full-desired-set reconcile, and a refusal there withdraws no capability flag (CP-005-11). The six genuine `2.1.210` upstream-anchor mentions are deliberately **not** swept. **Census: no move** — no task, invariant, obligation of this plan's own, wire member, error code, table, or column is added; the one obligation the ruling names, CP-005-11, is registered on Plan-005's side.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated

- **2026-08-26 — Effective-binding carrier discharge, with an in-swap targeted readiness-audit delta ([cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §6 node NS-86).** The born-unchecked §Preconditions carrier box — open since the 2026-08-12 audit and holding **T28.4.9** — is **discharged**, and Status flip-and-restores `approved → review → approved` in this same swap under the runbook's new-task/new-invariant/new-obligation rule. The box asked for one carrier threaded through two surfaces; the audit's re-examination found the two surfaces have materially different needs, so its criterion was **re-specified** before being checked (the NS-64 precedent — a held selector restated so it becomes satisfiable, never a bare marker flip). **Invocation side:** no carrier at all. The effective binding is a pure function of the post-drift composed-config snapshot this plan already builds at T28.4.6, so new task **T28.4.11** (`effective-binding-resolver.ts`) derives it in-plan — the carrier is made unnecessary rather than registered, and neither Plan-005 nor Plan-015 is touched. `null` is a first-class result meaning _no governed binding_, which is what gives a `NULL` digest meaning. **Receipt-resolution side:** a carrier would not have helped, because recovery has no session and re-resolution is what Spec-015 forbids; the binding identity is therefore **stamped** at receipt write as `command_receipts.mcp_binding_digest` (`b3:`-prefixed keyed BLAKE3 over the RFC 8785 JCS canonicalization of the binding tuple, under a binding-identity subkey of the daemon-held node-local master key — the `McpServerBindingAuditRef.scopeRefDigest` discipline widened from the `scopeRef` to the whole tuple, so no raw filesystem path enters a durable row and the digest is not brute-forceable from a database copy). The digest deliberately **excludes** the config hash, because a binding's config drifts while its identity does not and a drift-triggered revocation must still match receipts stamped before the drift. New invariant **I-028-6** closes the hazard the box had only diagnosed: a receipt stamped `compensable` under a trust revoked minutes later would otherwise be auto-compensated by post-crash recovery under a lapsed authority — a governed weakening outliving its governance, displaced in time. The neutralization is written into **T28.4.4**, the trust service, deliberately rather than into T28.4.5: T28.4.4 is the single revocation writer both entries (operator `mcp.setTrust`, drift auto-revoke) funnel through, so no entry can reach revocation without it and a later third entry inherits it by construction. New obligation **CP-028-7** registers the additive-nullable `command_receipts` EXTEND on the Plan-004-owned table, following the Plan-005 `mcp_task_id` precedent exactly (own migration, no Plan-004 migration edit); Plan-004's Status does not move, the reciprocal being an extender-list row on a table it owns per the CP-007-15 consumer-row precedent. A `§Lock Ordering Across Shared Tables` row was checked for and is **not** owed — all three registrants there lock control-plane Postgres rows, while `command_receipts` and the `mcp_*` tables are local SQLite, whose single-writer transactions cannot deadlock across plans. Spec-028 flip-and-restores in the same swap, carrying both the durable-neutralization rule and the §Non-Goals plane-scoping repair. Census: the SQLite table count is **unmoved** — this adds one nullable column and one partial index, not a table. **Round-1 review additions (Codex, PR #368):** two gaps in this same growth were adjudicated into it rather than deferred. First, the digest column and its partial index had a defining DDL and an invariant reading them but no task creating or populating either — a provenance column that is always `NULL` makes I-028-6's neutralization sweep silently vacuous — so new task **T28.4.12** owns the migration and threads the derived digest into Plan-015's existing receipt INSERT as an argument, opening no second write path. Second, `mcp_binding_digest` is a **keyed** digest, so a revocation matches receipts by recomputing it; losing the binding-identity subkey therefore breaks matching and would leave `compensable` receipts dispatching under an authority the daemon can no longer identify. I-028-6 now treats unmatchable as revoked: with the subkey unavailable, every non-terminal digest-bearing receipt is neutralized to the `manual_reconcile_only` floor and new stamping refuses. No census moves — one additive nullable column on an existing table, already registered under CP-028-7.
