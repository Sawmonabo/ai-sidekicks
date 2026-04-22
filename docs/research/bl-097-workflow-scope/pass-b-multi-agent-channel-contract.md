# BL-097 Pass B: Contract between Spec-017 `multi-agent` phase type and Spec-016 channels

**Date:** 2026-04-22
**Pass:** Pass B (of the BL-097 research passes)
**Question:** If V1 scope expands Spec-017 to include the `multi-agent` phase type, what contract must bind that phase type to Spec-016 multi-agent channels? Specifically — ownership model, gate composition, phase-vs-channel defaults, and termination semantics.
**Scope:** Decision-grade brief for Wave 1 synthesis. Bare-channel defaults (Spec-016 §Turn Policies / §Budget Policies / §Moderation Hooks, §Scheduler Limits) and the workflow V1 subset (Spec-017 §Phase-Type and Gate-Type Taxonomy) are treated as the fixed prior art; this brief recommends the *delta* that a workflow-phase-owned channel should apply on top of them.

---

## 1. Problem Framing

### 1.1 What's already true

Two V1-approved specs already define orthogonal primitives:

- **Spec-016** defines **channels** — session-scoped communication surfaces that can host multiple agents under a `turn-policy` (`free-form` default, plus `round-robin` and `request-based`), a `budget-policy` (100k token per run, $10 per session, 50 turns per agent), a `participation-policy` implicit in moderation hooks (`gate` pre-turn, informational post-turn), and partition semantics (arbitration pause under `round-robin` + unreachable node). Bare-channel defaults are already pinned (Spec-016:90–144). Channels exist independently of workflows.
- **Spec-017** defines a **workflow** — a versioned sequence of phases, each typed (`single-agent`, `automated` for V1; `multi-agent`, `human` deferred to V1.1 per line 40), gated (`auto-continue`, `quality-checks`, `human-approval`, `done`), producing structured JSON phase outputs backed by artifacts. Phase runs route through `OrchestrationRunCreate`; gate resolution goes through `WorkflowGateResolve`.

BL-097 is the decision of whether to promote `multi-agent` (and/or `human` and parallel execution) into V1. This brief does not decide that question; it defines the contract that would have to exist *if* `multi-agent` ships in V1. That contract is a Wave 1 input regardless of whether the expansion decision is α / β / γ-i / γ-ii / γ-iii — if the answer is "ship `multi-agent` at V1," a Pass-B-shaped contract must accompany Spec-017:40.

### 1.2 The open questions

Four named questions the parent task set:

1. **Ownership** — Does a `multi-agent` phase OWN the channel lifecycle (phase creates + destroys channel), or BIND to an externally-created channel (phase references an existing one)?
2. **Gate composition** — How does `WorkflowGateResolve` (phase-boundary gate, Spec-017) interact with Spec-016's channel-level moderation hooks (pre-turn `category: gate`, post-turn informational)? Do they compose, does one override, or are they temporally disjoint?
3. **Defaults delta** — What should a `multi-agent` phase's turn-policy / budget-policy / participation-policy defaults be *relative to* bare-channel defaults? Why?
4. **Termination** — How does phase completion signal to the channel? Does the channel survive phase end for audit/replay? How does phase failure propagate?

### 1.3 What makes this hard

The core tension: Spec-016 channels are designed to be *durable multi-agent surfaces* that outlive any single run or phase. Spec-017 phases are designed to be *bounded unit-of-progress executions* with strict outputs and clear gates. If the two are naively composed, we get either (a) channels whose independent lifecycles split audit trails from the phase that produced them, or (b) phases whose ownership of a channel defeats the channel's "persistent collaboration surface" reason for existing.

Temporal's child-workflow contract (`ChildWorkflowOptions` + `ParentClosePolicy`), Airflow's SubDAG deprecation and replacement path (SubDAGs → TaskGroups in-DAG + `TriggerDagRunOperator`/`ExternalTaskSensor` cross-DAG), n8n's Execute Sub-Workflow node, Kestra's `Subflow` task, Activepieces' SubFlows piece, Argo's nested DAG templates + workflow-of-workflows pattern, and AWS Step Functions' nested Express-in-Standard model all answer variations of these questions. They agree on some things and diverge sharply on others; the divergences are where the interpretive work is.

---

## 2. Industry Landscape — How Other Engines Bind Phases To Coordination Surfaces

### 2.1 Temporal — Child Workflows

Temporal's child workflow is the closest industry analog to a "phase owns a coordination surface" model. Key features relevant here:

- **Ownership is typed via `ParentClosePolicy`** with three values:
  - `TERMINATE` (default) — child is force-terminated when parent closes.
  - `REQUEST_CANCEL` — child receives a cancellation request and can wind down cleanly.
  - `ABANDON` — child continues independently after parent closes.
  Source: `docs.temporal.io/parent-close-policy` (fetched 2026-04-22).
- **`ParentClosePolicy` is per-child.** A single parent can spawn some children as `TERMINATE` and others as `ABANDON`. Source: Temporal docs, Parent Close Policy.
- **Default waiting behavior.** `executeChild()` awaits completion automatically; `startChild()` returns a handle for signal/query/cancel/terminate/await. Source: `docs.temporal.io/develop/typescript/child-workflows`.
- **Signals compose across the parent-child boundary.** Handles support `signal`, `query`, `cancel`, `terminate`, `getResult`. Source: Temporal TS SDK docs.
- **Child Workflow vs Activity dichotomy.** Child workflows have separate Event Histories (partition-friendly), can survive parent cancel via `ABANDON`, and are recommended for "separate service creation" / "workload partitioning" / "resource management" / "periodic logic." Activities cannot survive parent cancellation. "When in doubt, use an Activity" (`docs.temporal.io/child-workflows`).
- **Per-namespace scope.** Child workflows must be in the same namespace as the parent — they are not arbitrary cross-cutting references.
- **Event-history overhead.** A single parent should not spawn >1,000 children per Event History size guidance.

