# Plan-017: Workflow Authoring And Execution

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `017` |
| **Slug** | `workflow-authoring-and-execution` |
| **Date** | `2026-04-14` |
| **Amended** | `2026-04-22` (full engine V1 per [BL-097](../archive/backlog-archive.md) / [ADR-015](../decisions/015-v1-feature-scope-definition.md) amendment — was V1.1-deferred-subset at original approval; absorbs SA-24/29/30/31 per [Spec-017](../specs/017-workflow-authoring-and-execution.md) + [ADR-015 §Amendment History](../decisions/015-v1-feature-scope-definition.md#amendment-history)) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-017: Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (event taxonomy, integrity protocol), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (approval records, Cedar policy), [Plan-014](./014-artifacts-files-and-attachments.md) (artifact manifests, OWASP upload), [Plan-015](./015-persistence-recovery-and-replay.md) (recovery, writer worker, replay), [Plan-016](./016-multi-agent-channels-and-orchestration.md) (channel lifecycle), [Plan-004](./004-queue-steer-pause-resume.md) (queue/steer) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Spec-017](../specs/017-workflow-authoring-and-execution.md) (canonical contract surface; SA-24/29/30/31 narrative); [ADR-015 §Research Conducted](../decisions/015-v1-feature-scope-definition.md#research-conducted) (BL-097 primary-source corpus); see also `## References` at end of file |

## Goal

Implement versioned workflow definitions and durable workflow execution for the full V1 engine — four phase types, four gate types, parallel phases with named pools, and append-only hash-chained approval history — reusing existing session, run, approval, artifact, and recovery primitives.

## Scope

Workflow definition persistence (content-hashed, immutable versions), workflow run state, phase execution for all four V1 phase types (`single-agent`, `multi-agent`, `automated`, `human`), all four gate types, parallel phase execution with `ParallelJoinPolicy`, resource-pool admission, workflow-level gate resolution with per-run hash chain, OWN-only channel linkage, and replay-deterministic projection rebuild.

## Non-Goals

- Marketplace or global workflow distribution
- External workflow-engine integration
- Workflow editor polish beyond V1 ambition
- BIND channel ownership (V1.1 criterion-gated per ADR-015)
- Cross-node workflow dispatch (Spec-024 V1.1)

## Preconditions

- [x] Paired spec is approved (amended 2026-04-22 for full-engine V1)
- [x] Required ADRs are accepted (ADR-015 amended 2026-04-22)
- [x] Blocking open questions are resolved or explicitly deferred

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

## Data And Storage Changes

- Add the 9-table workflow schema per [Local SQLite Schema §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017) (SA-24): `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_phase_states`, `phase_outputs`, `workflow_gate_resolutions`, `parallel_join_state`, `workflow_channels`, `human_phase_form_state`.
- Source-of-truth hierarchy (SA-25): `session_events` remains canonical; tables 1/2/5/6 are immutable truth, 3/4/7/8/9 are projections rebuildable via Plan-015 `ProjectionRebuild`.
- `workflow_gate_resolutions` carries a per-run BLAKE3 hash chain anchored to `session_events` via dual-anchor payload (`gate_resolution_id` + `row_hash`) on the `workflow.gate_resolved` event (SA-26). Dual-hash: BLAKE3 for daemon-internal identity, SHA-256 reserved for Plan-014 artifact content (SA-27).
- `human_phase_form_state` ships empty at V1; clients persist drafts via localStorage/IndexedDB per [Spec-017 §Ship-empty tables (SA-28)](../specs/017-workflow-authoring-and-execution.md#ship-empty-tables-sa-28). Table reserved for V1.x daemon-side fallback.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions, index rationale, and write-amplification estimates.

## API And Transport Changes

- Add `WorkflowDefinitionCreate`, `WorkflowDefinitionRead`, `WorkflowVersionRead`, `WorkflowRunStart`, `WorkflowRunRead`, `PhaseOutputRead`, `WorkflowGateResolve`, `HumanPhaseFormDraftSave`, `HumanPhaseFormSubmit`, and `WorkflowGateChainVerify` to shared contracts and the typed client SDK.
- Carry workflow version ids, `phase_run_id`s (which double as the channel-owning phase id per SA-6), gate states, and parallel-join resolution through timeline events — 5 categories, 23 event types per Spec-017 §Workflow Timeline Integration. Envelope follows [CloudEvents v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) additive-extension rules; semantic-convention naming aligns with [OpenTelemetry Semantic Conventions for Events](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md).
- Event payload schemas evolve additive-MINOR per [ADR-018](../decisions/018-cross-version-compatibility.md); the `row_hash` + `gate_resolution_id` fields on `workflow.gate_resolved` are such an addition (Pass G §5).

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define workflow-definition, version, phase-state, gate, and definition-read contracts in shared packages.
   - Full type hierarchy: `WorkflowDefinition`, `WorkflowVersion`, `WorkflowPhaseDefinition`, `WorkflowRun`, `WorkflowPhaseRun`, `PhaseOutput`, `WorkflowGateResolution`, `ParallelJoinState`.
   - All 4 gate types: `auto-continue`, `quality-checks`, `human-approval`, `done`.
   - Entity separation: `WorkflowPhaseId` (logical phase in the definition) vs `PhaseRunId` (specific execution instance: ULID that also anchors channel OWN 1:1 per SA-6). `PhaseRunId` derived via `BLAKE3(workflowRunId || phaseDefinitionId || attemptNumber)` per SA-21.
   - Failure behaviors per phase: `retry` (new attempt row, C-9), `go-back-to` (bounded by `max_phase_transitions`), `stop`.
2. Implement durable workflow definition versioning and workflow-run persistence. Definition bodies are content-hashed via BLAKE3 over RFC 8785 JCS canonicalization; schema-version marker enforced by CHECK (C-8). All writes route through the Plan-015 single writer worker (50-event / 10 ms batch cadence).
3. Implement phase execution for all four V1 phase types:
   - `single-agent` — one agent, one driver adapter; inherits Plan-015 runtime-binding restore + `command_receipts` idempotency.
   - `multi-agent` — OWN channel 1:1 via `workflow_channels`; cancel cascade honors `CLOSE_WITH_RECORDS_PRESERVED` with a 30s grace window (SA-9). Per-turn moderation gate fires per Plan-012.
   - `automated` — subtype routes `auto-continue` / `quality-checks` / `done`; `quality-checks` writes a gate-resolution row.
   - `human` — form submission writes `phase_outputs` with `value_kind='artifact_ref'` when upload fields present (C-16). `human_phase_contribution` approval category (SA-12) covers non-approval phase submissions. Default timeout semantics per ADR-015 Decision D1: `timeout: "none" | Duration` with no default.
4. Implement `ParallelJoinPolicy` resolver (SA-4): `fail-fast` / `all-settled` / `any-success`. Cancel cascade is tick-synchronous; `cancel_wave_tick` on `parallel_join_state` records the executor tick for audit. Resource-pool admission enforces `agent_memory_mb` + `pty_slots` pools with SA-3 defaults.
5. Implement workflow-gate resolution with append-only hash chain:
   - Writer-worker-only INSERTs to `workflow_gate_resolutions`; per-run `sequence` monotonic from 1.
   - `row_hash = BLAKE3(prev_hash || JCS-canonical(row_body))`; Ed25519 daemon signature over same bytes; optional approver signature.
   - Dual-anchor: every row paired with a `session_events` row (category `workflow_gate_resolution`) carrying `gate_resolution_id` + `row_hash` in payload (SA-26 / Pass G §5).
6. Implement restart-safe workflow resumption and `ProjectionRebuild` integration: projection tables rebuildable from `session_events` via Plan-015; hash-chain replay re-verifies each row in `sequence` order and halts on `chain_break_detected`. Per-row recompute walks `prev_hash || JCS-canonical(row_body)` and asserts equality with the persisted `row_hash` (flat hash-chain pattern per [Local SQLite Schema §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017)).
7. Add `sidekicks workflow verify-gate-chain <run_id>` CLI subcommand exposing the dual-anchor verification procedure.
8. Add desktop workflow authoring, run-detail, and human-phase form surfaces backed by the shared client SDK. Human-phase drafts use localStorage/IndexedDB at V1.

## Parallelization Notes

- Definition-versioning work, workflow-run persistence, and the gate-chain writer can proceed in parallel once contracts are fixed.
- UI work should wait for phase-output and restart-resume semantics to stabilize.
- `parallel-join-resolver` and `resource-pool-admitter` are independent of the gate-chain path.

## Test And Verification Plan

Five test categories (SA-29): property-based, fuzz, load, long-running integration, security regression. Each carries a V1 _ambition level_ so the category can be stop-marked independently. Replay-determinism scaffolding follows the Temporal `runReplayHistory` pattern; property + fuzz frameworks pinned to `fast-check` and `@jazzer.js/core`; CVE-reproducer corpus seeds the security-regression battery (SA-30).

| Category | Covers | V1 Ambition | CI Cadence |
| --- | --- | --- | --- |
| Property-based (`fast-check`) | DAG acyclicity, ready-set determinism, `max_phase_transitions` / `max_duration`, `ParallelJoinPolicy` semantics, retry-re-entry stability | **Hardened** — adversarial + concurrency | PR (numRuns=100); nightly (numRuns=10 000) |
| Fuzz (`@jazzer.js/core` v4.x) | Workflow-definition parser, expression grammar (I2), secrets resolver (I4) | **Foundational+** — 15 min/target PR; 2 h/target nightly | PR (15m) + nightly (2h) |
| Load | Parallel executor contention, resource-pool admission, `max_concurrent_phases` backstop, SQLite write-amp | **Foundational** — baseline regression only, no SLO gate | Nightly |
| Long-running integration (`@playwright/test` + real daemon) | Multi-day `human` phase resume, checkpoint/replay determinism, multi-agent channel lifecycle, optimistic-concurrency on human submit | **Hardened** — compressed-time nightly + real-time weekly | Nightly (compressed) + weekly (real-time) |
| Security regression | Per-invariant I1–I7 battery with CVE-reproducer corpora (SA-30) | **Hardened** — full battery gates merge | PR + merge |

**Security regression battery (SA-30) — per-invariant CVE corpora:**

| Invariant | Assertion | CVE / source seed |
| --- | --- | --- |
| I1 — argv-list-only execution | Semgrep rule bans `exec`/`shell:true`; dynamic test proves shell metachars reach argv unshelled | Generic shell-injection corpus |
| I2 — typed substitution, no eval | Every expression payload either parses to whitelisted AST or throws `ExpressionParseError` | n8n [CVE-2025-68613](https://github.com/advisories/GHSA-v98v-ff95-f3cp); Airflow [CVE-2024-39877](https://nvd.nist.gov/vuln/detail/CVE-2024-39877); Airflow [CVE-2024-56373](https://nvd.nist.gov/vuln/detail/CVE-2024-56373); Jenkins `CVE-2024-34144` / `CVE-2024-34145` |
| I3 — typed approver capability | Cedar capability check; admin override logged as distinct entry kind | Plan-012 policy corpus |
| I4 — secrets never in argv/logs/artifacts | Canary secret never appears raw / base64 / URL-encoded / JSON-stringified | Airflow `#54540` masker-bypass reproducer |
| I5 — content-addressed external refs | Mutating pinned tool bytes yields `ContentHashMismatch` | GitHub Actions v3→v4 artifact mutability precedent |
| I6 — human-phase OWASP uploads | Zip bomb, polyglot, symlink-traversal, oversize, mismatched Content-Type all quarantined | Argo [CVE-2025-66626](https://nvd.nist.gov/vuln/detail/CVE-2025-66626); [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) |
| I7 — append-only hash-chained approval log | Row-level tampering detected at daemon start; replay uses at-approval-time policy | Crosby & Wallach 2009 flat-chain pattern; Spec-006 integrity protocol |

**Replay-testing contract (SA-31).** Temporal `runReplayHistory` pattern: replay executor consumes `session_events` history and asserts `DeterminismViolationError` is not thrown; final state is `deepEqual` to original. Every Pass F event type has at least one replay-correctness test ([Temporal TS SDK testing](https://docs.temporal.io/develop/typescript/testing-suite)).

**CI budget.** PR pipeline ≤ 30 min wall-clock; nightly ≤ 8 h; weekly unbounded real-time integration. Fuzz crashers are minimized, checked in under `corpus/<target>/regressions/`, and promoted to named `vitest` regression tests.

## Rollout Order

1. Land workflow definition + version contracts, 9-table schema, and writer-worker integration.
2. Enable sequential execution for `single-agent` + `automated` phases with the four gate types and gate-chain writer.
3. Enable `multi-agent` phase with OWN channel linkage + `human` phase with local-draft UX.
4. Enable parallel phase execution with resource-pool admission and `ParallelJoinPolicy`.
5. Enable authoring surfaces and run-detail UI.

## Rollback Or Fallback

- If parallel execution or gate-chain writer regresses, disable parallel blocks and restrict to sequential `single-agent` + `automated` — the engine still satisfies C-1…C-7 for V1 partial rollout.
- If `human_phase_form_state` daemon-side fallback is needed before V1.x, ship the empty table is already in place; enabling only requires a writer path without migration.

## Risks And Blockers

- Write amplification under pathological `progressed` heartbeat floods — Pass G §7 load tests in V1.x will calibrate the executor rate-limit.
- Per-run gate-chain verification cost scales linearly (~1 ms/row) — acceptable for operator-triggered audit; not in the hot path.
- Non-determinism in replay if driver adapters leak wall-clock or random seed state — Plan-015 runtime-binding resume is the guard; Pass H §5.2 replay test is the regression.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated

## References

- [Spec-017: Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md) — paired spec; canonical SA-1…SA-31 narrative
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) — Decision D1/D2 + V1.1 criterion-gated commitments + §Research Conducted (BL-097 primary-source corpus)
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
