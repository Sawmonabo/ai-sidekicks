# Plan-017: Workflow Authoring And Execution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `017` |
| **Slug** | `workflow-authoring-and-execution` |
| **Date** | `2026-04-14` |
| **Amended** | `2026-04-22` (full engine V1 per [BL-097](../archive/backlog-archive.md) / [ADR-015](../decisions/015-v1-feature-scope-definition.md) amendment — was V1.1-deferred-subset at original approval; absorbs SA-24/29/30/31 per [Spec-017](../specs/017-workflow-authoring-and-execution.md) + [ADR-015 §Amendment History](../decisions/015-v1-feature-scope-definition.md#amendment-history)); 2026-08-10 (Tier-8 plan-readiness audit — promoted `review → approved`; adds `## Implementation Phase Sequence`, `## Invariants`, `## Cross-Plan Obligations`, `## Upstream-Tier Amendments Required`, and the audit-gate Precondition; adds ADR-012 + ADR-017 to Required ADRs; ratifies the three-value workflow-definition scope domain `session` / `project` / `shared` across the spec, the contract doc, and the DDL, with the `scope_ref` companion column and the `(scope, scope_ref, content_hash)` dedupe key that make the tier storable; mints `workflow.definitionList`, the enumeration the declared operation set lacked; adds the visual workflow builder — `Spec-017 §Visual Workflow Builder`, the graph ↔ definition mapping and its refusal set, reference-only tool bindings, canvas layout held outside the hashed definition bytes, copy-on-write editing of `shared` definitions, the canonical definition file form, and the `sidekicks workflow` command set — paired with ADR-026) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-017: Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md) (added by the Tier-8 audit — `human-approval` gates and the per-turn moderation gate are Cedar-evaluated), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) (added by the Tier-8 audit — the 23 workflow event types and the SA-26 dual anchor ride the shared event-sourcing scope), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-026](../decisions/026-visual-node-graph-workflow-authoring.md) (added by the visual-builder amendment — the node-graph authoring surface, the React Flow library adoption, and the canonical-bytes / layout separation; `proposed` — lands with this PR, ratification carried by the scoped box below) |
| **Dependencies** | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (event taxonomy, integrity protocol), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (approval records, Cedar policy), [Plan-014](./014-artifacts-files-and-attachments.md) (artifact manifests, OWASP upload), [Plan-015](./015-persistence-recovery-and-replay.md) (recovery, writer worker, replay), [Plan-016](./016-multi-agent-channels-and-orchestration.md) (channel lifecycle), [Plan-004](./004-queue-steer-pause-resume.md) (queue/steer) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Spec-017](../specs/017-workflow-authoring-and-execution.md) (canonical contract surface; SA-24/29/30/31 narrative); [ADR-015 §Research Conducted](../decisions/015-v1-feature-scope-definition.md#research-conducted) (BL-097 primary-source corpus); see also `## References` at end of file |

## Goal

Implement versioned workflow definitions and durable workflow execution for the full V1 engine — four phase types, four gate types, parallel phases with named pools, and append-only hash-chained approval history — reusing existing session, run, approval, artifact, and recovery primitives.

## Scope

Workflow definition persistence (content-hashed, immutable versions), workflow run state, phase execution for all four V1 phase types (`single-agent`, `multi-agent`, `automated`, `human`), all four gate types, parallel phase execution with `ParallelJoinPolicy`, resource-pool admission, workflow-level gate resolution with per-run hash chain, OWN-only channel linkage, and replay-deterministic projection rebuild.

## Non-Goals

- Marketplace or cross-machine workflow distribution. The `shared` scope tier is node-local reuse breadth, not distribution — a `shared` definition never leaves the daemon that stores it. Cross-machine portability at V1 is the operator-moved file form of `Spec-017 §Definition file form — export and import (C-17)`, not a service.
- External workflow-engine integration
- Workflow editor polish beyond V1 ambition
- BIND channel ownership (V1.1 criterion-gated per ADR-015)
- Cross-node workflow dispatch (Spec-024 V1.1)

## Preconditions

- [x] Paired spec is approved (amended 2026-04-22 for full-engine V1; the 2026-08-10 Tier-8 audit flipped Spec-017 `approved → review` for the ratified three-value scope-domain growth and the visual-builder amendment (`Spec-017 §Visual Workflow Builder`, its scope-ref widening, and the ADR-026 pairing) and restored it `approved` in the same swap under its own targeted coverage — the flip-and-restore-in-one-swap shape, so this box never re-opened)
- [x] Required ADRs are accepted (ADR-015 amended 2026-04-22; ADR-012 + ADR-017 added by the Tier-8 audit, both `accepted`). **Scope clause (2026-08-10, visual-builder amendment):** this box covers the Required-ADRs row's `accepted` entries. ADR-026 lands `proposed` in this same PR and its ratification is **not** carried here — it is carried by the named scoped box below, so this box does not silently assert an acceptance that has not happened.
- [x] Blocking open questions are resolved or explicitly deferred (the two audit-surfaced upstream questions are deferred to named vehicles under `## Upstream-Tier Amendments Required` and gated by the two scoped boxes below)
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-8 audit (2026-08-10), the first-time `review → approved` promotion: 28 findings adjudicated (`A-017-01`…`A-017-29`, `A-017-26` folded into `A-017-01`); six criticals discharged in this swap (phase sequence, invariants, cross-plan obligations, contract-doc staleness, the `phase_type` CHECK, and this checkbox) plus the ratified scope-domain adjudication; two criticals routed to `## Upstream-Tier Amendments Required` per the runbook `§Cross-Tier Amendment Contingency` and mechanically gated by the two scoped boxes below.
- [ ] **Spec-006 workflow event registration landed (A-017-02; Tier-4 upstream delta):** `Spec-006 §Event Type Summary` registers no `workflow` category, while `Spec-017 §Workflow Timeline Integration` declares five categories and 23 `workflow.*` type literals that Plan-006 owns and must register — following the ratified `mcp_governance` + CP-028-1 precedent, moving all three census sites in one PR. A Tier-8 walk never amends a sealed Tier-4 pair, so the registration rides a combined Spec-006/Plan-006 targeted readiness-audit delta, which is what checks this box. Every phase carries a Gate-5 `precondition_box_checked` entry against it: no workflow code dispatches while the taxonomy it emits into is unregistered (Gate 7's governance scan deliberately covers only the plan-template trio, so a scoped box needs the phase-level entries). `CP-017-1` is blocked on this delta.
- [ ] **OWN-channel turn budget provider registered (A-017-07; Tier-6 upstream delta):** `Spec-017 §Interfaces And Contracts` specifies the OWN channel's `turns_per_agent` budget and `Spec-017 §Workflow Timeline Integration` emits progress at 25 / 50 / 75% of it, but no shipped surface provides the value. The ratified resolution is that Plan-016 provides it as a `turnsPerAgent` member on the Plan-016-owned `ChannelConfig`, together with a `InterruptReason` member covering workflow-phase-driven interrupts (the SA-9 `REQUEST_CANCEL` / `TERMINATE` cascade, A-017-14). Plan-017 consumes both and authors neither (cross-plan §2 one-writer); the Plan-016/Spec-016 restoring readiness-audit delta is the vehicle that lands them and checks this box. Phase 3 carries the Gate-5 `precondition_box_checked` entry, and Phases 4–5 chain behind Phase 3 so the auto-walk cannot hop the gate. `CP-017-5` is blocked on this delta.
- [ ] **ADR-026 ratified accepted (visual-builder amendment, 2026-08-10):** ADR-026 governs the node-graph authoring surface — the graph model, the refusal set, reference-only tool bindings, the canonical-bytes / layout separation, and the React Flow library adoption — and lands `proposed` in this same PR, so the Required-ADRs box above deliberately does not carry it (see its scope clause). Until this box is checked, the builder surface does not dispatch: **T1.7, T1.8, T5.5, T5.6, and T5.7** are held, while every pre-amendment task stays dispatch-eligible on its own gates. Phase 1 and Phase 5 each carry a Gate-5 `precondition_box_checked` entry against this box — the two phases that own those tasks — following the admitting-principal carrier-box precedent Plan-012 set for a governance decision that ships alongside the plan it gates. What checks it: ADR-026's `proposed → accepted` promotion.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/workflows/`
- `packages/runtime-daemon/src/workflows/workflow-definition-service.ts`
- `packages/runtime-daemon/src/workflows/workflow-run-service.ts`
- `packages/runtime-daemon/src/workflows/phase-executor.ts`
- `packages/runtime-daemon/src/workflows/parallel-join-resolver.ts`
- `packages/runtime-daemon/src/workflows/resource-pool-admitter.ts`
- `packages/runtime-daemon/src/workflows/gate-chain-writer.ts`
- `packages/runtime-daemon/src/workflows/gate-chain-verifier.ts`
- `packages/runtime-daemon/src/workflows/workflow-projector.ts`
- `packages/runtime-daemon/src/workflows/human-phase-form-service.ts`
- `packages/client-sdk/src/workflowClient.ts`
- `apps/desktop/src/renderer/src/workflows/`
- `apps/desktop/src/renderer/src/workflows/builder/` — the node-graph canvas, node palette, inspector, and connection rules. Sits **under** the Plan-017-owned renderer target area above, so it adds no ownership boundary.
- `apps/cli/src/commands/workflow-*.ts` — the `sidekicks workflow` command files, registered per the established per-file CLI ownership-crossing convention.

`packages/contracts/src/workflows/` above is EXTENDed by the visual-builder amendment with the graph ↔ definition mapping types, the entry record, and the file-form parse / serialize surface; no new package is introduced.

## Data And Storage Changes

- Add the 9-table workflow schema per [Local SQLite Schema §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017) (SA-24): `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_phase_states`, `phase_outputs`, `workflow_gate_resolutions`, `parallel_join_state`, `workflow_channels`, `human_phase_form_state`.
- Source-of-truth hierarchy (SA-25): `session_events` remains canonical; tables 1/2/5/6 are immutable truth, 3/4/7/8/9 are projections rebuildable via Plan-015 `ProjectionRebuild`.
- `workflow_gate_resolutions` carries a per-run BLAKE3 hash chain anchored to `session_events` via dual-anchor payload (`gate_resolution_id` + `row_hash`) on the `workflow.gate_resolved` event (SA-26). Dual-hash: BLAKE3 for daemon-internal identity, SHA-256 reserved for Plan-014 artifact content (SA-27).
- `human_phase_form_state` ships empty at V1; clients persist drafts via localStorage/IndexedDB per [Spec-017 §Ship-empty tables (SA-28)](../specs/017-workflow-authoring-and-execution.md#ship-empty-tables-sa-28). Table reserved for V1.x daemon-side fallback. **Reconciliation with the wire surface (A-017-25, Tier-8 audit):** `HumanPhaseFormDraftSave` is the V1.x-reserved companion of that empty table, not a V1 behavior. Its request/response shape is declared in the contract doc so the V1.x enablement is a pure additive wiring change with no contract break, and no V1 daemon handler is registered for it — the V1 wire surface is the other nine operations. A client that needs draft durability at V1 uses its own local store; the table and the operation light up together in V1.x.
- **Workflow-definition scope domain is three-valued (ratified 2026-08-10, A-017-11):** `session` \| `project` \| `shared`. `session` scopes a definition to its authoring session, `project` spans the sessions of one project, and `shared` is the cross-project tier — a definition authored once and reusable by any project on the same daemon, resolved out of the same local definition store with no additional table and no sync path. Scope identity is carried by a `scope_ref` column alongside `scope`, in the shape `Spec-028 §Unified Inventory` already uses for scope-qualified bindings — the authoring session id at `session`, the canonical repository root (`repo_mounts.canonical_root`) at `project`, the empty string at `shared` — and the dedupe key moves to `(scope, scope_ref, content_hash)` so a definition stored once at a scope is one row regardless of which session submitted it. A `scope`-only widening does not work: `project` would name no project, and a `(session_id, content_hash)` key would partition `shared` definitions by authoring session, so two sessions storing the same shared definition would produce two rows resolution cannot reconcile. `shared` widens **visibility and reuse breadth only**: it is not distribution, not a marketplace, and not cross-machine sync — a `shared` definition never leaves the daemon that stores it, and `Spec-017 §Non-Goals` continues to exclude marketplace/global-library distribution. The `workflow_definitions.scope` column carries the domain (`CHECK(scope IN ('session','project','shared'))`) while `session_id` keeps recording the authoring session at every scope, so provenance survives the widening. The pre-audit `channel` member — which appeared only on the contract doc and the DDL and never in the governing spec — is struck; a channel-scoped definition was never specified and would have collided with the Plan-016 `direct` channel kind's forced `humans-only` audience.
- **Copy-on-write provenance column (visual-builder amendment):** `workflow_definitions.parent_content_hash`, nullable, recording the content hash of the `shared` definition a row was branched from when an author edited a shared definition (T1.7, `Spec-017 §Definition scope in the builder (SA-36)`). It is provenance and **not** part of the hashed body, so a branched definition and a from-scratch definition with identical bodies still carry the same `content_hash` and converge on the dedupe key — the intended behavior, since the two are the same definition. Editing a `shared` definition in place is forbidden by construction: definition rows are immutable and the table carries no updated-at column, so an in-place edit would append a version to the shared definition and silently repoint every project on the daemon that resolves it. No table is added: the nine-table census is unchanged.
- **`workflow_phase_states.phase_type` admits the four V1 phase types only (A-017-08):** `CHECK(phase_type IN ('single-agent','multi-agent','automated','human'))` per [Spec-017 §Phase-Type and Gate-Type Taxonomy](../specs/017-workflow-authoring-and-execution.md#phase-type-and-gate-type-taxonomy). The pre-audit constraint conflated phase types with gate types (`auto-continue`, `human-approval`, `quality-checks`, `done`), carried two values (`gate`, `terminal`) in no taxonomy at all, and omitted `automated` — so an `automated` phase could not be inserted. Gate types live on the gate column, never here.
- **Resource-pool capacities are daemon-config values, not a cross-plan surface (A-017-17):** the SA-3 defaults restated from [Spec-017 §Execution semantics](../specs/017-workflow-authoring-and-execution.md#execution-semantics) — `pty_slots` capacity `min(8, cpu_count * 2)`; `agent_memory_mb` capacity `daemon_budget - overhead ≈ 192 MB` with a pessimistic 100 MB default reservation per `single-agent` phase; `max_concurrent_phases` daemon-global default 4 as the ready-set backstop. Both capacities are read from local daemon configuration and counted by this plan's own admitter — V1 consumes no other plan's pool API, so neither pool adds a dependency row. Should a future PTY host report live slot capacity instead, that becomes a declared consumption at the amendment that introduces it.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions, index rationale, and write-amplification estimates.

## API And Transport Changes

- Add eleven daemon JSON-RPC pairs to shared contracts and the typed client SDK, registered under a new `workflow` method root (root plus camelCase tail, the Plan-016 `channel.rosterRead` / `orchestration.runCreate` convention). The method strings are the wire identity; the PascalCase names are the contract-type names, and the two were unmapped before the Tier-8 audit (A-017-16). Ten were named by the pre-audit plan; the eleventh — `WorkflowDefinitionList` — is minted by this audit, because the declared ten contained no enumeration operation and so no caller could name a definition whose id it did not already hold, which leaves every list view, definition picker, and CLI enumeration surface with nothing to call. Shapes live in [api-payload-contracts.md §Plan-017](../architecture/contracts/api-payload-contracts.md#plan-017--workflow-authoring-and-execution).

| Contract type | Method string | Note |
| --- | --- | --- |
| `WorkflowDefinitionCreate` | `workflow.definitionCreate` | Content-hashes and persists version 1 of a definition |
| `WorkflowDefinitionRead` | `workflow.definitionRead` | Definition header plus current version pointer |
| `WorkflowDefinitionList` | `workflow.definitionList` | **New at the Tier-8 audit** — scope-resolved enumeration, most-specific-first, deduped on `(scope, scope_ref, content_hash)` |
| `WorkflowVersionRead` | `workflow.versionRead` | One immutable version body by content hash |
| `WorkflowRunStart` | `workflow.runStart` | Binds a run to a pinned version |
| `WorkflowRunRead` | `workflow.runRead` | Run header plus per-phase state projection |
| `PhaseOutputRead` | `workflow.phaseOutputRead` | Immutable outputs for one phase run |
| `WorkflowGateResolve` | `workflow.gateResolve` | Appends one gate-resolution row and its dual anchor |
| `HumanPhaseFormDraftSave` | `workflow.humanFormDraftSave` | **V1.x-reserved** — declared, not wired at V1 (SA-28, A-017-25) |
| `HumanPhaseFormSubmit` | `workflow.humanFormSubmit` | Optimistic-concurrency submit; writes `phase_outputs` |
| `WorkflowGateChainVerify` | `workflow.gateChainVerify` | Operator-triggered chain re-verification (CLI backing) |

- Carry workflow version ids, `phase_run_id`s (which double as the channel-owning phase id per SA-6), gate states, and parallel-join resolution through timeline events — 5 categories, 23 event types per `Spec-017 §Workflow Timeline Integration`. Envelope follows [CloudEvents v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) additive-extension rules; semantic-convention naming aligns with [OpenTelemetry Semantic Conventions for Events](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md).
- Event payload schemas evolve additive-MINOR per [ADR-018](../decisions/018-cross-version-compatibility.md); the `row_hash` + `gate_resolution_id` fields on `workflow.gate_resolved` are such an addition, per the SA-26 dual-anchor scheme in [Spec-017 §State And Data Implications](../specs/017-workflow-authoring-and-execution.md#state-and-data-implications).
- Typed refusals per [error-contracts.md](../architecture/contracts/error-contracts.md) §Workflow. That section defines three codes (`workflow.not_found`, `workflow.invalid_phase`, `workflow.gate_closed`) against a surface that refuses in at least thirteen ways — chain-break detection, pool-admission refusal, `fail-fast` sibling abort, `max_phase_transitions` / `max_duration` / `max_concurrent_phases` breach, human-form optimistic-concurrency conflict, definition content-hash mismatch (I-017-5), `ExpressionParseError` (I-017-2), and the four classes the visual-builder amendment adds to the same owed extension rather than to a parallel surface — invalid graph shape (any of the seven refused shapes, I-017-16), scope-ref violation, a tool binding carrying an inline governance facet (I-017-14), and an unknown top-level key in an imported definition file. The extension is owed on that contract doc and is **not taken by this plan** (A-017-15; the file is outside the Tier-8 audit's Plan-017 write scope) — until it lands, no phase may mint an unregistered code, which is the constraint `Spec-017 §Loud-errors discipline (C-12)` already imposes.

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-017 PRs and downstream extensions. Any change that would weaken or remove one requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)). `I-017-1` … `I-017-7` carry the seven SA-13 security invariants of [Spec-017 §Pitfalls To Avoid](../specs/017-workflow-authoring-and-execution.md#pitfalls-to-avoid) into first-class plan ids so every `#### Tasks` block can name the one it discharges; that section states each as non-conformant-if-violated and requires at least one failing test per invariant.

| ID | Invariant | Grounds in | Verified by |
| --- | --- | --- | --- |
| **I-017-1** | Argv-list-only execution: no author-controlled field ever reaches a shell-string command form — no `shell: true`, no `/bin/sh -c`. Shell metacharacters arrive at the process unshelled or the launch refuses. | `Spec-017 §Pitfalls To Avoid` (SA-13 invariant I1) | T2.2, T4.2 |
| **I-017-2** | Typed substitution only: parameter expressions parse to a closed whitelisted AST or throw `ExpressionParseError`. No Jinja2, no `${…}` eval, no Turing-complete expression language over definition strings. | `Spec-017 §Pitfalls To Avoid` (SA-13 invariant I2) | T1.1, T1.5 |
| **I-017-3** | Approver capability is a typed identity-bound capability evaluated through the Plan-012 Cedar path, never a submitter string and never "whoever can read"; an admin override is a distinct audited entry kind. | `Spec-017 §Pitfalls To Avoid` (SA-13 invariant I3); [ADR-012 §Decision](../decisions/012-cedar-approval-policy-engine.md#decision) | T2.3, T3.3 |
| **I-017-4** | Secrets are referenced only (`secret://<scope>/<name>`), resolved at phase launch into env / stdin / named-file fd — never argv, never inline in a definition body, never in an emitted event or artifact. Log redaction is defense-in-depth on top, never the primary control. | `Spec-017 §Pitfalls To Avoid` (SA-13 invariant I4) | T1.1, T2.2 |
| **I-017-5** | External tool references resolve by content address, never by mutable tag; re-resolving a pinned reference whose bytes changed yields a typed `ContentHashMismatch` rather than a silent substitution. | `Spec-017 §Pitfalls To Avoid` (SA-13 invariant I5) | T1.5, T2.2 |
| **I-017-6** | Human-phase uploads clear the Plan-014 OWASP pipeline unchanged — size cap, extension allowlist, magic-byte sniff, storage rename, path validation, AV hook, quarantine-on-fail. Plan-017 consumes that pipeline and reimplements no part of it. | `Spec-017 §Pitfalls To Avoid` (SA-13 invariant I6) | T3.2 |
| **I-017-7** | `workflow_gate_resolutions` is append-only: no row is ever updated or deleted, per-run `sequence` is monotonic from 1, and each row's `row_hash` recomputes from `prev_hash \|\| JCS-canonical(row_body)`. Row-level tampering is detected at daemon start; replay evaluates at-approval-time policy, never current policy. | `Spec-017 §Pitfalls To Avoid` (SA-13 invariant I7); [ADR-017 §Decision](../decisions/017-shared-event-sourcing-scope.md#decision) | T2.3, T5.1, T5.2 |
| **I-017-8** | The SA-20 event-ordering rules hold on every emitted sequence: `workflow.phase_admitted` precedes `workflow.phase_started`; `workflow.phase_cancelling` precedes `workflow.phase_failed` whenever `cancellation_reason` is non-null; a `workflow-phase`-scoped `workflow.gate_resolved` precedes the next `workflow.phase_started`; `workflow.channel_created_for_phase` precedes any event carrying that `channelId`; parallel cancellation emits one coordinator event plus per-sibling chains at a deterministic tick boundary, never mid-callback. | `Spec-017 §Workflow Timeline Integration` (SA-20 ordering invariants) | T2.1, T2.3, T3.1, T4.1 |
| **I-017-9** | The SA-26 dual anchor is a pairing, not a convention: no `workflow_gate_resolutions` row exists without its paired `session_events` row carrying `gate_resolution_id` + `row_hash`, and no such event exists without its row. Both are written by the same Plan-015 writer-worker unit of work, so a partial pair is unreachable rather than merely uncommon. | `Spec-017 §State And Data Implications` (SA-26 hash-chain scheme) | T2.3, T5.2 |
| **I-017-10** | The SA-25 truth/projection split holds: `workflow_definitions`, `workflow_versions`, `phase_outputs`, and `workflow_gate_resolutions` are immutable truth; `workflow_runs`, `workflow_phase_states`, `parallel_join_state`, `workflow_channels`, and `human_phase_form_state` rebuild byte-equal from `session_events` plus the truth tables through the Plan-015 `ProjectionRebuild` path. No projection ever consults request state. | `Spec-017 §State And Data Implications` (SA-25 truth vs projection vs ephemeral) | T1.4, T5.1 |
| **I-017-11** | Replay is deterministic: `phaseRunId` is derived from `BLAKE3(workflowRunId \|\| phaseDefinitionId \|\| attemptNumber)` and never randomly minted, so replaying a run's history reproduces the identical `phaseRunId` sequence and final state without a `DeterminismViolationError`. | `Spec-017 §Deterministic identity (SA-21)` | T1.1, T5.1 |
| **I-017-12** | The phase-type, gate-type, failure-behavior, definition-scope, and run-status domains stay in lockstep across the shared contracts, the DDL CHECK constraints, and the taxonomy — four phase types (`single-agent`, `multi-agent`, `automated`, `human`), four gate types, three failure behaviors, three scope values (`session`, `project`, `shared`), six run statuses (`pending`, `running`, `suspended`, `completed`, `failed`, `cancelled`) — enforced by a conformance suite rather than by comment. | Plan-owned: the taxonomy is governed by `Spec-017 §Phase-Type and Gate-Type Taxonomy` and the scope domain by `Spec-017 §Resolved Questions and V1 Scope Decisions`, but the contract-versus-DDL lockstep **mechanism** is a plan-designed enforcement no governing document requires. | T1.6 |
| **I-017-13** | Definition enumeration never discloses a definition outside the caller's resolved scope set: a `session`-scoped definition reaches only its own session, a `project`-scoped one only sessions of that same `scope_ref` project, and `shared` the whole daemon. The filter is a query-level predicate on `(scope, scope_ref)`, never a post-fetch trim of a wider result set, so a caller in one project cannot observe another project's definitions — including by name, id, or count. | `Spec-017 §Core SDK and persistence contracts` (the `WorkflowDefinitionList` scope-resolution rule added by the same Tier-8 amendment that minted the operation) | T1.5 |
| **I-017-14** | The builder can never author a definition that bypasses tool governance. A tool binding persisted in a workflow definition carries a reference only — the scope-qualified binding identity plus a tool name — and **no** `enabled`, `approvalMode`, or `idempotencyClass` facet. Those three are node-operator surface set exclusively through the Spec-028 override operations under Cedar authorization; a definition carrying one is rejected at parse, not merely ignored at launch, so an imported or hand-edited definition cannot smuggle a weakened posture onto a machine. Effective facets are read-only in the inspector, sourced live from the governance surface. | `Spec-017 §Tool bindings are references, never inline policy (SA-34)`; [Spec-028 §Tool-Level Overrides](../specs/028-mcp-server-configuration-and-governance.md#tool-level-overrides); [Spec-028 §Authorization](../specs/028-mcp-server-configuration-and-governance.md#authorization) | T1.8, T5.5, T5.6 |
| **I-017-15** | Canonical definition bytes are layout-independent. Canvas geometry is excluded from the JCS-canonicalized definition body and from the BLAKE3 hash preimage: moving every node in a definition and re-serializing yields a byte-identical body and an identical content hash, and mints no new version. The exclusion is hash-scope only — no field the engine reads may be relocated into the layout channel. | `Spec-017 §Canvas layout is not definition bytes (SA-35)`; `Spec-017 §Truth vs projection vs ephemeral (SA-25)` | T1.8, T5.5, T5.6 |
| **I-017-16** | Edit-time graph validation mirrors the daemon's definition validation and never substitutes for it. Every refusal rule — cycles, orphans, zero or multiple entry nodes, an inbound edge on the entry node, an outgoing edge from a `done`-gated phase, an unjoined fan-out — is re-evaluated at `workflow.definitionCreate`, whose answer is authoritative. A client that skips or weakens a rule produces a typed refusal, never a persisted definition. No builder-only error code is minted; refusals use the codes registered in `error-contracts.md` §Workflow. | `Spec-017 §Graph shapes that are refused (SA-33)`; `Spec-017 §Loud-errors discipline (C-12)` | T1.8, T5.5, T5.7 |

## Cross-Plan Obligations

Plan-017 declares the following obligations on adjacent plans (or inherits obligations declared by them). Implementation cannot proceed — or must defer specific surfaces — without these being satisfied or explicitly staged. Two of the six are blocked on the sealed-tier deltas recorded under `## Upstream-Tier Amendments Required`.

### CP-017-1 — Event registration (Plan-006)

The five `workflow.*` categories and 23 event type literals enumerated in [Spec-017 §Workflow Timeline Integration](../specs/017-workflow-authoring-and-execution.md#workflow-timeline-integration) are [Plan-006](./006-session-event-taxonomy-and-audit-log.md) registry surface. Plan-017 emits them and registers none itself (cross-plan §2 one-writer). The ratified precedent is the `mcp_governance` row in `Spec-006 §Event Type Summary` paired with Plan-028's CP-028-1: the category and its type literals are registered by a named Plan-006 task, and registration moves all three census sites in one PR — the summary table rows, the `corpus:total-check`-governed in-band total, and Plan-006's prose restatement of the registry census.

**Resolution.** Blocked on the Tier-4 delta named in `## Upstream-Tier Amendments Required`; a return-cite is owed from Plan-006 when that delta lands. Consumed by T1.3, and mechanically held by the `Spec-006 workflow event registration landed` §Preconditions box, whose `precondition_box_checked` entry rides every phase.

### CP-017-2 — Approvals and moderation (Plan-012)

The `human_phase_contribution` approval category (SA-12) and the per-turn moderation gate a `multi-agent` phase fires are [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) surface. Plan-017 writes no Cedar policy, defines no approval category, and implements no gate evaluation — it consumes `PermissionCheckService` and the approval-blocking flow, and the `human-approval` gate type resolves through the same path (I-017-3, ADR-012).

**Resolution.** Consumed by T2.3 (gate evaluation), T3.2 (human-phase submission), and T3.3 (per-turn moderation). Within-tier ordering: T3.3 lands after Plan-012's approval-service phase; a return-cite is owed from Plan-012 at its restoring readiness-audit delta.

### CP-017-3 — Artifact references and upload validation (Plan-014)

`phase_outputs` rows with `value_kind='artifact_ref'` reference [Plan-014](./014-artifacts-files-and-attachments.md) artifact manifests, and human-phase file uploads run Plan-014's OWASP validation pipeline unchanged (I-017-6). Plan-017 stores references, never bytes, and adds no second upload path.

**Resolution.** Consumed by T3.2. SHA-256 stays Plan-014's manifest-content algorithm while BLAKE3 stays daemon-internal identity (SA-27) — the two hashes are a deliberate split, not a drift to reconcile.

### CP-017-4 — Writer worker and projection rebuild (Plan-015)

Every workflow write routes through [Plan-015](./015-persistence-recovery-and-replay.md)'s single writer worker at its 50-event / 10 ms batch cadence — including the SA-26 dual-anchor pair, which must land as one unit of work for I-017-9 to be structural rather than aspirational. The five projection tables rebuild through Plan-015's `ProjectionRebuild` (I-017-10), and restart-safe resumption reuses Plan-015 runtime-binding restore plus `command_receipts` idempotency.

**Resolution.** Consumed by T1.5 (writer routing), T2.3 (dual-anchor unit of work), and T5.1 (rebuild + resumption). No Plan-017 code opens a write transaction of its own.

### CP-017-5 — Channel lifecycle and turn budget (Plan-016)

`workflow_channels.channel_id` is a foreign key into the [Plan-016](./016-multi-agent-channels-and-orchestration.md)-owned `channels` table, and OWN-channel creation and termination invoke Plan-016 channel operations over wire methods and events, never daemon internals — the consuming side of Plan-016's forward-declared CP-016-6, whose return-cite this audit supplies. Two legs are unprovided today: the `turnsPerAgent` budget the OWN channel runs under, and an `InterruptReason` member for workflow-phase-driven interrupts, without which the SA-9 `REQUEST_CANCEL` and `TERMINATE` policies have no Plan-016 mechanism to invoke (A-017-07, A-017-14). `CLOSE_WITH_RECORDS_PRESERVED` maps onto Plan-016's `channel.archive` — non-destructive and terminal, which is exactly "records preserved".

**Resolution.** The mapping leg is stated in `## Implementation Steps` step 3 and consumed by T3.1. The two unprovided legs are blocked on the Tier-6 delta named in `## Upstream-Tier Amendments Required` and mechanically held by the `OWN-channel turn budget provider registered` §Preconditions box, whose `precondition_box_checked` entry rides Phase 3 with Phases 4–5 chained behind it.

### CP-017-6 — Tool-binding resolution and governance (Plan-005 / Plan-028)

A workflow phase's tool bindings resolve through the [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) tool-metadata layer, with per-tool governance facets supplied by the [Plan-028](./028-mcp-server-configuration-and-governance.md) override and trust stores. Plan-017 **consumes** that resolution and authors none of it: it defines no override facet, writes no trust row, evaluates no Cedar policy for tool authorization, and adds no `mcp.*` operation. The definition's persisted binding is an identity reference only (I-017-14); the effective posture is read at launch and refuses there under the existing Spec-028 rules when a binding is untrusted or disabled.

**Resolution.** Not blocked. Plan-028 is a landed Tier-7 leaf and the consumption is read-only, so this obligation is a declared consumption with no upstream delta owed. Consumed by T1.8, T5.5, and T5.6. If a future amendment gives workflow definitions any write into the governance surface, that amendment — not this one — opens the cross-plan write.

## Upstream-Tier Amendments Required

Surfaced by the Tier-8 plan-readiness audit. Neither is amended here, per the runbook `§Cross-Tier Amendment Contingency` — a Tier-N walk never amends a sealed Tier-K, K < N. Each is gated by a named §Preconditions box carrying a Gate-5 `precondition_box_checked` entry, so the deferral is machine-enforced rather than prose-only.

- **Tier 4 — event registration.** `Spec-006 §Event Type Summary` registers no `workflow` category, while `Spec-017 §Workflow Timeline Integration` declares five categories and 23 `workflow.*` type literals that Plan-006 owns. Registration follows the ratified `mcp_governance` + CP-028-1 precedent and moves three census sites in one PR: the summary table rows, the marker-governed in-band total, and Plan-006's prose restatement. Vehicle: a combined Spec-006/Plan-006 targeted readiness-audit delta. `CP-017-1` is blocked on it; the `Spec-006 workflow event registration landed` box gates every phase.
- **Tier 6 — OWN-channel turn budget and workflow interrupt reason.** `Spec-017 §Interfaces And Contracts` specifies `turns_per_agent` for the OWN channel and `Spec-017 §Workflow Timeline Integration` emits progress at 25 / 50 / 75% of that budget, but no `ChannelConfig` field, no `workflow_channels` column, and no Spec-016 default supplies it — and Plan-016's `InterruptReason` is a closed set (`budget_exhausted` / `idle_timeout` / `moderation_denied`) with no member a workflow-phase-driven interrupt can use. The ratified resolution keeps ownership with Plan-016: it adds `turnsPerAgent` to `ChannelConfig` and the workflow interrupt member to `InterruptReason`; Plan-017 sets the former at OWN-channel creation and names the latter in the SA-9 cascade, authoring neither. Vehicle: the Plan-016/Spec-016 restoring readiness-audit delta. `CP-017-5` is blocked on it; the `OWN-channel turn budget provider registered` box gates Phase 3, with Phases 4–5 chained behind Phase 3.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define workflow-definition, version, phase-state, gate, and definition-read contracts in shared packages.
   - Full type hierarchy: `WorkflowDefinition`, `WorkflowVersion`, `WorkflowPhaseDefinition`, `WorkflowRun`, `WorkflowPhaseRun`, `PhaseOutput`, `WorkflowGateResolution`, `ParallelJoinState`.
   - All 4 gate types: `auto-continue`, `quality-checks`, `human-approval`, `done`.
   - Entity separation: `WorkflowPhaseId` (the logical phase in the definition) vs `PhaseRunId` (one specific execution instance, which also anchors the OWN channel 1:1 per SA-6). `PhaseRunId` is **derived, never randomly minted**: every bit is a function of `BLAKE3(workflowRunId || phaseDefinitionId || attemptNumber)` per [Spec-017 §Deterministic identity (SA-21)](../specs/017-workflow-authoring-and-execution.md#deterministic-identity-sa-21). It is therefore **not a ULID** — a ULID's leading 48 bits are a millisecond timestamp, which that preimage cannot produce, so the pre-audit "ULID" wording asserted determinism and a clock at once (A-017-10, Tier-8 audit). Treat it as a derived opaque identifier: the digest's text rendering is not yet ratified and is carried as an entry in `Spec-017 §Open Questions`, so build the derivation behind a single helper (T1.1) that every call site goes through, and do not encode a rendering assumption anywhere else. The storage column is `TEXT` under every candidate rendering, so no schema work waits on the ruling.
   - Failure behaviors per phase: `retry` (new attempt row, C-9), `go-back-to` (bounded by `max_phase_transitions`), `stop`.
2. Implement durable workflow definition versioning and workflow-run persistence. Definition bodies are content-hashed via BLAKE3 over RFC 8785 JCS canonicalization; schema-version marker enforced by CHECK (C-8). All writes route through the Plan-015 single writer worker (50-event / 10 ms batch cadence).
3. Implement phase execution for all four V1 phase types:
   - `single-agent` — one agent, one driver adapter; inherits Plan-015 runtime-binding restore + `command_receipts` idempotency.
   - `multi-agent` — OWN channel 1:1 via `workflow_channels`; cancel cascade honors `CLOSE_WITH_RECORDS_PRESERVED` with a 30s grace window (SA-9). Per-turn moderation gate fires per Plan-012. **SA-9 termination-policy → Plan-016 mechanism mapping (A-017-14, Tier-8 audit — the enum is Plan-017-owned, the mechanisms are not):** `CLOSE_WITH_RECORDS_PRESERVED` invokes Plan-016's `channel.archive`, whose `active`|`muted` → `archived` transition is terminal and non-destructive — exactly "records preserved". `REQUEST_CANCEL` interrupts each in-flight run in the channel through Plan-016's system-intervention path and then archives once the grace window drains; `TERMINATE` skips the grace window and interrupts immediately before archiving. Both cancel policies need an `InterruptReason` member representing a workflow-phase-driven interrupt, which Plan-016's closed set does not yet carry — the CP-017-5 leg blocked on the Tier-6 delta, so the two cancel arms do not dispatch while the `OWN-channel turn budget provider registered` box is unchecked.
   - `automated` — subtype routes `auto-continue` / `quality-checks` / `done`; `quality-checks` writes a gate-resolution row.
   - `human` — form submission writes `phase_outputs` with `value_kind='artifact_ref'` when upload fields present (C-16). `human_phase_contribution` approval category (SA-12) covers non-approval phase submissions. Default timeout semantics per ADR-015 Decision D1: `timeout: "none" | Duration` with no default.
4. Implement `ParallelJoinPolicy` resolver (SA-4): `fail-fast` / `all-settled` / `any-success`. Cancel cascade is tick-synchronous; `cancel_wave_tick` on `parallel_join_state` records the executor tick for audit. Resource-pool admission enforces the `agent_memory_mb` + `pty_slots` pools at the SA-3 default capacities restated in `## Data And Storage Changes` — daemon-config values counted by this plan's own admitter, not another plan's pool API (A-017-17).
5. Implement workflow-gate resolution with append-only hash chain:
   - Writer-worker-only INSERTs to `workflow_gate_resolutions`; per-run `sequence` monotonic from 1.
   - `row_hash = BLAKE3(prev_hash || JCS-canonical(row_body))`; Ed25519 daemon signature over same bytes; optional approver signature.
   - Dual-anchor: every row paired with a `session_events` row (category `workflow_gate_resolution`) carrying `gate_resolution_id` + `row_hash` in payload (SA-26 per [Spec-017 §State And Data Implications](../specs/017-workflow-authoring-and-execution.md#state-and-data-implications)). Row and event land in one Plan-015 writer-worker unit of work, so a partial pair is structurally unreachable (I-017-9).
6. Implement restart-safe workflow resumption and `ProjectionRebuild` integration: projection tables rebuildable from `session_events` via Plan-015; hash-chain replay re-verifies each row in `sequence` order and halts on `chain_break_detected`. Per-row recompute walks `prev_hash || JCS-canonical(row_body)` and asserts equality with the persisted `row_hash` (flat hash-chain pattern per [Local SQLite Schema §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017)).
7. Add `sidekicks workflow verify-gate-chain <run_id>` CLI subcommand exposing the dual-anchor verification procedure.
8. Add desktop workflow authoring, run-detail, and human-phase form surfaces backed by the shared client SDK. Human-phase drafts use localStorage/IndexedDB at V1.
9. Ship the visual workflow builder: the graph ↔ definition mapping and refusal set in shared contracts, copy-on-write editing of `shared` definitions over the `scope_ref` column and three-tier resolution landed in steps 1–2, the canonical definition file form, the React Flow canvas in the renderer, and the `sidekicks workflow` command set (`Spec-017 §Visual Workflow Builder`, ADR-026).

## Implementation Phase Sequence

Authored by the Tier-8 plan-readiness audit (2026-08-10, A-017-01). The five phases map 1:1 onto `## Rollout Order`, absorbing `## Implementation Steps` and `## Target Areas`; each phase carries a reviewer-checkable `**Precondition:**` line plus the machine-readable `preconditions:` block preflight consumes.

Two gates ride every block. The `audit_status` entry records this audit as the phase's readiness evidence. The `Spec-006 workflow event registration landed` box — the Tier-4 delta of `## Upstream-Tier Amendments Required` — gates **all five** phases, because every phase emits into the `workflow.*` taxonomy that delta registers; carrying it on Phase 1 alone would let the auto-walk soft-skip to Phase 2 and dispatch past an unregistered taxonomy. The `OWN-channel turn budget provider registered` box gates Phase 3 specifically, and Phases 2–5 each chain on the preceding phase so the walk cannot hop over it. The `ADR-026 ratified accepted` box, added by the visual-builder amendment, rides Phases 1 and 5 — the two phases that own the five builder tasks — so the builder surface cannot dispatch ahead of ADR-026's promotion while the pre-amendment tasks in those phases stay eligible on their own gates.

### Phase 1 — Contracts, schema, and writer integration

**Goal:** The shared contract surface, the 23 `workflow.*` event payload schemas, the 9-table migration, and definition/run persistence routed through the Plan-015 writer worker — everything later phases import.

**Scope:** `packages/contracts/src/workflows/` (NEW), `packages/runtime-daemon/src/migrations/` (EXTEND), `packages/runtime-daemon/src/workflows/workflow-definition-service.ts` + `workflow-run-service.ts` (NEW). Absorbs `## Implementation Steps` 1–2 plus step 9's contract and persistence legs; Rollout Order item 1.

**Precondition:** Tier-8 plan-readiness audit complete, the Tier-4 Spec-006/Plan-006 `workflow.*` registration delta merged, and — for the two builder tasks T1.7 and T1.8 only — ADR-026 promoted `accepted`.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: precondition_box_checked, box: "Spec-006 workflow event registration landed" }
  - { type: precondition_box_checked, box: "ADR-026 ratified accepted" }
```

#### Tasks

- **T1.1 — Workflow contract core.**
  - **Files:** `packages/contracts/src/workflows/` (NEW).
  - **Provides:** `WorkflowDefinition`, `WorkflowVersion`, `WorkflowPhaseDefinition`, `WorkflowRun`, `WorkflowPhaseRun`, `PhaseOutput`, `WorkflowGateResolution`, `ParallelJoinState` as strict Zod schemas; the four-value phase-type union, the four-value gate-type union, the three-value failure-behavior union, and the three-value definition-scope union (`session` / `project` / `shared`); the single `PhaseRunId` derivation helper (BLAKE3 preimage; the digest's text rendering behind one seam pending the `Spec-017 §Open Questions` ruling) and the closed whitelisted substitution grammar with its `ExpressionParseError` refusal; the `secret://` reference type with no inline-material arm.
  - **Consumes:** `SessionId` branded-id factory (Plan-001, shipped); `ChannelId` (Plan-002, shipped); Plan-014 artifact-reference type (CP-017-3).
  - **Spec coverage:** Spec-017 §Interfaces And Contracts; Spec-017 §Phase-Type and Gate-Type Taxonomy.
  - **Verifies invariant:** I-017-2, I-017-4, I-017-11.
  - **Tests:** acceptance/rejection rows per union member; an inline secret literal is rejected at parse; a non-whitelisted expression throws `ExpressionParseError` rather than evaluating; `phaseRunId` derivation is stable across processes for a fixed preimage and differs on `attemptNumber`; a scope value outside the three-value domain is rejected.
- **T1.2 — Wire request/response pairs + `workflow` method registry.**
  - **Files:** `packages/contracts/src/workflows/` (EXTEND from T1.1).
  - **Provides:** the eleven request/response pairs field-for-field against [api-payload-contracts.md §Plan-017](../architecture/contracts/api-payload-contracts.md#plan-017--workflow-authoring-and-execution), bound to the eleven `workflow.*` method strings registered there; `WorkflowGateResolveResponse` carries the `gateResolutionId` + `rowHash` dual anchor; `WorkflowDefinitionListRequest` / `Response` carry the audit-minted enumeration. `workflow.humanFormDraftSave` is declared without a V1 handler (SA-28, A-017-25).
  - **Consumes:** T1.1 unions and branded ids.
  - **Spec coverage:** Spec-017 §Core SDK and persistence contracts.
  - **Verifies invariant:** I-017-9.
  - **Tests:** request-validation rows per pair; response parity assertions against the contract block; the gate-resolve response rejects a payload missing either anchor field; the list request accepts an omitted `scope` filter and round-trips its `limit` / `cursor` pagination arm while rejecting a cursor of the wrong shape; a `project`-scoped create with no `scopeRef` is a typed schema refusal while `session` and `shared` parse without one; the reserved draft-save method resolves in the registry but has no registered handler.
- **T1.3 — Event payload schemas + union registration.**
  - **Files:** `packages/contracts/src/workflows/` (EXTEND), `packages/contracts/src/event.ts` (EXTEND).
  - **Provides:** payload schemas for all 23 `workflow.*` types across the five categories, and their `SessionEventSchema` union registration, matching the Plan-006-owned registry entries (CP-017-1). The `workflow.gate_resolved` payload carries `gate_resolution_id` + `row_hash` as the additive-MINOR extension under ADR-018.
  - **Consumes:** the Plan-006 event-taxonomy registration named in `## Upstream-Tier Amendments Required` (CP-017-1) — this task does not dispatch until that delta lands.
  - **Spec coverage:** Spec-017 §Workflow Timeline Integration; Spec-017 §Event envelope and category split (SA-18).
  - **Verifies invariant:** I-017-8.
  - **Tests:** the union discriminates all 23 types; each category's members parse and reject strictly; a pre-extension `workflow.gate_resolved` event still parses on replay (ADR-018 back-compat); ordering-rule fixtures reject an admitted-after-started sequence.
- **T1.4 — Migration: the 9-table workflow schema.**
  - **Files:** `packages/runtime-daemon/src/migrations/` (CREATE — next free version at PR-open time), `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND).
  - **Provides:** the nine tables byte-matching [local-sqlite-schema.md §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017) — including the three-value `workflow_definitions.scope` CHECK with its `scope_ref` companion column, the `CHECK((scope = 'shared') = (scope_ref = ''))` ref-presence rule, the `UNIQUE(scope, scope_ref, content_hash)` dedupe key, and the four-value `workflow_phase_states.phase_type` CHECK (A-017-08, A-017-11) — with `human_phase_form_state` created empty per SA-28 and `workflow_channels.channel_id` declared as the foreign key into the Plan-016 `channels` table (CP-017-5).
  - **Consumes:** the Plan-001 migration-runner seam (shipped); the Plan-016 `channels` table (CP-017-5).
  - **Spec coverage:** Spec-017 §State And Data Implications; Spec-017 §Ship-empty tables (SA-28).
  - **Verifies invariant:** I-017-10, I-017-12.
  - **Tests:** migration up plus idempotence; CHECK-rejection rows for a fifth phase type, a gate type supplied as a phase type, and a fourth scope value; a `project`-scoped row with an empty `scope_ref` and a `shared` row with a non-empty one are both rejected; two sessions inserting the same `shared` definition body collide on the dedupe key rather than producing two rows; an `automated` phase inserts successfully (the pre-audit constraint's regression); `human_phase_form_state` exists and is empty after migration; index presence.
- **T1.5 — Definition versioning + run persistence.**
  - **Files:** `packages/runtime-daemon/src/workflows/workflow-definition-service.ts` (NEW), `packages/runtime-daemon/src/workflows/workflow-run-service.ts` (NEW).
  - **Provides:** content-hashed immutable versions (BLAKE3 over RFC 8785 JCS canonicalization) with the schema-version marker enforced by CHECK (C-8); author-time cycle rejection over the phase DAG; content-addressed external tool-reference pinning with a typed `ContentHashMismatch` on re-resolution; run creation binding a run to a pinned version; scope-resolved enumeration behind `workflow.definitionList`, walking `session` then `project` then `shared` most-specific-first and deduping on `(scope, scope_ref, content_hash)`; every write routed through the Plan-015 writer worker at its 50-event / 10 ms batch cadence (CP-017-4).
  - **Consumes:** Plan-015 single writer worker (CP-017-4); T1.1–T1.4.
  - **Spec coverage:** Spec-017 §Required Behavior; Spec-017 §Execution semantics; Spec-017 §Core SDK and persistence contracts.
  - **Verifies invariant:** I-017-2, I-017-5, I-017-13.
  - **Tests:** identical bodies with differing key order hash identically (JCS); a cyclic definition is refused at create, not at launch; editing a definition mints a new version and leaves a running instance on its pinned version; mutating pinned tool bytes yields `ContentHashMismatch`; a create at `project` scope with no `scopeRef` is a typed refusal while `session` and `shared` derive theirs; enumeration from a session in one project returns that session's, that project's, and the daemon's `shared` definitions and none of a second project's — asserted against the emitted query predicate as well as the result set, so a post-fetch trim cannot pass; no service path opens its own write transaction.
- **T1.6 — Contract ↔ DDL conformance suite.**
  - **Files:** `packages/runtime-daemon/src/workflows/__tests__/workflow-schema-conformance.test.ts` (NEW).
  - **Provides:** mechanical lockstep checks between the T1.1 unions and the T1.4 CHECK lists — phase types, gate types, failure behaviors, definition scopes, run statuses, phase-run statuses, and gate-result statuses — so the domains are an enforced pin rather than a documented one. The run-status row pins `WorkflowRunReadResponse.state` against the `workflow_runs.status` CHECK; a start response legitimately narrows to a subset of that domain, so the check is containment for start and equality for read.
  - **Consumes:** T1.1, T1.4.
  - **Spec coverage:** Spec-017 §Phase-Type and Gate-Type Taxonomy; Spec-017 §Resolved Questions and V1 Scope Decisions.
  - **Verifies invariant:** I-017-12.
  - **Tests:** the suite is the test — one row per pinned pair, each failing when either side drifts.
- **T1.7 — Copy-on-write editing and `project → shared` promotion.**
  - **Files:** `packages/contracts/src/workflows/` (EXTEND from T1.1), `packages/runtime-daemon/src/migrations/` (EXTEND the same migration as T1.4), `packages/runtime-daemon/src/workflows/workflow-definition-service.ts` (EXTEND from T1.5).
  - **Provides:** the `parent_content_hash` column on `workflow_definitions` and its `parentContentHash` contract member, recording copy-on-write provenance; the copy-on-write path that turns an edit of a `shared` definition into a **new** definition at the editing context's scope (`project` by default, `session` when there is no project context) carrying the shared original's content hash as its parent, leaving the `shared` row untouched; and `project → shared` promotion as an explicit, separately-invoked operator action that creates the definition at `shared` scope from the promoted version's exact bytes — expressed through the existing `workflow.definitionCreate` operation, so no twelfth method string is minted. The scope-ref column, its ref-presence CHECK, the `(scope, scope_ref, content_hash)` dedupe key, and the most-specific-first resolution order are **not** re-delivered here: they land at T1.4 and T1.5 and this task builds on them.
  - **Consumes:** T1.4 schema and T1.5 definition service; the canonical-root resolution already produced by the repo-mount layer (Plan-009, shipped) for the `project` ref value.
  - **Spec coverage:** Spec-017 §Definition scope in the builder (SA-36); Spec-017 §Resolved Questions and V1 Scope Decisions.
  - **Verifies invariant:** I-017-12, I-017-13.
  - **Tests:** editing a `shared` definition leaves the shared row's version count unchanged and produces a project-scope row whose `parent_content_hash` equals the shared original's content hash; the same edit made with no project context lands at `session` scope; promotion creates a `shared` row from byte-identical bytes, so the promoted definition's content hash equals the source version's; a definition created with no parent carries a null parent hash and still hashes identically to the same bytes created with one, because the parent pointer is provenance and not part of the hashed body.
- **T1.8 — Graph ↔ definition mapping and the refusal set.**
  - **Files:** `packages/contracts/src/workflows/` (EXTEND from T1.1).
  - **Provides:** the total, deterministic mapping between a node graph and a phase sequence in both directions — phase nodes to `PhaseDefinition` entries, sequence edges to phase ordering, fan-out plus join to the parallel construct and its `ParallelJoinPolicy`, and the single mandatory entry record; the gate, agent-assignment, and tool-binding fields as **properties of a phase node** with no independent node identity; the `go-back-to` back-reference as a phase property that is never an edge; the seven-rule refusal set evaluated as a pure function over a graph; and the layout-exclusion boundary as a typed split so the canonicalizer provably cannot see geometry.
  - **Consumes:** T1.1 unions and the phase-type / gate-type domains; the Plan-028-owned `McpServerBindingRef` union that a persisted tool binding composes, and the Spec-005 tool-metadata layer that resolves it at launch (CP-017-6) — neither is re-declared here.
  - **Spec coverage:** Spec-017 §Visual Workflow Builder; Spec-017 §Phase-Type and Gate-Type Taxonomy.
  - **Verifies invariant:** I-017-14, I-017-15, I-017-16.
  - **Tests:** round-trip property — an arbitrary valid phase sequence maps to a graph and back to a byte-identical sequence, and an arbitrary valid graph maps to a sequence and back to an isomorphic graph; each of the seven refusal rules has a minimal rejecting fixture and a minimal accepting neighbor; a cyclic graph and a `go-back-to` drawn as an edge are both rejected before any daemon call; a tool binding carrying an `approvalMode`, an `enabled`, or an `idempotencyClass` value is rejected at parse; perturbing every node coordinate in a definition leaves the canonicalized body byte-identical.

### Phase 2 — Sequential execution and the gate chain

**Goal:** `single-agent` and `automated` phases execute end to end under all four gate types, with the append-only per-run hash chain and its dual anchor writing on every resolution.

**Scope:** `packages/runtime-daemon/src/workflows/phase-executor.ts` (NEW), `gate-chain-writer.ts` (NEW). Absorbs `## Implementation Steps` 3 (`single-agent` and `automated` arms) and 5; Rollout Order item 2.

**Precondition:** Phase 1 merged; the Tier-4 Spec-006/Plan-006 registration delta merged; Plan-012's approval-service phase shipped for the `human-approval` gate arm (CP-017-2).

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: precondition_box_checked, box: "Spec-006 workflow event registration landed" }
  - { type: plan_phase, plan: 17, phase: 1, status: merged }
```

#### Tasks

- **T2.1 — Sequential phase executor + `single-agent` arm.**
  - **Files:** `packages/runtime-daemon/src/workflows/phase-executor.ts` (NEW).
  - **Provides:** the Kahn-style ready-set tick loop over the phase DAG; the `single-agent` arm (one agent, one driver adapter) inheriting Plan-015 runtime-binding restore and `command_receipts` idempotency; `workflow.phase_*` emission in SA-20 order; `workflow.phase_progressed` at turn-completion and tool-invocation boundaries.
  - **Consumes:** T1.1–T1.5; Plan-015 runtime-binding restore (CP-017-4).
  - **Spec coverage:** Spec-017 §Execution semantics; Spec-017 §Default Behavior.
  - **Verifies invariant:** I-017-8.
  - **Tests:** ready-set admission order is deterministic for a fixed DAG; `phase_admitted` always precedes `phase_started`; a restart mid-phase resumes without duplicating a command receipt; progressed cadence fires on both named boundaries and nowhere else.
- **T2.2 — `automated` phase arm.**
  - **Files:** `packages/runtime-daemon/src/workflows/phase-executor.ts` (EXTEND from T2.1).
  - **Provides:** the `automated` arm routing `auto-continue` / `quality-checks` / `done` gate subtypes, with `quality-checks` writing a gate-resolution row; argv-list-only process launch for every automated command (no shell string, no `shell: true`); secrets resolved at phase launch into env / stdin / named-file fd and never into argv; content-addressed tool pins resolved before launch.
  - **Consumes:** T2.1; T1.5 pin resolution.
  - **Spec coverage:** Spec-017 §Quality-Check Model; Spec-017 §Output Mode Specification.
  - **Verifies invariant:** I-017-1, I-017-4, I-017-5.
  - **Tests:** a command carrying shell metacharacters reaches argv unshelled; a launch attempted through a shell string is refused; a canary secret never appears raw, base64-encoded, URL-encoded, or JSON-stringified in argv, logs, or emitted events; a `quality-checks` gate writes exactly one resolution row.
- **T2.3 — Gate-chain writer + dual anchor.**
  - **Files:** `packages/runtime-daemon/src/workflows/gate-chain-writer.ts` (NEW).
  - **Provides:** writer-worker-only INSERTs into `workflow_gate_resolutions` with per-run `sequence` monotonic from 1; `row_hash = BLAKE3(prev_hash || JCS-canonical(row_body))` plus an Ed25519 daemon signature over the same bytes and an optional approver signature; the paired `session_events` row carrying `gate_resolution_id` + `row_hash` written in the same unit of work; `human-approval` gates resolved through the Plan-012 Cedar path with admin override recorded as a distinct entry kind.
  - **Consumes:** Plan-015 writer worker (CP-017-4); Plan-012 `PermissionCheckService` and approval-blocking flow (CP-017-2).
  - **Spec coverage:** Spec-017 §State And Data Implications; Spec-017 §Workflow gate scope vs channel gate scope (SA-7).
  - **Verifies invariant:** I-017-3, I-017-7, I-017-8, I-017-9.
  - **Tests:** an UPDATE or DELETE against a resolution row is refused; a gap or repeat in `sequence` is rejected; a row written without its paired event (and the converse) is unreachable — the failure injection rolls back both; an approver lacking the typed capability is denied and a bare read capability never suffices; an admin override lands as its own audited entry.
- **T2.4 — Bounds, retries, and typed refusals.**
  - **Files:** `packages/runtime-daemon/src/workflows/phase-executor.ts` (EXTEND from T2.2).
  - **Provides:** `retry` (new attempt row, C-9), `go-back-to` bounded by `max_phase_transitions`, and `stop`; `max_duration` and `max_concurrent_phases` breach handling with a preserved `failure_reason`; every refusal surfaced as a typed error from the registered §Workflow vocabulary — this task mints no code of its own (A-017-15).
  - **Consumes:** T2.1–T2.3.
  - **Spec coverage:** Spec-017 §Fallback Behavior; Spec-017 §Loud-errors discipline (C-12).
  - **Verifies invariant:** I-017-2, I-017-11.
  - **Tests:** each bound hard-fails with `failure_reason` preserved; a retry mints a new attempt row and a new derived `phaseRunId` while leaving the prior attempt's outputs immutable; an unknown phase reference, unknown pool, or unknown approver principal fails loudly at create or launch rather than no-op'ing.

### Phase 3 — Multi-agent OWN channel and human phase

**Goal:** `multi-agent` phases run in phase-owned channels with the SA-9 termination cascade, and `human` phases accept form submissions as durable phase outputs.

**Scope:** `packages/runtime-daemon/src/workflows/human-phase-form-service.ts` (NEW), the `workflow_channels` linkage, and the `multi-agent` / `human` arms of the executor. Absorbs `## Implementation Steps` 3 (`multi-agent` and `human` arms); Rollout Order item 3.

**Precondition:** Phase 2 merged; the Tier-4 registration delta merged; the Tier-6 Plan-016/Spec-016 delta merged, supplying the `ChannelConfig.turnsPerAgent` budget and the workflow `InterruptReason` member (CP-017-5); Plan-012's approval-service phase and Plan-014's artifact pipeline shipped (CP-017-2, CP-017-3).

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: precondition_box_checked, box: "Spec-006 workflow event registration landed" }
  - { type: precondition_box_checked, box: "OWN-channel turn budget provider registered" }
  - { type: plan_phase, plan: 17, phase: 2, status: merged }
```

#### Tasks

- **T3.1 — `multi-agent` arm: OWN channel lifecycle.**
  - **Files:** `packages/runtime-daemon/src/workflows/phase-executor.ts` (EXTEND from T2.4).
  - **Provides:** 1:1 OWN-channel creation per phase run through Plan-016 wire methods, recorded on `workflow_channels`; the channel's turn budget set from the Plan-016-provided `ChannelConfig.turnsPerAgent`; `workflow.phase_progressed` at channel-turn boundaries and 25 / 50 / 75% budget milestones; the SA-9 termination cascade mapping `CLOSE_WITH_RECORDS_PRESERVED` / `REQUEST_CANCEL` / `TERMINATE` onto Plan-016 archive and interrupt mechanisms with the 30s grace window; transcript hand-off to the next phase via `inheritContext`.
  - **Consumes:** Plan-016 channel creation, archive, and interrupt surfaces plus the `turnsPerAgent` and workflow `InterruptReason` legs (CP-017-5) — the two legs gate this task through the §Preconditions box above; no Plan-016 daemon internals are imported.
  - **Spec coverage:** Spec-017 §Interfaces And Contracts; Spec-017 §Discussion Integration Path.
  - **Verifies invariant:** I-017-8.
  - **Tests:** exactly one channel per phase run and none on a retry that reuses the prior attempt's records; `channel_created_for_phase` precedes every event carrying that `channelId`; each termination policy invokes its mapped mechanism and no other; the grace window drains before archive on `REQUEST_CANCEL` and is skipped on `TERMINATE`; the next phase receives the transcript through `inheritContext`.
- **T3.2 — Human-phase form service.**
  - **Files:** `packages/runtime-daemon/src/workflows/human-phase-form-service.ts` (NEW).
  - **Provides:** `workflow.humanFormSubmit` handling with optimistic-concurrency conflict detection; submissions written as `phase_outputs`, with upload fields stored as `value_kind='artifact_ref'` pointing at Plan-014 manifests (C-16); typed `timeout: 'none' | Duration` with no field-level default (ADR-015 Decision D1); claim / re-claim and `workflow.phase_suspended` with `reason: 'waiting-human'`. No daemon-side draft persistence — `human_phase_form_state` stays empty at V1 (SA-28).
  - **Consumes:** Plan-014 artifact manifests and the OWASP upload pipeline, unchanged (CP-017-3); Plan-012 approval categories for `human_phase_contribution` (CP-017-2).
  - **Spec coverage:** Spec-017 §Interfaces And Contracts; Spec-017 §Ship-empty tables (SA-28).
  - **Verifies invariant:** I-017-6, I-017-10.
  - **Tests:** the OWASP battery — zip bomb, polyglot, symlink traversal, oversize, mismatched `Content-Type` — quarantines through Plan-014's pipeline with no second validation path in this service; a stale submit is refused rather than silently overwriting; a submission with no explicit `timeout` is refused at definition create; `human_phase_form_state` holds zero rows after a full human-phase lifecycle.
- **T3.3 — Per-turn moderation gate wiring.**
  - **Files:** `packages/runtime-daemon/src/workflows/phase-executor.ts` (EXTEND from T3.1).
  - **Provides:** the per-turn moderation gate fired through Plan-012 for `multi-agent` phase turns, and the `human_phase_contribution` approval category (SA-12) covering non-approval phase submissions; a denial discards the buffered turn output rather than appending it.
  - **Consumes:** Plan-012 `PermissionCheckService` and the approval-blocking flow (CP-017-2).
  - **Spec coverage:** Spec-017 §Interfaces And Contracts; Spec-017 §Loud-errors discipline (C-12).
  - **Verifies invariant:** I-017-3.
  - **Tests:** the gate resolves before the turn's output is appended; a denial leaves no output event; the approval category is Plan-012-defined and never minted here; a moderation refusal is a typed error, never a silent skip.

### Phase 4 — Parallel execution and pool admission

**Goal:** Parallel phase blocks execute under `ParallelJoinPolicy` with a deterministic tick-synchronous cancel wave, gated by named resource-pool admission.

**Scope:** `packages/runtime-daemon/src/workflows/parallel-join-resolver.ts` (NEW), `resource-pool-admitter.ts` (NEW). Absorbs `## Implementation Steps` 4; Rollout Order item 4.

**Precondition:** Phase 3 merged; the Tier-4 registration delta merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: precondition_box_checked, box: "Spec-006 workflow event registration landed" }
  - { type: plan_phase, plan: 17, phase: 3, status: merged }
```

#### Tasks

- **T4.1 — `ParallelJoinPolicy` resolver.**
  - **Files:** `packages/runtime-daemon/src/workflows/parallel-join-resolver.ts` (NEW).
  - **Provides:** `fail-fast` / `all-settled` / `any-success` resolution (SA-4); a tick-synchronous cancel cascade recorded with `cancel_wave_tick` on `parallel_join_state`; one coordinator `workflow.parallel_join_cancellation` event plus per-sibling chains at the tick boundary; `workflow.phase_failed` extended with `cancellation_reason`.
  - **Consumes:** T2.1 executor tick loop; T1.3 event schemas.
  - **Spec coverage:** Spec-017 §Execution semantics; Spec-017 §Example Flows.
  - **Verifies invariant:** I-017-8, I-017-10.
  - **Tests:** each policy's settle semantics over a five-sibling block; `fail-fast` cancels siblings at one deterministic tick and never from an async callback; the cancel wave records one coordinator event; `cancelling` precedes each sibling's `failed` when `cancellation_reason` is non-null; `parallel_join_state` rebuilds byte-equal from the log.
- **T4.2 — Resource-pool admitter.**
  - **Files:** `packages/runtime-daemon/src/workflows/resource-pool-admitter.ts` (NEW).
  - **Provides:** admission against the `agent_memory_mb` and `pty_slots` pools at the SA-3 default capacities, with `max_concurrent_phases` as the ready-set backstop; `workflow.phase_admitted` on grant and `workflow.phase_waiting_on_pool` on entry-to-blocked plus 30-second intervals while blocked, carrying `waitingSinceSeq`; aggregate `totalPoolWaitMs` on the phase row rather than per-wait rows; pool reservations held in memory and re-requested after restart (SA-3 ephemeral tier). Every admitted launch goes out argv-list-only.
  - **Consumes:** daemon configuration for pool capacities (no cross-plan pool API at V1, A-017-17); T4.1 tick boundary.
  - **Spec coverage:** Spec-017 §Execution semantics; Spec-017 §Fallback Behavior.
  - **Verifies invariant:** I-017-1, I-017-8.
  - **Tests:** a saturated pool blocks launch and emits the waiting event at entry and on the 30s cadence; admitted always precedes started; the tripwire threshold fires on the rolling window; restart drops reservations and re-requests rather than restoring stale counts; the ready-set backstop caps concurrency independently of pool capacity.

### Phase 5 — Resumption, verification CLI, and authoring surfaces

**Goal:** Workflows survive daemon restart with phase state intact, the gate chain is operator-verifiable end to end, and the SDK plus desktop surfaces expose authoring, run detail, and human-phase forms.

**Scope:** `packages/runtime-daemon/src/workflows/gate-chain-verifier.ts` (NEW), `workflow-projector.ts` (NEW), `packages/client-sdk/src/workflowClient.ts` (NEW), `apps/desktop/src/renderer/src/workflows/` (NEW), `apps/desktop/src/renderer/src/workflows/builder/` (NEW), `apps/cli/src/commands/workflow-*.ts` (NEW). Absorbs `## Implementation Steps` 6–8 (A-017-09 assigns steps 6 and 7 here) plus step 9's renderer, file-form, and CLI legs; Rollout Order item 5.

**Precondition:** Phase 4 merged; the Tier-4 registration delta merged; and — for the three builder tasks T5.5, T5.6, and T5.7 only — ADR-026 promoted `accepted`.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: precondition_box_checked, box: "Spec-006 workflow event registration landed" }
  - { type: precondition_box_checked, box: "ADR-026 ratified accepted" }
  - { type: plan_phase, plan: 17, phase: 4, status: merged }
```

#### Tasks

- **T5.1 — Restart-safe resumption + projection rebuild.**
  - **Files:** `packages/runtime-daemon/src/workflows/workflow-projector.ts` (NEW).
  - **Provides:** the five projection tables rebuilt from `session_events` plus the immutable truth tables through Plan-015 `ProjectionRebuild`; restart-safe resumption emitting `workflow.resumed` with the structured `resumptionPoint: {activePhaseRunIds, pendingGates}`; hash-chain replay re-verifying each row in `sequence` order and halting on `chain_break_detected`; replay driven only by derived `phaseRunId`s so a re-run reproduces the identical sequence.
  - **Consumes:** Plan-015 `ProjectionRebuild` and recovery surfaces (CP-017-4); T2.3 chain layout.
  - **Spec coverage:** Spec-017 §State And Data Implications; Spec-017 §Deterministic identity (SA-21).
  - **Verifies invariant:** I-017-7, I-017-10, I-017-11.
  - **Tests:** rebuild is byte-equal to the pre-restart projection; a tampered row halts replay at its `sequence` rather than at the end; replay of a full history throws no `DeterminismViolationError` and `deepEqual`s the original final state; no projection path reads request state.
- **T5.2 — Gate-chain verifier + CLI.**
  - **Files:** `packages/runtime-daemon/src/workflows/gate-chain-verifier.ts` (NEW), the `sidekicks workflow verify-gate-chain <run_id>` subcommand.
  - **Provides:** the operator-triggered dual-anchor verification procedure — per-row recompute of `prev_hash || JCS-canonical(row_body)` asserted equal to the persisted `row_hash`, plus the paired `session_events` row's `gate_resolution_id` and `row_hash` cross-check — surfaced through `workflow.gateChainVerify` and the CLI subcommand, reporting the first divergent `sequence` rather than a bare pass/fail.
  - **Consumes:** T2.3 chain layout; T5.1 replay path.
  - **Spec coverage:** Spec-017 §State And Data Implications; Spec-017 §Loud-errors discipline (C-12).
  - **Verifies invariant:** I-017-7, I-017-9.
  - **Tests:** a clean chain verifies; a mutated row body, a re-signed row, and a deleted paired event each fail with the offending `sequence` named; verification cost stays linear in row count and runs outside the hot path.
- **T5.3 — Typed client SDK.**
  - **Files:** `packages/client-sdk/src/workflowClient.ts` (NEW).
  - **Provides:** typed callers for the eleven `workflow.*` methods, marshalling and never deriving — no client-side gate evaluation, no client-side admission outcome, no client-side chain verification.
  - **Consumes:** T1.2 wire pairs.
  - **Spec coverage:** Spec-017 §Core SDK and persistence contracts.
  - **Verifies invariant:** I-017-12.
  - **Tests:** each method round-trips its declared pair; refusals surface verbatim with no client-side retry; the reserved draft-save method is typed but unwired at V1.
- **T5.4 — Desktop authoring, run detail, and human-phase surfaces.**
  - **Files:** `apps/desktop/src/renderer/src/workflows/` (NEW).
  - **Provides:** the workflow authoring surface, run-detail rendering with phases as distinct timeline sections and retry iterations as sub-entries, the pending-human count surfaced prominently, and the human-phase form with local draft persistence via localStorage / IndexedDB (SA-28). The node-graph builder canvas itself is T5.5; T5.4 establishes the workflows view shell, run detail, and the human-phase form that the builder mounts inside.
  - **Consumes:** T5.3 SDK; the Plan-023 renderer bridge substrate.
  - **Spec coverage:** Spec-017 §Session timeline surfacing; Spec-017 §Output Mode Specification.
  - **Verifies invariant:** I-017-6, I-017-12.
  - **Tests:** phases render as distinct sections with retries nested; a suspended-waiting-human phase surfaces in the pending count; drafts survive a renderer reload without any daemon write; an upload rejected by the daemon pipeline renders its typed refusal rather than a generic failure.
- **T5.5 — Visual workflow builder canvas.**
  - **Files:** `apps/desktop/src/renderer/src/workflows/builder/` (NEW), `apps/desktop/package.json` (EXTEND — adds the React Flow renderer dependency whose adoption ADR-026 governs).
  - **Provides:** the node-graph authoring view built on React Flow in fully controlled mode — nodes and edges held in application state, all mutations flowing through the change handlers, connection attempts screened by the validation predicate so a refused connection cannot be completed; a node palette offering exactly the four phase types plus the entry node; custom node renderers per phase type with gate, agent, and tool-binding badges; an inspector panel writing phase properties and displaying governance facets read-only per I-017-14; canvas pan and zoom with a persisted viewport; deterministic topological auto-layout for a definition with no stored geometry; and client-local layout persistence on the SA-28 tier.
  - **Consumes:** T5.3 SDK (`workflow.definitionCreate`, `workflow.definitionRead`, `workflow.versionRead`, and `workflow.definitionList`); T1.8 mapping and refusal set; T1.7 copy-on-write path; the Plan-023 renderer bridge substrate. The builder reaches the daemon only through the preload bridge and imports no Node, Electron, main-process, or preload module.
  - **Spec coverage:** Spec-017 §Visual Workflow Builder; Spec-017 §Ship-empty tables (SA-28).
  - **Verifies invariant:** I-017-14, I-017-15, I-017-16.
  - **Tests:** a connection that would close a cycle, orphan a phase, target the entry node, or leave a `done`-gated phase is refused by the connection predicate and never enters edge state; the palette offers no node kind outside the four phase types and the entry node; dragging every node and reloading restores geometry with no daemon write and no new version; a definition read with no stored geometry renders identically across two runs of the auto-layout; the inspector exposes no writable control for `enabled`, `approvalMode`, or `idempotencyClass`; a daemon refusal on save renders its typed code rather than a generic failure; the renderer lint boundary rejects any Node or Electron import added under the builder subtree.
- **T5.6 — Definition file form: export and import.**
  - **Files:** `packages/contracts/src/workflows/` (EXTEND from T1.8), `packages/client-sdk/src/workflowClient.ts` (EXTEND from T5.3).
  - **Provides:** the canonical YAML file form carrying the schema-version marker — the definition body plus an optional top-level `layout` section outside the hashed bytes — with serialize and parse as the single dialect shared by the desktop builder and the CLI; parse feeds the ordinary definition-create validation path, so an imported definition is subject to every refusal rule and carries no governance state.
  - **Consumes:** T1.8 mapping; T1.2 wire pairs.
  - **Spec coverage:** Spec-017 §Definition file form — export and import (C-17); Spec-017 §Visual Workflow Builder.
  - **Verifies invariant:** I-017-14, I-017-15.
  - **Tests:** export → import → export is byte-stable and the content hash is identical at every hop; a file whose `layout` section is stripped imports to the same content hash as the file that carried it; a file with an unknown top-level key is refused rather than silently accepted; a file carrying an inline governance facet is refused at parse; a CLI-produced file with no `layout` opens in the builder through auto-layout and re-exports to the same body bytes.
- **T5.7 — `sidekicks workflow` command set.**
  - **Files:** `apps/cli/src/commands/workflow-list.ts` (NEW), `workflow-show.ts` (NEW), `workflow-start.ts` (NEW), `workflow-status.ts` (NEW), `workflow-export.ts` (NEW), `workflow-import.ts` (NEW), `apps/cli/src/main.ts` (EXTEND — explicit registration, no auto-discovery).
  - **Provides:** CLI parity with the builder over the same typed SDK operations — `workflow list` over `workflow.definitionList`, `workflow show` over `workflow.definitionRead` plus `workflow.versionRead`, `workflow start` over `workflow.runStart`, `workflow status` over `workflow.runRead`, `workflow export` as a client-side serialization of a version read, and `workflow import` as a submission through `workflow.definitionCreate`. Scope is a flag on `list`, `start`, and `import`, defaulting to most-specific-first resolution. Commands marshal and never derive: no client-side validation verdict is treated as authoritative, and every refusal surfaces verbatim. The `verify-gate-chain` subcommand of T5.2 joins the same command root.
  - **Consumes:** T5.3 SDK; T5.6 file form; the Plan-007 CLI scaffold and command-registration seam.
  - **Spec coverage:** Spec-017 §Definition file form — export and import (C-17); Spec-017 §Core SDK and persistence contracts.
  - **Verifies invariant:** I-017-16.
  - **Tests:** each verb round-trips its named operation against a fake transport; `list` groups by scope and reports the tier each definition resolves from; `import` of a file the daemon refuses exits non-zero with the typed code and creates nothing; `export` of a definition authored in the builder and `import` of it on a fresh store yields the identical content hash; no command imports anything outside the CLI's declared import-isolation allowlist.

## Parallelization Notes

- Within Phase 1, T1.1 gates everything; T1.2, T1.3, and T1.4 then proceed in parallel, with T1.5 joining after T1.4 and T1.6 last (it asserts T1.1 against T1.4).
- Within Phase 1, T1.7 joins after T1.5 (it extends both T1.4's migration and T1.5's definition service) and T1.8 after T1.1; both land before T1.6, which stays last so it asserts the final contract-versus-DDL state.
- Within Phase 2, T2.3 (gate-chain writer) is independent of T2.2 (the `automated` arm) once T2.1 lands; T2.4 joins both.
- Phase 4's two tasks are independent of the Phase 2 gate-chain path and of each other until the tick boundary is shared — T4.1 owns the tick, so T4.2 lands after it.
- Within Phase 5, T5.1 and T5.2 are sequential (the verifier reuses the replay path); T5.3 may start once Phase 1's wire pairs are merged, but T5.4 waits for T5.3 and for phase-output and restart-resume semantics to stabilize.
- Within Phase 5, T5.6 follows T5.3, T5.5 follows T5.6 and T5.4 (it renders inside the surface T5.4 establishes), and T5.7 follows T5.6 but is independent of T5.5 — the CLI and the canvas are two consumers of one file form and may proceed in parallel.
- Across phases the sequence is strictly ordered by the `plan_phase` chain in each phase's `preconditions:` block — this plan's parallelism is intra-phase only (A-017-20 restates the pre-audit work-stream framing in phase terms).

## Test And Verification Plan

Five test categories (SA-29): property-based, fuzz, load, long-running integration, security regression. Each carries a V1 _ambition level_ so the category can be stop-marked independently. Replay-determinism scaffolding follows the Temporal `runReplayHistory` pattern; property + fuzz frameworks pinned to `fast-check` and `@jazzer.js/core`; CVE-reproducer corpus seeds the security-regression battery (SA-30).

| Category | Covers | V1 Ambition | CI Cadence | First runnable at |
| --- | --- | --- | --- | --- |
| Property-based (`fast-check` v4.x) | DAG acyclicity, ready-set determinism, `max_phase_transitions` / `max_duration`, `ParallelJoinPolicy` semantics, retry-re-entry stability, graph ↔ definition round-trip over generated valid definitions and generated valid graphs (T1.8), and layout-perturbation canonical-byte stability under arbitrary geometry (I-017-15) | **Hardened** — adversarial + concurrency | PR (numRuns=100); nightly (numRuns=10 000) | Phase 1 (definition-level properties, T1.5; graph round-trip and layout-perturbation properties, T1.8); extended at Phase 2 (T2.4) and Phase 4 (T4.1) |
| Fuzz (`@jazzer.js/core` v4.x) | Workflow-definition parser, expression grammar (I-017-2), secrets resolver (I-017-4) | **Foundational+** — 15 min/target per PR; 2 h/target nightly | PR (15 min/target) + nightly (2 h/target) | Phase 1 (T1.1 grammar and secret-reference targets; T1.5 definition parser) |
| Load | Parallel executor contention, resource-pool admission, `max_concurrent_phases` backstop, SQLite write-amp | **Foundational** — baseline regression only, no SLO gate | Nightly | Phase 4 (T4.1, T4.2 — the write-amp reading feeds the `## Risks And Blockers` calibration trigger) |
| Long-running integration (`@playwright/test` v1.58.x + real daemon) | Multi-day `human` phase resume, checkpoint/replay determinism, multi-agent channel lifecycle, optimistic-concurrency on human submit | **Hardened** — compressed-time nightly + real-time weekly | Nightly (compressed) + weekly (real-time) | Phase 3 (T3.1, T3.2); replay-determinism arm joins at Phase 5 (T5.1) |
| Security regression | Per-invariant I-017-1…I-017-7 battery with CVE-reproducer corpora (SA-30) | **Hardened** — full battery gates merge | PR + merge | Rows land with the task that first makes each invariant reachable — see the phase column below |

Tool pins follow the repo convention of naming the CI-pinned line in the cell (A-017-19); `@playwright/test` v1.58.x is the line [Plan-023](./023-desktop-shell-and-renderer.md) already pins for the desktop E2E harness, so the two suites share one Playwright version.

**Security regression battery (SA-30) — per-invariant CVE corpora.** The plan-side invariant ids are the `## Invariants` entries; the parenthesized `I1`–`I7` are the `Spec-017 §Pitfalls To Avoid` labels they carry. The Phase column discharges A-017-18 — each row lands with the task that first makes the invariant reachable, so no battery row is orphaned from a phase.

| Invariant | Assertion | CVE / source seed | Phase |
| --- | --- | --- | --- |
| I-017-1 (I1) — argv-list-only execution | Semgrep rule bans `exec`/`shell:true`; dynamic test proves shell metachars reach argv unshelled | Generic shell-injection corpus | Phase 2 (T2.2); re-asserted at Phase 4 (T4.2) |
| I-017-2 (I2) — typed substitution, no eval | Every expression payload either parses to whitelisted AST or throws `ExpressionParseError` | n8n [CVE-2025-68613](https://github.com/advisories/GHSA-v98v-ff95-f3cp); Airflow [CVE-2024-39877](https://nvd.nist.gov/vuln/detail/CVE-2024-39877); Airflow [CVE-2024-56373](https://nvd.nist.gov/vuln/detail/CVE-2024-56373); Jenkins `CVE-2024-34144` / `CVE-2024-34145` | Phase 1 (T1.1, T1.5) |
| I-017-3 (I3) — typed approver capability | Cedar capability check; admin override logged as distinct entry kind | Plan-012 policy corpus | Phase 2 (T2.3); Phase 3 (T3.3) |
| I-017-4 (I4) — secrets never in argv/logs/artifacts | Canary secret never appears raw / base64 / URL-encoded / JSON-stringified | Airflow `#54540` masker-bypass reproducer | Phase 1 (T1.1); Phase 2 (T2.2) |
| I-017-5 (I5) — content-addressed external refs | Mutating pinned tool bytes yields `ContentHashMismatch` | GitHub Actions v3→v4 artifact mutability precedent | Phase 1 (T1.5); Phase 2 (T2.2) |
| I-017-6 (I6) — human-phase OWASP uploads | Zip bomb, polyglot, symlink-traversal, oversize, mismatched Content-Type all quarantined | Argo [CVE-2025-66626](https://nvd.nist.gov/vuln/detail/CVE-2025-66626); [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) | Phase 3 (T3.2); rendering arm at Phase 5 (T5.4) |
| I-017-7 (I7) — append-only hash-chained approval log | Row-level tampering detected at daemon start; replay uses at-approval-time policy | Crosby & Wallach 2009 flat-chain pattern; Spec-006 integrity protocol | Phase 2 (T2.3); detection arms at Phase 5 (T5.1, T5.2) |

The nine non-security invariants are exercised alongside: I-017-8 (SA-20 ordering) at T2.1 / T2.3 / T3.1 / T4.1, I-017-9 (SA-26 dual anchor) at T2.3 / T5.2, I-017-10 (SA-25 truth vs projection) at T1.4 / T3.2 / T4.1 / T5.1, I-017-11 (SA-21 replay determinism) at T1.1 / T2.4 / T5.1, I-017-12 (domain lockstep) at T1.6 / T1.7 / T5.3 / T5.4, I-017-13 (enumeration visibility) at T1.5, I-017-14 (tool-governance non-bypass) at T1.8 / T5.5 / T5.6, I-017-15 (layout-independent canonical bytes) at T1.8 / T5.5 / T5.6, and I-017-16 (edit-time validation mirrors the daemon) at T1.8 / T5.5 / T5.7.

**Replay-testing contract (SA-31).** Temporal `runReplayHistory` pattern: replay executor consumes `session_events` history and asserts `DeterminismViolationError` is not thrown; final state is `deepEqual` to original. Every one of the 23 `workflow.*` event types enumerated in [Spec-017 §Workflow Timeline Integration](../specs/017-workflow-authoring-and-execution.md#workflow-timeline-integration) has at least one replay-correctness test ([Temporal TS SDK testing](https://docs.temporal.io/develop/typescript/testing-suite)). The contract is gated at Phase 5 (T5.1), which is why `## Rollout Order` item 5 orders resumption ahead of the UI.

**CI budget.** PR pipeline ≤ 30 min wall-clock; nightly ≤ 8 h; weekly unbounded real-time integration. Fuzz crashers are minimized, checked in under `corpus/<target>/regressions/`, and promoted to named `vitest` regression tests.

## Rollout Order

The five items map 1:1 onto `## Implementation Phase Sequence` Phases 1–5.

1. Land workflow definition + version contracts, the 23 `workflow.*` event schemas, the 9-table schema, writer-worker integration, the graph ↔ definition mapping with its refusal set, and copy-on-write editing of `shared` definitions. (Phase 1; `## Implementation Steps` 1–2 plus step 9's contract and persistence legs.)
2. Enable sequential execution for `single-agent` + `automated` phases with the four gate types and gate-chain writer. (Phase 2; step 3's `single-agent` and `automated` arms, plus step 5.)
3. Enable `multi-agent` phase with OWN channel linkage + `human` phase with local-draft UX. (Phase 3; step 3's `multi-agent` and `human` arms.)
4. Enable parallel phase execution with resource-pool admission and `ParallelJoinPolicy`. (Phase 4; step 4.)
5. Enable restart-safe resumption with `ProjectionRebuild` and hash-chain replay verification, then the `sidekicks workflow verify-gate-chain <run_id>` CLI, then the SDK and the authoring / run-detail / human-phase UI, and finally the builder canvas, the canonical definition file form, and the `sidekicks workflow` command set. (Phase 5; steps 6, 7, and 8 plus step 9's renderer, file-form, and CLI legs — the pre-audit rollout list covered only step 8, leaving steps 6 and 7 without a rollout position even though step 6 is the hard prerequisite for the SA-31 replay contract that gates merges. A-017-09 assigns both here and orders them ahead of the UI within the phase.)

## Rollback Or Fallback

- If parallel execution or gate-chain writer regresses, disable parallel blocks and restrict to sequential `single-agent` + `automated` — the engine still satisfies C-1…C-7 for V1 partial rollout.
- If the `human_phase_form_state` daemon-side fallback is needed before V1.x, the empty table already ships, so enabling it requires only a writer path and the `workflow.humanFormDraftSave` handler — no migration.

## Risks And Blockers

- Write amplification under pathological `progressed` heartbeat floods. **Named calibration criterion (A-017-24):** the nightly load category (Phase 4, T4.2) records per-workflow write volume against the [Local SQLite Schema §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017) estimate of ~42 KB / 110 writes per 10-phase workflow; a sustained nightly reading above **2× that estimate** is the trigger to add an executor rate-limit, and until it fires no rate-limit ships. The trigger is a threshold on an already-collected measurement, not a scheduled revisit.
- Per-run gate-chain verification cost scales linearly (~1 ms/row) — acceptable for operator-triggered audit; not in the hot path (T5.2 asserts the linearity and the out-of-hot-path placement).
- Non-determinism in replay if driver adapters leak wall-clock or random seed state — Plan-015 runtime-binding resume is the guard, and T5.1's replay-determinism battery (SA-31, asserting no `DeterminismViolationError` and a `deepEqual` final state) is the regression.
- **Error vocabulary gap carried, not closed (A-017-15).** `error-contracts.md §Workflow` defines three codes for a surface with at least thirteen refusal points (nine at the audit, four more from the visual-builder amendment). That file is outside this plan's write scope, so the extension is owed there and named in `## API And Transport Changes`; no Plan-017 task mints a code, which means the affected refusals cannot ship typed until the contract-doc extension lands. Tracked as a blocker on Phases 2 and 4 rather than as a task.

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

- **2026-08-10 — Tier-8 plan-readiness audit; `review → approved`.** First-time promotion per the runbook `§Status Promotion Gate`, cleared at Tier 8's place in the build order. The audit authored `## Implementation Phase Sequence` (five phases mapped 1:1 onto `## Rollout Order`, 19 tasks, each `#### Tasks` entry carrying `**Files:**` / `**Provides:**` / `**Consumes:**` / `**Spec coverage:**` / `**Verifies invariant:**` / `**Tests:**`), `## Invariants` (`I-017-1` … `I-017-13`, carrying the seven SA-13 security invariants plus the SA-20 ordering, SA-25 truth-vs-projection, SA-26 dual-anchor, and SA-21 replay-determinism legs, with the domain-lockstep entry declared plan-owned and the enumeration-visibility entry grounded in the operation the audit minted), `## Cross-Plan Obligations` (`CP-017-1` … `CP-017-5` against Plans 006 / 012 / 014 / 015 / 016 — CP-017-5 supplies the return-cite Plan-016's CP-016-6 forward-declared), and `## Upstream-Tier Amendments Required`. Required ADRs gained ADR-012 and ADR-017. The contract doc's `§Plan-017` block and the schema doc's Plan-017 tables were corrected in the same swap: the `PhaseDefinition.type` union widened from the pre-amendment two values to the four V1 phase types, five previously shapeless operations gained request/response pairs, `WorkflowGateResolveResponse` gained the SA-26 dual anchor, a `workflow` method registry landed, and the `phase_type` CHECK was rewritten to the four phase types (it had conflated gate types with phase types and omitted `automated` outright, so an `automated` phase could not be inserted).
- **2026-08-10 — scope-domain adjudication (A-017-11), ratified.** The contract doc and the DDL carried `session` \| `channel` while `Spec-017 §Resolved Questions and V1 Scope Decisions` carried session- and project-scoped only — a two-versus-one split the audit deliberately routed to the owner rather than calling. The ratified resolution takes neither side wholesale: the unsupported `channel` member is struck, and the domain becomes three-valued — `session` \| `project` \| `shared` — with `shared` a daemon-local cross-project reuse tier for workflow templates. It widens visibility breadth only: no new table, no sync path, and no change to `Spec-017 §Non-Goals`, which continues to exclude marketplace and global-library distribution. One column is required and was added in the same swap — `workflow_definitions.scope_ref`, modelled field-for-field on the scope-qualified binding shape `Spec-028 §Unified Inventory` already governs, with the dedupe key moved to `(scope, scope_ref, content_hash)`. Widening `scope` alone would have shipped an unstorable tier: `project` would have named no project, and the old `(session_id, content_hash)` key would have split one `shared` definition into a row per submitting session. Because the growth adds a member to a governed domain, Spec-017 flipped `approved → review` and was restored `approved` in this same swap under this audit's targeted coverage — the flip-and-restore-in-one-swap shape precedented by the Plan-010/Spec-010 deltas — so the README spec-status census does not move.
- **2026-08-10 — two criticals deferred to named upstream vehicles.** `A-017-02` (the Spec-006 `workflow.*` registration of five categories and 23 type literals) and `A-017-07` (the OWN-channel `turnsPerAgent` provider, carrying the A-017-14 `InterruptReason` leg) sit in sealed Tier-4 and Tier-6 respectively, which the runbook `§Cross-Tier Amendment Contingency` forbids a Tier-8 walk to amend. Each is recorded under `## Upstream-Tier Amendments Required`, each has a born-unchecked scoped §Preconditions box, and each box is machine-enforced by `precondition_box_checked` entries — the registration box on all five phases, the turn-budget box on Phase 3 with Phases 4–5 chained behind Phase 3 so the auto-walk cannot soft-skip past it. Promotion therefore clears the audit and status gates only; no phase dispatches until its named delta lands.
- **2026-08-10 — divergences recorded, not forced.** Five findings resolve outside this plan's write scope and are surfaced rather than patched: the scope domain in `docs/domain/workflow-model.md`, which still reads `session` or `channel` and is now stale in both directions — the `channel` member is struck and the domain is three-valued with a `scope_ref` companion — so that domain file owes a correction this audit does not take; `A-017-15` (the `error-contracts.md §Workflow` extension from three codes to the nine-plus refusal points, named in `## API And Transport Changes` and carried as a blocker in `## Risks And Blockers`), the fourth leg of `A-017-10` (`docs/domain/workflow-phase-model.md` still types `PhaseRunId` as a `RunId`, which the not-a-ULID ruling above contradicts — that domain file is another owner's surface, so the correction is owed there), the **encoding half of `A-017-10`** (the audit fixed that a `phaseRunId` is totally derived but deliberately did not choose the digest's text rendering: that is a one-way design decision on a durable primary key, of the same class as the scope domain, and is routed to lead ratification through `Spec-017 §Open Questions` — every surface here describes the value as a derived opaque identifier and T1.1 keeps the rendering behind one seam so the ruling lands in a single place), and `A-017-28` (the count embedded in a Spec-017 heading — deliberately not renamed: it is a nit, the rename is pure slug churn, and no citer of that slug exists).

- **2026-08-10 — visual-builder amendment (ADR-026 pairing).** V1 gains a node-graph authoring surface, specified in `Spec-017 §Visual Workflow Builder` under SA-32…SA-37 and C-17 and governed by ADR-026, which lands `proposed` in this same PR. The plan grew five tasks — T1.7 (copy-on-write off `shared` plus `project → shared` promotion, carried by the new `parent_content_hash` column), T1.8 (the graph ↔ definition mapping and the seven-rule refusal set), T5.5 (the React Flow canvas), T5.6 (the canonical export / import file form), and T5.7 (the `sidekicks workflow` command set) — three invariants (I-017-14 tool-governance non-bypass, I-017-15 layout-independent canonical bytes, I-017-16 edit-time validation mirrors the daemon), and one obligation (CP-017-6, a read-only consumption of the Plan-005 / Plan-028 tool-governance surface with no upstream delta owed). No new wire operation was minted: promotion and import both ride `workflow.definitionCreate`, so the eleven-method registry is unchanged. Because ADR-026 is not yet `accepted`, the `Required ADRs are accepted` box keeps its check under a dated scope clause naming what it covers, and ADR-026's ratification is carried by a separate born-unchecked box whose `precondition_box_checked` entries ride Phases 1 and 5 — the two phases owning the five builder tasks. Every pre-amendment task stays dispatch-eligible on its own gates.

## Done Checklist

Named completion conditions rather than the template defaults (A-017-23). Each is checkable against the tree, not against a reviewer's impression.

- [ ] The 9-table migration is applied and the contract ↔ DDL conformance suite (T1.6) is green on every pinned domain
- [ ] All 23 `workflow.*` event types are registered in the Spec-006 registry and discriminate in the shared union (T1.3; `## Upstream-Tier Amendments Required` Tier-4 leg closed)
- [ ] All four phase types and all four gate types execute end to end, including the `automated` path the pre-audit CHECK constraint rejected
- [ ] `sidekicks workflow verify-gate-chain <run_id>` ships and reports the first divergent `sequence` on a tampered chain (T5.2)
- [ ] The SA-31 replay battery is green — no `DeterminismViolationError`, `deepEqual` final state, and at least one replay-correctness test per event type (T5.1)
- [ ] The full I-017-1…I-017-7 security-regression battery with its CVE corpora gates merge (SA-30)
- [ ] Every §Cross-Plan Obligation is either satisfied with a return-cite from its provider plan or explicitly staged
- [ ] The visual builder ships and refuses all seven graph shapes at edit time while the daemon re-evaluates every one of them at `workflow.definitionCreate` (T1.8, T5.5; I-017-16), a definition round-trips builder → file → CLI → daemon to an identical content hash (T5.6, T5.7), and no tool binding in any persisted definition carries a governance facet (I-017-14)
- [ ] Related docs updated — the contract doc, the SQLite schema doc, and the `error-contracts.md §Workflow` extension owed under A-017-15

## References

- [Spec-017: Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md) — paired spec; canonical SA-1…SA-37 narrative (SA-32…SA-37 and C-17 added by the visual-builder amendment)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) — Decision D1/D2 + V1.1 criterion-gated commitments + §Research Conducted (BL-097 primary-source corpus)
- [ADR-012: Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md) — `human-approval` gate and per-turn moderation-gate evaluation path (I-017-3; added by the Tier-8 audit)
- [ADR-017: Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md) — the locally-authoritative `session_events` log the 23 workflow event types and the SA-26 dual anchor ride (I-017-7; added by the Tier-8 audit)
- [ADR-026: Visual Node-Graph Workflow Authoring](../decisions/026-visual-node-graph-workflow-authoring.md) — the node-graph authoring decision governing T1.8 / T5.5 / T5.6 / T5.7 and I-017-14…I-017-16 (`proposed`; added by the visual-builder amendment)
- [Local SQLite Schema §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017) — 9-table schema, hash-chain layout, write-amplification estimates
- [Plan-006: Session Event Taxonomy and Audit Log](./006-session-event-taxonomy-and-audit-log.md) — event taxonomy + integrity protocol
- [Plan-012: Approvals, Permissions, and Trust Boundaries](./012-approvals-permissions-and-trust-boundaries.md) — Cedar policy + approval categories
- [Plan-014: Artifacts, Files, and Attachments](./014-artifacts-files-and-attachments.md) — artifact manifests, OWASP upload pipeline
- [Plan-015: Persistence, Recovery and Replay](./015-persistence-recovery-and-replay.md) — single writer worker, `ProjectionRebuild`, replay
- [Plan-016: Multi-Agent Channels and Orchestration](./016-multi-agent-channels-and-orchestration.md) — channel lifecycle, OWN ownership
- [CloudEvents v1.0.2 spec](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) — envelope additive-bump rules (SA-18)
- [OpenTelemetry Semantic Conventions for Events](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md) — event-name convention precedent (SA-19)
- [OpenTelemetry AI Agent observability blog (2025)](https://opentelemetry.io/blog/2025/ai-agent-observability/) — LLM-event semantic-convention rationale (SA-19)
- [Argo Workflows architecture — workflow events](https://argo-workflows.readthedocs.io/en/latest/architecture/#workflow-engine) — event-engine industry comparison
- [n8n executions API reference](https://docs.n8n.io/api/api-reference/#tag/Execution) — execution-event industry comparison
- [Argo Workflows — intermediate parameters](https://argo-workflows.readthedocs.io/en/latest/intermediate-inputs/) — human-phase form input pattern
- [Argo Workflows — `suspend-template-outputs.yaml` example](https://github.com/argoproj/argo-workflows/blob/main/examples/suspend-template-outputs.yaml) — output-projection-on-resume pattern
- [argoproj/argo-workflows#8365](https://github.com/argoproj/argo-workflows/discussions/8365) — form-input UX gap (Argo discussion)
- [Camunda 8 — user tasks](https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/) — human-phase claim-semantics precedent
- [Camunda 8 — handling data in processes](https://docs.camunda.io/docs/components/best-practices/development/handling-data-in-processes/) — form-data persistence pattern
- [GitHub Actions — reviewing deployments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments) — approval-gate UX precedent
- [AWS Step Functions — human-approval tutorial](https://docs.aws.amazon.com/step-functions/latest/dg/sample-project-human-approval.html) — approval-gate sample
- [AWS Step Functions — `SendTaskHeartbeat`](https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskHeartbeat.html) — heartbeat-based liveness pattern
- [Temporal — Python message passing](https://docs.temporal.io/develop/python/message-passing) — signal-based human input
- [Temporal — automation of human-in-the-loop workflows](https://pages.temporal.io/webinar-automation-of-human-in-the-loop-workflows-with-temporal.html) — HITL workflow pattern
- [Cloudflare Workflows — `waitForEvent`](https://developers.cloudflare.com/workflows/build/events-and-parameters/) — wait-for-event primitive
- [LangGraph — human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/) — HITL primitive (LLM stack)
- [Microsoft Agent Framework — AG-UI HITL](https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/human-in-the-loop) — HITL primitive (recent industry)
- [W3C WCAG 2.2 §3.3.7 Redundant Entry](https://www.w3.org/TR/WCAG22/#redundant-entry) — accessibility requirement for form-state UX (SA-26)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) — I6 human-upload minimums (also inline in Test table)
- [Restate — What is Durable Execution](https://restate.dev/what-is-durable-execution) — per-invocation durable-log precedent (C-13)
- [Temporal — custom persistence (2024)](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer) — persistence-model precedent
- [Argo Workflows — workflow archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/) — persistence-tier precedent
- [Argo Workflows — offloading large workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/) — large-workflow persistence pattern
- [Cadence — cross-DC replication / persistence](https://cadenceworkflow.io/docs/concepts/cross-dc-replication) — persistence-tier industry comparison
- [SQLite — JSON1 extension](https://www.sqlite.org/json1.html) — JSON-column rationale for `workflow_definitions`
- [`fast-check` (model-based testing)](https://github.com/dubzzz/fast-check) — property-test framework pin (SA-29)
- [Jazzer.js (fuzzing)](https://github.com/CodeIntelligenceTesting/jazzer.js) — fuzz-test framework pin (SA-29)
- [Jazzer.js — fuzz-targets docs](https://github.com/CodeIntelligenceTesting/jazzer.js/blob/main/docs/fuzz-targets.md) — fuzz-target shape (SA-29)
- [Endor Labs — Argo CVE-2025-66626 broken-fix analysis](https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo) — broken-fix-precedent rationale for security-regression category
- [Astronomer — testing Airflow](https://www.astronomer.io/docs/learn/testing-airflow/) — DAG-test precedent
- [Bitovi — replay testing in Temporal](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows) — replay-test pattern (SA-31)
- [Temporal — TypeScript SDK testing suite](https://docs.temporal.io/develop/typescript/testing-suite) — `runReplayHistory` contract (SA-31; also inline)