**What Temporal teaches us about `multi-agent` phase → channel:** ownership is a first-class per-invocation decision, not a framework-wide constant. The contract must expose `ParentClosePolicy`-equivalent vocabulary, even if we only use one option at V1.

### 2.2 Airflow — SubDAGs (deprecated 2.0, removed 3.0) → TaskGroups + cross-DAG operators

This is the richest counter-evidence for OWN-without-scope-discipline. The Airflow 2.0 deprecation was driven by named execution-time pathologies:

- **Parallelism violation.** `SubDagOperator` starts a `BackfillJob`, which "ignores existing parallelism configurations potentially oversubscribing the worker environment" (`airflow.apache.org/docs/apache-airflow/2.6.0/core-concepts/dags.html`).
- **Pool deadlock.** `SubDagOperator` holds its worker slot for the entire duration of its children's execution, waiting on a `BackfillJob` that needs *other* worker slots to run the children. Under concurrent SubDAGs on a pool with bounded workers, parents starve children → children can never complete → parents never release slots → deadlock. Canonical explanation: "the SubDagOperator leaves its children in line, and insists on occupying the cashier until every child's order has been processed by another cashier" (`medium.com/@team_24989/fixing-subdagoperator-deadlock-in-airflow`, fetched 2026-04-22). Live-traced in `apache/airflow#1350` ("Subdag operators consuming all celeryd worker processes").
- **Inconsistent attributes.** SubDAGs maintained their own DAG attributes (default_args, schedule_interval, etc.); when these diverged from the parent DAG's attributes, behavior was surprising.
- **Visibility limitations.** A SubDAG is a separate DAG in the Airflow UI — users could not see "the full DAG" in a single view.

**The replacement is a clean split, not a cleaner OWN:**

- **Intra-DAG grouping → `TaskGroup`.** `TaskGroups` are "purely a UI grouping concept. Tasks in TaskGroups live on the same original DAG, and honor all the DAG settings and pool configurations." (`airflow.apache.org/docs/apache-airflow/2.6.0/core-concepts/dags.html`). There is no separate execution context — only a UI box and a namespacing prefix.
- **Cross-DAG coupling → `TriggerDagRunOperator` + `ExternalTaskSensor`.** Loose coupling where one DAG triggers or waits on another, with no shared execution context.
- **SubDAGs removed entirely in Airflow 3.0.** "The long deprecated SubDag feature was removed … use Airflow task groups instead to visually and logically group tasks within a larger Airflow DAG" (release notes, `airflow.apache.org/docs/apache-airflow/3.0.3/release_notes.html`; summary via `astronomer.io/blog/upgrading-airflow-2-to-airflow-3-a-checklist-for-2026`).

**What Airflow teaches us:** the failure wasn't OWN per se — it was *OWN with an independent executor*. SubDAGs owned a separate scheduler scope that fought the parent's scheduler for the same worker pool. The corrective lesson is: if a phase owns a channel, the channel must share the phase's execution scope (no independent scheduler, no independent pool, no independent attributes). That exactly maps to our situation: a `multi-agent` phase-owned channel should share the phase's admission controller and scheduler limits, not introduce a second one.

### 2.3 n8n — Execute Sub-Workflow

n8n's sub-workflow is a pure BIND pattern:

- **Reference modes.** The Execute Sub-Workflow node accepts the target sub-workflow by **ID**, by **URL**, by **local file**, or by **JSON blob** as a node parameter (`docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/`, summarized via WebSearch 2026-04-22).
- **Data contract.** Two modes: `Define using fields` (explicit schema — parent sees exactly what the sub-workflow expects) vs `Accept all data` (permissive; sub-workflow handles missing values).
- **Lifecycle.** Sub-workflow must have a `Callable Flow` trigger and must be published. Parent synchronously waits (default). Last node of sub-workflow returns data to the Execute Sub-Workflow node in parent (`docs.n8n.io/flow-logic/subworkflows/`).
- **Key property:** the sub-workflow is a first-class persistent flow that exists independently of any parent invocation. Multiple parents can call it. The parent-child relationship is a runtime relationship, not a lifecycle relationship.

**What n8n teaches us:** BIND is a valid pattern when the referenced entity has its own durable identity and independent reuse value. That doesn't match Spec-016 channel semantics in the phase-owned case — a channel created specifically for a phase's deliberation does not have independent reuse value; the channel and the phase are co-created.

### 2.4 Kestra — Subflow

Kestra is BIND-only, even more strictly than n8n:

- Subflows are **referenced by `flowId` and `namespace` only** — there is no inline definition (`kestra.io/docs/workflow-components/subflows`).
- Default `wait: true` — parent synchronously waits. `wait: false` enables fire-and-forget.
- Outputs exposed via `{{ outputs.subflow.outputs.final }}` templating — explicit structured contract.
- Failure propagation: `transmitFailed` controls whether child failure becomes parent failure (requires `wait: true`).

