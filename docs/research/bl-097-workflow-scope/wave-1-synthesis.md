# BL-097 Wave 1 Synthesis — Scope Memo for Wave 2 + ADR-015 Amendment

**Date:** 2026-04-22
**Task:** Wave 1 synthesis of Passes A/B/C/D/E. Purpose: pin V1 contract commitments, surface genuine product decisions for user, scope Wave 2 concretely.
**Scope note:** This memo is a *scoping* memo. The single-source-of-truth design-decisions doc is produced at Wave 2 synthesis (task #25). Here: land load-bearing commitments, name the 2 open product decisions, concretize Pass F/G/H scope.

---

## 1. Source Passes (on-disk artifacts)

All five passes written 2026-04-22 by Opus 4.7 subagents with websearch + primary-source citations. All in `docs/research/bl-097-workflow-scope/`.

| Pass | Topic | File | Lines |
|---|---|---|---|
| A | Parallel execution semantics for phase DAG | `pass-a-parallel-execution.md` | 357 |
| B | Multi-agent phase ↔ Spec-016 channel contract | `pass-b-multi-agent-channel-contract.md` | 357 |
| C | `human` phase UX + contract (vs `human-approval` gate) | `pass-c-human-phase-ux.md` | 395 |
| D | Post-V1 freeze-regret patterns (7-system survey) | `pass-d-post-v1-freeze-regrets.md` | 560 |
| E | Security posture for full workflow engine at V1 | `pass-e-security-surface.md` | 434 |

---

## 2. Option 6 Concretized — What Shipping "Full Workflow Engine at V1" Actually Commits To

The user chose Option 6 in the abstract ("ship full workflow engine V1 instead of deferring"). Passes D and E specified what Option 6 concretely means as load-bearing V1 contract commitments. These are **not** open questions — they are architecturally heavy implications the user should see explicitly before Wave 2 proceeds. Each is backed by primary-source evidence in the referenced Pass file.

| # | Commitment | Why forced | Source |
|---|---|---|---|
| C-1 | **Workflow definitions in YAML + typed TypeScript SDK.** No bespoke DSL (no CUE, no HCL, no custom expression language). | F2 DSL Lock-In. Dagger (CUE, 2.5-yr rewrite) and GitHub Actions (HCL, mass rewrite 2019) both paid this cost. Convergent answer across 2020-2026 cohort. | Pass D §2.3, §2.5, §3 Pattern F2 |
| C-2 | **argv-list-only execution; no shell-string command form, ever.** No `shell=True`, no `/bin/sh -c "..."` with user-templated content. | Security I1 — closes GitHub Actions script injection, n8n `CVE-2025-68613` (CVSS 9.9), Airflow `CVE-2024-39877` in one architectural choice. | Pass E §4.1, §5.1 |
| C-3 | **Typed parameter substitution; no templating over author-controlled fields.** No Jinja2 / `${...}` / `{{}}`-eval. If any templating needed, it's a closed, non-Turing-complete lookup grammar with a whitelist. | Security I2 — closes template injection class. | Pass E §4.2 |
| C-4 | **Typed step-to-daemon control channel; no stdout-as-control-plane.** JSON-RPC over stdio (LSP-style framing), env-file writes/reads, or named API calls. Never `::set-output::`-style stdout pattern matching. | F5 / Security I1 — GitHub Actions `set-output` deprecation 2022, postponed indefinitely because ecosystem couldn't migrate. V1 chance only. | Pass D §2.5, Pass E §4.1 |
| C-5 | **JSON-only I/O for workflow state, step inputs/outputs, captures.** No pickle, no YAML-with-`!!python/object`, no eval-of-user-expression except in explicitly bounded scripting contexts. | F4 unsafe serialization. Airflow XCom pickle default = direct RCE path; disabled 2.0. | Pass D §2.1, §3 Pattern F4 |
| C-6 | **First-party adapters (Codex, Claude, MCP tool adapters, channel surfaces) ship as separately-versioned packages** (`@ai-sidekicks/adapter-*`). Core exposes an adapter contract via `packages/contracts/`. No `src/adapters/` folder inside core. | F1 monolithic integration bundling. Airflow `airflow.contrib` → 61 provider packages split in 2.0 was forced. | Pass D §2.1, §3 Pattern F1 |
| C-7 | **External tool references are content-addressed with hash pins** (e.g., `codex@v1.2.3#sha256=...`). Mutable tags not trusted for externally-referenced definitions. | Security I5 — `tj-actions/changed-files` `CVE-2025-30066` compromised 23,000 repos via retroactive tag repointing. | Pass E §4.5 |
| C-8 | **Workflow definition files carry an explicit schema version marker** (`ai-sidekicks-schema: 1.0` or equivalent). Daemon supports compat mode for reading older-marker files. | F13 versioning-API-at-V1. Temporal rewrote its versioning API at least once already (Version Sets → Build IDs). Cheap to add at V1; expensive to retrofit. | Pass D §2.2, §3 Pattern F13 |
| C-9 | **Workflow step outputs are immutable once written.** Accumulator patterns build on top (e.g., a `collect` step reads N upstream outputs, emits a new one). Retry creates a new output identity. | F9. GitHub Actions v3→v4 artifact API forced immutability after mutability caused scaling/consistency bugs. | Pass D §2.5, §3 Pattern F9 |
| C-10 | **State-access boundary from V1.** Workflow step code never touches the daemon's internal state directly. All access via a formal client API — even if V1's implementation is in-process. | F3 state-access boundary. Airflow 2.x → 3.x had to remove direct-DB access that users depended on for five years. | Pass D §2.1, §3 Pattern F3 |
| C-11 | **One execution model at V1.** Local daemon runs workflows locally. Do not ship a `local / queued / remote` enum in V1. | F8. Airflow executors, n8n `own` mode — every system that enumerated execution models at V1 had to break-remove entries later. | Pass D §3 Pattern F8 |
| C-12 | **Loud errors for any user-facing workflow semantics** — unknown integration name, missing input, typo in expression, unknown step reference. Silent no-ops forbidden by default. | F6 silent-error defaults. n8n 1.0 had to break silent-error-passing behavior users had built on. | Pass D §2.4, §3 Pattern F6 |
| C-13 | **Append-only hash-chained approval history.** Workflow-definition edits are a separate audit entry. Replays use at-execution-time policy, not current definition. | Security I7. Prevents approval-history tampering; Temporal's Event History is the reference pattern. | Pass E §4.7 |
| C-14 | **Approver permission is a typed capability, not a submitter string.** Admin override is a distinct audited capability. | Security I3. Jenkins `input` step: `Read` permission approves; admin bypass silent. Anti-pattern we explicitly don't copy. | Pass E §4.3 |
| C-15 | **Secrets by reference only** (`secret://<scope>/<name>`). Resolved at phase-launch into env / stdin / named-file fd — never argv. Logging redaction is defense-in-depth on top, not primary. | Security I4. `tj-actions/changed-files` dumped runner memory to logs via argv exposure. | Pass E §4.4 |
| C-16 | **`human` phase uploads follow OWASP File Upload minimums** — size cap, extension allowlist, magic-byte sniff, storage rename, path validate, AV hook, quarantine-on-fail. | Security I6, Argo `CVE-2025-66626` (symlink traversal broken-fix). | Pass E §4.6 |

---

## 3. V1 Contract Commitments by Domain

Pinned by Wave 1; Wave 2 (Passes F/G/H) builds on these; Spec-017 rewrite carries them into the spec body.

### 3.1 Execution semantics (Pass A)

- **Scheduling:** DFS three-color cycle check at `WorkflowDefinitionCreate` (reject invalid definitions); Kahn-style ready-set in executor tick loop. No algorithm naming in user-facing docs.
- **Loop safety:** Graph stays acyclic at definition time. `go-back-to` is a state-reset operation, **not** a cyclic edge. Iteration bounded by three counters:
  - Per-phase `max_retries` (already in Spec-017, default 3)
  - New workflow-run-level `max_phase_transitions` (**landed: default 100**; tripwire fires if `RUN_ITERATION_LIMIT` exceeds 2% of runs)
  - New workflow-run wall-clock `max_duration` (**landed: default 24h**)
- **Backpressure:** Named per-resource-pool model. V1 pools:
  - `pty_slots`: capacity = `min(8, cpu_count * 2)` — tunable per daemon config
  - `agent_memory_mb`: capacity = `daemon_budget - overhead` ≈ 192 MB
  - **Pessimistic memory budgeting landed: default 100 MB per `single-agent` phase reservation.** Tripwire: >15% phase-launch attempts blocked on `agent_memory_mb` in 2-week rolling window → V1.1 calibration pass.
  - Pull-based admission in executor tick (§4.1 of Pass A).
  - Daemon-global `max_concurrent_phases` default 4 as final backstop.
- **Parallel failure:** `ParallelJoinPolicy` enum **landed**: `fail-fast | all-settled | any-success`. Default `fail-fast`. Per-join override allowed in workflow definition.
- **Ready-set priority: landed:** config-time `priority` on phase definition; FIFO as tiebreaker. (Airflow-style priority weight deferred to V1.1 if tripwire warrants.)
- **Cancellation synchrony (to verify in Wave 2):** sibling cancellation MUST be recorded at a synchronous tick checkpoint, not in async callbacks. Pass B names this as a Wave-2-scope verification against `OrchestrationRunCreate`'s cancel path.

### 3.2 Multi-agent contract (Pass B)

- **Ownership: landed:** `ownership: OWN` is V1 default and only value; `BIND` reserved for V1.1. Phase-owned channel shares phase execution scope (no independent scheduler/pool/attributes — Airflow SubDAG lesson).
- **Gate scoping: landed — temporally-disjoint:** Channel-level gates (Spec-016 moderation) fire per-turn via Plan-012 approval backend with `scope: channel`. `WorkflowGateResolve` fires at phase boundary via Plan-012 with `scope: workflow-phase`. Pending channel gates block phase transition to `completed`.
- **Phase-owned channel defaults deltas (4 axes):**
  - Turn policy: `round-robin` (bare-channel default `free-form`)
  - Budget `turns_per_agent`: formula-bounded, indicative max 20 (bare-channel 50)
  - Membership: phase-targeted agents only (bare-channel: session membership)
  - Moderation: inherits phase gate — `off` for `auto-continue`/`done`/`human-approval`, `post-turn informational` for `quality-checks`
  - All other bare-channel defaults (token budget, cost limit, idle timeout, scheduler limits, partition behavior) unchanged.
- **Termination: landed:** V1 default `CLOSE_WITH_RECORDS_PRESERVED` (inverts Temporal's `TERMINATE`). Phase failure drives `REQUEST_CANCEL` with 30s grace period. Retry creates a new channel per iteration. `TERMINATE` selectable per-phase; `ABANDON` reserved for V1.1+BIND.

### 3.3 Human phase contract (Pass C)

- **Semantic separation — landed as three-way, not collapsed:**
  - `user_input` approval (agent mid-run pause, inside phase)
  - `human-approval` gate (binary decision between phases)
  - `human` phase (produces phase output artifact(s))
- **Cedar category: landed as new `human_phase_contribution`** (Spec-012 enum extension). Matches existing `gate` vs `user_input` granularity convention.
- **Input surface:** primitive-type JSON schema (`text`/`long_text`/`number`/`integer`/`boolean`/`enum`) + `artifact` field referencing Plan-014 pre-uploaded `ArtifactId`. No in-form file upload.
- **Persistence:** reuse BL-097 guardrail (1) SQLite suspend/resume. Zero new primitives.
- **Resumability:** deep-link URL `/session/:sid/workflow/:rid/phase/:pid`; client-side autosave via IndexedDB keyed on `(phaseRunId, participantId)`. **Landed: localStorage/IndexedDB local-only for V1; daemon-side draft persistence V1.x.**
- **Assignment:** implicit claim on first open; optimistic-concurrency reject on submit; `assignees?: ParticipantRef[]` phase-definition field.
- **Timeout:** see §5 Open Decisions #1.

### 3.4 Security invariants (Pass E)

I1 through I7 are testable contract requirements; engine implementations violating any are non-conformant. See Pass E §4 for exact statements and tests. Carries into Spec-017 §Pitfalls-To-Avoid + ADR-015 §Security language.

---

## 4. Cross-Cutting Themes

Five emergent patterns where multiple Pass recommendations reinforce each other. Each is a load-bearing design insight the Spec-017 rewrite must preserve.

1. **Parameter-substitution model is the foundational V1 decision.** Pass D (F2 DSL lock-in, F5 stdout control) and Pass E (I1 argv-only, I2 typed substitution) converge on the same architectural point: the substitution / evaluation model must be typed and non-eval from V1. This is the single control that cannot be retrofitted (Pass E §5.1). Getting C-1, C-2, C-3, C-4 right is 80% of the V1 security+evolution posture.

2. **State-access boundary must be defined even when V1 is in-process.** Pass D (F3 Airflow 2→3), Pass A (deterministic tick checkpoint), Pass B (phase-owned channel shares phase scope, no independent executor), and Pass E (I4 secrets-by-reference) all point to: the contract is client-server even if V1's implementation is monolithic. Allows V1.1+ to move components across process/host boundaries without contract break.

3. **Capability-based permission model unifies three concerns.** Pass E (I3 typed approver capability), Pass B (workflow-gate scope vs channel-gate scope through same Plan-012 backend), and Pass C (Cedar principal = verified PASETO sub + new `human_phase_contribution` category) all rely on one shared mental model: every gate resolution is a capability exercise bound to an identity, recorded with scope, audited. This is Plan-012's existing architecture — workflow engine plugs into it, does not duplicate.

4. **Immutable outputs + append-only audits + content-addressing form one consistency posture.** Pass D (F9 output mutability), Pass E (I5 content-addressed external refs, I7 append-only approval log), Pass A (deterministic tick checkpoints) all require one consistency mental model: anything the engine wrote stays written; anything it references externally is hash-pinned; anything it decided was decided at a specific moment and that moment's policy is authoritative.

5. **Terminology freeze is cheap now, disproportionately expensive later.** Pass D (F7 Airflow Datasets→Assets, SubDAG→TaskGroup, execution_date→logical_date) dominates the spec/doc rewrite scope. The Spec-017 rewrite must pick terminology once from the 2024-2026 convergent vocabulary: **"workflow"** (not pipeline/flow), **"phase"** (already chosen), **"artifact"** (not output/capture when persisted), **"step"** reserved for intra-phase operations if any. Do not invent terms.

---

## 5. Resolved Decisions

Both decisions resolved on 2026-04-22 after staff-engineer analysis framed against four criteria: architectural correctness, modern practices (2025-2026), bug/regression surface, vulnerability surface. Websearch-verified against Temporal, Argo, Camunda 8, LangGraph, OpenAI Assistants, AutoGen primary sources.

### 5.1 Decision 1 — Default timeout for `human` phase: **Option A (no default) + required typed opt-in**

**Resolution:** No default timeout. Author opts in explicitly. Session timeline reflects `waiting-human` until resolved.

**Rationale:** Three independent durable-execution engines converge — Temporal Workflow Execution Timeout default ∞, Argo Workflows `{}` = indefinite suspend, Camunda 8 `dueDate` optional/expression-based. This is modern durable-execution convention across independent implementations, not one-camp disagreement. Option B's 7-day soft cap + escalate is architecturally illusory at V1 because no notification-routing primitive exists — escalate fires `workflow.human_phase_escalated` to telemetry but no human is paged, creating the "telemetry-only guardrail that looks like protection" silent-failure class (directly violates C-12).

**SDK ergonomic safeguard (feeds SA-10 amendment):** TypeScript SDK types `timeout: "none" | Duration` as **required** on `HumanPhaseConfig`. Author must type either `"none"` or a duration explicitly. Removes "forgot to set it" footgun while preserving durable-execution semantics. Zero-cost ergonomic win.

**Trade-off accepted:** UX/ops cost — phases may linger indefinitely. Mitigation is observability, not enforcement: Wave 2 Pass F ensures `workflow.phase_suspended` with `reason: waiting-human` is a first-class surfaced event; session UI surfaces pending-human count prominently.

### 5.2 Decision 2 — Multi-phase channel reuse: **V1 OWN-only + binding V1.1 ADR commit with criterion gates**

**Resolution:** `multi-agent` phase at V1 supports `ownership: OWN` only. Phase B receives phase A's channel transcript as read-only context (`inheritContext: { from: "previous_phase" }` SDK ergonomic). BIND committed to V1.1 via ADR-015 under named criteria (see §5.3).

**Rationale:** All five engineering-correctness criteria favor OWN-only:
- **Architectural correctness:** Temporal Child Workflows + Signals (explicit contract, no shared state), LangGraph `Command(goto, state)` (state-passing, not handle-binding), AutoGen/AG2 `HandoffMessage` (message passing within one conversation). Modern composition convergence is state-passing, not handle-binding.
- **Modern practices (2025-2026):** OpenAI Assistants API deprecation (Threads removal 2026-08-26) is the fresh drift signal — the industry is actively removing exactly BIND's primitive in favor of explicit conversation references. LangGraph 2026 handoff pattern is state-as-data. Airflow SubDAG (closest BIND analogue) was deprecated in 2.x.
- **Bug surface:** OWN has 3 state-machine invariants; BIND adds 5 more (retry↔BIND, abandon↔BIND, gate-scoping lattice, membership snapshot timing, termination authority). Airflow SubDAG's lifecycle bugs took 3+ years to patch before deprecation.
- **Regression risk:** OWN-only → V1.1 BIND is additive (no breaking change). OWN+BIND at V1 → V1.1 revision is breaking.
- **Vulnerability surface:** BIND imports confused-deputy risk (phase B acts on phase A's state with phase B's privileges, where phase B's moderation didn't approve phase A's grants).

The "V1.1 drift pattern" scope concern is addressed via criterion-gated ADR commitment (§5.3) rather than by absorbing engineering risk into V1.

**Trade-off accepted:** Authors wanting live multi-phase channel continuation use transcript-as-context. SDK `inheritContext: { from: "previous_phase" }` ergonomic must feel effortless — this is where V1 spends engineering labor.

### 5.3 ADR-015 V1.1 Commitments (draft language for task #26)

When task #26 amends ADR-015, add a new `V1.1 Commitments` section capturing criterion-gated deferrals. Commitments take this form:

**BIND multi-phase channel reuse (committed V1.1):**

> Add `ownership: 'BIND'` to `multi-agent` phase contract in V1.1, contingent on all three criteria:
> (a) ≥3 production workflows reporting OWN+transcript-inheritance insufficient, AND
> (b) concrete failure case documented where transcript pattern degrades UX measurably (e.g., agent context loss detectable in outcomes), AND
> (c) BIND lifecycle contract addressing the 5 ambiguities documented in `docs/research/bl-097-workflow-scope/pass-b-multi-agent-channel-contract.md` §3.1: phase-A-retry semantics, phase-A-abandonment handling, gate-scoping-lattice resolution, membership-snapshot timing, termination-authority resolution.
>
> If (a)-(c) are satisfied, BIND ships as an additive amendment to the `multi-agent` phase type. If any of (a)-(c) is not satisfied within V1.1's scoping window, BIND remains deferred under the same criteria.

**Notification-routing-dependent `human` phase default-timeout (committed V1.x):**

> Reconsider default timeout for `human` phase once notification routing primitive exists (enabling escalate to fire to an actual human rather than a telemetry-only event). Criterion: notification routing ships as a distinct V1.x feature. At that point, revisit whether a default `timeout: "7d"` with `timeoutBehavior: "escalate"` should be the `HumanPhaseConfig` default. Until then, required typed opt-in per §5.1 stands.

---

## 6. Spec-017 Amendments Required

Consolidated list of new schema elements / contract language the Spec-017 rewrite must carry. Each references the landing Pass.

| # | Amendment | Source |
|---|---|---|
| SA-1 | Add `max_phase_transitions: int` (default 100) to workflow-run schema | Pass A §3.2 |
| SA-2 | Add `max_duration: Duration` (default 24h) to workflow-run schema | Pass A §3.2 |
| SA-3 | Add `ResourcePool` + `PhaseResourceNeed` model; declare V1 pools `pty_slots` and `agent_memory_mb` | Pass A §3.3 |
| SA-4 | Add `ParallelJoinPolicy = 'fail-fast' \| 'all-settled' \| 'any-success'` on parallel blocks; default `fail-fast` | Pass A §3.4 |
| SA-5 | Add `priority?: number` on phase definition; FIFO tiebreaker | Pass A §6 Q5 |
| SA-6 | Add `ownership: 'OWN'` on `multi-agent` phase (V1 only value; `BIND` committed V1.1 per §5.3 with criterion gates) | Pass B §3.1, §5.2 |
| SA-7 | Temporally-disjoint gate-scoping contract language (channel gates per-turn, workflow gates at boundary, pending-channel-gate-blocks-phase-transition rule) | Pass B §3.2 |
| SA-8 | Four phase-owned channel defaults deltas (turn policy, turn budget, membership, moderation) | Pass B §3.3 |
| SA-9 | `CLOSE_WITH_RECORDS_PRESERVED` default termination + `REQUEST_CANCEL` on failure with 30s grace | Pass B §3.4 |
| SA-10 | `HumanPhaseConfig` type with required `timeout: 'none' \| Duration` typing per D1 Option A + SDK safeguard (no default, no optional field); `prompt`, `inputSchema` primitives + artifact ref, `assignees`, `dueAt`, `timeoutBehavior` | Pass C §3.2, §5.1 |
| SA-11 | `timeoutBehavior = 'fail' \| 'continue' \| 'escalate'`; escalate fires `workflow.human_phase_escalated` event only (no notification routing in V1 by design; V1.x commitment per §5.3) | Pass C §5.3 |
| SA-12 | Add `human_phase_contribution` to Spec-012 approval category enum | Pass C §2.4 |
| SA-13 | Pitfalls-To-Avoid section expanded with Pass E §4 invariants I1–I7 as non-conformant-if-violated language | Pass E §5.2 |
| SA-14 | Schema version marker on workflow definition files | Pass D F13 / C-8 |
| SA-15 | Adapter-contract section: first-party adapters separately-versioned | Pass D F1 / C-6 |
| SA-16 | Output-immutability invariant | Pass D F9 / C-9 |
| SA-17 | Terminology normalization pass (workflow / phase / artifact — see §4.5) | Pass D F7 |

---

## 7. Wave 2 Scope — Concretized

Wave 1 resolved enough of the contract that Wave 2 Passes F/G/H now have concrete targets. Each pass scope below is binding; subagent prompts should cite this synthesis memo.

### 7.1 Pass F — Event taxonomy + observability

New Spec-006 event categories required:

- **Phase-lifecycle:** `workflow.phase_admitted` (new, distinct from `phase_started`), `workflow.phase_waiting_on_pool` (new, diagnostic), `workflow.phase_started`, `workflow.phase_progressed`, `workflow.phase_failed` (extended with `cancellation_reason: 'sibling_failure' | null`), `workflow.phase_retried`, `workflow.phase_suspended`, `workflow.phase_resumed`, `workflow.phase_completed`, `workflow.phase_cancelling`
- **Parallel-execution:** `workflow.parallel_join_cancellation` (new, sibling cancel driven by `ParallelJoinPolicy`)
- **Workflow-lifecycle:** `workflow.created`, `workflow.started`, `workflow.gated`, `workflow.failed`, `workflow.completed`, `workflow.resumed`
- **Gate-resolution:** `workflow.gate_resolved` (with scope + result); already partly in Spec-006
- **Human-phase:** `workflow.human_phase_claimed` (informational), `workflow.human_phase_escalated` (new, from SA-11)
- **Channel-coordination (Pass B overlap):** `workflow.channel_created_for_phase`, `workflow.channel_closed_with_records_preserved`, `workflow.channel_terminated_forcibly`

Alignment with Spec-006: must not collide with existing `presence.*`, `run.*`, `approval.*` categories. OpenTelemetry workflow semantic conventions (if any) should be surveyed.

### 7.2 Pass G — Persistence model

SQLite schema recommendations required for:

- `workflow_definitions` (with schema version marker per SA-14; immutable + content-hash)
- `workflow_versions` (version history for definition edits; references parent-version hash)
- `workflow_runs` (with `max_phase_transitions` counter, `max_duration` deadline, pool-state reference)
- `workflow_phase_states` (per-phase state machine rows; supports parallel partial-completion)
- `phase_outputs` (immutable once written per C-9)
- `workflow_gate_resolutions` (append-only hash-chain per C-13 / I7)
- `parallel_join_state` (tracks sibling phases under a join; cancellation bookkeeping)
- `workflow_channels` (links `phase_run_id` ↔ `channel_id` per Pass B ownership)
- `human_phase_form_state` (draft autosave if daemon-side option is chosen V1.x; optional V1)

Must interact with Plan-015 recovery foundation and Plan-014 artifact signing. Evaluate normalized per-phase rows vs. JSON blob per workflow-run (Pass G open trade-off).

### 7.3 Pass H — Testing / verification strategy

Test categories required:

- **Property-based (fast-check / test.each):** DAG invariants — acyclicity, reachability, topological determinism under concurrent submit; `max_phase_transitions` bounds holding under adversarial workflow definitions; ready-set determinism tick-over-tick
- **Fuzz:** workflow-definition parser — injection via every author-controlled field (every CVE in Pass E §2.2 is a fuzz target); expression grammar (I2 testable assertion — every attempt to break out returns parse error, never an eval)
- **Load:** parallel executor under contention (fail-fast vs all-settled sibling handling under 10+ parallel phases); resource-pool admission under steady-state memory pressure; `max_concurrent_phases` backstop under burst
- **Long-running integration:** multi-day human resumption (daemon restart mid-human-phase, re-entry, submit); checkpoint/replay correctness across daemon restart; multi-agent channel lifecycle coordination (OWN close, REQUEST_CANCEL grace, retry new-channel isolation)
- **Security regression battery:** canary-secret tests (argv absent, logs absent, artifacts absent); upload tests (zip bomb, polyglot, symlink); approval-history tamper-detection tests; expression-sandbox fuzz

---

## 8. References

- All 5 Pass files in this directory (see §1 table for links)
- `docs/specs/017-workflow-authoring-and-execution.md` — existing spec to be rewritten
- `docs/specs/012-approvals-permissions-and-trust-boundaries.md` — approval category enum (SA-12 amendment)
- `docs/specs/006-session-event-taxonomy-and-audit-log.md` — event taxonomy to extend (Pass F)
- `docs/specs/015-persistence-recovery-and-replay.md` — Plan-015 recovery foundation (Pass G dep)
- `docs/specs/014-artifacts-files-and-attachments.md` — Plan-014 artifact signing (Pass G + C-16 dep)
- `docs/specs/016-multi-agent-channels-and-orchestration.md` — Spec-016 channels (Pass B integration)
- `docs/decisions/015-v1-feature-scope-definition.md` — ADR to amend (workflow V1.1→V1; feature count 16→17)
- `docs/backlog.md:700-734` — BL-097 current state

*End of synthesis.*
