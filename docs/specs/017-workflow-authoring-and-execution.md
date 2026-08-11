# Spec-017: Workflow Authoring And Execution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `017` |
| **Slug** | `workflow-authoring-and-execution` |
| **Date** | `2026-04-14` |
| **Amended** | `2026-04-22` (full engine V1 per BL-097 / ADR-015 amendment — was V1.1-deferred-subset at original approval; see §Resolved Questions and V1 Scope Decisions); `2026-08-10` (Tier-8 plan-readiness audit — the workflow-definition scope domain becomes three-valued `session` / `project` / `shared`, carried by a `scope_ref` companion in the shape Spec-028 already governs, without which `project` names nothing and the tier is unstorable; `WorkflowDefinitionList` added to §Core SDK and persistence contracts, the enumeration the operation set lacked; `## Preconditions` and `## Open Questions` backfilled per the spec template; §Deterministic identity clarified — a `phaseRunId` is totally derived and therefore not a ULID, with the digest's text rendering left open under §Open Questions rather than decided by the audit; §Visual Workflow Builder added — the node-graph authoring surface, its refusal set, its reference-only tool bindings, the layout-outside-the-hash rule, builder scope semantics including copy-on-write off `shared`, the single-value entry record, and the canonical export/import file form, carried by SA-32 through SA-37 and C-17 and paired with ADR-026; the same amendment narrows the marketplace Non-Goal to distribution and replaces the wholesale editor-UI Non-Goal with a pixel-level one) |
| **Author(s)** | `Codex` |
| **Depends On** | [Multi Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md), [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md), [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md), [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md), [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md), [Artifacts Files And Attachments](../specs/014-artifacts-files-and-attachments.md) |
| **Implementation Plan** | [Plan-017: Workflow Authoring And Execution](../plans/017-workflow-authoring-and-execution.md) |

## Purpose

Define how reusable workflows are authored, versioned, and executed inside sessions. V1 ships the full workflow engine: four phase types (`single-agent`, `multi-agent`, `automated`, `human`), four gate types, parallel phase execution with named resource pools, and durable state with append-only hash-chained approval history. The engine plugs into existing daemon primitives (Spec-016 channels, Spec-012 approvals, Spec-014 artifacts, Spec-006 events, Spec-015 recovery) — workflow execution does not duplicate them.

## Scope

This spec covers:

- Workflow authoring as YAML definitions + typed TypeScript SDK (no bespoke DSL per C-1)
- Workflow versioning (immutable-by-version with content-hash identity)
- Phase execution for all four phase types
- Workflow-level gates (four gate types)
- Parallel phase execution with named resource pools and bounded iteration
- Append-only hash-chained approval history (C-13 / I7)
- Workflow event taxonomy (new Spec-006 categories + event types)
- Durable phase state persisted via Spec-015 (SQLite + WAL)
- Replay-determinism contract
- Visual node-graph authoring of workflow definitions, and the canonical file form definitions export to and import from (§Visual Workflow Builder)

## Non-Goals

- General-purpose external workflow engines (no Temporal, Restate, Argo binding at V1)
- Marketplace or distribution semantics for workflow templates — publishing, importing from outside the daemon, or any cross-machine sync of definitions. Narrowed 2026-08-10 (Tier-8 audit) rather than deleted: the ratified `shared` scope value adds daemon-local cross-project **reuse**, which is a visibility breadth, not distribution. A `shared` definition never leaves the daemon that stores it, so this Non-Goal stands with its subject stated precisely. Definition portability between machines at V1 is therefore the operator-driven file form of §Definition file form — export and import (C-17) — a file an operator moves, never a service that moves it.
- Pixel-level UI design for the workflow editor. V1 ships the visual builder surface specified in §Visual Workflow Builder — its node taxonomy, port and connection rules, refusal set, layout-persistence tier, and scope semantics are normative here; visual styling, theming, and interaction polish beyond those rules stay out of the spec and are implementation choices. (Amended 2026-08-10, Tier-8 audit: the prior bullet scoped out "full UI design for workflow editors" wholesale, which the visual-builder amendment contradicts.)
- `BIND` multi-phase channel reuse — criterion-gated V1.1 commitment per [ADR-015 §V1.1 Criterion-Gated Commitments](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments). V1 ships `ownership: OWN` only; `BIND` lands only if three named criteria are satisfied (see Interfaces And Contracts §Multi-agent).
- Default timeout for `human` phase — required typed opt-in in V1 per BL-097 D1. Default-timeout + escalate-to-paging deferred to V1.x under notification-routing criterion per `ADR-015 §V1.1 Criterion-Gated Commitments`.
- Daemon-side draft autosave for `human` phase forms — V1 ships with client-side localStorage / IndexedDB only (SA-28 / Pass G §10.3). Daemon-side form-state table ships empty at V1.
- Cross-phase discussion channels (V2): agents from different phases collaborating in shared channels.
- OpenTelemetry workflow semantic conventions — OTel GenAI semconv is not yet ratified as of 2026-04-22 ([OpenTelemetry GenAI Observability Blog 2025](https://opentelemetry.io/blog/2025/ai-agent-observability/)); V1 ships on CloudEvents + Spec-006 envelope and adopts OTel semconv additively when ratified under [ADR-018](../decisions/018-cross-version-compatibility.md) MINOR rules.
- SQLite STRICT tables adoption (criterion-gated V1.x deferral per Wave 2 §4.1 — cross-plan policy change; Plan-017 schema uses repo's existing TEXT-column convention).
- Mutation testing in CI (criterion-gated V1.x deferral per Wave 2 §4.2 — V1 PR budget already at 30 min).
- Execution-model enum (`local | queued | remote`) — C-11 commitment is local-only at V1 (Airflow executors and n8n `own` mode precedent: every system that enumerated execution models at V1 had to break-remove entries later).

## Domain Dependencies

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)

## Preconditions

Backfilled 2026-08-10 by the Tier-8 plan-readiness audit (A-017-12) — the spec predates the template's Preconditions block, so its original promotion left no record of the gate. Recorded as found, not retrofitted to pass.

- [ ] All declared `Depends On` specs are at `approved` status — Spec-004 (restored 2026-08-08, PR #299), Spec-006, and Spec-015 are `approved`; **Spec-012, Spec-014, and Spec-016 are `review`**, each pending its own restoring targeted readiness-audit delta. This box is the residual that keeps Plan-017 code dispatch bound to [AGENTS.md §Doc-First Discipline](../../AGENTS.md#doc-first-discipline) on those three specs, over and above Plan-017's own audit and status gates.
- [x] All declared `Depends On` ADRs are at `accepted` status — ADR-015 (amended 2026-04-22), ADR-002, and ADR-018 per §References; the plan-side Required-ADR set additionally names ADR-001, ADR-004, ADR-012, and ADR-017, all `accepted`
- [x] Blocking open questions are resolved or explicitly deferred — see `## Open Questions`; all three deferred items carry named vehicles (two are upstream-tier amendments, one is a lead ratification), and none gates a Required Behavior row
- [x] **Spec-status promotion gate cleared per [`docs/operations/plan-implementation-readiness-audit-runbook.md#spec-status-promotion-gate`](../operations/plan-implementation-readiness-audit-runbook.md#spec-status-promotion-gate)** — executed per criterion at the 2026-08-10 flip-and-restore: criterion 1 is recorded as the standing residual above rather than claimed clear; criterion 2 is discharged by `## Open Questions`; criterion 3 holds because no code citing this spec has shipped (Plan-017's shipment manifest is empty and Tier-8 code has not started); criterion 4 is the promotion PR's own citation. **Flip-and-restore record (2026-08-10, this swap):** the Tier-8 plan-readiness audit's three ratified growths — the three-valued scope domain with its `scope_ref` identity, the `WorkflowDefinitionList` enumeration, and the visual-builder amendment (§Visual Workflow Builder, SA-32…SA-37, C-17, two narrowed Non-Goals) — change a governed domain, the operation set, and the required-behavior surface, tripping the runbook's spec-amendment rule and flipping this spec `approved → review`; the same audit's targeted coverage of the growths restores `approved` in the same swap (the Plan-010/Spec-010 flip-and-restore shape), so the README spec-status census does not move; the header Status cell stays bare per preflight Gate 7, this row carrying the narrative.

## Required Behavior

### Authoring + versioning

- Workflows must be authored as explicit phase definitions with stable ids and versioned structure.
- Workflow authoring format: YAML definitions + typed TypeScript SDK. **No bespoke DSL** (no CUE, no HCL, no custom expression language) — C-1 commitment. DSL lock-in cost is precedent-heavy: Dagger maintained its CUE SDK as primary authoring language from Jan 2022 (v0.1.0) through Dec 2023, then ended CUE SDK support after a year of dual-maintenance against multi-language SDKs, citing that "engineers...want to write code in a language they already know. Learning a brand new language, however powerful, is simply not what they're looking for" ([Dagger — Ending Support for the Dagger CUE SDK, 2023](https://dagger.io/blog/ending-cue-support/); [Solomon Hykes on Changelog #550, 2023](https://changelog.com/podcast/550)); GitHub Actions migrated off HCL to YAML under breaking-change pressure ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)).
- Workflow definition files must carry an explicit schema version marker (e.g., `ai-sidekicks-schema: 1.0`). Daemon must support compat mode for reading older-marker files (SA-14 / C-8 — Temporal's Version Sets → Build IDs retrofit is the precedent cost avoided here).
- Workflow definitions must be stored as first-class durable definition and version records. Artifact publication may represent workflow exports or summaries, but it must not be the canonical source of workflow definition truth.
- `WorkflowDefinitionCreate` must run a DFS three-color cycle check against the phase graph and reject invalid definitions with a typed error. Graph stays acyclic at definition time; `go-back-to` is a state-reset operation, not a cyclic edge.

### Execution semantics

- V1 ships all four phase types: `single-agent`, `multi-agent`, `automated`, `human`.
- V1 ships all four gate types: `auto-continue`, `quality-checks`, `human-approval`, `done`.
- V1 ships parallel phase execution with named per-resource-pool backpressure (SA-3). The executor tick loop uses a Kahn-style ready-set admission over the phase DAG; ready-set processing bounded by `max_concurrent_phases` (daemon-global default 4) as final backstop.
- Iteration must be bounded by three counters:
  - Per-phase `max_retries` (default 3).
  - Workflow-run-level `max_phase_transitions` (default 100) — hard-fails the run with `failure_reason='RUN_ITERATION_LIMIT'` (SA-1; G §10.6 resolved).
  - Workflow-run wall-clock `max_duration` (default 24h) — hard-fails run on deadline (SA-2).
- Resource pools for V1 (SA-3):
  - `pty_slots` — capacity `min(8, cpu_count * 2)`, tunable per daemon config.
  - `agent_memory_mb` — capacity `daemon_budget - overhead ≈ 192 MB`; per-`single-agent` phase default reservation 100 MB (pessimistic). Tripwire: >15% phase-launch attempts blocked on `agent_memory_mb` in a 2-week rolling window triggers V1.1 calibration.
  - Pull-based admission in executor tick.
- `PhaseResourceNeed` model on phase definition: `{pool: string, amount: number}[]`. Multiple pool reservations must all be available at admit time.
- Parallel execution must specify `ParallelJoinPolicy` (SA-4): `'fail-fast' | 'all-settled' | 'any-success'`. Default `fail-fast`. Sibling cancellation on `fail-fast` must be recorded at a deterministic synchronous tick checkpoint — never in async callbacks (prevents the non-determinism class documented in Temporal Java SDK #902).
- `priority?: number` on phase definition drives ready-set ordering; FIFO tiebreaker (SA-5). Airflow-style priority weight deferred to V1.1 if tripwire warrants.
- All phase execution routes through existing `OrchestrationRunCreate` per Spec-016/017 constraints.
- A workflow phase may create runs, request approvals, emit artifacts, or block on participant input.
- Workflow execution must remain visible in the session timeline and must preserve per-phase provenance.
- Phase outputs must be durable, addressable after workflow completion, **and immutable once written** (SA-16 / C-9). Accumulator patterns build on top (e.g., a `collect` phase reads N upstream outputs and emits a new output). Retry creates a new phase-run identity and a new output row — never overwrites. The GitHub Actions Artifact v3→v4 mutability-forced migration is the precedent ([GitHub Actions — v3 artifact deprecation notice, 2024-04-16](https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/)).
- Workflow execution must be resumable after daemon restart or client reconnect.

### Loud-errors discipline (C-12)

- Unknown integration name, missing required input, typo in expression, unknown phase reference, unknown resource pool, unknown approver principal — all must fail loudly at `WorkflowDefinitionCreate` or at phase launch. Silent no-ops forbidden by default. n8n 1.0 had to break silent-error-passing behavior users had built on — the V1 chance to avoid that is now.
- Workflow step outputs referenced by downstream phases must resolve at definition time (by shape) and at execution time (by presence). Missing-output is never silently coerced to empty string.

## Default Behavior

- Workflow phases default to sequential execution unless the definition explicitly marks safe parallelism. When explicitly parallel, default `ParallelJoinPolicy` is `fail-fast`.
- Each `single-agent` / `automated` phase defaults to one primary target channel and one primary producing run.
- `multi-agent` phase defaults to `ownership: OWN` — V1 default and only value (SA-6).
- `multi-agent` phase-owned channel defaults differ from bare-channel defaults on four axes (SA-8 / Pass B §3.3):
  - `turn_policy: round-robin` (bare-channel default `free-form`)
  - `turns_per_agent`: formula-bounded, indicative max 20 (bare-channel 50)
  - `membership`: phase-targeted agents only (bare-channel: session membership)
  - `moderation`: `off` for `auto-continue` / `done` / `human-approval` gates; `post-turn informational` for `quality-checks` gate
  - All other bare-channel defaults (token budget, cost limit, idle timeout, scheduler limits, partition behavior) unchanged.
- `multi-agent` channel termination defaults to `CLOSE_WITH_RECORDS_PRESERVED` on phase completion (SA-9). This inverts Temporal's `TERMINATE` default because the workflow engine inherits channel transcripts as phase-output source material. Phase failure drives `REQUEST_CANCEL` with 30-second grace period. Retry creates a new channel per iteration (prevents BIND-like cross-iteration state leak).
- Workflow definitions default to immutable-by-version: editing a workflow creates a new version rather than mutating a running definition in place.
- Workflow definition reads default to the canonical persisted definition record for the requested scope and version rather than to an artifact manifest.
- `human` phase forms default to primitive-type JSON schema fields (`text` / `long_text` / `number` / `integer` / `boolean` / `enum`) plus optional `artifact` field referencing a Plan-014 pre-uploaded `ArtifactId`. No in-form file upload — uploads are out-of-band via Plan-014 (SA-10; Pass C §3.2).

## Fallback Behavior

- If a later phase depends on unavailable capabilities, the workflow must pause in a blocked state instead of silently skipping the phase.
- If a workflow definition changes while an older version is running, the running instance must continue on the version it started with.
- If a phase output is large or unavailable inline, the workflow timeline must link to a durable artifact reference instead of dropping the output.
- If a `multi-agent` phase's channel fails to create (resource exhaustion, moderation-backend unavailable), phase admission blocks until preconditions are met or `max_duration` deadline fires.
- If a `human` phase is claimed by one participant and then abandoned, optimistic-concurrency must allow re-claim on next open (SA-10; Pass C §3.2). Assignment model: implicit claim on first open; optimistic-concurrency reject on submit if version mismatch.
- If `RUN_ITERATION_LIMIT` or `max_duration` fires mid-run, the workflow moves to `failed` with `failure_reason` preserved; all completed phase outputs remain addressable.

## Interfaces And Contracts

### Core SDK and persistence contracts

- `WorkflowDefinitionCreate` must persist phase definitions and version metadata with schema version marker (C-8).
- `WorkflowDefinitionRead` must return the canonical definition record and selected version metadata for the requested scope.
- `WorkflowDefinitionList` must enumerate the definitions visible to a caller, resolving scope most-specific-first — the caller's session, then its project, then the daemon's `shared` tier — and deduping on `(scope, scopeRef, contentHash)` (added 2026-08-10 by the Tier-8 plan-readiness audit). Enumeration is not optional polish: every other operation here addresses a definition by an id the caller must already hold, so without it a definition that is not already known cannot be reached at all, and the `session` / `project` / `shared` breadth the same amendment ratified would be unobservable.
- `WorkflowRunStart` must bind a workflow version to a session and create phase execution state.
- Definition/execution entity separation: `WorkflowPhaseId` identifies a phase in the definition (static); `PhaseRunId` identifies a specific execution (with iteration number, status, timestamps). `PhaseRunId` is deterministically generated as `BLAKE3(workflowRunId || phaseDefinitionId || attemptNumber)` (SA-21 — see State And Data Implications).
- `PhaseOutputRead` must expose durable phase outputs and artifact references.
- `WorkflowGateResolve` must resolve workflow-scoped approvals or participant questions; gate resolution rows are append-only hash-chained per §State And Data Implications.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

### Workflow gate scope vs channel gate scope (SA-7)

Workflow gates (`WorkflowGateResolve`) and channel moderation gates (Spec-016 per-turn) share the Plan-012 approval backend but are **temporally disjoint** (Pass B §3.2):

- Channel-level gates fire per-turn with `scope: channel`.
- `WorkflowGateResolve` fires at phase boundary with `scope: workflow-phase`.
- Pending channel gates **block** phase transition to `completed`. A phase cannot complete while its owned channel has an unresolved moderation gate.

### Multi-agent phase — `ownership: OWN` at V1 (SA-6, SA-8, SA-9)

`multi-agent` phase at V1 supports `ownership: OWN` only:

- Phase B receives phase A's channel transcript as read-only context via SDK ergonomic `inheritContext: { from: "previous_phase" }`.
- Retry creates a new channel per iteration — never reuses a phase-owned channel across attempts.
- `BIND` (multi-phase channel reuse) is committed to V1.1 under three named criteria in [ADR-015 §V1.1 Criterion-Gated Commitments](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments): (a) ≥3 production reports of OWN+transcript-inheritance insufficient, (b) concrete failure case documented, (c) BIND lifecycle contract addressing the five ambiguities recorded canonically in `ADR-015 §V1.1 Criterion-Gated Commitments`.
- Modern multi-agent composition convergence (2025–2026) is **state-passing, not handle-binding**: Temporal Child Workflows + Signals ([Temporal — Child Workflows](https://docs.temporal.io/develop/typescript/child-workflows)), LangGraph `Command(goto, state)` ([LangGraph multi-agent handoff](https://langchain-ai.github.io/langgraph/concepts/multi_agent/)), AutoGen `HandoffMessage` ([AutoGen Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)), OpenAI Assistants API Threads removal ([OpenAI Assistants deprecation, Threads removal 2026-08-26](https://platform.openai.com/docs/assistants/migration)). Airflow SubDAG — the closest BIND analogue — was deprecated in 2.x because its shared-scope ambiguity took 3+ years to patch ([Airflow — Deprecate SubDags in Favor of TaskGroups, #12292](https://github.com/apache/airflow/issues/12292)).

### Human phase — `HumanPhaseConfig` (SA-10, SA-11, SA-12)

Human-phase authoring uses the `HumanPhaseConfig` type:

```typescript
type HumanPhaseConfig = {
  prompt: string;
  inputSchema: JSONSchema7; // primitive-type fields + optional artifact ref
  assignees?: ParticipantRef[];
  dueAt?: Duration;
  timeout: "none" | Duration; // REQUIRED — no default; author must opt in
  timeoutBehavior?: "fail" | "continue" | "escalate"; // default 'fail'
};
```

- `timeout` is **required** at the SDK-type level — no field-default footgun (Wave 1 §5.1 SDK ergonomic safeguard). Author must type either `"none"` (no deadline; session timeline shows `waiting-human` until resolved) or an explicit `Duration`.
- Three independent durable-execution engines converge on no-default-timeout: [Temporal Workflow Execution Timeouts](https://docs.temporal.io/encyclopedia/detecting-workflow-failures) default ∞, [Argo — Suspending Workflows](https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/) with `{}` = indefinite suspend, [Camunda 8 User Task dueDate](https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/) optional/expression-based. This is modern durable-execution convention across independent implementations — not one-camp disagreement.
- `timeoutBehavior: 'escalate'` emits the `workflow.human_phase_escalated` telemetry event only at V1 (SA-11). No paging primitive exists; default-timeout is reconsidered V1.x once notification routing ships (see [ADR-015 §V1.1 Criterion-Gated Commitments](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments)).
- `human` phase uses the new Spec-012 approval category `human_phase_contribution` (SA-12). See [Spec-012 Approvals](../specs/012-approvals-permissions-and-trust-boundaries.md).
- Deep-link URL: `/session/:sid/workflow/:rid/phase/:pid`. Client-side autosave via localStorage / IndexedDB keyed on `(phaseRunId, participantId)` — daemon-side draft persistence deferred V1.x.

### Adapter contract (SA-15)

- First-party adapters (Codex, Claude, MCP tool adapters, channel surfaces) ship as separately-versioned packages under `@ai-sidekicks/adapter-*`. Core exposes an adapter contract via `packages/contracts/`. No `src/adapters/` folder inside core (C-6).
- Adapter-bundling precedent cost: Airflow `airflow.contrib` was force-split into 61 provider packages in the 2.0 release ([Airflow 2.0 providers](https://airflow.apache.org/docs/apache-airflow-providers/)).

### External tool references — content-addressed (C-7)

- External tool references in workflow definitions (e.g., `codex@v1.2.3#sha256=...`) must be content-addressed with hash pins. Mutable tags must not be trusted for externally-referenced definitions.
- This closes the [tj-actions/changed-files CVE-2025-30066](https://nvd.nist.gov/vuln/detail/CVE-2025-30066) retroactive-tag-repointing class (23,000 repositories compromised by a single upstream tag repointing).

### Secrets — by reference only (C-15)

- Secrets are referenced via `secret://<scope>/<name>` and resolved at phase-launch into environment variables, stdin, or a named-file file descriptor — **never argv**. Logging redaction is defense-in-depth, not primary control. Closes the argv-exposure vector documented in CVE-2025-30066 (runner memory dumped to logs via argv).

## State And Data Implications

### Truth vs projection vs ephemeral (SA-25)

Workflow state separates into three tiers (Pass G §1, §8):

- **Truth (immutable, source-of-truth):** `workflow_definitions` (content-hashed), `workflow_versions`, `phase_outputs`, `workflow_gate_resolutions` (hash-chained). These, together with `session_events` (Spec-006), are authoritative. Daemon must be able to rebuild everything else from them.
- **Projection (rebuildable):** `workflow_runs`, `workflow_phase_states`, `parallel_join_state`, `workflow_channels` — rebuildable via a `ProjectionRebuild` path owned by Plan-015 ([Temporal — Custom persistence layer, 2024](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer)).
- **Ephemeral:** pool reservation state is not persisted — re-requested on daemon restart; no runtime pool-counts rows (G §10.7 resolved).

Workflow definitions, versions, and phase outputs must be durable and replayable. Workflow and run histories must remain cross-linked for audit and replay. Optional workflow exports, previews, or summaries may be published as artifacts, but those artifacts are derivative views and must not replace the canonical definition store. Running workflows require phase-state persistence separate from UI state.

Plan-017 specifies the concrete 9-table SQLite schema (SA-24 lands there — implementation detail, not spec contract).

Canvas layout is deliberately **none of the three tiers** and therefore holds no daemon storage at V1: it is not truth (it is mutable per author), it is not a projection (it is not rebuildable from `session_events`), and it is not run-ephemeral (it must outlive a run). It is client-local, per §Canvas layout is not definition bytes (SA-35).

### Deterministic identity (SA-21)

`PhaseRunId` generator: `BLAKE3(workflowRunId || phaseDefinitionId || attemptNumber)`. **Derivation is total (clarified 2026-08-10, Tier-8 plan-readiness audit):** every bit of the identifier is a function of that preimage and none of it comes from a clock or an entropy source — so a `phaseRunId` is **not a ULID**, whose leading 48 bits are a millisecond timestamp the preimage cannot produce. Implementation surfaces that typed the column as a ULID were describing a shape this rule forbids; the audit corrected them and left the identifier's concrete text rendering open (see §Open Questions), because choosing a rendering is a design decision rather than an audit finding. Any ratified rendering must stay a pure function of the digest. Replay reproduces the same `phaseRunId` sequence; random ULIDs are forbidden for `phaseRunId`. Replay uses `session_events` + immutable truth tables as authority; projection tables rebuild via `ProjectionRebuild` ([Temporal Encyclopedia — Event History](https://docs.temporal.io/encyclopedia/event-history); [Bitovi — Replay Testing in Temporal](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows)).

### Hash-chain scheme (SA-26, SA-27)

- Approval history is append-only, per-`workflow_run_id` flat hash chain (C-13 / I7), anchored to Spec-006's existing scheme: **BLAKE3** digest, Ed25519 signature, RFC 8785 JSON Canonicalization Scheme. No new SHA-256 approval-chain scheme. Dual-anchored: each `workflow_gate_resolutions` row also has a corresponding `session_events` row whose payload carries the `row_hash` — the pre-ordered-log pattern from [Google Trillian](https://google.github.io/trillian/docs/TransparentLogging.html) at smaller scale.
- Flat chain (not a Merkle tree) is appropriate at V1 write volume per [Crosby & Wallach, Efficient Data Structures for Tamper-Evident Logging (USENIX 2009)](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf) and [AuditableLLM, MDPI Electronics 2025](https://www.mdpi.com/2079-9292/15/1/56).
- **Dual-hash algorithm (SA-27):** BLAKE3 for daemon-internal identity (workflow-definition content hash, `phaseRunId` derivation, approval-chain row digest). SHA-256 reserved for Plan-014 artifact-manifest content hashes where ecosystem interop matters. This is deliberate — different algorithms for different scopes, not an oversight.
- Write amplification: ~42 KB / 110 writes per 10-phase workflow; fits within 2–3 Spec-015 batches under `synchronous=FULL` WAL mode ([SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html)).

### Ship-empty tables (SA-28)

`human_phase_form_state` ships in V1 as an **empty schema** (reserved for V1.x daemon-side draft autosave). Zero migration cost when autosave feature lands; zero runtime cost while unused. Clients resume drafts from their own localStorage / IndexedDB per Pass C §3.2 until daemon-side drafts ship V1.x. Canvas layout for the visual builder persists on this same client-local tier and for the same reason — see §Canvas layout is not definition bytes (SA-35). Neither is daemon state at V1.

### I/O format invariants (C-5)

Workflow state, step inputs/outputs, captures: **JSON-only**. No pickle, no YAML-with-`!!python/object`, no eval-of-user-expression. Airflow XCom's pickle default enabled a direct RCE path, disabled in 2.0 ([Airflow — Turn off pickling of XCom by default in 2.0, #9606](https://github.com/apache/airflow/issues/9606)).

## Example Flows

- **Sequential with human gate.** A workflow runs `analyze → plan → implement → review`, pausing between `plan` and `implement` for a human-approval gate.
- **Version-immutable edit.** A workflow is edited after one instance has already started. The running instance continues on the old version while new runs use the new version.
- **Definition-as-artifact export (derivative view).** A project-scoped workflow definition is exported as a review artifact for discussion. Later workflow execution still binds to the canonical persisted definition version rather than to the artifact copy.
- **Parallel with `all-settled`.** A research workflow spawns `{pass-a, pass-b, pass-c, pass-d, pass-e}` in parallel under `ParallelJoinPolicy: all-settled`. Any pass that fails emits `workflow.phase_failed`; siblings continue; the workflow enters its synthesis phase once all five settle (pass or fail).
- **Multi-agent OWN.** A `deliberate` multi-agent phase spawns a phase-owned channel with three agents under `turn_policy: round-robin`, `turns_per_agent: 15`. The channel produces a conclusion artifact which becomes phase output. Phase completes; channel closes with `CLOSE_WITH_RECORDS_PRESERVED`. The next phase receives the transcript via `inheritContext: { from: "previous_phase" }`.
- **Human phase with escalation.** A `validate` human phase with `timeout: {days: 3}`, `timeoutBehavior: 'escalate'`, `inputSchema: {decision: enum['approve','reject'], notes: long_text}`. The participant opens the deep-link `/session/:sid/workflow/:rid/phase/:pid`, drafts a reply (localStorage autosave), submits. Gate resolves with `scope: workflow-phase`. If timeout fires before submit, the workflow emits `workflow.human_phase_escalated` telemetry event — no paging at V1 (deferred per `ADR-015 §V1.1 Criterion-Gated Commitments` until notification routing ships).

## Quality-Check Model

- Retry targets: the phase that produced the output, or a specific earlier phase (configured per gate).
- Max retries: configurable per gate (default 3).
- Quality-check failure behavior: `block` (halt workflow), `warn` (continue with flag), `skip` (bypass gate).
- Quality checks are evaluated by a dedicated agent or automated script — not by the same agent that produced the output.

## Output Mode Specification

- V1: structured JSON with artifact references. Each phase produces `{artifacts: ArtifactId[], summary: string, metadata: Record<string, unknown>}`.
- V2 (deferred): conversation markdown, channel transcripts, rich media as first-class output types.
- Phase outputs are stored as artifacts (Plan-014) with `artifactType: 'workflow_output'`.

## Discussion Integration Path

- **V1:** `single-agent` phases run one agent in one channel. `multi-agent` phases spawn phase-owned channels (`ownership: OWN`) where agents discuss before producing output; the channel's conclusion becomes phase output.
- **V1.1 (criterion-gated):** `ownership: BIND` — multi-phase channel reuse. Contingent on three criteria in [ADR-015 §V1.1 Criterion-Gated Commitments](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments). See Interfaces And Contracts §Multi-agent.
- **V2 (deferred):** cross-phase discussion channels — agents from different phases collaborate in shared channels.

## Workflow Timeline Integration

### Event envelope and category split (SA-18)

All workflow events land as payloads inside the existing Spec-006 `EventEnvelope` — **no new envelope schema**. `causationId` on the envelope carries parent-event relationships; `workflow_run_id` / `phase_run_id` are payload fields. This is an additive MINOR envelope bump under [ADR-018](../decisions/018-cross-version-compatibility.md) discipline.

V1 introduces **5 new Spec-006 categories** (not one monolithic `workflow_lifecycle`):

- `workflow_lifecycle`
- `workflow_phase_lifecycle`
- `workflow_parallel_coordination`
- `workflow_channel_coordination`
- `workflow_gate_resolution`

Scope-of-query split matches Spec-006's existing `run_lifecycle` / `approval_flow` pattern. No collision with existing `presence.*`, `run.*`, `approval.*`, `channel.*`, `recovery.*` categories.

Reverse-DNS `workflow.*` namespace convention follows [CloudEvents Specification v1.0.2 `type` attribute](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md#type).

### Event types (SA-19) — 23 types under `workflow.*`

- **`workflow_lifecycle` (6):** `workflow.created`, `workflow.started`, `workflow.gated`, `workflow.failed`, `workflow.completed`, `workflow.resumed`
- **`workflow_phase_lifecycle` (12):** `workflow.phase_admitted` (new; resource-pool admission), `workflow.phase_waiting_on_pool` (diagnostic), `workflow.phase_started`, `workflow.phase_progressed`, `workflow.phase_cancelling`, `workflow.phase_failed` (extended with `cancellation_reason: 'sibling_failure' | null`), `workflow.phase_retried`, `workflow.phase_suspended`, `workflow.phase_resumed`, `workflow.phase_completed`, `workflow.human_phase_claimed` (informational), `workflow.human_phase_escalated` (telemetry-only at V1 per SA-11; no `nextAction` pre-declaration — additive-field discipline per ADR-018)
- **`workflow_parallel_coordination` (1):** `workflow.parallel_join_cancellation` (sibling cancel driven by `ParallelJoinPolicy`)
- **`workflow_channel_coordination` (3):** `workflow.channel_created_for_phase`, `workflow.channel_closed_with_records_preserved`, `workflow.channel_terminated_forcibly`
- **`workflow_gate_resolution` (1):** `workflow.gate_resolved` — carries `scope: channel | workflow-phase` + `outcome`. The base payload is extended at the persistence layer with `gate_resolution_id` + `row_hash` fields to realize the `session_events` dual-anchor (SA-26). No separate chain-advance event — the gate-resolved event carries the chain extension. Payload additions are additive MINOR bumps under [ADR-018](../decisions/018-cross-version-compatibility.md).

### Ordering invariants (SA-20)

Load-bearing event-sequence rules ([Temporal Events Reference](https://docs.temporal.io/references/events), [Temporal — Events and Event History](https://docs.temporal.io/workflow-execution/event)):

- `workflow.phase_admitted` precedes `workflow.phase_started` (resource-pool admission required first).
- `workflow.phase_cancelling` precedes `workflow.phase_failed` whenever `cancellation_reason != null`.
- `workflow.gate_resolved` with `scope: workflow-phase` precedes the subsequent `workflow.phase_started`.
- `workflow.channel_created_for_phase` precedes any events with matching `channelId`.
- Parallel cancellation fires one coordinator event (`workflow.parallel_join_cancellation`) + per-sibling event chains at deterministic tick-boundary — never mid-callback.

### Cadence (SA-22, SA-23)

- `workflow.phase_progressed` cadence is phase-type-specific:
  - `single-agent` / `automated`: emit on turn completion + tool-invocation boundary.
  - `multi-agent`: emit on channel-turn boundary + 25 / 50 / 75% of `turns_per_agent` budget milestones.
  - `human`: emit on form-section save + claim / re-claim.
- `workflow.phase_waiting_on_pool` cadence: emit on entry-to-blocked-state + 30-second intervals while blocked (tripwire-configurable), carrying `waitingSinceSeq` for reader correlation. Pass G stores aggregate `totalPoolWaitMs` on phase row — not per-wait rows (G §10.1 resolved).
- `workflow.resumed` payload carries structured `resumptionPoint: {activePhaseRunIds, pendingGates}` for reader-reconstruction speed (aligns with low-cardinality naming per [OpenTelemetry SemConv for Events](https://opentelemetry.io/docs/specs/semconv/general/events/); [n8n Workflow Executions](https://docs.n8n.io/workflows/executions/) provides durable-resume prior art).

### Session timeline surfacing

- Workflow phases appear as distinct sections in the session timeline (Spec-013).
- Retry iterations appear as sub-entries within the phase section.
- `workflow.phase_suspended` with `reason: 'waiting-human'` is a first-class surfaced event; session UI surfaces pending-human count prominently (Pass C §5.1 mitigation for no-default-timeout UX cost).

## Phase-Type and Gate-Type Taxonomy

Phase types (V1):

| Type | Description |
| --- | --- |
| `single-agent` | One agent executes the phase autonomously in one channel |
| `multi-agent` | Phase-owned channel (`ownership: OWN`) — multiple agents deliberate, conclusion becomes phase output |
| `automated` | No agent — executes a script or validation check |
| `human` | Human participant completes a form; submission becomes phase output |

Gate types (V1):

| Gate Type | Behavior | Failure Behavior |
| --- | --- | --- |
| `auto-continue` | Phase completes, next phase starts automatically | N/A (no gate check) |
| `quality-checks` | Automated quality check runs on phase output | Configurable: block / warn / skip. Retry: re-run phase up to `max_retries`. |
| `human-approval` | Human must approve phase output before continuing | Block until approved. Reject: retry or stop (configurable). |
| `done` | Terminal gate — marks workflow as complete | N/A |

Failure behaviors: `retry`, `go-back-to`, `stop`. Phase run statuses: `pending`, `running`, `completed`, `failed`, `skipped`. Gate result statuses: `passed`, `failed`, `waiting-human`.

## Visual Workflow Builder

V1 ships a visual, node-graph authoring surface for workflow definitions alongside the file and SDK authoring paths. The builder is an **authoring and visualization surface over the execution model defined above** — it introduces no execution semantics, no scheduling behavior, and no node kind the phase model cannot already express. Every graph the builder can produce serializes to the same `PhaseDefinition` sequence a hand-authored definition produces, and the daemon accepts it through the same `workflow.definitionCreate` path with the same validation. See [ADR-026](../decisions/026-visual-node-graph-workflow-authoring.md).

### Graph model — nodes, ports, and edges (SA-32)

The persisted node set is **exactly the phase set plus one entry node**. Nothing else is a node.

| Node kind | Persisted as | Count | Notes |
| --- | --- | --- | --- |
| Phase node | one `PhaseDefinition` in the definition's phase sequence | one per phase | Carries the phase's declared type — `single-agent`, `multi-agent`, `automated`, `human` — from §Phase-Type and Gate-Type Taxonomy. The node's visual class is that type; there is no fifth phase type and the builder cannot mint one. |
| Entry node | not a phase; a definition-level `entry` record | exactly one, mandatory | Names how a run of this definition begins. It never enters the phase sequence, never receives a phase run id, and never produces a phase-state row. |

Everything else an author manipulates on the canvas is a **property of a phase node**, edited in that node's inspector and rendered on the node as a badge or attached affordance — never an independent node with its own identity:

- **Gate** — the phase's gate type (`auto-continue`, `quality-checks`, `human-approval`, `done`). Rendered on the phase node's outgoing edge shoulder. A gate is not a node; promoting it to one would require a node kind the phase-type domain does not contain and would put a second writer on the phase-state row.
- **Agent assignment** — the agents a `single-agent` or `multi-agent` phase runs, rendered as avatars inside the phase node. A `multi-agent` phase's agents are the members of that phase's OWN channel; they are not separate graph nodes, because they have no independent position in the phase sequence.
- **Tool / action binding** — see §Tool bindings are references, never inline policy (SA-34) below.
- **Human-form definition** — a `human` phase's form config, edited in the inspector.

**Edges.** A single edge kind exists: the **sequence edge**, meaning "when the source phase's gate resolves to continue, the target phase becomes eligible." Fan-out from one phase node to several targets is the graph spelling of the existing within-phase-boundary parallel construct and carries the definition's `ParallelJoinPolicy` on the join, exactly as a hand-authored definition does. Ports are typed by construction: a phase node exposes one inbound port and one gate-qualified outbound port; the entry node exposes an outbound port only and has no inbound port.

**`go-back-to` is not an edge.** §Required Behavior states it is a state-reset operation, not a cyclic edge, and `workflow.definitionCreate` runs a cycle check that would reject the cyclic spelling. The builder therefore renders a phase's `go-back-to` target as an **annotation on the phase node** (a labelled back-reference), never as a drawn connection, and the connection layer refuses any attempt to draw one. A builder that drew it would emit definitions the daemon rejects on every save.

### Graph shapes that are refused (SA-33)

The builder refuses these at **edit time** — a connection that would produce one cannot be completed, and a definition that already contains one cannot be saved:

1. **Any cycle** among phase nodes, including a self-edge. Mirrors the definition-create cycle check.
2. **An orphan phase** — a phase node not reachable from the entry node by sequence edges.
3. **Zero phase nodes.** A definition must contain at least one phase.
4. **Zero or more than one entry node in the graph.** The refusal is on the graph and on the stored definition, which always carry exactly one entry record — it is **not** a wire-level requirement: a `workflow.definitionCreate` request may omit the entry record, because `manual` is the only V1 start mode and the daemon materializes it (§Entry node and the V1 trigger surface (SA-37)). A request carrying an entry record with an unrecognized start mode still refuses.
5. **Any edge whose target is the entry node.**
6. **A `done`-gated phase with an outgoing sequence edge** — `done` terminates; an outgoing edge would assert a successor the engine will never run.
7. **A fan-out whose branches carry no join policy**, or whose branches converge on more than one join point.

**Edit-time validation mirrors the daemon check; it never replaces it (SA-33).** Every rule above is re-evaluated server-side at `workflow.definitionCreate`, and the daemon's answer is authoritative. A client that skips, weakens, or predates a rule produces a **refusal**, not a persisted definition — the fail-closed direction. Refusals surface as the typed codes registered in [error-contracts.md](../architecture/contracts/error-contracts.md) §Workflow; the builder mints no error surface of its own, and until the pending §Workflow extension lands, an unregistered condition refuses under the existing codes rather than inventing one, per §Loud-errors discipline (C-12).

### Tool bindings are references, never inline policy (SA-34)

A phase node may bind tools. The binding a definition persists is a **reference only**: the scope-qualified binding identity plus a tool name, resolved at phase launch through the [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) §Tool Metadata layer that [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) §Tool-Level Overrides feeds.

A workflow definition **MUST NOT** carry any governance facet inline. Specifically, a tool binding in a definition carries no `enabled`, no `approvalMode`, and no `idempotencyClass` value — those three facets are node-operator surface, set only through the Spec-028 override operations, Cedar-gated per [Spec-028](../specs/028-mcp-server-configuration-and-governance.md) §Authorization, and independent per binding scope. A definition that carried them would let a workflow author grant themselves an approval posture the operator never granted, and would let a definition exported from one machine silently import a weakened posture onto another. The builder's inspector therefore **displays** the effective facets read-only, sourced live from the governance surface, and offers no control that writes them.

Trust is likewise not a definition concern: an untrusted binding refuses at launch under the Spec-028 trust rules, and the builder shows that state rather than overriding it. This is a distinct mechanism from the content-addressed external-tool pin of §External tool references — content-addressed (C-7): that pin governs a fetched tool artifact's bytes, while a tool binding's identity and trust are governed by the binding's own keyed base-config hash. Neither substitutes for the other.

### Canvas layout is not definition bytes (SA-35)

The **canonical definition** is the JCS-canonicalized JSON body the BLAKE3 content hash already covers. Canvas geometry — node coordinates, viewport pan and zoom, collapse state, and any other purely visual attribute — is **excluded from that body** and from the hash preimage. Dragging a node changes no byte of the definition, mints no content hash, and creates no version. This exclusion is **hash-scope only, never semantics-scope**: nothing that affects execution may be moved into the layout channel to escape hashing, and every field the engine reads stays inside the hashed body.

Layout persists **client-local**, on the same tier and by the same mechanism as `human` phase form drafts in §Ship-empty tables (SA-28) — browser-local storage in the renderer, with no daemon write and no table. The choice is forced by §Truth vs projection vs ephemeral (SA-25): `workflow_versions` is immutable truth, so a mutable per-author geometry cannot live there; a new mutable table would be neither truth nor a projection rebuildable from `session_events`, which is a tier SA-25 does not define; and eventing geometry would enlarge the workflow event taxonomy for data no execution path reads.

Layout is nonetheless **portable**, because the file form of §Definition file form — export and import (C-17) carries it as an optional top-level section outside the hashed body. A definition opened with no layout available — freshly imported, authored through the CLI or SDK, or opened on a second machine — renders through a **deterministic topological auto-layout** derived from the phase sequence, so a definition is never unopenable and two authors opening the same layout-less definition see the same arrangement.

### Definition scope in the builder (SA-36)

The builder loads and saves at all three scopes of §Resolved Questions and V1 Scope Decisions.

- **Loading** lists definitions visible from the current context — the session's own, its project's, and the daemon's `shared` tier — grouped by scope, with the resolution order (`session`, then `project`, then `shared`) shown so an author can see which definition a run would pick.
- **Saving at `session` or `project` scope** creates a new immutable version of that definition, exactly as today.
- **Saving an edit to a `shared` definition is copy-on-write, never edit-in-place.** Opening a `shared` definition and editing it produces a **new definition at the editing context's scope** (`project` by default, `session` if there is no project context), carrying the shared definition's content hash as its parent content hash so provenance is recorded in the existing version-chain field. The `shared` original is untouched.

  Copy-on-write is required, not preferred. Definition rows are immutable by construction — the definitions table deliberately carries no updated-at column — so "editing in place" would mean appending a version to the shared definition, which silently repoints **every project on the daemon** that resolves it, with no signal at any consuming project and no way for a consumer to pin. Copy-on-write keeps the blast radius of an edit equal to the scope the editor is standing in, which is the same containment principle that makes two same-scope-name MCP bindings distinct entries rather than a merge.

- **Promotion `project → shared` is an explicit, separately-invoked operator action**, never an implicit consequence of saving. It creates the definition at `shared` scope from the promoted version's exact bytes.

### Entry node and the V1 trigger surface (SA-37)

Every definition has exactly one entry node, which records **how a run begins**. At V1 the entry node's start mode has exactly one value: **manual** — a run begins when a participant starts it through `workflow.runStart` or the CLI.

The entry node is shipped as a **structurally extensible single-value record, not a union with unhonored arms**. No `schedule`, `event`, or `webhook` arm is declared, because §Non-Goals records the C-11 precedent for exactly this shape — an enum whose arms outran the engine had to be break-removed later — and §Loud-errors discipline (C-12) forbids a surface that looks like a capability and silently is not. When a firing engine ships, its start mode is an additive-MINOR extension under [ADR-018](../decisions/018-cross-version-compatibility.md), and the run row's existing creator field already distinguishes a participant-initiated run from a trigger-initiated one, so the persistence hook is in place without declaring the arm early.

### Definition file form — export and import (C-17)

A workflow definition has one canonical file form, and it is the YAML the authoring commitment already names, carrying the schema-version marker the versioning commitment already requires. **No second schema dialect exists**: the file is the definition, and its canonical bytes are the JCS-canonicalized JSON of the parsed document — which is precisely the existing hash preimage, so a definition's content hash is identical whether it arrived through the builder, the SDK, or a file.

The document has exactly two top-level parts:

1. The **definition body** — the hashed, canonical part. Everything the engine reads.
2. An **optional `layout` section** — canvas geometry, outside the hashed body. An importer that does not understand it, or a consumer that does not want it, ignores it and loses nothing executable. A CLI-authored file omits it entirely.

Round-tripping is closed in both directions: builder → file → CLI → daemon and CLI → file → builder produce the same definition body bytes and therefore the same content hash. Export is a serialization of an existing read; import is a submission through the ordinary definition-create path with the ordinary validation, so an imported definition is subject to every refusal rule above and to the ordinary tool-governance resolution — an import can never carry governance state with it.

## Implementation Notes

- Workflow authoring belongs in the product surface, but workflow execution still uses the same run, approval, and artifact primitives as free-form sessions.
- Version immutability simplifies replay and support.
- Phase-level parallelism remains explicit and bounded — no implicit concurrency.
- Persistence uses a LangGraph-inspired checkpoint pattern on the existing SQLite store (Spec-015), with the normalized-tables-over-JSON-blob decision documented in State And Data Implications. No external workflow engines (Temporal, Restate) — contradicts ADR-002 (local-first). V1 ships ahead of OpenTelemetry workflow semantic conventions and adopts OTel semconv additively when ratified.
- One execution model at V1 per C-11: local daemon runs workflows locally. Do not ship a `local | queued | remote` enum at V1.

## Pitfalls To Avoid

### Structural pitfalls

- Mutating running workflow definitions in place.
- Hiding workflow phase outputs outside the session timeline.
- Treating workflow pause as a UI-only banner with no durable execution state.
- Using mutable tags instead of content-addressed pins for external tool references — directly opens the CVE-2025-30066 class.
- Absorbing `BIND` multi-phase channel reuse into V1 without the three ADR-015 criteria being met — engineering risk budget is documented in Pass B §3.1.
- Recording sibling cancellation in async callbacks instead of at a deterministic synchronous tick checkpoint — reintroduces the non-determinism class observed in Temporal Java SDK #902.
- Collapsing `user_input` approval / `human-approval` gate / `human` phase into two categories — the three-way split is load-bearing (Pass C §2).

### Security invariants (non-conformant if violated) — SA-13 / Pass E §4

Engine implementations violating any of the following are **non-conformant**. Each invariant is a testable contract requirement; concrete CVE-reproducer corpora and test categories are specified in [Plan-017 §Testing](../plans/017-workflow-authoring-and-execution.md) (SA-29, SA-30, SA-31 — implementation detail, not spec surface).

- **I1 — argv-only execution.** The engine **MUST NOT** accept a shell-string command form for user-templated content. No `shell=true`, no `/bin/sh -c "..."` over author-controlled fields. All commands execute via argv-list spawn only. Closes [GitHub Actions — Script-injection guidance](https://docs.github.com/en/actions/concepts/security/script-injections), [n8n CVE-2025-68613 (CVSS 9.9)](https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp), and [Airflow CVE-2024-39877](https://nvd.nist.gov/vuln/detail/CVE-2024-39877) in one architectural choice.
- **I2 — typed substitution; no templating over author-controlled fields.** The engine **MUST NOT** evaluate Jinja2, `${...}`, `{{}}`-eval, or any Turing-complete expression language over workflow-definition strings. Parameter substitution is a closed, non-Turing-complete lookup grammar with a whitelist. Closes the template-injection class.
- **I3 — typed approver capability.** The engine **MUST NOT** treat approver permission as a submitter string or as "whoever has `Read`". Approver principal is a typed capability bound to an identity (Spec-012). Admin override is a distinct audited capability. Anti-pattern: Jenkins Pipeline Input Step historically approved on `Item/Read` (CVE-2017-1000108, fixed in plugin 2.8 on 2017-08-07) and still silently bypasses the `submitter` allow-list for holders of `Jenkins.ADMINISTER` with no audit emission ([Jenkins SECURITY-576 advisory, 2017-08-07](https://www.jenkins.io/security/advisory/2017-08-07/); [`InputStepExecution.java` `canSettle()`](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java); [JENKINS-56016 Won't Fix](https://issues.jenkins.io/browse/JENKINS-56016)).
- **I4 — secrets by reference only.** The engine **MUST NOT** accept inline secret material in workflow definitions. Secrets are referenced as `secret://<scope>/<name>` and resolved at phase-launch into env / stdin / named-file fd — never argv. Logging redaction is defense-in-depth on top, not primary control. Closes [tj-actions/changed-files CVE-2025-30066](https://nvd.nist.gov/vuln/detail/CVE-2025-30066) runner-memory-via-argv class. The redaction-is-defense-in-depth stance is motivated by [Airflow secret masker issue #54540](https://github.com/apache/airflow/issues/54540) Vault masking regression (Airflow 3.0.0-3.0.4).
- **I5 — content-addressed external references.** The engine **MUST NOT** resolve external tool references by mutable tag. References carry hash pins (`codex@v1.2.3#sha256=...`). Closes CVE-2025-30066 retroactive-tag-repointing class.
- **I6 — OWASP File Upload minimums on human-phase uploads.** The engine **MUST** enforce size cap, extension allowlist, magic-byte sniff, storage rename, path validate, AV hook, quarantine-on-fail per [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html). Closes [Argo CVE-2025-66626](https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo) symlink-traversal-via-broken-fix class.
- **I7 — append-only hash-chained approval history.** The engine **MUST NOT** permit mutation of `workflow_gate_resolutions` rows. Workflow-definition edits are a separate audit entry. Replays use at-execution-time policy — not current definition ([Crosby & Wallach USENIX 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf); [AuditableLLM MDPI 2025](https://www.mdpi.com/2079-9292/15/1/56); Temporal's Event History is the reference pattern).
- **I1–I7 testability.** Every invariant has ≥1 test that fails when the invariant is violated. Test categories and CVE-reproducer corpora are specified in Plan-017 §Testing (SA-30).

### Terminology discipline (SA-17 / C-12)

- Use **"workflow"** (not pipeline / flow), **"phase"** (not stage / task), **"artifact"** (not output / capture when persisted), **"step"** reserved for intra-phase operations if any.
- Airflow Datasets→Assets, SubDAG→TaskGroup, execution_date→logical_date terminology churn is the precedent for cost of late rename ([Airflow — Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html)).

## Acceptance Criteria

- [ ] Workflows can be authored as versioned phase definitions with schema version marker; cycle-check rejects invalid definitions at author time.
- [ ] All four phase types execute: `single-agent`, `multi-agent` (`OWN` only), `automated`, `human`.
- [ ] All four gate types resolve correctly, with channel gates blocking phase transition per temporally-disjoint contract (SA-7).
- [ ] Workflow runs survive reconnect and daemon restart with phase state intact; replay reproduces deterministic `phaseRunId` sequence (SA-21).
- [ ] Parallel phase execution honors `ParallelJoinPolicy`; `fail-fast` cancels siblings at deterministic tick boundary (SA-4).
- [ ] Resource-pool admission (`pty_slots`, `agent_memory_mb`) blocks phase launch when pool saturated; tripwire events fire.
- [ ] `RUN_ITERATION_LIMIT` / `max_duration` / `max_retries` bounds all hard-fail with preserved `failure_reason` (SA-1, SA-2).
- [ ] Workflow phase outputs are addressable after workflow completion; retries produce new output rows (immutability preserved — SA-16).
- [ ] Human-phase `HumanPhaseConfig.timeout` is typed `'none' | Duration` with no field-level default (SA-10).
- [ ] Human-phase uploads enforce OWASP File Upload minimums; CVE-2025-66626 regression battery passes (I6).
- [ ] Approval history hash chain verifies on replay; tamper-detection tests pass (I7 regression battery).
- [ ] Security regression battery covers I1–I7 invariants with CVE-reproducer corpora (test surface lands in Plan-017 §Testing per SA-30).
- [ ] All 23 workflow event types emit in the Spec-006 envelope with correct ordering invariants; Pass F ordering-invariant tests pass.
- [ ] Secrets referenced via `secret://...` never appear in argv, logs, or artifacts (canary-secret regression — I4).

## ADR Triggers

- If workflow execution requires a materially different orchestration model than session and run primitives allow, create a new ADR before implementation.
- If the `BIND` criterion-gated commitment (per ADR-015) is activated, draft a BIND-lifecycle ADR resolving the five ambiguities documented in [ADR-015 §V1.1 Criterion-Gated Commitments](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments).
- If cross-plan SQLite STRICT adoption warrants, draft the SQLite STRICT policy ADR (proposed follow-up task per [ADR-015 §V1.1 Criterion-Gated Commitments](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments)).
- If OpenTelemetry workflow semantic conventions ratify, draft an additive ADR-018 MINOR bump for `traceparent` carriage on the envelope.

## Open Questions

Backfilled 2026-08-10 by the Tier-8 plan-readiness audit (A-017-12). Questions this spec settled are recorded below in §Resolved Questions and V1 Scope Decisions. The first two entries here are open against **other** specs, not against this one; the third is open against this spec but is narrow — it asks how a value this spec already constrains is rendered, not what the value must be. No entry gates a Required Behavior row: §Deterministic identity (SA-21) is satisfied by any rendering that stays a pure function of the digest, so the determinism row holds irrespective of which rendering is ratified. Criterion 2 of the runbook `§Spec-Status Promotion Gate` is therefore satisfied by deferral with a named vehicle rather than by resolution.

- **Where the 23 `workflow.*` event types and their five categories are registered.** §Workflow Timeline Integration enumerates them, but `Spec-006 §Event Type Summary` — the owning registry — carries no `workflow` category. Deferred to a combined Spec-006/Plan-006 targeted readiness-audit delta, following the ratified `mcp_governance` registration precedent; registration moves the summary rows, the marker-governed in-band total, and Plan-006's prose census in one PR. Tracked plan-side as `Plan-017 §Upstream-Tier Amendments Required` and gated by a named Precondition box on every Plan-017 phase.
- **Which surface provides the OWN channel's `turns_per_agent` budget.** §Interfaces And Contracts specifies the budget and §Workflow Timeline Integration emits progress at 25 / 50 / 75% of it, but no Spec-016 `ChannelConfig` field, `workflow_channels` column, or Spec-016 default supplies a value — and the "bare-channel 50" comparator has no bare-channel default to compare against. Ratified resolution: Plan-016 owns the field (`ChannelConfig.turnsPerAgent`) and also gains an `InterruptReason` member for workflow-phase-driven interrupts, without which the SA-9 `REQUEST_CANCEL` and `TERMINATE` policies have no mechanism to invoke. Deferred to the Spec-016/Plan-016 restoring readiness-audit delta; gated plan-side on Plan-017 Phase 3, with Phases 4–5 chained behind it.
- **How a derived `phaseRunId` is rendered into its text form.** §Deterministic identity (SA-21) fixes the preimage and, as of the 2026-08-10 clarification, fixes that the identifier is totally derived — but not the encoding of the digest into the column's stored characters. The obvious candidate, "ULID-shaped so the column type is unchanged," is not self-consistent as usually stated: Crockford base32 carries 5 bits per character, so a 26-character rendering spans 130 bits, and a ULID reaches 26 characters by padding its 128 bits and constraining the leading character — a rendering rule that must be written down rather than assumed. The audit deliberately did **not** choose: picking an encoding is a design decision of the same class as the scope domain, and the identifier is a durable primary key, so the choice is one-way. Deferred to lead ratification and a targeted Spec-017/Plan-017 delta, which must state the digest function's output width, the truncation or padding rule, the alphabet, and whether any leading-character constraint applies. Until it lands, implementation surfaces must describe the column as a derived opaque identifier and must not call it a ULID.

## Resolved Questions and V1 Scope Decisions

- **V1 scope per [ADR-015 amendment 2026-04-22](../decisions/015-v1-feature-scope-definition.md) (BL-097 resolution).** Full workflow engine ships at V1 (the then-17-feature V1 — workflow promoted from V1.1-deferred to V1; V1 subsequently grew to 23 features per the ADR-015 amendment of 2026-07-02, which does not affect this promotion). Two workflow-scoped V1.1 criterion-gated commitments documented in `ADR-015 §V1.1 Criterion-Gated Commitments`: (1) `BIND` multi-phase channel reuse (3 criteria); (2) `human`-phase default timeout once notification routing ships (1 criterion). (The ADR section gained a third, non-workflow commitment — the automated GDPR erasure endpoint, 2026-07-08 per BL-139 — and a fourth, also non-workflow — direct-first artifact fetch, C4, 2026-07-08 with the cross-node artifact pull-forward; neither affects this spec.)
- **V1 decision (BL-097 D1, Wave 1 §5.1):** no default timeout on `human` phase. Required typed opt-in `timeout: 'none' | Duration`. Revisit V1.x once notification routing ships. Rationale: three durable-execution engines (Temporal ∞, Argo `{}`, Camunda 8 expression-based) converge on no-default-timeout as modern convention; the `7d+escalate` alternative is illusory at V1 because no paging primitive exists — escalate fires telemetry-only, creating the "telemetry-that-looks-like-protection" silent-failure class (violates C-12).
- **V1 decision (BL-097 D2, Wave 1 §5.2):** `multi-agent` phase ships `ownership: OWN` only; `BIND` is criterion-gated V1.1. Rationale: modern multi-agent composition (2025–2026) is state-passing (Temporal Child Workflows, LangGraph `Command(goto, state)`, AutoGen `HandoffMessage`), not handle-binding. BIND adds 5 state-machine invariants on top of OWN's 3 (retry↔BIND, abandon↔BIND, gate-scoping lattice, membership snapshot timing, termination authority); Airflow SubDAG's lifecycle bugs took 3+ years to patch before deprecation. OWN-only→V1.1 BIND is additive (non-breaking); OWN+BIND at V1→V1.1 revision is breaking.
- **V1 decision (amended 2026-08-10, Tier-8 plan-readiness audit):** the workflow-definition scope domain is three-valued — `session` \| `project` \| `shared`. `session` binds a definition to its authoring session; `project` spans the sessions of one project; `shared` is the cross-project tier, a definition authored once and reusable by any project on the same daemon. All three resolve out of the same local definition store: no additional table and no synchronization path. Scope identity is carried by a `scope_ref` value alongside `scope`, in the shape `Spec-028 §Unified Inventory` already uses for scope-qualified bindings — the authoring session id at `session`, the canonical repository root at `project`, the empty string at `shared` — and definition dedupe keys on `(scope, scope_ref, contentHash)` so one definition stored at a scope is one record regardless of which session submitted it. Resolution at run start walks the tiers most-specific-first — `session`, then `project`, then `shared` — with **no merging across tiers**: two definitions of the same name at two scopes are two distinct definitions, exactly as two same-named MCP bindings in two scopes are distinct entries. Widening `scope` alone would not be storable: `project` would name no project, and a dedupe key rooted in the authoring session would split a `shared` definition into one record per submitting session. `workflow_definitions.session_id` keeps recording the authoring session at every scope, so provenance survives the widening. `shared` widens **visibility and reuse breadth only** — it is not publication, not a marketplace, and not cross-machine sync; global workflow libraries and any distribution of definitions beyond the storing daemon remain out of scope per §Non-Goals. The `channel` scope value that appeared on the contract doc and the SQLite DDL before this amendment was never specified here and is struck: a channel-scoped definition has no defined visibility semantics and would have collided with the Spec-016 `direct` channel kind, whose audience is server-forced `humans-only`.
- **V1 decision:** workflow definitions are canonical durable definition records, not canonical artifacts. Artifact publication is allowed only for derivative exports, previews, or summaries.
- **V1 decision:** one execution model (local) at V1 per C-11. No `local | queued | remote` enum at V1.

## References

### Governing docs

- [ADR-015 — V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) (amended 2026-04-22 per BL-097)
- [ADR-002 — Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [ADR-018 — Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md)
- [ADR-026 — Visual Node-Graph Workflow Authoring](../decisions/026-visual-node-graph-workflow-authoring.md) (governs §Visual Workflow Builder)

### Related specs

- [Spec-016 — Multi-agent channels and orchestration](../specs/016-multi-agent-channels-and-orchestration.md) (phase-owned channel dependency)
- [Spec-006 — Session event taxonomy and audit log](../specs/006-session-event-taxonomy-and-audit-log.md) (new categories + event types land here)
- [Spec-012 — Approvals, permissions, and trust boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md) (`human_phase_contribution` category; Plan-012 backend)
- [Spec-013 — Live timeline visibility and reasoning surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md) (phase surfacing, pending-human count)
- [Spec-014 — Artifacts, files, and attachments](../specs/014-artifacts-files-and-attachments.md) (Plan-014 artifact refs; SHA-256 manifest)
- [Spec-015 — Persistence, recovery, and replay](../specs/015-persistence-recovery-and-replay.md) (projection-rebuild path; replay corpus)
- [Spec-005 — Provider driver contract and capabilities](../specs/005-provider-driver-contract-and-capabilities.md) (§Tool Metadata resolves a phase's tool bindings at launch, per SA-34)
- [Spec-028 — MCP server configuration and governance](../specs/028-mcp-server-configuration-and-governance.md) (owns the scope-qualified binding identity and the governance facets a definition must never carry inline, per SA-34)

### Primary sources (external)

**DSL / schema-version / freeze-regret precedents (C-1, C-6, C-8, C-9, C-11, C-12, SA-14, SA-15, SA-16, SA-17):**

- [Dagger — Ending Support for the Dagger CUE SDK](https://dagger.io/blog/ending-cue-support/) — 2023
- [Changelog #550 — From Docker to Dagger with Solomon Hykes](https://changelog.com/podcast/550) — 2023
- [GitHub Actions — HCL→YAML deprecation](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/) — 2019
- [Airflow 2.0 provider packages](https://airflow.apache.org/docs/apache-airflow-providers/) — forced split from `airflow.contrib`
- [Airflow — Turn off pickling of XCom by default in 2.0, #9606](https://github.com/apache/airflow/issues/9606) — JSON replaced Pickle to close RCE exposure; `[core] enable_xcom_pickling` forced to `False`
- [Airflow — Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html) — Datasets→Assets, SubDAG→TaskGroup, execution_date→logical_date
- [Airflow — Deprecate SubDags in Favor of TaskGroups, #12292](https://github.com/apache/airflow/issues/12292) — SubDAG removed in Airflow 3.0; TaskGroup is the canonical replacement
- [GitHub Actions — v3 artifact deprecation notice (2024-04-16)](https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/) — mutability-forced v3→v4 migration precedent for C-9 / SA-16

**Security invariants (I1–I7, C-7, C-15, C-16):**

- [GitHub Actions — Script-injection guidance](https://docs.github.com/en/actions/concepts/security/script-injections)
- [n8n CVE-2025-68613 advisory (CVSS 9.9)](https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp)
- [Airflow CVE-2024-39877](https://nvd.nist.gov/vuln/detail/CVE-2024-39877)
- [tj-actions/changed-files CVE-2025-30066](https://nvd.nist.gov/vuln/detail/CVE-2025-30066)
- [Airflow secret masker issue #54540 (Vault masking regression, Airflow 3.0.0-3.0.4)](https://github.com/apache/airflow/issues/54540)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) — 2025
- [Endor Labs — CVE-2025-66626 Argo broken-fix analysis](https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo)
- [Jenkins SECURITY-576 / CVE-2017-1000108 advisory (2017-08-07)](https://www.jenkins.io/security/advisory/2017-08-07/)
- [NVD CVE-2017-1000108 — Pipeline Input Step Item/Read → Item/Build](https://nvd.nist.gov/vuln/detail/CVE-2017-1000108)
- [Pipeline Input Step source — `canSettle()` admin bypass](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java)
- [JENKINS-56016 — submitterParameter ignored for admins (Won't Fix)](https://issues.jenkins.io/browse/JENKINS-56016)

**Execution semantics + human phase (D1, D2, SA-1…SA-12, SA-26):**

- [Temporal — Workflow Execution Timeouts](https://docs.temporal.io/encyclopedia/detecting-workflow-failures)
- [Temporal — Child Workflows (TypeScript)](https://docs.temporal.io/develop/typescript/child-workflows)
- [Argo — Suspending Workflows walkthrough](https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/)
- [Argo — Intermediate Parameters](https://argo-workflows.readthedocs.io/en/latest/intermediate-inputs/) — human-phase form-input pattern (SA-10)
- [Airflow — Pools](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html) — resource-pool precedent for SA-3 named pools
- [AWS Step Functions — Error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html) — `fail-fast` `ParallelJoinPolicy` precedent (SA-4)
- [Dagster — Managing concurrency](https://docs.dagster.io/guides/operate/managing-concurrency) — multi-tier resource-pool precedent (SA-3)
- [Camunda 8 — User tasks](https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/) — assignments, scheduling, dueDate, followUpDate
- [GitHub Actions — Reviewing deployments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments) — approval-gate UX precedent for `human-approval` gate (SA-12)
- [LangGraph — Multi-agent handoff](https://langchain-ai.github.io/langgraph/concepts/multi_agent/)
- [AutoGen — Teams and HandoffMessage](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)
- [OpenAI Assistants API — Migration / Threads removal 2026-08-26](https://platform.openai.com/docs/assistants/migration)
- [Model Context Protocol — Elicitations](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) — `mcp_elicitation` Cedar-category overlap with `human_phase_contribution` (SA-12)
- [W3C WCAG 2.2 §3.3.7 — Redundant Entry](https://www.w3.org/TR/WCAG22/#redundant-entry) — human-phase form-state UX requirement (SA-26 / SA-28 deferral rationale)

**Event taxonomy + replay determinism (SA-18…SA-23, SA-21):**

- [CloudEvents Specification v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)
- [Temporal — Events and Event History](https://docs.temporal.io/workflow-execution/event)
- [Temporal Events Reference](https://docs.temporal.io/references/events)
- [Temporal Encyclopedia — Event History](https://docs.temporal.io/encyclopedia/event-history)
- [Bitovi — Replay Testing in Temporal](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows)
- [OpenTelemetry Semantic Conventions for Events](https://opentelemetry.io/docs/specs/semconv/general/events/)
- [OpenTelemetry GenAI Observability Blog, 2025](https://opentelemetry.io/blog/2025/ai-agent-observability/)
- [n8n Workflow Executions Docs](https://docs.n8n.io/workflows/executions/)

**Persistence + hash-chain (SA-25, SA-26, SA-27, SA-28):**

- [SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [Crosby & Wallach — Efficient Data Structures for Tamper-Evident Logging (USENIX 2009)](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf)
- [AuditableLLM — MDPI Electronics 2025](https://www.mdpi.com/2079-9292/15/1/56)
- [Google Trillian — Transparent Logging](https://google.github.io/trillian/docs/TransparentLogging.html)
- [Temporal blog — Custom persistence layer](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer) — 2024
- [Argo Workflows — Offloading Large Workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/)

---

_Spec-017 amended 2026-04-22 to reverse the V1-subset claim (was `single-agent` + `automated` only) and absorb 27 amendments from BL-097 Wave 1 + Wave 2 research: SA-1…SA-23, SA-25, SA-26, SA-27, SA-28. SA-24 (9-table schema rows), SA-29 (5 test categories + V1 ambition levels + coverage targets), SA-30 (CVE-reproducer corpora), SA-31 (replay-testing harness using Temporal `runReplayHistory` pattern) land in Plan-017 per implementation-detail separation._