**What Kestra teaches us:** Kestra's BIND purity is what you get when the child is a reusable pipeline. It's the wrong shape for an ephemeral-phase-scoped channel.

### 2.5 Activepieces — SubFlows piece

Activepieces is BIND with sync/async toggle:

- Called flow must have `Callable Flow` trigger and must be published.
- "Same sub-flow can be invoked by multiple parent flows, ensuring consistency across processes" (`resources.activepieces.com/glossary/nested-flows`).
- Optional wait behavior — parent can wait or proceed immediately.
- Data passes via explicit parent-to-child parameters; JSON paths `{{step_slug.path.to.property}}` access child outputs.

**Pattern:** BIND with an optional sync/async flag. Same lesson as Kestra/n8n — this is designed for reusable subflows, not ephemeral coordination surfaces.

### 2.6 Argo Workflows — Nested DAG templates + Workflow-of-Workflows

Argo has **both** patterns cleanly separated, which is instructive:

- **Nested DAG templates (OWN pattern).** Inside a single Workflow CR, templates can be DAG or Steps templates that call other DAG or Steps templates. All live in the same Workflow object, share the same `spec`, same parameters, same execution scope. The canonical pattern for bounded decomposition of a single workflow (`argo-workflows.readthedocs.io/en/latest/walk-through/dag/`, `argo-workflows.readthedocs.io/en/latest/workflow-templates/`).
- **Workflow-of-Workflows (BIND pattern).** A Workflow uses a `resource` template to create a separate Workflow object that references a `WorkflowTemplate` CR by name. Two independent Workflow CRs, two independent execution scopes, two independent Event Histories. The pattern is criticized in `argoproj/argo-workflows#12425` as verbose ("requires embedded workflow definitions within resource templates," "reduced maintainability") and a proposed simplification (`workflowTemplateRef` as a first-class step field) is under consideration.
- **Suspend templates** as approval gates — a named template type that pauses the workflow until resumed via UI/CLI/API. "Use a Suspend template to pause the Workflow at any point in a Steps or DAG context" (`argo-workflows.readthedocs.io/en/latest/walk-through/suspending/`).

**What Argo teaches us:** having both OWN and BIND patterns exist in one engine is viable, but the UX complaint against the BIND pattern's verbosity (#12425) is evidence that the BIND pattern accrues complexity costs that aren't obvious upfront. Further: Argo's `suspend` is a first-class *template* (not a channel-level concept) — gates are workflow-level, not coordination-surface-level. This aligns with Spec-017's `WorkflowGateResolve` framing.

### 2.7 AWS Step Functions — Nested Express-in-Standard

A different framing entirely:

- Standard workflow calls Express workflow as a child state machine. "Express Workflow is a distinct child workflow with its own Success or Fail task state from within the parent workflow, and the child workflow must complete within the parent's duration limit and uses the parent retry policy" (`docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html`).
- Parent IAM role needs `states:StopExecution` permission — parent can force-terminate child.
- Express children cap at 5 minutes, no `.waitForTaskToken` or `.sync` integration pattern.
- Parent failure / termination cascades to child via retry/error policies.

**What Step Functions teaches us:** tight scope (Express = bounded-duration, no long gates, parent-retry-driven) is how AWS bought themselves the right to default-terminate child on parent close. The tightness of scope is what made default-TERMINATE palatable.

### 2.8 Cross-engine summary table

| Engine | Pattern | Default on parent close | Default wait | Gate mechanism |
|---|---|---|---|---|
| Temporal | Child Workflow (OWN) | `TERMINATE` | Blocks until child Started event | Signal/query on handle; no built-in gate |
| Airflow (modern) | `TaskGroup` (UI group) + `TriggerDagRunOperator` (BIND) | N/A (TaskGroup) / loose (BIND) | Sync sensor (`ExternalTaskSensor`) | Sensors or branch operators |
| n8n | Execute Sub-Workflow (BIND) | Sub-workflow continues if async | Sync (default) | Manual/approval trigger nodes |
| Kestra | Subflow task (BIND) | Per `transmitFailed` | `wait: true` (default) | Pause/resume task |
| Activepieces | SubFlows piece (BIND) | Configurable wait/no-wait | Configurable | Human input / approval pieces |
| Argo | Nested DAG (OWN) + WoW (BIND) | OWN: cascades; BIND: independent | OWN: sync; BIND: sync if parent awaits | `suspend` template |
| Step Functions | Express-in-Standard (OWN, bounded) | Cascades via retry policy | Sync | Task tokens + manual approval |

**Convergence observations:**

1. Every surveyed engine exposes *some* way to control parent-close behavior explicitly, even if the default differs.
2. Synchronous wait is the default everywhere (Temporal `executeChild`, n8n, Kestra, Activepieces, Argo nested, Step Functions Express).
3. Gates are typically *workflow-level* concerns (Argo `suspend`, Step Functions task tokens, Kestra pause, Activepieces approval pieces), not *coordination-surface-level* concerns. This is the relevant datum for Q2.
4. BIND patterns exist to support reuse across parent invocations (n8n, Kestra, Activepieces, Argo WoW); OWN patterns exist to support bounded decomposition within one invocation (Temporal, Argo nested, Step Functions).
5. Airflow's SubDAG experience is the cautionary tale: OWN-with-separate-executor causes deadlocks. OWN must share executor scope with the parent.

---

## 3. Answers to the Four Open Questions

