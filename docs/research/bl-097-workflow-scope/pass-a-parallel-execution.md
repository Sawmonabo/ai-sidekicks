# BL-097 Pass A — Parallel Execution Semantics for the Phase DAG

**Date:** 2026-04-22
**Pass:** A of N — Parallel execution semantics
**Question:** How should a local workflow engine execute a phase DAG in parallel — specifically scheduling, cycle/loop handling, backpressure against a 256 MB + finite-PTY daemon, and failure propagation across parallel siblings?
**Scope:** Decision-grade brief informing the Spec-017 executor design. Other BL-097 passes cover persistence/replay, sub-workflows, and failure-recovery primitives; this pass is strictly the **live-execution** surface.
**Spec-017 anchor (resolved):** Phases run sequentially by default; parallelism is opt-in and explicitly bounded (`017-workflow-authoring-and-execution.md:57`, `workflow-phase-model.md:140`). Failure behavior taxonomy is `retry | go-back-to | stop` (`workflow-phase-model.md:98-102`). `max_retries` default 3, configurable per gate. V1 phase types are `single-agent | automated`; `multi-agent | human` are V1.1.

---

## 1. Framing the four questions

### 1.1 Q1 is not a versus — it's two separate roles

The task asks "Kahn's vs Tarjan's SCC" for ordering. That framing collapses two distinct responsibilities:

- **Static validation at submit time** — prove the definition is acyclic, reject if not. DFS with three-color marking (WHITE/GRAY/BLACK) is the standard; Tarjan's SCC / Kosaraju are overkill for a pure DAG (they *find* SCCs, which only matter if you're permitting cycles).
- **Runtime scheduling** — emit ready phases as upstream dependencies clear. Kahn's algorithm (ready-set driven by in-degree) is the universal choice; it naturally yields the "what can I dispatch now" question that a parallel executor asks every tick.

Primary-source evidence that production engines do both:

- Airflow: `DAG._test_cycle_helper` is DFS with `CYCLE_IN_PROGRESS` state marking ([code snippet extracted via Airflow 1.10.4 source module](https://airflow.apache.org/docs/apache-airflow/1.10.4/_modules/airflow/models/dag.html)). `DAG.topological_sort` is Kahn-style (iteratively strip nodes with no un-resolved upstream). Performance PR [apache/airflow#4322](https://github.com/apache/airflow/pull/4322) optimized the data structures (in-degree counters instead of repeated scans), not the algorithm.
- Argo, Dagster, Prefect: all reject cycles at submit; none publish source-level algorithm naming, but the same two-role split is visible in their codebases and forum guidance.

**Takeaway:** there is no tradeoff to present. V1 does DFS-cycle-check at definition-save + Kahn-style ready-set at runtime. Both are textbook, cheap, and independently correct.

### 1.2 Q2 has a hidden presupposition

The task asks how engines "prevent infinite loops when `go-back-to` is present." That phrasing smuggles cycles into a DAG. The resolution in the V1 model is that `go-back-to` is **not** a DAG edge — it is a runtime control operation that *resets* phase states from the target back to the failing phase (`workflow-phase-model.md:100-101`). The definition graph remains acyclic; iteration is bounded by `max_retries`.

This lines up with the pattern across production engines:

- **Pure DAG engines (Airflow, Argo, Dagster, Prefect)** reject cycles at submit. Retry is *in-place* (attempt counter on a task); there is no "jump back to task X" primitive in the DAG. Iteration lives outside the graph.
- **State-machine engines (AWS Step Functions, Camunda BPMN)** permit cycles natively but bound them with `MaxAttempts` (AWS) or stack-depth / timeouts (others). Step Functions' `Retry` policy has MaxAttempts default 3, max 99999999, and a mandatory `Catch` fallback when retries exhaust ([AWS Step Functions error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)).
- **Temporal** uses **Continue-As-New** for cyclic/long-running logic: atomically complete the current execution, start a fresh one with the same ID but empty history ([Temporal Go SDK workflow package](https://pkg.go.dev/go.temporal.io/sdk/workflow), [Temporal Child Workflows docs](https://docs.temporal.io/child-workflows)). The cycle is never in the graph — the workflow restarts.

**Takeaway:** V1's `go-back-to` is in the Airflow/Prefect/Dagster family — "reset state and re-enter the DAG from target," with iteration bounded by `max_retries`. It is NOT a cyclic edge. Three overlapping bounds defend against runaway loops: per-phase `max_retries` (default 3), workflow-wide attempt cap (see Open Questions below), and a wall-clock timeout on the workflow run.

### 1.3 Q3's constraint is tight and resource-typed

The daemon targets 256 MB RSS and a finite PTY slot pool (exact count TBD but bounded). A single global semaphore is insufficient because the scarce resources are *typed*:

- PTY slots — finite, each `single-agent` phase needs one for the duration
- Memory headroom — each active agent plus the daemon compete
- (Forward-looking) CPU cores, network egress, and any future tool-specific capacity

Production engines all solve this with **per-resource semaphores / pools**, not a global throttle:

- **Airflow Pools** — named pools (`ep_data_pipeline_db_msg_agg`, etc.), each with a slot count; tasks declare `pool="X"` and optional `pool_slots=N` for weighted consumption. Scheduler queues tasks when pool is full and orders waiting tasks by priority weight ([Airflow Pools docs](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html)).
- **Argo Workflows semaphores** — ConfigMap-declared, referenced by name from workflow/template; workflow-controller polls the ConfigMap and rate-limits pod creation via `resourceRateLimit` (average QPS + burst) to protect the Kubernetes API server. Workflows waiting on a mutex/semaphore count against parallelism ([Argo parallelism issue #11984](https://github.com/argoproj/argo-workflows/issues/11984)).
- **Dagster Pools + Tag Limits + Run-Executor Limits** — three-layer model: run-queue caps total concurrent runs; pools protect shared external resources across runs; tag limits throttle within a run. "If any limit would be exceeded by launching an op, then the op will stay queued" ([Dagster concurrency docs](https://docs.dagster.io/guides/operate/managing-concurrency)).
- **Temporal task queue worker slots** — worker process declares `maxConcurrentActivityExecutions` and similar per-slot-type limits; scheduling is lazy (worker pulls when a slot is free), not eagerly pushed by the scheduler.

**Takeaway:** V1 should expose a small set of typed capacity pools — at minimum `pty_slots` and `agent_memory_mb` — with per-phase declared consumption. The scheduler admits a ready phase only if **all** declared pool requirements fit current free capacity. Lazy / pull-based scheduling (worker asks for next job) is materially simpler to make robust under memory pressure than eager push scheduling — the daemon is effectively its own single worker, so this mostly collapses to "ready-set → admission-check loop."

### 1.4 Q4's honest answer is: there is no universal default — there is a **toggle**

The survey splits cleanly into three camps, and each has a principled reason:

- **Fail-fast (cancel siblings on first failure)** — Temporal default with `Promise.all` *semantically* (one reject aborts the combined promise), but the cancellation of sibling operations is **not automatic** — the programmer must explicitly call `scope.cancel()` on the enclosing `CancellationScope`. Argo DAG templates expose `failFast: true` as the default.
- **Wait-all-settled (let siblings finish, aggregate errors)** — Temporal `Promise.allSettled`-style via `Selector.AddFuture`; Prefect (explicit — "when a concurrent task raises, the other submitted task is not cancelled" per [PrefectHQ/prefect#17867](https://github.com/PrefectHQ/prefect/issues/17867)); n8n's Split-in-Batches+Merge pattern ("errors don't stop the others because they're on separate branch outputs" per [n8n community](https://community.n8n.io/t/parallel-execution-with-error-handling-and-aggregated-result-email-in-n8n/290000)).
- **Configurable per-join (trigger rules)** — Airflow's 12 trigger rules (`all_success`, `all_failed`, `all_done`, `all_skipped`, `all_done_min_one_success`, `one_failed`, `one_success`, `one_done`, `none_failed`, `none_failed_min_one_success`, `none_skipped`, `always`) let the downstream join node declare what it accepts ([Astronomer trigger rules docs](https://www.astronomer.io/docs/learn/airflow-trigger-rules)). This is the **most expressive** model and corresponds to what a gate's failure-behavior configuration should look like.

Why the variance:
- Temporal and Argo are long-running infra-grade schedulers; "one fails, cancel rest to save compute" is operationally right.
- Prefect is data-pipeline-oriented where partial results still have value (one API failed, keep the other two).
- Airflow exposes both and more because ETL workloads have diverse join semantics (cleanup tasks want `all_done`; retry-if-any-sibling-failed tasks want `one_failed`).

There is a latent correctness hazard independent of policy: Temporal's Java SDK had a **non-deterministic-execution bug** when an exception in one parallel promise was not surfaced eagerly — later replay diverged from history ([temporalio/sdk-java#902](https://github.com/temporalio/sdk-java/issues/902)). Lesson: failed-sibling bookkeeping must be observed at a deterministic checkpoint, not smeared across async callbacks.

**Takeaway:** V1 should pick a **default** (fail-fast is the safer production default for a local daemon with scarce resources — don't keep working on output that will be discarded) and expose a **per-join override** for cases where partial results matter. Airflow-style trigger rules are overkill for V1; a three-valued enum (`fail-fast | all-settled | any-success`) covers the real cases.

---

## 2. Reference-engine comparison matrix

| Engine | Static cycle check | Runtime scheduling | Cyclic retry pattern | Backpressure primitive | Parallel sibling failure default |
|---|---|---|---|---|---|
| **Airflow** | DFS three-color (`_test_cycle_helper`) | Kahn-style ready-set + Pools + priority weight | In-place retry counter on task; no cycle edges | Named Pools (per-resource slots) + global parallelism | `all_success` (one fails → siblings run to completion but downstream blocks with `upstream_failed`); 11 other trigger rules opt-in |
| **Argo Workflows** | Submit-time validation | Controller reconciliation + `resourceRateLimit` | In-place retry; recursive template invocation for loop-like patterns (implicit stack bound) | ConfigMap-named semaphores + mutexes; workflow-level `parallelism`; template-level `parallelism` | `failFast: true` (default) cancels siblings; `failFast: false` lets them run |
| **Temporal** | N/A (imperative code, not a graph) | Selector + Futures; deterministic replay | **Continue-As-New** (atomic restart with empty history) | Task-queue worker slot limits (`maxConcurrentActivityExecutions`); lazy pull scheduling | **Not automatic** — `Promise.all` rejects but siblings keep running until `CancellationScope.cancel()` is called explicitly |
| **Dagster** | Submit-time validation | Multi-process executor + run queue + pools | In-place retry; no cycle primitive | Run queue (total runs) + Pools (cross-run resource) + Tag Limits (within-run) + Run-Executor Limits | Op-level (within run): op failure does not auto-cancel sibling ops in the same executor batch |
| **Prefect** | Submit-time (flow-graph) | Task runner (ThreadPool/ProcessPool) + futures | In-place retry; no cycle primitive | Task-runner concurrency + concurrency slot contexts | **Not automatic** — "when a concurrent task raises, the other submitted task is not cancelled" |
| **n8n** | Implicit (UI topology) | Top-down branch execution | No cycle primitive; Loop-over-items for iteration | Per-instance execution; no formal semaphore | **Not automatic** — sibling branches are isolated; Split-in-Batches + Merge handles partial failure |
| **AWS Step Functions** | N/A (state machine) | State transition engine | MaxAttempts counter + Catch fallback | Service-level quota (not user-configurable per state) | Parallel state: one branch fails → entire Parallel state fails (sibling branches cancelled); configurable via Catch |
| **Dagger (post-Theseus)** | BuildKit-replacement engine; e-graph cache-equivalence tracking | Native DAG engine (replaced BuildKit solver in 2025-2026 per [Dagger changelog](https://dagger.io/changelog/)) | In-place; content-addressed cache makes retry cheap | Implicit (cache-hit elimination is the main throttle) | Fail-fast (build-system norm) |

---

## 3. Research findings by question

### 3.1 Q1 — Algorithm choice for topological sort

**Finding:** The "Kahn vs Tarjan" framing is mis-posed. Every production engine surveyed uses (a) DFS for cycle detection at definition-commit time and (b) Kahn-style ready-set iteration at run time. They are complementary, not competing.

**Primary evidence:**
- Airflow's DAG class carries both: `_test_cycle_helper` (DFS with three-color marking, raises `AirflowDagCycleException`) and `topological_sort` (Kahn-style iterative node-removal). See the [Airflow 1.10.4 source module for DAG](https://airflow.apache.org/docs/apache-airflow/1.10.4/_modules/airflow/models/dag.html) and the perf-optimization [PR #4322](https://github.com/apache/airflow/pull/4322) which confirms Kahn remains the approach — the PR improved data structures (cached in-degree), not the algorithm.
- Dagster's run queue + asset-based execution uses the same two-step pattern: validate acyclic on deployment-code load, then emit ready assets as upstream completes ([Dagster concurrency docs](https://docs.dagster.io/guides/operate/managing-concurrency)).
- Argo validates at submit and reconciles at run; the CRD specification forbids cycles.
- Tarjan's SCC and Kosaraju are *not* standard in these systems precisely because they exist to enumerate SCCs in graphs where cycles are *expected* — that's state-machine territory, not DAG territory.

**Performance note:** cycle detection is O(V+E) DFS and topological sort is O(V+E) Kahn. For V1's expected phase counts (single digits to low tens per workflow), both are microsecond-scale. Algorithmic complexity is not a V1 constraint.

**Recommendation for V1:** Adopt the two-role split explicitly in the executor design. DFS-cycle-check on `WorkflowDefinitionCreate` (reject invalid definitions before they reach disk); Kahn-style ready-set in the executor's tick loop. Do not cite Tarjan or name the algorithms in user-facing docs — these are implementation details.

### 3.2 Q2 — `go-back-to` and infinite-loop prevention

**Finding:** V1's `go-back-to` is a **state reset operation**, not a cyclic graph edge. The phase-model spec is explicit: on `go-back-to`, phases between the target and the current phase transition back to `pending`; iteration is bounded by `max_retries` (`workflow-phase-model.md:96-102`). This matches the Airflow/Dagster/Prefect pattern (in-place retry counters, no graph cycles) rather than the Temporal (`Continue-As-New`) or Step Functions (cyclic state machine with `MaxAttempts`) patterns.

**Why this matters:** the graph-level invariant stays acyclic, so DFS cycle check at save time is sufficient. Retry explosion is bounded by three independent limits:
1. **Per-phase `max_retries`** (default 3) — local bound on iteration at a single phase.
2. **Workflow-run attempt ceiling** (not yet in spec — see Open Questions §6) — guards against `go-back-to` cascades where phase B sends to A, A sends to B (mutual reset). Without a run-level cap, a mis-configured workflow can still iterate forever if each individual `max_retries` counter resets on state transition to `pending`.
3. **Wall-clock workflow timeout** — orthogonal safeguard.

**Primary evidence:**
- Airflow and Dagster: in-place retry, no cycle primitive. `go-back-to` semantics don't exist in either; users encode "go back to earlier step" by structuring the DAG with compensating/alternate branches and trigger rules.
- Step Functions: `Retry` with `MaxAttempts` default 3, max 99999999 ([AWS docs](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)). `Catch` fallback when retries exhaust. State-machine loops are explicit `Choice` + base-case transitions — if you omit the base case you get an infinite loop ([AWS blog on recursive Step Functions](https://arpadt.com/articles/iteration-with-step-functions) / see SparkCodeHub variants).
- Temporal: Continue-As-New atomically resets history ([Temporal Go SDK docs](https://pkg.go.dev/go.temporal.io/sdk/workflow)). Child-workflow retry uses the usual retry policy on the child-workflow options; parent does not see a cycle.
- Argo: `retryStrategy.limit` bounds in-place retry; `withSequence`/`withItems` are bounded iteration (not true loops); recursive template invocation is technically possible and relies on implicit stack-depth bounds.

**Recommendation for V1:**
1. Keep the graph acyclic at definition time; DFS cycle check rejects bad definitions.
2. Bound iteration with three counters: per-phase `max_retries` (already in spec), a **new** workflow-run attempt cap (propose `max_phase_transitions: 100` default), and a workflow wall-clock timeout (propose `max_duration: 24h` default, configurable).
3. When `go-back-to` fires, increment the run-level counter and check the cap **before** transitioning target phases to `pending`. If the cap fires, the workflow transitions to `failed` with a distinguishable reason (`RUN_ITERATION_LIMIT`) — not a plain phase failure.
4. Audit `go-back-to` targets at submit: target must be a strict ancestor in the DAG topological order of the configured phase. Reject configurations where a phase can `go-back-to` itself or a descendant.

### 3.3 Q3 — Backpressure against 256 MB + finite PTY slots

**Finding:** Global semaphores are the wrong shape. The scarce resources are typed and bound different phases differently:
- `pty_slots` — integer count, typed consumer: `single-agent` phases
- `agent_memory_mb` — integer budget, typed consumer: `single-agent` phases (automated phases are cheap)
- Future: `tool_quota` per external tool, `network_egress_qps`, etc.

The right primitive is a **named per-resource semaphore with declared per-phase consumption**, admitted by a gate that checks *all* required pools fit before launching.

**Primary evidence:**
- **Airflow Pools** are the cleanest fit: tasks declare `pool="X"` and `pool_slots=N`; scheduler admits only when the named pool has `N` free slots ([Airflow Pools docs](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html)).
- **Argo semaphores** via ConfigMap: workflow references `synchronization.semaphore.configMapKeyRef`; controller polls and enforces ([Argo parallelism design issue #740](https://github.com/argoproj/argo/issues/740)).
- **Dagster Pools + Tag Limits + Run-Executor Limits** — three-layer model confirms the per-resource-type pattern. "Pools address scenarios where multiple runs might simultaneously access the same external system" ([Dagster docs](https://docs.dagster.io/guides/operate/managing-concurrency)).
- **Temporal worker slots** — `maxConcurrentActivityExecutions` etc. on the worker, not on the scheduler. Lazy pull (worker fetches when a slot is free) instead of eager push. Matches a single-worker local daemon well.

**Concrete V1 shape:**
```
ResourcePool = { name: string, capacity: int }
PhaseResourceNeed = { pool_name: string, slots: int }

V1 pools (declared in daemon config):
- pty_slots: capacity = min(8, os.cpu_count * 2)   # tripwire below
- agent_memory_mb: capacity = daemon_budget - overhead = ~192MB usable (if 256MB target)

Per-phase declarations (in PhaseDefinition):
- single-agent phase: pty_slots=1, agent_memory_mb=<claimed>
- automated phase: pty_slots=0, agent_memory_mb=<small>
```

**Admission-check loop (in executor tick):**
```
for phase in ready_set (topological order, priority-ordered):
  if all(free(pool) >= need for pool, need in phase.resource_needs):
    admit phase
    decrement pools by need
  else:
    phase stays in ready_set, revisited next tick
```

This is deliberately pull-based and idempotent: the ready-set is computed fresh each tick (Kahn-style in-degree collapse from completed phases), and admission is a pure check. Under memory pressure the executor simply doesn't admit new work — no cancellation, no crash.

**Open tension:** `agent_memory_mb` is hard to predict before running an agent. Three options:
- **Declared** — author annotates phase with expected memory; executor rejects if claimed > capacity.
- **Observed** — executor tracks live RSS across running children, gates admission on `free = capacity - sum(observed)`.
- **Pessimistic-budgeted** — every `single-agent` phase reserves a fixed budget (e.g., 100 MB) regardless of actual usage.

V1 probably wants pessimistic-budgeted + an observability escape hatch (monitor RSS, emit telemetry when the budget is wrong). Declared is too hard for users; observed is too hard for V1 to implement correctly under fork/exec race conditions.

**Recommendation for V1:**
1. Adopt named-resource-pool model. Ship with `pty_slots` and `agent_memory_mb` as the two initial pools.
2. Pessimistic memory budgeting: every `single-agent` phase consumes a fixed per-agent MB budget (tunable per agent persona, default 100 MB for V1 local models). Refine in V1.1 based on telemetry.
3. Pull-based admission in executor tick: recompute ready-set from completed-phases-in-topological-order, admit the highest-priority ready phase whose resource needs fit, repeat.
4. Emit `workflow.phase_waiting_on_pool` timeline events when a phase is ready but can't admit — this is diagnostic gold.
5. Add a daemon-level `max_concurrent_phases` global cap as a final backstop (default 4), independent of per-pool limits.

**Risk:** 256 MB on the daemon is tight enough that if users routinely run 4+ `single-agent` phases in parallel with local models, the budget will blow. If that becomes the norm, the product probably wants to raise the daemon memory target rather than engineer around it — but that's a BL-097 scope question, not an executor-design question.

### 3.4 Q4 — Parallel sibling failure propagation

**Finding:** There is no universal default. The three camps (fail-fast cancellation, wait-all-settled, configurable trigger rule) are each coherent in their own operational context. For a local daemon with scarce resources, **fail-fast is the right default**, but V1 must expose an opt-in override because some workflows legitimately want partial results.

**Primary evidence:**
- **Argo DAG template** — `failFast: true` is default; one task fails → scheduler attempts to cancel running tasks in the same parallel block. Setting `failFast: false` lets siblings run to completion ([Argo best-practice piece by Lingxian Kong](https://medium.com/@lingxiankong/best-practice-of-using-argo-workflows-3162708f1bd5)).
- **Temporal** — `Promise.all` rejects on first child failure *semantically*, but sibling activities / child workflows **do not auto-cancel**; the programmer must explicitly `scope.cancel()` on the enclosing `CancellationScope` ([Temporal TypeScript cancellation docs](https://docs.temporal.io/develop/typescript/cancellation); [Temporal Community: failure propagation from async child workflow](https://community.temporal.io/t/failure-propagation-from-async-child-workflow-to-parent/9966)). The Temporal Java SDK issue [temporalio/sdk-java#902](https://github.com/temporalio/sdk-java/issues/902) is a cautionary tale: deferred exception surfacing creates non-deterministic replay — failed-sibling bookkeeping must be observed at deterministic checkpoints.
- **Airflow** — configurable per downstream node via 12 trigger rules; `all_success` (default) yields "siblings continue, downstream marked `upstream_failed`." See [Astronomer trigger-rules docs](https://www.astronomer.io/docs/learn/airflow-trigger-rules) for the full table.
- **Prefect** — no auto-cancel. "When a concurrent task raises, the other submitted task is not cancelled" ([PrefectHQ/prefect#17867](https://github.com/PrefectHQ/prefect/issues/17867)). Failure surfaces when `.result()` is called on the specific future.
- **n8n** — sibling branches isolated; programmer explicitly wires Merge nodes to collect partial results ([n8n community discussion](https://community.n8n.io/t/parallel-execution-with-error-handling-and-aggregated-result-email-in-n8n/290000)).
- **AWS Step Functions Parallel state** — one branch fails → entire Parallel state fails; sibling branches are cancelled. `Catch` at the Parallel state level is the escape hatch.

**Why each camp chose its default:**
- **Argo (fail-fast):** saving compute is paramount; a failed upstream usually makes downstream work pointless; Kubernetes pod cleanup is expensive.
- **Temporal (manual cancel):** deterministic replay requires the programmer to reason explicitly about cancellation; auto-cancel would hide control flow from history.
- **Airflow (configurable):** ETL pipelines have heterogeneous semantics (cleanup wants `all_done`; DQ wants `all_success`; failover wants `one_failed`). Expose them all.
- **Prefect / n8n (let-them-finish):** partial results often have value in data pipelines; cancellation of in-flight work is expensive; engine simplicity wins.

**Recommendation for V1:** adopt **fail-fast as the default** with a three-valued per-join override.

```
ParallelJoinPolicy = 'fail-fast' | 'all-settled' | 'any-success'

fail-fast (default):
  On first sibling failure, cancel running siblings, transition parent phase to failed.
  Rationale: 256 MB and finite PTY slots mean wasted work has non-trivial cost.
  Matches Argo / Step Functions convention.

all-settled:
  Let every sibling reach a terminal state. Aggregate results. Downstream gate
  decides based on aggregated state.
  Rationale: quality-check fan-out where one negative result is informative but
  not disqualifying.
  Matches Prefect / Temporal Promise.allSettled pattern.

any-success:
  First successful sibling wins. Cancel the rest. Parent succeeds.
  Rationale: redundant calls to alternative agents/tools; take the first valid
  answer. (V1.1 likely feature, but name it now.)
```

**Design constraint:** the cancellation path MUST be deterministic and observable — failed-sibling status must be recorded at a synchronous checkpoint in the executor tick, not at the moment a callback fires. This matches the lesson from [temporalio/sdk-java#902](https://github.com/temporalio/sdk-java/issues/902). Concretely: every tick, the executor (1) collects terminated siblings, (2) applies the join policy to decide cancellation, (3) marks cancellations, (4) sends cancel signals to underlying runs, (5) commits state. No async drift.

---

## 4. Cross-cutting design implications

### 4.1 The scheduler loop shape

Given the four recommendations above, the V1 executor tick looks like:

```
while workflow_run.state == 'running':
  1. Collect terminal phases since last tick (polled from run-state-machine).
     For each newly-terminal phase:
       - update its WorkflowPhaseState (completed/failed/skipped)
       - if failed and inside a parallel block: apply join policy (fail-fast /
         all-settled / any-success) and mark sibling phases for cancellation
       - evaluate the phase's gate (auto-continue / quality-checks /
         human-approval / done) and resolve
       - on gate failure: apply failure behavior (retry / go-back-to / stop)
         with counter checks (§3.2)
  2. Recompute ready-set by Kahn-style in-degree collapse from updated
     completed-set (§3.1).
  3. For each phase in ready-set (priority-ordered):
       - admission check against all declared resource pools (§3.3)
       - admit if all fit; decrement pools; create run via OrchestrationRunCreate
       - otherwise emit workflow.phase_waiting_on_pool event
  4. Sleep until next external event (run state change, timer, signal) or
     timeout.
```

This is fully deterministic tick-by-tick. Every tick produces a consistent snapshot of (terminated-set, ready-set, admitted-set, resource-free-set) that can be persisted as a checkpoint.

### 4.2 Persistence / replay compatibility

Spec-017 §Implementation Notes commits to a "LangGraph-inspired checkpoint pattern on existing SQLite store." The tick shape above is checkpoint-friendly: each tick's post-condition (phase states, resource pool balances, pending cancellations) is a pure function of the accumulated events. On daemon restart: replay session events, reconstruct workflow-run state, resume from the next tick. This is Pass B material but is pre-compatible with Pass A here.

### 4.3 Observability hooks

Four timeline events are design-load-bearing:
- `workflow.phase_admitted` — phase moved from `ready` to `running` (new event, distinct from `phase_started`)
- `workflow.phase_waiting_on_pool` — phase was ready but admission blocked on resource pool (new event)
- `workflow.parallel_join_cancellation` — sibling cancellation triggered by join policy (new event)
- `workflow.phase_failed` (existing) — with new field `cancellation_reason: 'sibling_failure' | null`

Without these, V1 cannot answer basic operator questions like "why is my workflow slow?" or "did this phase fail on its own merits or because a sibling failed?"

---

## 5. Recommendation for V1 (consolidated)

1. **Scheduling** — DFS cycle check at `WorkflowDefinitionCreate`; Kahn-style ready-set in the executor tick. No naming of algorithms in user-facing docs.
2. **Loop safety** — keep the graph acyclic; `go-back-to` is a state reset (not an edge). Bound with three counters: per-phase `max_retries` (in spec), new workflow-run `max_phase_transitions` (propose 100), new workflow-run wall-clock `max_duration` (propose 24h).
3. **Backpressure** — named per-resource-pool model. V1 pools: `pty_slots` and `agent_memory_mb`. Per-phase declared needs. Pessimistic memory budgeting (fixed per-agent MB reservation). Admission-gate loop in executor tick. Global `max_concurrent_phases` default 4 as final backstop.
4. **Parallel failure** — default `fail-fast` with per-join override (`fail-fast | all-settled | any-success`). Deterministic sibling-cancellation checkpoint every tick. Cancellation routed through the run state machine's child-run cancellation path.

### Biggest risk identified

**Memory budgeting is fragile.** Declared per-phase memory is a UX tax on workflow authors who don't know their agent's RSS. Observed/live memory gating races with fork/exec startup. Pessimistic fixed-budget (§3.3) is the best V1 compromise but will under-provision long-running agents and over-provision short ones. The real fix is probably a V1.1 feedback loop: executor tracks observed RSS per agent persona across runs and adjusts the pessimistic budget. For V1 ship with pessimistic-fixed and instrument enough telemetry to validate.

### Tripwires — flip the design if any fires

- **Tripwire A (memory):** If >15% of phase-launch attempts are blocked on `agent_memory_mb` pool over a two-week rolling window, the budget model is wrong and needs V1.1 attention.
- **Tripwire B (PTY):** If the default `pty_slots=min(8, cpu*2)` leaves users unable to run their typical workflow shape (e.g., 6 agents in parallel and it only admits 4), the cap is too tight.
- **Tripwire C (join policy):** If >30% of workflows in the wild opt out of `fail-fast` to `all-settled`, the default is wrong and should flip.
- **Tripwire D (`go-back-to` loops):** If `RUN_ITERATION_LIMIT` fires on >2% of runs, the `max_phase_transitions` default is too low or users are authoring mis-structured loops (surface in docs).

---

## 6. Open questions surfaced (for Wave 1 synthesis)

1. **Run-level iteration cap** — Spec-017 does not currently specify a workflow-run-level iteration ceiling (only per-phase `max_retries`). Mutual `go-back-to` chains (A → B → A → B, each under its own max_retries) can unbound iterate without it. Propose adding `max_phase_transitions: 100` to the workflow definition schema. **Spec-017 amendment required.**
2. **Parallel join policy is not in Spec-017** — §3.4 and §5 recommend a `ParallelJoinPolicy` enum (`fail-fast | all-settled | any-success`) on each parallel block. Spec-017 today defines `failure_behavior` per phase (`retry | go-back-to | stop`) but has no concept of a per-join behavior when multiple siblings have run concurrently. **Spec-017 amendment required** to add parallel-block configuration. If V1 chooses to keep the executor minimal, a valid alternative is to hard-code `fail-fast` for V1 and defer the enum to V1.1.
3. **Pessimistic memory budget calibration** — default per-agent MB reservation needs a concrete number. 100 MB is a guess; real calibration requires running the V1 agent persona set (Codex, Claude, local models) and measuring. Pass B or a later pass owns this.
4. **Cancellation channel** — sibling cancellation routes through `OrchestrationRunCreate`'s cancel path (Spec-017 §Required Behavior). Pass B needs to verify the cancel path is synchronous-enough to meet the determinism requirement from §3.4 — if run cancellation is eventually-consistent, the executor can't durably record "cancelled at tick T."
5. **Priority semantics in ready-set** — when multiple phases are ready and pool admission can't take all of them, priority weight (Airflow-style) or FIFO? Spec is silent. Recommend: config-time priority on the phase definition, FIFO as tiebreaker.
6. **V1.1 `multi-agent` phase resource accounting** — deferred phase type means 1 phase = N agents = N PTY slots + N memory budgets. The resource-pool model handles this cleanly (multi-agent phase declares `pty_slots=N`), but call it out so Spec-017 V1.1 updates don't re-design.

---

## 7. Sources

All fetched 2026-04-22. Primary sources preferred; forum/blog citations are explicitly labeled as secondary.

### Airflow
- Airflow 1.10.4 DAG source module (DFS cycle detection + Kahn-style topological sort visible in code) — `https://airflow.apache.org/docs/apache-airflow/1.10.4/_modules/airflow/models/dag.html`
- Airflow Pools docs (3.2) — `https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html`
- Airflow Scheduler docs (3.2) — `https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html`
- Airflow DAGs docs (3.2) — `https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html`
- `apache/airflow#4322` — Performance fixes for topological_sort — `https://github.com/apache/airflow/pull/4322`
- Astronomer — Airflow trigger rules reference (all 12 rules documented) — `https://www.astronomer.io/docs/learn/airflow-trigger-rules`

### Temporal
- Temporal Go SDK `workflow` package (Selector, Futures, CancellationScope, Continue-As-New, Promise.all vs allSettled patterns) — `https://pkg.go.dev/go.temporal.io/sdk/workflow`
- Temporal Child Workflows docs — `https://docs.temporal.io/child-workflows`
- Temporal Failure reference — `https://docs.temporal.io/references/failures`
- Temporal TypeScript cancellation docs — `https://docs.temporal.io/develop/typescript/cancellation`
- Temporal Community forum — failure propagation from async child workflow to parent — `https://community.temporal.io/t/failure-propagation-from-async-child-workflow-to-parent/9966`
- `temporalio/sdk-java#902` — Exception in one of several parallel workflow async functions leads to non-deterministic execution — `https://github.com/temporalio/sdk-java/issues/902`

### Argo Workflows
- Argo Workflows parallelism docs — `https://argo-workflows.readthedocs.io/en/latest/parallelism/` (some fetches returned 403 — content paraphrased from search-result snippets; documentation headers reliable)
- Argo Workflows synchronization docs — `https://argo-workflows.readthedocs.io/en/latest/synchronization/`
- `argoproj/argo#740` — Proposal: system level workflow parallelism limits & priorities — `https://github.com/argoproj/argo/issues/740`
- `argoproj/argo-workflows#11984` — parallelism count includes Workflows waiting on a mutex/semaphore — `https://github.com/argoproj/argo-workflows/issues/11984`
- Best Practice of Using Argo Workflows (Lingxian Kong, Medium — secondary but concrete `failFast` semantics) — `https://medium.com/@lingxiankong/best-practice-of-using-argo-workflows-3162708f1bd5`

### Dagster
- Dagster Managing Concurrency docs — `https://docs.dagster.io/guides/operate/managing-concurrency`
- Dagster run queue / customizing priority — `https://docs.dagster.io/deployment/execution/customizing-run-queue-priority`

### Prefect
- Prefect Task Runners docs — `https://docs.prefect.io/v3/develop/task-runners`
- `PrefectHQ/prefect#17867` — Have a chance to terminate all flow's (concurrent) tasks on flow exit / canceling futures (confirms no auto-cancel) — `https://github.com/PrefectHQ/prefect/issues/17867`

### n8n
- n8n community — Parallel execution with error handling and aggregated result email — `https://community.n8n.io/t/parallel-execution-with-error-handling-and-aggregated-result-email-in-n8n/290000`
- n8n community — Issue with parallel workflows — `https://community.n8n.io/t/issue-with-parallel-workflows/85195`
- n8n workflow template: Pattern for parallel sub-workflow execution followed by wait-for-all loop — `https://n8n.io/workflows/2536-pattern-for-parallel-sub-workflow-execution-followed-by-wait-for-all-loop/`

### AWS Step Functions
- AWS Step Functions error handling concepts — `https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html`
- Building recursive logic with Step Functions (Arpadt — secondary, explicit MaxAttempts + base-case pattern) — `https://arpadt.com/articles/iteration-with-step-functions`

### Dagger
- Dagger changelog (Project Theseus — BuildKit solver replacement 2025-2026) — `https://dagger.io/changelog/`
- Dagger engine repo — `https://github.com/dagger/dagger`

### Internal (Spec-017 and related)
- `docs/specs/017-workflow-authoring-and-execution.md` — V1 scope and Required Behavior
- `docs/domain/workflow-phase-model.md` — Phase states, gate states, iteration model, `go-back-to` semantics

*End of Pass A.*
