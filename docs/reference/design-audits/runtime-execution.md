# Doc Review: Runtime, Execution, Provider, and Observability

**Date:** 2026-04-14
**Reviewer:** Claude Opus 4.6 (1M context)
**Documents reviewed:** 6 specs, 6 plans, 3 domain models, 3 ADRs (15 documents total)

---

## 1. What's Covered

### Signature Feature 3: Queue, Steer, Pause, Resume

The docs define a complete conceptual model for run control:

**Run State Machine** (domain/run-state-machine.md) defines 11 canonical states: `queued`, `starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `paused`, `recovering`, `interrupting`, `completed`, `interrupted`, `failed`. Terminal states are `completed`, `interrupted`, `failed`. Blocking states are `waiting_for_approval`, `waiting_for_input`, `paused`. The model explicitly separates canonical RunState from derived signals (`stuck-suspected`, `recovery-needed`) and failure categories (`provider failure`, `transport failure`, `local persistence failure`, `projection failure`).

**Queue and Intervention Model** (domain/queue-and-intervention-model.md) defines `QueueItem` with states `queued`, `admitted`, `superseded`, `canceled`, `expired`. Interventions have states `requested`, `accepted`, `applied`, `rejected`, `expired`. Queue items are persisted by the runtime, not the client. Every intervention has an initiator, target, timestamp, and outcome.

**Spec 004** (queue-steer-pause-resume) specifies: follow-ups during active runs default to queue; `pause` transitions to `paused` (not queue-drain); `resume` returns a paused run with the same run id; `interrupt` transitions through `interrupting` to `interrupted`; waiting states are distinct from paused; queue items support pre-admission cancellation. Default follow-up behavior is `queue`, default ordering is FIFO.

**ADR-003** (daemon-backed-queue-and-interventions) decides queue and intervention state lives in daemon-backed durable storage, rejecting client-side queuing and provider-native-only queuing.

**Driver Capability Interaction.** Spec 005 declares capability flags: `resume`, `steer`, `pause`, `interactive_requests`, `mcp`, `tool_calls`, `reasoning_stream`, `model_mutation`. If a driver does not advertise pause, the product defaults to queue and interrupt only. If steer is unsupported, the request is rejected or downgraded to a queue item.

### Signature Feature 5: Visibility (Live Timeline)

Coverage is **partial**. The reviewed documents cover the observability and health surfaces relevant to visibility but do not include Spec 006 (Session Event Taxonomy and Audit Log), which is the primary live timeline specification. That spec is referenced by multiple reviewed documents as a dependency but was not in the review set.

What these docs do cover for visibility:

**Spec 020** (observability-and-failure-recovery) specifies health signals at five layers: local daemon, provider drivers, replay state, queue state, and control-plane connectivity. Users and operators must distinguish transport failure, provider failure, local persistence failure, projection failure, and policy/approval blockage. Runtime health defaults to `healthy`, `degraded`, `blocked`. Stuck-run detection uses heartbeat and event-progress thresholds.

**Spec 015** (persistence-recovery-and-replay) specifies that canonical local execution data includes session events, queue state, approvals, runtime bindings, and command receipts. Replay must work without client memory.

**Event Model.** Spec 005 requires normalized event families: run lifecycle, assistant output, tool activity, interactive request, artifact publication, and usage/quota telemetry. Every intervention outcome must be visible in the canonical event stream (Spec 004).

---

## 2. Run State Machine Analysis

### Transition Completeness

The primary allowed transitions table in domain/run-state-machine.md lists 14 transitions. Several important transitions are missing or ambiguous:

**Missing: `starting -> failed`.** The "Edge Cases" section states "A run may fail from starting if workspace or provider initialization cannot complete" but this transition does not appear in the primary allowed transitions table. This is a spec defect: the normative table contradicts the edge-case prose.

**Missing: transitions INTO `recovering`.** The state machine defines 4 transitions OUT of `recovering` (`recovering -> running`, `recovering -> waiting_for_approval`, `recovering -> waiting_for_input`, `recovering -> failed`) but never specifies which states can transition TO `recovering`. The edge cases say "A daemon restarts during execution. The run enters recovering" but does not specify whether this applies only from `running`, or from all non-terminal states (`running`, `waiting_for_approval`, `waiting_for_input`, `paused`, `starting`). This must be resolved before implementation: the run engine needs an exhaustive list of states from which recovery entry is valid.

**Missing: interrupt from blocking states.** No `paused -> interrupting`, `waiting_for_approval -> interrupting`, or `waiting_for_input -> interrupting` transitions are listed. If a user wants to cancel a paused or blocked run, the state machine does not define the path. This is a critical gap for Feature 3 -- users must be able to cancel work that is waiting or paused.

**Missing: `starting -> interrupted`.** If a user interrupts a run that is still in setup, there is no defined path. Should it go `starting -> interrupting -> interrupted`?

### Error State Handling

Error states are handled through a layered model: one terminal `failed` state plus orthogonal failure categories and recovery conditions. This design is sound -- it avoids state explosion. Spec 020 adds derived health signals (`stuck-suspected`) and operator-facing failure detail. The model explicitly forbids creating new run states for each failure cause.

The `recovering` state is well-motivated but underspecified regarding entry conditions as noted above.

### Comparison Against Forge, CodexMonitor, and Paseo

Evidence drawn from the archived feature audits (`forge-feature-audit-report.md`, `codexmonitor-feature-audit-report.md`, and `paseo-repo-exploration/`).

**CodexMonitor** (Tauri app wrapping Codex `app-server`):
- Run lifecycle is a client-side projection of Codex thread state, not a daemon-owned state machine. There is no equivalent of `queued`, `starting`, `recovering`, or `paused` as canonical daemon states.
- "Pause" is queue-drain suspension only -- it pauses flushing queued follow-ups when Codex needs user input, not a true runtime pause of execution (Section 2.2 of the audit: "there is no true active-turn pause or unpause operation").
- "Resume" means re-read/reattach thread state from Codex, not continue a suspended turn (Section 2.3: "/resume and thread/resume do not mean resume a paused turn").
- Queue is client-local in-memory FIFO, not daemon-persisted (Section 2.1: "queue is a client feature, not a Codex server-side queue"; Section 9.2: "queue is local in-memory only").
- Steer uses `turn/steer` when an active turn exists; otherwise falls back to queueing.
- No `recovering` state; no daemon-startup recovery. Session persistence relies on Codex upstream.

**Forge** (Electron/web app with its own server daemon):
- Has a real server runtime with daemon mode, event sourcing, projections, provider recovery, and SQLite persistence (Section 6: "Event store and command receipts", "Recovery and reconciliation").
- Provider session orchestration supports start/send/interrupt/respond/stop/list/fork/rollback (Section 5: "Provider session orchestration").
- Has a CLI with explicit pause/resume/cancel commands (Section 5: "CLI can ... pause/resume/cancel").
- Has provider-level recovery: "Provider session recovery depends on persisted runtime bindings and usually a stored resume cursor; missing state does not silently recreate sessions" (Section 8).
- Provider registry aggregates Codex and Claude health/auth/version/model snapshots (Section 5: "Provider registry").
- Live timeline rendering with virtualization and orchestration event replay/recovery (Section 2: "Live timeline rendering", "Session recovery and replay").
- Workflow timeline with phase runs, iterations, transition states (Section 3: "Workflow timeline").
- No evidence of a canonical `recovering` state as defined in the ai-sidekicks run state machine; recovery appears to happen at the provider-session level during startup reconciliation.

**Paseo** (multi-provider daemon with AgentManager + Session architecture):
- Has the most mature normalized driver contract among the three. `AgentClient` and `AgentSession` interfaces define create/resume, start turn, stream history, list models/modes, manage permissions, persist handle, interrupt, close (Paseo exploration 09, "Common Contract").
- Provider adapters exist for Claude (SDK over spawned process), Codex (app-server over JSON-RPC), OpenCode (SDK over local server), and ACP family (stdio protocol). Custom providers plug in through `extends: "acp"` (Paseo exploration 06).
- Capability flags are normalized: streaming, session persistence, dynamic modes, MCP, reasoning streams, tool calls (Paseo exploration 09, "Capabilities Features And Functionality").
- `AgentManager` owns authoritative runtime model: sessions, timelines, permissions, lifecycle transitions, attention tracking (Paseo exploration 08, "AgentManager As The Shared Runtime Core").
- Run orchestration: rejects overlapping foreground runs, uses `replaceAgentRun()` for explicit replacement, has `waitForAgentRunStart()` and `waitForAgentEvent()` (Paseo exploration 08, "Run Orchestration And Wait Semantics").
- No evidence of a `paused` state or `recovering` state in the Paseo run lifecycle. The lifecycle appears simpler: running, idle, error, permission-needed. No daemon-backed queue model; follow-up handling appears to be at the session/client level.
- Identity wrapping for derived providers (`wrapSessionProvider`, `wrapClientProvider`) is more sophisticated than what the ai-sidekicks driver contract specifies (Paseo exploration 06, "Identity Wrapping And Compatibility").

**Implications for the ai-sidekicks state machine:**
1. The `paused` state and true pause/resume semantics are novel relative to all three implementations. None of the reference apps implement real runtime pause. This makes it critical to specify how `pauseRun` works at the driver level -- the spec is introducing behavior that does not exist upstream.
2. The `recovering` state is partially covered by Forge's startup reconciliation but is not formalized as a run state in any reference implementation. The ai-sidekicks formalization is more rigorous but must define entry transitions.
3. Daemon-backed queue persistence is partially implemented in Forge (event store, command receipts) but not as a first-class queue model. CodexMonitor and Paseo use client-side or session-level queueing. The ai-sidekicks queue model is more ambitious than any reference.
4. The normalized driver contract in ai-sidekicks is closest to Paseo's `AgentClient`/`AgentSession` interface, but Paseo's contract is richer in some areas (slash commands, thinking-option mutation, dynamic mode switching) and does not include `pauseRun` or `steerRun`.
5. Forge is the only reference with explicit CLI-level pause/resume/cancel verbs, making it the closest validation target for Feature 3.

---

## 3. Provider Driver Contract

### Interface Specification

Spec 005 defines 9 required driver operations:
- `createSession`, `resumeSession`, `startRun`, `interruptRun`, `respondToRequest`, `closeSession`, `listModels`, `listModes`, `getCapabilities`

And 8 required capability flags:
- `resume`, `steer`, `pause`, `interactive_requests`, `mcp`, `tool_calls`, `reasoning_stream`, `model_mutation`

### Critical Gap: Missing Operations for Declared Capabilities

The contract declares capability flags for `pause` and `steer` but defines no corresponding driver operations. There is no `pauseRun` operation and no `steerRun` operation. This creates an implementability gap: the runtime can check whether a driver supports pause and steer, but has no defined method to invoke those behaviors.

Similarly, `mcp`, `tool_calls`, and `reasoning_stream` are capability flags but have no explicit driver operations. The `respondToRequest` operation may cover `interactive_requests` but this mapping is not documented.

The contract needs either:
- Additional operations (`pauseRun`, `steerRun`, etc.), or
- Explicit documentation that existing operations subsume these (e.g., "steer is delivered through `respondToRequest` with intervention payload"), or
- A generic operation like `applyIntervention` that handles capability-specific control actions

### Codex vs Claude Differences

Spec 005 calls out key differences through examples:
- Codex driver: "starts a session through its native transport, exposes resume and steer capability"
- Claude driver: "calls a remote provider API from the participant's runtime node"

The spec correctly identifies that Claude's driver calls remote APIs while Codex may use local transports, but driver authority stays local in both cases. However, the spec does not enumerate which capability flags each driver is expected to support. Plan 005 says both drivers are built "against the contract" but does not include a capability matrix showing expected coverage.

### Capability Negotiation and Fallbacks

Well specified. Undeclared capabilities are treated as unsupported (Spec 005 "Required Behavior"). Fallback behavior is explicit:
- Unsupported pause: offer queue and interrupt only (Spec 004 "Default Behavior")
- Unsupported steer: reject or downgrade to queue item (Spec 004 "Fallback Behavior")
- Failed resume: surface `provider failure` and `recovery-needed`, do not silently replace (Spec 005 "Fallback Behavior")
- Unsupported model mutation: require new run or agent config (Spec 005 "Fallback Behavior")

Capability refresh is specified as "bounded periodic cadence" with optional live push (Spec 005 "Open Questions"). Correctness must not depend on push-only updates.

### Resume Handle Persistence

Well specified. Resume handles are stored separately from canonical session/run ids (Spec 005 "Required Behavior"). Runtime bindings store driver name, contract version, resume handle, and recovery metadata (Spec 005 "State And Data Implications"). Recovery prefers adopting existing live provider sessions before using stored handles (Spec 015 "Default Behavior").

---

## 4. Queue/Intervention Model

### Daemon-Backed Queue

Fully specified at the semantic level. ADR-003 decides the daemon owns queue truth. Spec 004 requires:
- `QueueItemCreate`, `QueueItemList`, `QueueItemCancel` against runtime-owned durable state
- Default follow-up while active run is `queue`
- FIFO ordering within scheduling scope
- Queue items require durable storage and ordering metadata
- Queue persistence unavailable -> reject new queue creation (no silent client-memory fallback)

### How Steer Differs From a New Message

Steer is defined as an intervention that injects content or direction into an already-running execution, as opposed to queuing a new work item. Key distinctions from domain/queue-and-intervention-model.md:
- An Intervention targets a Run or QueueItem; a new message would create a QueueItem
- Steer requires the target run to advertise steer capability
- If steer capability is absent, the intervention is rejected or explicitly degraded to a new queue item (Spec 004 "Fallback Behavior")

However, the mechanics of steer injection are underspecified. There is no `steerRun` driver operation (see Section 3 above). The domain model says an Intervention can target "a Run, a QueueItem, or the session scheduler" but does not describe the payload shape for steer vs pause vs interrupt interventions.

### How Pause Persists

Spec 004 states: "pause must transition a run into paused; it must not mean queue-drain suspension or blocked waiting." The paused state is part of the durable run state machine. Since the daemon owns run state and persists it to SQLite (Spec 015), a paused run survives daemon restart.

Spec 004 "Fallback Behavior" addresses the edge case: "If a paused run cannot be resumed because driver state is lost, the system must transition it through recovery logic and then to failed or interrupted; it must not pretend the same run resumed."

### How Resume Recovers State

Resume is valid only from `paused` (domain/run-state-machine.md "Invariants"). The spec requires that resume operates on the same run id with the same run history (Spec 004 "Acceptance Criteria"). Recovery uses driver resume handles stored in runtime bindings (Spec 015). Recovery attempts: (1) projection rebuild from canonical events, (2) runtime binding restoration, (3) resumption or explicit failure transition.

The distinction between "resume from paused" and "recovery after restart" is well drawn: `resume` is a user-initiated action from `paused` to `running`; `recovering` is an automatic daemon-initiated action after restart that can target any in-flight state.

---

## 5. Spec Completeness

### Spec 003 (Runtime Node Attach)
**Sufficient for implementation.** Node identity, capabilities, health, attach/detach/reconnect are all specified. Interfaces are named. Fallback for degraded and offline states is clear. V1 limits (one session per node) are stated.

### Spec 004 (Queue Steer Pause Resume)
**Mostly sufficient, with gaps.** Queue semantics, pause/resume contract, and intervention outcomes are well specified. Gaps: (1) steer injection mechanics are not specified at the driver operation level, (2) the intervention request payload shape is underspecified (target id, type, initiator, scope -- but no concrete payload schemas), (3) queue priority overrides are deferred but FIFO-only may be insufficient for steer-then-queue workflows.

### Spec 005 (Provider Driver Contract)
**Mostly sufficient, with a critical gap.** The 9 driver operations and 8 capability flags are listed. Normalized event families are named. Resume handle persistence is specified. Critical gap: no driver operations for pause and steer despite declaring them as capabilities (see Section 3).

### Spec 010 (Worktree Lifecycle)
**Sufficient for implementation.** Four execution modes are well specified. Lifecycle states, fallback behavior, and branch naming are clear. V1 limits (no auto-setup scripts) are stated.

### Spec 015 (Persistence Recovery and Replay)
**Sufficient for implementation.** SQLite with WAL, recovery ordering, replay contracts, and fallback to degraded read-only mode are specified. Snapshot compaction is explicitly deferred.

### Spec 020 (Observability and Failure Recovery)
**Sufficient for implementation.** Health categories, failure categories, stuck-run detection, degraded modes, and bounded diagnostic retention are specified. Automated retry policy is deferred to a "bounded policy across providers."

---

## 6. Plan Completeness

### All Plans: Common Issues

- **ADR preconditions are unmet.** All three ADRs (002, 003, 005) remain at status `proposed`. Every plan lists "Required ADRs are accepted" as an unchecked precondition. This is a real blocker -- no plan can formally proceed.
- **Cross-plan dependencies are not declared.** Plan 004 depends on Plan 005 (driver capabilities) for capability-aware controls, but this is unstated. Plan 020 depends on Plan 015 (persistence) for canonical event truth, but this is also unstated. Plan 003 (runtime node attach) is a prerequisite for Plans 004 and 005 but is not declared.

### Plan 003 (Runtime Node Attach)
**Concrete.** 4 implementation steps, 6 target areas, parallel work identified (local registry and control-plane services). Rollout order is sequential and reasonable. Missing: estimated scope or sizing.

### Plan 004 (Queue Steer Pause Resume)
**Concrete.** 4 implementation steps, 6 target areas. Rollout phases wisely start with read-only queue visibility. Risk of "provider capability mismatch" is identified. Missing: explicit dependency on Plan 005 for capability checks; no mention of the missing steer/pause driver operations.

### Plan 005 (Provider Driver Contract)
**Concrete.** 4 implementation steps. Two initial drivers (Codex, Claude) built in parallel. Recovery tests are called out. Risk of "contract churn while both drivers are under construction" is honestly flagged. Missing: capability matrix for each driver; no driver operation gap acknowledgment for pause/steer.

### Plan 010 (Worktree Lifecycle)
**Concrete.** 4 implementation steps. Ephemeral clone cleanup risk is flagged. Failure-path tests explicitly include "no silent main-checkout mutation." Missing: no sizing or scope estimate.

### Plan 015 (Persistence Recovery and Replay)
**Concrete.** 4 implementation steps. Snapshot compaction risk is flagged ("may affect rebuild performance"). Rollout wisely gates mutable work admission on successful recovery. Missing: no sizing; no explicit dependency on Plan 005 for runtime binding schema.

### Plan 020 (Observability and Failure Recovery)
**Concrete.** 5 implementation steps (the most of any plan). Bounded-retention handling is an explicit step. Stuck-run detection tests include false-positive suppression. Missing: no sizing; cross-plan dependency on Plan 015 is unstated.

---

## 7. Internal Consistency

### Contradictions and Mismatches

**State machine transition table vs edge cases.** `starting -> failed` is described in edge cases but absent from the primary transition table (domain/run-state-machine.md). The transition table is the normative reference and must be corrected.

**Intervention states diverge between domain model and spec.** The domain model (queue-and-intervention-model.md "State Model") defines 5 intervention states: `requested`, `accepted`, `applied`, `rejected`, `expired`. Spec 004 "Interfaces And Contracts" says `InterventionResult` must distinguish `accepted`, `applied`, `rejected`, and `degraded`. The domain model has `expired` but not `degraded`; the spec has `degraded` but not `expired`. Neither document acknowledges the other's deviation.

**Capability flags without operations.** Spec 005 declares 8 capability flags including `pause` and `steer`, but its 9 required driver operations include no `pauseRun` or `steerRun`. The spec's "Required Behavior" and "Interfaces And Contracts" sections contradict each other in scope.

### Term Drift

**"Intervention" vs "InterventionResult" vs "InterventionRequest."** The domain model uses `Intervention` as the top-level entity with its own lifecycle. Spec 004 introduces `InterventionRequest` and `InterventionResult` as the contract interfaces. These should align: is the domain entity the Request, the Result, or both? The domain model implies both are part of one `Intervention` record; the spec implies they are separate messages.

**"Runtime binding" usage.** Spec 005 uses "runtime binding" to mean the association between a driver and a canonical run. Spec 015 uses "runtime binding" in the same sense but extends it to include resume handles and recovery metadata. These are consistent but the term is not defined in any domain model document -- it should be.

### Entity Alignment

The entity graph is consistent across documents:
- Participant -> RuntimeNode -> Agent -> Run (domain/runtime-node-model.md)
- QueueItem -> Run (domain/queue-and-intervention-model.md)
- Intervention -> Run or QueueItem (domain/queue-and-intervention-model.md)
- Run states, queue states, and intervention states are non-overlapping

No entity naming conflicts were found. The main alignment risk is the intervention state divergence noted above.

---

## 8. Open Questions and Critical Gaps

### Must Resolve Before Implementation

1. **Complete the state machine transition table.** Add `starting -> failed`. Define which states can transition to `recovering`. Add `paused -> interrupting`, `waiting_for_approval -> interrupting`, `waiting_for_input -> interrupting` (or document why interrupt from these states is not supported).

2. **Add driver operations for pause and steer.** The contract declares capabilities it has no methods to exercise. Either add `pauseRun` and `steerRun` operations, or document which existing operations carry these semantics.

3. **Accept the ADRs.** All three ADRs (002, 003, 005) are `proposed`. Every plan is blocked on "Required ADRs are accepted." Assign reviewers and finalize.

4. **Reconcile intervention states.** The domain model has `expired`; the spec has `degraded`. One or both documents must be updated so the intervention lifecycle is unambiguous.

5. **Declare cross-plan dependencies.** Plan 004 needs Plan 005 (capabilities). Plan 020 needs Plan 015 (persistence). Plan 003 is a prerequisite for all. This ordering must be explicit.

### Should Resolve Before Implementation

6. **Define a Codex/Claude capability matrix.** Plan 005 builds two drivers but does not say which capabilities each will support. Implementers need to know which flags are `true` for Codex and which for Claude.

7. **Add "runtime binding" to the domain glossary.** The term is used by two specs and one plan but has no domain-model definition.

8. **Specify intervention payload shapes.** `InterventionRequest` says "target id, intervention type, initiator, requested scope" but does not define the payload for each intervention type (steer content, pause reason, etc.).

9. **Include Spec 006 (Session Event Taxonomy) in Feature 5 review.** The live timeline is Feature 5's core surface. These documents cover health and observability but not the event taxonomy that feeds the timeline.

### Deferred but Tracked

10. **Queue priority overrides** -- explicitly deferred in Spec 004.
11. **Snapshot compaction cadence** -- explicitly deferred in Spec 015.
12. **Automated retry budgets per driver** -- explicitly deferred in Spec 020 (single bounded policy for v1).
13. **Multi-session node sharing** -- explicitly deferred in Spec 003.
14. **Shared hosted execution drivers** -- explicitly deferred in Spec 005.

---

## Summary

The documentation set is well-structured and internally disciplined. The run state machine, queue/intervention model, driver contract, persistence/recovery, and observability specs form a coherent system design. The key principle -- execution stays local, control plane coordinates, daemon owns runtime truth -- is consistently applied across all documents.

The critical gaps are concentrated in three areas: (1) the state machine transition table is incomplete for entry into `recovering`, exit from blocking states via interrupt, and `starting -> failed`; (2) the driver contract declares pause and steer capabilities but provides no corresponding operations; (3) the ADRs blocking all plans remain unaccepted. These are not design flaws -- they are specification gaps that must be closed before implementation can proceed safely.