### 3.1 Q1 — OWN or BIND?

**Recommendation: OWN with shared scope, with a V1.1 door open for BIND.**

The `multi-agent` phase creates its channel at phase start and closes it at phase end (see Q4 for closing semantics). The channel's execution scope is the phase's execution scope — the phase's budget accounting flows through to the channel, the phase's scheduler admission counts against the same per-session limits, and the phase's intervention dispatch governs the channel's agents.

**Why OWN wins for V1:**

1. **Spec-016 delegation-depth cap already biases this way.** Spec-016 §Default Behavior caps V1 at one parent-child delegation layer. If the phase BINDs to an externally-created channel, the channel and the phase become peers with separate lifecycles, which splits audit and creates ambiguity about whether the channel counts against the delegation-depth budget. OWN keeps the phase as the accountable parent in Spec-016's existing parent-child vocabulary.
2. **Spec-017:44 requires workflow timeline visibility.** "Workflow execution must remain visible in the session timeline and must preserve per-phase provenance." A channel that outlives the phase that produced it either (a) continues to emit events attributed to a phase that has closed (violates provenance) or (b) drops the phase attribution post-close (violates audit). OWN keeps phase-attribution binding durably.
3. **Airflow's SubDAG lesson is not "OWN is bad" — it's "OWN with an independent executor is bad."** The phase-owned channel in our design does *not* introduce a separate scheduler, separate pool, or separate attribute set. It shares the phase's execution scope. The failure mode Airflow experienced (pool deadlock via `BackfillJob`) cannot reproduce here because the channel has no executor of its own.
4. **BIND has weaker reuse justification in this shape.** n8n/Kestra/Activepieces BIND patterns exist because sub-workflows are independently useful and reusable across many parent invocations. A channel created specifically for one `multi-agent` phase's deliberation does not have independent reuse value — the channel and the phase are co-created.
5. **Argo's Workflow-of-Workflows UX complaint (#12425) is evidence that BIND accumulates friction.** "Verbose," "reduced maintainability." We'd be importing that friction without the reuse benefit.

**What we lose:** if a user wants to run two phases inside the same durable channel (e.g., "continue the design discussion across `analyze` → `plan` phases"), OWN forces two channels. The loss is acceptable at V1 and openly resolvable at V1.x via a BIND mode that references an externally-created Spec-016 channel. Spec-017 already contemplates "cross-phase discussion" as V2 (Spec-017:110) — that's the natural home for a BIND escape-hatch.

**Steel-man for BIND:** "Channels are the persistent multi-agent primitive per Spec-016 §Purpose. A workflow phase is an ephemeral execution scope. Tying channel lifecycle to phase lifecycle violates the design intent of Spec-016 — channels should be discoverable and reusable across workflow runs." Response: this is true for *bare channels* (channels created directly via `ChannelCreate`). A phase-owned channel is a *workflow artifact* in the same way that a phase's output artifacts are workflow artifacts — Spec-017:50 is explicit that "each phase defaults to one primary target channel and one primary producing run." That sentence already presumes a phase has *its* channel. The BIND escape-hatch is additive, not a correction.

**Contract vocabulary implications:** borrow from Temporal. The `multi-agent` phase definition should expose an `ownership` enum with at minimum `OWN` (V1 default and only option at V1) and a reserved `BIND` value (V1.1). This is forward-compatibility insurance in the same spirit as the BL-097 M-012 research guardrails (`predecessors: PhaseId[]` with validator enforcing length ≤ 1).

### 3.2 Q2 — WorkflowGateResolve vs channel-level gates

**Recommendation: temporally disjoint scoping, not composition. Channel-level pre-turn gates fire *inside* the phase and block individual turns. `WorkflowGateResolve` fires *at phase boundaries* and blocks the phase-to-phase transition. Both surfaces resolve through the same Plan-012 approval backend but record with different scopes.**

**The scoping rule:**

- **During phase execution** (phase is `running`): channel-level gates from Spec-016 §Moderation Hooks apply to each turn. An agent's proposed output is approved or rejected per-turn via the normal approval surface (category `gate`). Multiple turns can each fire a gate. These do *not* route through `WorkflowGateResolve`; they route through the existing Spec-016 approval hook.
- **At phase boundary** (phase transitions from `running` → `completed`/`failed`/`skipped`, and gate of the phase is `quality-checks` or `human-approval`): `WorkflowGateResolve` fires on the phase output as a whole. This is the Spec-017 gate pathway.

These are **temporally disjoint by construction**: a channel-level gate cannot fire after the phase has stopped admitting turns, and `WorkflowGateResolve` cannot fire before the phase stops admitting turns. They cannot fire simultaneously.

**Why scoping-not-composition wins:**

1. **Composition creates a matrix of compound states.** If channel gate is `pending` and workflow gate is `waiting-human` at the same moment, what is the workflow instance's state? "Resolve channel gate first, then evaluate workflow gate" is a sequencing rule — in that case, the semantics *are* disjoint. Making them formally disjoint in the spec removes the ambiguity.
2. **Argo's precedent.** Argo's `suspend` template is a first-class *template* (gate at workflow boundary), not a channel-level concept. Argo's channels-equivalent (steps in a parallel group) do not have their own suspend gates — gates are always workflow-structural. This matches our phase-boundary-only framing for `WorkflowGateResolve`.
3. **Plan-012 approval engine stays single-minded.** Cedar evaluates each approval request with the scope it was submitted under. Channel gates carry `scope: channel, channelId: ...`. Workflow gates carry `scope: workflow-phase, phaseId: ..., workflowVersionId: ...`. The backend is the same; the recorded scope differs. No composition logic in the engine.
4. **Audit clarity.** A timeline reader sees either "Channel X, turn 47 — approval denied (by Alice)" or "Workflow Y, phase `review` — quality-checks failed (retry scheduled)." The two event types don't collide.

**Failure mode if both fire** (can this happen?): only if a channel gate is *still pending* when the phase completes. Policy: **phase cannot transition from `running` to `completed` while any channel gate is unresolved.** A pending channel gate holds the phase open. If the phase's own turn-limit or budget-limit fires while a channel gate is pending, the phase transitions to `failed` with `reason: budget_exhausted_with_pending_gate`, the channel gate is force-denied with a linked reason, and failure propagates per Q4. This keeps the two mechanisms disjoint while ensuring no silent drops.

**Steel-man for composition:** "A phase-level gate might want to *subsume* channel-level gates — i.e., 'skip all per-turn approvals for this phase because the phase-level human reviewer will approve the whole output.'" Response: this is already the recommended default — see §3.3 moderation row. When phase gate is `human-approval`, channel moderation defaults to `off` precisely so the reviewer doesn't see double-approval. No runtime composition rule is needed; the defaults are already aligned, and authors who want per-turn review opt in explicitly. The two surfaces stay temporally disjoint.

### 3.3 Q3 — Defaults delta: phase-owned channel vs bare channel

**Note on vocabulary mapping:** the parent task names "turn-policy, budget-policy, and participation-policy" as the three axes. Spec-016 exposes `turn-policy` and `budget-policy` explicitly. Spec-016 has no formally-named `participation-policy` surface — the closest analog is the combination of (a) channel membership (Spec-016:54 "inheriting session membership unless later restricted by policy") and (b) moderation hooks (Spec-016:128–132 pre-turn gate / post-turn informational). This brief maps `participation-policy` onto **both** axes: a membership default and a moderation default. That yields four deltas, not three.

**Recommendation:** a phase-owned channel inherits bare-channel defaults unless overridden, with four specific deltas recommended as the phase-owned-channel default:

| Axis | Bare channel default (Spec-016) | Phase-owned channel recommended default | Rationale |
|---|---|---|---|
| Turn policy | `free-form` | `round-robin` | A phase has a bounded goal and produces one output artifact. Free-form admits noise and makes termination criteria ambiguous. Round-robin forces structured deliberation with deterministic turn order, which matches the phase's output contract (Spec-017 §Output Mode Specification — structured JSON, one `summary`, one `metadata`, zero-or-more artifact refs). |
| Budget: turns-per-agent | 50 | `max(10, ceil(phase.expected_turns / agent_count))`, capped at 20 | A phase is not a long-running conversation. 50 turns per agent is sized for free-form exploration in a bare channel. Phase-owned channels should default lower to produce bounded outputs and fail-fast rather than drift. The exact formula is indicative; the principle is "lower than 50, bounded by the phase's expected scope." Authors can explicitly raise it. |
| Membership (participation-policy / who is admitted) | inherits session membership | **phase-targeted agents only** — the agents named in the phase definition are admitted; session humans and other session agents are not auto-admitted. Humans can explicitly join via the normal invite surface. | A phase is a scoped execution with a named participant set. Auto-admitting the full session into a phase-owned channel violates the phase's contract — the phase "has agents A and B," not "has whoever is in this session." Humans who want to observe can still read the channel timeline (Spec-016 visibility policy); they just don't auto-participate in turn order. |
| Moderation (participation-policy / approval surface) | off (opt-in per channel) | inherits phase's gate type — `off` if phase gate is `auto-continue`, `done`, or `human-approval`; `post-turn informational` if phase gate is `quality-checks` | The `human-approval` case is deliberately OFF, not ON. A `human-approval`-gated phase already has a phase-boundary human reviewer via `WorkflowGateResolve`. Defaulting channel moderation to `pre-turn gate` on top would force the same reviewer to approve every intermediate turn *and* the final output — double approval by default is a worse UX than single approval at the boundary. Authors who want negotiation-style per-turn review opt in by setting `moderation: pre-turn`. `auto-continue` and `done` phases explicitly don't want gates. `quality-checks`-gated phases want automated checks on final output; post-turn informational at channel level is a light touch that doesn't block flow but surfaces intermediate turns for the quality-check agent to read as context. |

**What stays bare-channel-default:**

- **Token budget per run (100k)** — unchanged; this is a provider-cost ceiling that doesn't depend on whether the channel is bare or phase-owned.
- **Cost limit per session ($10)** — unchanged; session-scoped not phase-scoped.
- **Idle timeout (5 min)** — unchanged; phase-owned or bare, idle is idle.
- **Scheduler limits (5 concurrent channels, 25 queue depth, 10 pending orchestration runs)** — unchanged; phase-owned channels count against the same per-session scheduler limits (this is the Airflow-SubDAG lesson — no independent scheduler).
- **Partition/reconnect behavior** — unchanged; inherited from Spec-003 and Spec-015 as for bare channels.

**Why each delta wins:**

1. **Round-robin default.** Empirical evidence from both agentic workflow pattern summaries (`skywork.ai/blog/agentic-ai-examples-workflow-patterns-2025`, `vellum.ai/blog/agentic-workflows-emerging-architectures-and-design-patterns`) and structured deliberation research: unstructured multi-agent chat produces circular reasoning and late-stage noise. Phases are finite; structured turn-taking converges faster. Round-robin is the simplest deterministic policy that matches phase semantics. Users who want `free-form` can explicitly override.
2. **Tighter turn cap.** 50 turns * N agents is a lot of turns for a phase that has *one* output contract. A `multi-agent` phase's turn count should be a design parameter, not a liability. Lower default with explicit author-override preserves author control without letting V1 phases run away.
3. **Moderation inherits phase gate.** This is the cleanest way to avoid the "both gates fire" concern from Q2 by making the *channel defaults* already consistent with the *phase gate* the author chose. If the author wants finer control, they override.

**Steel-man for "all defaults identical":** "Consistency is simpler. Channels behave the same whether phase-owned or bare; the phase only adds lifecycle (Q1, Q4). Users who want tighter semantics configure them per phase." Response: this loads the defensive work onto every author. The "principle of least surprise" argument is real, but the *default* of a phase-owned channel should match *phase-like* intuitions (bounded, structured, output-producing), not *bare-channel* intuitions (persistent, exploratory, open-ended). The deltas are small, each defensible with a one-line reason, and explicitly overridable per-phase.

### 3.4 Q4 — Termination: phase completion / failure propagation to channel

**Recommendation:** borrow Temporal's `ParentClosePolicy` vocabulary, but **invert the default from `TERMINATE` to a Spec-016-specific `CLOSE_WITH_RECORDS_PRESERVED`** — the channel transitions to a terminal `closed` status on phase end, records survive, and no new activity is admitted.

**Vocabulary:**

- `CLOSE_WITH_RECORDS_PRESERVED` (V1 default) — phase end drives channel to terminal `closed` state. All existing events, turn history, and agent state remain durable. No new turns admitted. This is ABANDON-with-state-transition in Temporal vocabulary (ABANDON preserves the child but lets it continue; ours preserves records but stops admission — a tighter variant).
- `TERMINATE` (reserved; V1 selectable with explicit opt-in) — phase end force-terminates agents mid-turn, flushes in-flight output, records transition. For phases where the author wants hard-stop semantics.
- `REQUEST_CANCEL` (reserved; V1 for phase *failure* path) — phase failure sends cancel-intent to agents; agents may emit a final closing turn before channel closes. Used automatically when phase transitions to `failed` to allow clean wind-down.
- `ABANDON` (reserved; V1.1) — phase end lets channel continue under its own lifecycle. Only meaningful with the BIND variant of Q1; reserved until Q1's BIND mode ships.

**Why inverting Temporal's default wins for V1:**

1. **Spec-016 §State and Data Implications is explicit.** "Channel and run-link records must be durable and replayable." TERMINATE-default loses in-flight state; CLOSE_WITH_RECORDS_PRESERVED never loses it.
2. **Spec-016 §Required Behavior demands audit.** "Internal helper runs must remain distinguishable from user-visible agents while still appearing in canonical history." A terminated channel that loses its last turn's output creates an audit hole.
3. **Temporal's TERMINATE default was chosen for isolation-first semantics** — children running independent long-lived work should die with their parents to avoid orphans. Our channels are *coordination surfaces*, not independent executors — there is nothing to "leak" by preserving records, because the channel's in-memory state (active turn timers, agent attentions) closes immediately; only the durable history survives. The risk Temporal's default guards against doesn't apply.
4. **Step Functions Standard-calls-Express is a partial analog** — parent can `StopExecution` child, and failure cascades via retry policies, but the child's execution history survives in the Step Functions execution record regardless. That's consistent with CLOSE_WITH_RECORDS_PRESERVED.
5. **Replay is cheap.** Because records survive, a failed workflow can be audited, its channel transcript inspected, and the failure understood without reconstructing state.

**Phase failure propagation (phase → `failed` state):**

- Phase triggers `REQUEST_CANCEL` to the channel: agents receive a `phase.cancelling` event and may emit one final turn if they have a turn queued.
- After a bounded grace period (default 30s, tunable per-phase), channel transitions to `closed` with `reason: phase_failed`, retaining all records.
- Workflow-run state records `PhaseRun.status = failed` and per the Spec-017:43 `failure-behavior` (`retry` / `go-back-to` / `stop`), the workflow proceeds.
- If `failure-behavior: retry`, a *new* channel is created for the retry iteration (channels are not reused across retry iterations — this preserves audit separation between attempts). The failed iteration's channel remains available via `PhaseOutputRead` equivalent queries.

**Why no auto-cascade beyond the single channel:** Spec-016:122 explicitly: "A pause, interrupt, or steer applied to a parent run does not auto-cascade to its child runs. Each child run is an independent intervention target." Phase failure drives the *phase-owned channel* to close but does not signal any other channel the session holds. This aligns with the existing non-cascade rule.

**Channel visibility after phase end:**

- Channel appears in timeline with `status: closed` badge and phase-linked provenance.
- Replay and `ChildRunLinkRead` continue to work against the closed channel.
- `ChannelCreate` cannot target the closed channel for new activity (it's terminal, not paused).
- For workflow replay (Spec-015), the closed channel replays the exact turn sequence it contained. No new agent admission during replay.

**Steel-man for TERMINATE default:** "Keeping closed channels around indefinitely bloats the session. A TERMINATE default with explicit opt-in for preservation would let the common case be lightweight." Response: Spec-015 persistence/recovery/replay already owns durable history. A closed channel is a few bytes of metadata + the event log entries the replay already persists. The storage cost of records-preserved is negligible. The audit cost of TERMINATE-default is not.

---

## 4. V1 Contract — Summary Recommendation

If `multi-agent` phase type ships in V1, Wave 1 synthesis should land the following contract deltas in Spec-017 (and matching language in Spec-016 where appropriate):

1. **Ownership.** V1 supports OWN only. `multi-agent` phase creates a channel at phase start and binds the channel's lifecycle to the phase. Contract exposes `ownership: OWN` (V1 only option; `BIND` reserved for V1.1+). Channel shares phase execution scope — no independent scheduler, no independent pool, no independent attributes.
2. **Gate scoping.** Channel-level gates (Spec-016 moderation hooks) fire during phase execution, per-turn, via the existing Plan-012 approval surface with `scope: channel`. `WorkflowGateResolve` fires at phase boundary, on phase output, via the existing Plan-012 approval surface with `scope: workflow-phase`. Pending channel gates block phase transition to `completed`; if budget/timeout fires with a pending gate, phase transitions to `failed` with explicit reason.
3. **Defaults delta.** Phase-owned channel defaults differ from bare-channel defaults on four axes: turn policy defaults to `round-robin` (not `free-form`); per-agent turn budget defaults to a phase-bounded formula (indicative: max 20); membership defaults to phase-targeted agents only (not full session membership); moderation defaults to `off` for `auto-continue` / `done` / `human-approval` phases (the phase-boundary gate is the sole approval) and `post-turn informational` for `quality-checks` phases. All other bare-channel defaults apply unchanged.
4. **Termination.** V1 default is `CLOSE_WITH_RECORDS_PRESERVED` — channel transitions to terminal `closed` state on phase end, records survive, no new turns admitted. Phase failure drives `REQUEST_CANCEL` with a bounded grace period (default 30s) before close. `TERMINATE` selectable per-phase; `ABANDON` reserved for V1.1 with BIND. Retry creates a new channel for the retry iteration; prior iteration's channel remains queryable.

**V1 scope gate:** shipping `multi-agent` at V1 requires landing these four contract points as Spec-017 additions (not new ADR — they fit within existing Spec-016/017 vocabulary). Estimate: ~1 week of additional Spec-017 edits beyond the BL-097 M-012 guardrails already proposed under resolution α, plus a Plan-017 update to carry the four contract clauses into the implementation steps. No new ADR trigger unless the Wave 1 synthesis decides to cascade intervention or change delegation depth, neither of which this brief recommends.

---

## 5. Open Questions For Wave 1 Synthesis

Questions this brief cannot resolve because they depend on Wave 1's integration with other passes:

1. **Multi-phase same-session channel reuse** — if a user has an `analyze` phase that produced insights and a `plan` phase that wants the same agents to continue the discussion, our OWN recommendation forces two channels. Wave 1 should decide whether to surface cross-phase context stitching (phase B reads phase A's channel transcript as context) or formally defer the use case to V1.x with a BIND escape-hatch. This is a UX decision, not a contract decision; the contract permits either.
2. **Per-phase channel participant membership invite flow** — §3.3's membership delta defaults to phase-targeted agents only. Wave 1 should decide the exact invite-surface UX: does a session human need to click a "join this phase's channel" affordance, is it surfaced automatically at phase start, or does the authoring UI let the workflow author pre-declare observer-eligible humans? Spec-016:54's "later restricted by policy" clause covers the contract surface; the UX is Plan-017 authoring + Plan-013 timeline work, not this brief.
3. **Channel re-entry during workflow replay** — Spec-015 owns replay; this brief assumes replayed channels are read-only and do not admit new turns. If Wave 1 wants interactive replay ("pause at phase 3, manually steer the channel, resume"), that's a Spec-015 + Spec-017 joint decision beyond Pass B's scope.
4. **Default turn-budget formula precision** — §3.3 recommends "max 20 turns per agent, formulaically" but the exact formula should be decided with Plan-017 authoring-UI affordances in mind. If the UI shows "turns per agent" as an obvious knob, the default can be lower; if it's hidden, the default should be more generous.

**Biggest contract ambiguity Wave 1 must resolve:** **Q2 (gate scoping/sequencing) is the only place Spec-016 and Spec-017 mechanisms can genuinely produce ambiguous behavior.** Q1 (OWN) and Q4 (termination) are discrete choices with clear defaults. Q3 is a set of deltas, each individually defensible. Q2 requires Wave 1 to author a new rule: *when does a gate fire through which surface.* The temporally-disjoint framing in §3.2 is this brief's recommended resolution; Wave 1 must decide whether to accept it, refine it, or replace it with an explicit composition rule (and accept the matrix of compound states that entails).

---

## 6. Sources

All fetched 2026-04-22 unless otherwise noted.

**Temporal child workflows:**
- Temporal — Parent Close Policy — `https://docs.temporal.io/parent-close-policy`
- Temporal — Child Workflows overview — `https://docs.temporal.io/child-workflows`
- Temporal TypeScript SDK — Child Workflows — `https://docs.temporal.io/develop/typescript/child-workflows`
- Temporal TypeScript SDK — `ParentClosePolicy` enum — `https://typescript.temporal.io/api/enums/proto.coresdk.child_workflow.ParentClosePolicy`
- Temporal Community — Parent and child workflow close policy — `https://community.temporal.io/t/parent-and-child-workflow-close-policy/463`
- Temporal Community — Child Workflow Cancelling Despite Abandon Policy — `https://community.temporal.io/t/child-workflow-cancelling-despite-abandon-policy/7223`
- Temporal Community — Awaiting the completion of a child workflow in cancellation cleanup — `https://community.temporal.io/t/awaiting-the-completion-of-a-child-workflow-in-cancellation-clean-up/16102`

**Airflow SubDAGs → TaskGroups:**
- Airflow 2.0 release blog — `https://airflow.apache.org/blog/airflow-two-point-oh-is-here/`
- Airflow 2.6 Core Concepts — DAGs (TaskGroups + SubDAG drawbacks + cross-DAG patterns) — `https://airflow.apache.org/docs/apache-airflow/2.6.0/core-concepts/dags.html`
- Airflow 3.0 release notes (SubDAG removal) — `https://airflow.apache.org/docs/apache-airflow/3.0.3/release_notes.html`
- Astronomer — Upgrading Airflow 2 to 3 checklist — `https://www.astronomer.io/blog/upgrading-airflow-2-to-airflow-3-a-checklist-for-2026/`
- AIP-34: TaskGroup (Confluence) — `https://cwiki-test.apache.org/confluence/display/AIRFLOW/AIP-34+TaskGroup:+A+UI+task+grouping+concept+as+an+alternative+to+SubDagOperator`
- Deprecate SubDags in Favor of TaskGroups issue — `https://github.com/apache/airflow/issues/12292`
- Apache dev mailing list discussion — `https://markmail.org/message/o3q6qbdlj6k2wzqy`
- SubDagOperator deadlock explanation (Twine Labs / Medium) — `https://medium.com/@team_24989/fixing-subdagoperator-deadlock-in-airflow-6c64312ebb10`
- SubDAG worker-slot starvation — `https://github.com/apache/airflow/issues/1350`
- Airflow TaskGroup tutorial (BigThinkCode) — `https://www.bigthinkcode.com/insights/grouping-of-tasks-in-airflow`

**n8n sub-workflows:**
- n8n Docs — Sub-workflows — `https://docs.n8n.io/flow-logic/subworkflows/`
- n8n Docs — Execute Sub-workflow node — `https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/`
- n8n Docs — Execute Sub-workflow Trigger node — `https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflowtrigger/`
- n8n Docs — Call n8n Workflow Tool — `https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow/`

**Kestra subflows:**
- Kestra Docs — Subflows — `https://kestra.io/docs/workflow-components/subflows`

**Activepieces SubFlows:**
- Activepieces Docs — Passing Data — `https://www.activepieces.com/docs/flows/passing-data`
- Activepieces Docs — Nested Flows glossary — `https://resources.activepieces.com/glossary/nested-flows`
- Activepieces — SubFlows piece — `https://www.activepieces.com/pieces/subflows`
- Activepieces — Launch Week I Day 4 SubFlows announcement — `https://www.activepieces.com/blog/subflows-piece`

**Argo Workflows:**
- Argo — DAG walk-through — `https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/`
- Argo — Workflow Templates — `https://argo-workflows.readthedocs.io/en/latest/workflow-templates/`
- Argo — Suspending walk-through — `https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/`
- Argo — Core Concepts — `https://argo-workflows.readthedocs.io/en/latest/workflow-concepts/`
- Argo Workflows issue #12425 — Simplify Workflow of Workflows — `https://github.com/argoproj/argo-workflows/issues/12425`

**AWS Step Functions nested workflows:**
- AWS Step Functions — Best Practices — `https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html`
- AWS Blog — Breaking down monolith Step Functions workflows (nested Express + Standard) — `https://aws.amazon.com/blogs/compute/breaking-down-monolith-workflows-modularizing-aws-step-functions-workflows/`
- AWS Step Functions FAQs — `https://aws.amazon.com/step-functions/faqs/`
- AWS Step Functions — Choosing workflow type — `https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html`

**Durable-execution / agentic-workflow context:**
- Restate — Building a modern Durable Execution Engine — `https://www.restate.dev/blog/building-a-modern-durable-execution-engine-from-first-principles`
- Restate Docs — Workflows — `https://docs.restate.dev/use-cases/workflows`
- Kai Waehner — Rise of Durable Execution Engines 2025 — `https://www.kai-waehner.de/blog/2025/06/05/the-rise-of-the-durable-execution-engine-temporal-restate-in-an-event-driven-architecture-apache-kafka/`
- Vellum — Agentic Workflows 2026 — `https://www.vellum.ai/blog/agentic-workflows-emerging-architectures-and-design-patterns`
- Skywork — 20 Agentic AI Workflow Patterns 2025 — `https://skywork.ai/blog/agentic-ai-examples-workflow-patterns-2025/`
- Dapr Docs — Workflow patterns — `https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/`
- Orkes Conductor Docs — Sub Workflow operator — `https://orkes.io/content/reference-docs/operators/sub-workflow`

**Project context (non-fetched; read from repo):**
- `docs/specs/016-multi-agent-channels-and-orchestration.md` (read 2026-04-22).
- `docs/specs/017-workflow-authoring-and-execution.md` (read 2026-04-22).
- `docs/plans/017-workflow-authoring-and-execution.md` (read 2026-04-22).
- `docs/backlog.md` §BL-097 (read 2026-04-22).

*End of brief.*
