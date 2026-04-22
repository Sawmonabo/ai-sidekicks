# BL-097 Pass F — Event Taxonomy for the V1 Workflow Engine

**Date:** 2026-04-22
**Pass:** F (Wave 2) — Event taxonomy + observability
**Question:** What event categories, types, payloads, ordering invariants, and security rules must the V1 workflow engine emit to integrate cleanly with Spec-006 while supporting the Wave-1-pinned contract (parallel execution, OWN-only multi-agent, human phase with typed timeout, immutable outputs, append-only approval log)?
**Audience:** Spec-006 amendment author, Spec-017 rewrite owner, Pass G persistence model author, Pass H test-strategy author.

**Framing constraints carried in from Wave 1 synthesis (2026-04-22):**
- All events emit as envelope `EventEnvelope{id, sessionId, sequence, occurredAt, category, type, actor, correlationId, causationId, version, payload}` (Spec-006 §EventEnvelope). This pass defines **payload shape per type + category assignment**, not a new envelope.
- `parent_event_id` in the task prompt maps to the envelope's existing `causationId` — no new correlation primitive is introduced. `workflow_run_id` and `phase_run_id` are *payload* fields.
- New event-type introductions are additive under ADR-018 §Decision #11 and ship as a MINOR version bump of the envelope (`EventEnvelope.version = "1.1"` at workflow-engine landing).
- Unknown-to-receiver workflow types are accepted and stubbed per ADR-018; receivers below `1.1` persist workflow events as version stubs, do not crash.

---

## §1 Event Category Hierarchy

Four new categories are introduced. All live under the `workflow.*` type namespace (reverse-DNS prefixed per CloudEvents §3.1.1 convention — see §6). Categories group events by **audit/query scope**, matching Spec-006's existing pattern (e.g. `run_lifecycle` vs. `approval_flow` vs. `cross_node_dispatch`).

| New Category | Scope | Types in category |
|---|---|---|
| `workflow_lifecycle` | A single workflow *run* — from `WorkflowRunCreate` through terminal state. | `workflow.created`, `workflow.started`, `workflow.gated`, `workflow.resumed`, `workflow.completed`, `workflow.failed` |
| `workflow_phase_lifecycle` | A single phase *run* inside a workflow run — from admission through terminal. Covers retries as distinct phase-run identities (see §3). | `workflow.phase_waiting_on_pool`, `workflow.phase_admitted`, `workflow.phase_started`, `workflow.phase_progressed`, `workflow.phase_suspended`, `workflow.phase_resumed`, `workflow.phase_cancelling`, `workflow.phase_retried`, `workflow.phase_completed`, `workflow.phase_failed`, `workflow.human_phase_claimed`, `workflow.human_phase_escalated` |
| `workflow_parallel_coordination` | Cross-sibling coordination under `ParallelJoinPolicy` (SA-4). | `workflow.parallel_join_cancellation` |
| `workflow_channel_coordination` | The `multi-agent` phase ↔ Spec-016 channel boundary (OWN-only V1, SA-6). | `workflow.channel_created_for_phase`, `workflow.channel_closed_with_records_preserved`, `workflow.channel_terminated_forcibly` |
| `workflow_gate_resolution` | Phase-boundary gate resolutions (SA-7). Distinct from `approval_flow` because the scope is a phase transition, not an in-run approval request. | `workflow.gate_resolved` |

**Namespace tree:**
```
workflow.*                               (reserved root)
├── workflow.created
├── workflow.started
├── workflow.gated
├── workflow.resumed
├── workflow.completed
├── workflow.failed
├── workflow.phase_waiting_on_pool
├── workflow.phase_admitted
├── workflow.phase_started
├── workflow.phase_progressed
├── workflow.phase_suspended
├── workflow.phase_resumed
├── workflow.phase_cancelling
├── workflow.phase_retried
├── workflow.phase_completed
├── workflow.phase_failed
├── workflow.human_phase_claimed
├── workflow.human_phase_escalated
├── workflow.parallel_join_cancellation
├── workflow.channel_created_for_phase
├── workflow.channel_closed_with_records_preserved
├── workflow.channel_terminated_forcibly
└── workflow.gate_resolved
```

**Why five categories, not one.** Spec-006's existing categories (`run_lifecycle`, `approval_flow`, `membership_change`, `cross_node_dispatch`) each correspond to a distinct *replay projection* — a reader rebuilding the run timeline reads `run_lifecycle`; a reader rebuilding the approval audit reads `approval_flow`. Collapsing all workflow events into a single `workflow_lifecycle` category would force every projection reader to filter by type prefix. Splitting by *scope-of-query* matches the Spec-006 pattern and keeps Pass G's replay-projection design simple (one SQL index per category).

---

## §2 Per-Event Payload Schemas

**Preamble.** Every event's payload is the value of `EventEnvelope.payload`. Envelope fields (`id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `correlationId`, `causationId`, `version`) are always present and never restated in payload. Types use TypeScript-style notation; `Iso8601Timestamp`, `Duration`, `ArtifactId`, `ParticipantId`, `ChannelId`, `ApprovalRequestId`, `RunId` refer to existing Spec-006 / Spec-017 / Spec-012 primitives.

### 2.1 `workflow_lifecycle` Category

**Base payload (all events in this category):**
```ts
type WorkflowLifecycleBase = {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;       // stable identity for the run
  workflowDefinitionId: WorkflowDefinitionId;
  workflowDefinitionVersion: string;  // semver from schema marker (SA-14)
  schemaVersion: string;              // ai-sidekicks-schema version (C-8)
};
```

| Type | Payload (base + extension) | Required fields |
|---|---|---|
| `workflow.created` | `base + {createdBy: ParticipantId, inputRef?: ArtifactId}` | all |
| `workflow.started` | `base + {startedAt: Iso8601Timestamp, maxPhaseTransitions: number, maxDuration: Duration}` | all; `maxPhaseTransitions` / `maxDuration` echo SA-1/SA-2 |
| `workflow.gated` | `base + {gateResolutionEventId: EventId}` (points to the `workflow.gate_resolved` event that blocked the run) | all |
| `workflow.resumed` | `base + {resumedAt: Iso8601Timestamp, recoveryId?: RecoveryId}` | base + `resumedAt`; `recoveryId` present only when resume followed a daemon restart (Spec-015 recovery) |
| `workflow.completed` | `base + {completedAt: Iso8601Timestamp, outputRef?: ArtifactId, phaseTransitionCount: number, totalDuration: Duration}` | base + `completedAt` + `phaseTransitionCount` + `totalDuration`; `outputRef` optional per workflow definition |
| `workflow.failed` | `base + {failedAt: Iso8601Timestamp, failureCategory: 'definition_cap_exceeded' \| 'duration_cap_exceeded' \| 'phase_failure' \| 'gate_denial' \| 'system_error', failureDetail: string, failingPhaseRunId?: PhaseRunId, causingGateResolutionEventId?: EventId}` | all; `failingPhaseRunId` present for `phase_failure`, `causingGateResolutionEventId` for `gate_denial` |

**Example (`workflow.started`):**
```json
{
  "sessionId": "ses_01HQZ...",
  "workflowRunId": "wfr_01HQZ...",
  "workflowDefinitionId": "wfd_01HQZ...",
  "workflowDefinitionVersion": "1.4.0",
  "schemaVersion": "1.0",
  "startedAt": "2026-04-22T14:12:00.123Z",
  "maxPhaseTransitions": 100,
  "maxDuration": "PT24H"
}
```

### 2.2 `workflow_phase_lifecycle` Category

**Base payload (all events in this category):**
```ts
type WorkflowPhaseLifecycleBase = {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  phaseRunId: PhaseRunId;            // unique per attempt — retry creates new id (see §3)
  phaseDefinitionId: PhaseDefinitionId;
  phaseType: 'single-agent' | 'automated' | 'multi-agent' | 'human';
  attemptNumber: number;             // 1-indexed; >1 only when this is a retry
};
```

| Type | Payload extension | Required |
|---|---|---|
| `workflow.phase_waiting_on_pool` | `base + {pool: 'pty_slots' \| 'agent_memory_mb', requestedCapacity: number, poolFreeCapacity: number, waitingSinceSeq: number}` | all; `waitingSinceSeq` = first sequence at which phase became blocked |
| `workflow.phase_admitted` | `base + {admittedAt: Iso8601Timestamp, pools: Array<{pool: string, consumed: number}>}` | all; `pools` records resource-pool consumption committed at admission (SA-3) |
| `workflow.phase_started` | `base + {startedAt: Iso8601Timestamp, executorId?: ExecutorId}` | base + `startedAt` |
| `workflow.phase_progressed` | `base + {progressedAt: Iso8601Timestamp, progressMarker: string, progressPayload?: {turnCount?: number, tokenCount?: number}}` | base + `progressedAt` + `progressMarker`; `progressPayload` optional per phase type |
| `workflow.phase_suspended` | `base + {suspendedAt: Iso8601Timestamp, reason: 'waiting-human' \| 'waiting-gate' \| 'waiting-pool' \| 'waiting-subresource' \| 'author-directed'}` | all |
| `workflow.phase_resumed` | `base + {resumedAt: Iso8601Timestamp, suspendedByEventId: EventId}` | all; must reference a prior `workflow.phase_suspended` via envelope `causationId` AND payload `suspendedByEventId` |
| `workflow.phase_cancelling` | `base + {cancellingAt: Iso8601Timestamp, cancellationReason: 'sibling_failure' \| 'workflow_failure' \| 'author_directed' \| 'parent_cancel'}` | all |
| `workflow.phase_retried` | `base + {retriedAt: Iso8601Timestamp, priorPhaseRunId: PhaseRunId, retryCount: number, retryReason: 'phase_failure' \| 'go_back_to'}` | all; `retryCount` = attempt number of the new phase-run (≥2) |
| `workflow.phase_completed` | `base + {completedAt: Iso8601Timestamp, outputRef?: ArtifactId, durationMs: number}` | base + `completedAt` + `durationMs`; `outputRef` mandatory for phase types that produce output per C-9 |
| `workflow.phase_failed` | `base + {failedAt: Iso8601Timestamp, failureKind: 'agent_error' \| 'tool_error' \| 'validation_error' \| 'timeout' \| 'cancellation', cancellationReason: 'sibling_failure' \| null, detail: string}` | all; `cancellationReason` is **non-null only when** `failureKind == 'cancellation'` (SA-4 parallel-join scenario) |
| `workflow.human_phase_claimed` | `base + {claimedAt: Iso8601Timestamp, claimedBy: ParticipantId}` | all; `phaseType` must equal `'human'` |
| `workflow.human_phase_escalated` | `base + {escalatedAt: Iso8601Timestamp, escalationReason: 'timeout_behavior', timeoutBehavior: 'fail' \| 'continue' \| 'escalate', dueAt?: Iso8601Timestamp}` | all; **telemetry-only in V1 per SA-11** — no notification routing. `timeoutBehavior` mirrors `HumanPhaseConfig.timeoutBehavior`. Receivers MUST NOT wire downstream notification handlers to this event until the V1.x notification-routing primitive ships. |

**Example (`workflow.phase_failed` under sibling cancel):**
```json
{
  "sessionId": "ses_01HQZ...",
  "workflowRunId": "wfr_01HQZ...",
  "phaseRunId": "phr_01HQZ...",
  "phaseDefinitionId": "phd_parallel_branch_B",
  "phaseType": "automated",
  "attemptNumber": 1,
  "failedAt": "2026-04-22T14:17:03.441Z",
  "failureKind": "cancellation",
  "cancellationReason": "sibling_failure",
  "detail": "Cancelled by ParallelJoinPolicy=fail-fast after sibling phd_parallel_branch_A failed at seq=4102"
}
```

### 2.3 `workflow_parallel_coordination` Category

| Type | Payload |
|---|---|
| `workflow.parallel_join_cancellation` | `{sessionId, workflowRunId, parallelJoinId: JoinId, joinPolicy: 'fail-fast' \| 'all-settled' \| 'any-success', triggeringPhaseRunId: PhaseRunId, triggeringOutcome: 'failed' \| 'succeeded', cancelledSiblingPhaseRunIds: PhaseRunId[], cancelledAt: Iso8601Timestamp}` |

**Why one event with a list, not N events.** The Temporal cautionary tale from Pass A §1.4 ([temporalio/sdk-java#902](https://github.com/temporalio/sdk-java/issues/902)) shows sibling-cancel bookkeeping must land at a *deterministic* synchronous checkpoint. A single event with `cancelledSiblingPhaseRunIds: PhaseRunId[]` records the full cancellation decision atomically at the tick boundary; N independent events would let the cancellation decision smear across ticks and reopen the replay-nondeterminism class. Each sibling's own `workflow.phase_cancelling` and subsequent `workflow.phase_failed` (with `cancellation_reason: 'sibling_failure'`) still fire — this event is the *coordinator's* record of the decision, not a substitute for per-sibling events. Temporal's Event History pattern of "one semantic decision = one event, downstream consequences = downstream events" (see §6 §Temporal reference) applies.

### 2.4 `workflow_channel_coordination` Category

**Base payload:**
```ts
type WorkflowChannelCoordinationBase = {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  phaseRunId: PhaseRunId;
  channelId: ChannelId;              // references Spec-006 channel.* events
};
```

| Type | Payload extension | Required |
|---|---|---|
| `workflow.channel_created_for_phase` | `base + {createdAt: Iso8601Timestamp, ownership: 'OWN', turnPolicy: 'round-robin' \| 'free-form' \| 'request-based', turnBudgetMax: number, membershipParticipants: ParticipantId[]}` | all. `ownership: 'OWN'` is the only valid value in V1 per SA-6 (BIND deferred to V1.1). **References** the corresponding Spec-006 `channel.created` event via `channelId` and `causationId`. |
| `workflow.channel_closed_with_records_preserved` | `base + {closedAt: Iso8601Timestamp, reason: 'phase_completed' \| 'phase_failed' \| 'author_directed', finalTurnCount: number}` | all. Default V1 termination per SA-9. Paired Spec-006 `channel.archived` fires separately from Spec-006's channel lifecycle. |
| `workflow.channel_terminated_forcibly` | `base + {terminatedAt: Iso8601Timestamp, reason: 'phase_failure_request_cancel' \| 'workflow_failure' \| 'author_directed_terminate', graceWindowMs: number, forciblyClosedAfter: 'grace_expired' \| 'immediate'}` | all. `REQUEST_CANCEL` with 30 s grace per SA-9 is represented here when the grace expired and hard termination fired. |

**Why workflow-channel events in addition to Spec-006 channel events.** Spec-006 `channel.created` / `channel.archived` describe the *channel's lifecycle as seen by Spec-016*. The workflow-channel events describe *phase ownership of that channel* — they carry `phaseRunId` and the ownership semantic, which Spec-006 events don't. Readers reconstructing "which channel did phase X own?" need the workflow-channel view; readers reconstructing "which channels exist in the session?" use Spec-006. Two categories, two projections; no duplication because each event carries distinct semantic payload.

### 2.5 `workflow_gate_resolution` Category

| Type | Payload |
|---|---|
| `workflow.gate_resolved` | `{sessionId, workflowRunId, phaseRunId?: PhaseRunId, gateDefinitionId: GateDefinitionId, scope: 'channel-turn' \| 'workflow-phase', outcome: 'approved' \| 'rejected' \| 'expired', approvalRequestId: ApprovalRequestId, approver?: ParticipantId, resolvedAt: Iso8601Timestamp, rememberedScope?: string, rationaleRef?: ArtifactId}` |

**Cross-reference discipline.** `workflow.gate_resolved` references the underlying Spec-006 `approval.approved` / `approval.rejected` / `approval.expired` event via `approvalRequestId` (matching the field on `approval_flow` payloads). It does **not** restate the approval decision — it records the *gate-resolution event* in workflow-scope terms. Two readers:
- Audit reader (compliance): reads `approval_flow` for the full approval audit trail per C-13 / I7.
- Workflow timeline reader: reads `workflow_gate_resolution` to know when a workflow unblocked and which phase-boundary was cleared, without needing to understand approval semantics.

`scope: 'channel-turn'` fires per-turn inside a `multi-agent` phase (Spec-016 moderation hook approvals). `scope: 'workflow-phase'` fires at phase-boundary per Pass B §3.2 temporally-disjoint gate-scoping contract (SA-7). `phaseRunId` is present for `workflow-phase` scope; optional for `channel-turn` because the relevant run identity is carried on the Spec-006 `approval.*` companion event.

---

## §3 Ordering Invariants

Ordering invariants are enforced **per envelope `sequence`** within a session. The envelope's `causationId` chain enforces cross-event provenance. Violations are bugs — readers SHOULD surface an integrity alarm but MUST NOT crash, per Spec-006 §Fallback Behavior.

### 3.1 Per-workflow-run lifecycle chain

```
workflow.created          (exactly 1)
  → workflow.started      (exactly 1)
    → [workflow.gated → workflow.resumed]*  (0..N balanced pairs; gated references a gate_resolved event)
    → workflow.completed  XOR  workflow.failed  (exactly 1 terminal)
```

Balanced constraint: every `workflow.gated` MUST be followed by exactly one `workflow.resumed` OR `workflow.failed` in the same workflow run. No orphan `workflow.resumed` without a prior `workflow.gated`.

### 3.2 Per-phase-run lifecycle chain (single attempt)

```
[workflow.phase_waiting_on_pool]*            (0..N; optional diagnostic — fires when phase is ready but blocked on resource pool; can fire multiple times on different pools)
  → workflow.phase_admitted                  (exactly 1)
    → workflow.phase_started                 (exactly 1)
      → [workflow.phase_progressed]*         (0..N; phase-type-specific progress markers)
      → [workflow.human_phase_claimed]*      (0..1; human phase only, informational)
      → [workflow.phase_suspended → workflow.phase_resumed]*   (0..N balanced pairs)
      → [workflow.human_phase_escalated]*    (0..N; only on human phase, triggered by timeoutBehavior)
      → [workflow.phase_cancelling]?         (0..1; if fired, terminal MUST be phase_failed with failureKind='cancellation')
      → workflow.phase_completed  XOR  workflow.phase_failed   (exactly 1 terminal)
```

**Key rules:**
1. `phase_admitted` MUST precede `phase_started` — scheduling admission is a distinct tick from launch, matching Pass A §3.3 pull-based admission model. This lets operators distinguish "blocked on pool" from "launched and failed."
2. `phase_waiting_on_pool` is *informational* — its absence does not imply the phase was never blocked; its presence is a guaranteed signal when blockage exceeds 100 ms (pass-G threshold, see §7 Open Question).
3. `phase_cancelling` → `phase_failed` ordering is mandatory when `cancellation_reason != null`. A `phase_failed` with `failureKind: 'cancellation'` without a prior `phase_cancelling` is an invariant violation.
4. `phase_suspended` and `phase_resumed` MUST come in balanced pairs; envelope `causationId` on `phase_resumed` MUST point to the paired `phase_suspended`.
5. Terminal events (`phase_completed` / `phase_failed`) are exclusive — exactly one fires per `phaseRunId`.

### 3.3 Retry — new phase-run identity, not same identity with attempt counter

**Decision:** retries produce a new `phaseRunId`. The `workflow.phase_retried` event fires in the *new* phase-run's chain, carries `priorPhaseRunId` referencing the failed attempt, and `attemptNumber: 2+` on both the `phase_retried` and subsequent events for that retry.

**Rationale:**
- Temporal's convention: every retry of a Workflow produces a new `runId` (same `workflowId`, new `runId`). Event History is per-`runId`. Cited at [docs.temporal.io/encyclopedia/event-history](https://docs.temporal.io/encyclopedia/event-history). Replays over a single `runId` are deterministic; retries are replayable independently.
- Immutable outputs (C-9) require that each attempt's output has distinct identity. Sharing `phaseRunId` across attempts would make `outputRef` on `phase_completed` ambiguous.
- Pass G persistence — normalizing `workflow_phase_states` by `phaseRunId` is trivial; tracking retry as attempt-counter-on-same-row requires compound keys and makes parallel-phase partial-completion harder to reason about.
- Trade-off: readers reconstructing "all attempts of phase definition X" must index by `(workflowRunId, phaseDefinitionId)` rather than by `phaseRunId`. This is a trivial SQL index in Pass G.

### 3.4 Parallel-join cancellation chain

```
workflow.phase_failed (triggering sibling; e.g. branch A)   seq=N
  → workflow.parallel_join_cancellation                     seq=N+1   (causationId = branch A's phase_failed)
    → workflow.phase_cancelling (branch B)                  seq=N+2   (causationId = parallel_join_cancellation)
    → workflow.phase_cancelling (branch C)                  seq=N+3   (causationId = parallel_join_cancellation)
    → workflow.phase_failed (branch B, cancellation_reason='sibling_failure')  (causationId = branch B's phase_cancelling)
    → workflow.phase_failed (branch C, cancellation_reason='sibling_failure')  (causationId = branch C's phase_cancelling)
```

`parallel_join_cancellation` MUST precede every sibling's `phase_cancelling`. This enforces Pass A §3.4's "deterministic tick checkpoint" guarantee — every sibling cancel is a downstream event of the coordinator decision, not a peer.

### 3.5 Channel-coordination chain (OWN-only V1)

```
workflow.phase_admitted (multi-agent phase)
  → channel.created (Spec-006; emitted first by channel-creation path)
  → workflow.channel_created_for_phase (causationId = Spec-006 channel.created)
  → workflow.phase_started
  → ... (channel turn activity via Spec-006 and Spec-016 events) ...
  → workflow.phase_completed  OR  workflow.phase_failed
    → workflow.channel_closed_with_records_preserved  (default per SA-9)
       OR workflow.channel_terminated_forcibly       (after 30 s grace expired per SA-9)
    → channel.archived (Spec-006; emitted by channel-archive path)
```

Pairing rule: every `workflow.channel_created_for_phase` MUST be followed by either `workflow.channel_closed_with_records_preserved` or `workflow.channel_terminated_forcibly` before the workflow run terminates.

### 3.6 `workflow.human_phase_escalated` ordering

Fires at or after `dueAt` is reached AND before any subsequent `phase_completed` / `phase_failed`. MAY fire multiple times if `timeoutBehavior == 'continue'` (periodic re-escalation). MUST NOT fire before `workflow.phase_started`.

---

## §4 Spec-006 Alignment Verification

### 4.1 Namespace collision check

| Workflow event namespace | Collision with existing Spec-006 category? | Resolution |
|---|---|---|
| `workflow.*` (all new) | No — Spec-006 has no `workflow.*` prefix. | Clean root reservation. |
| `workflow.channel_*` payload references | References `channelId` from Spec-006 `channel.created`. | No collision — distinct event types, shared identifier. |
| `workflow.gate_resolved` | Cross-references `approval.approved/.rejected/.expired` via `approvalRequestId`. | No collision — distinct category; shared identifier enforces cross-reference discipline. |
| `workflow.phase_failed.failureKind` enum | Distinct from `run_lifecycle.failureCategory` (Spec-006 line 176). | Named differently (`failureKind` vs. `failureCategory`) so projections treat them as separate enums; phase failure is distinct from run failure. |

**No collision with `presence.*`, `run.*`, `approval.*`, `membership.*`, `session.*`, `channel.*`, `arbitration.*`, `queue_item.*`, `intervention.*`, `tool.*`, `assistant.*`, `repo.*`, `workspace.*`, `worktree.*`, `artifact.*`, `diff.*`, `pr.*`, `usage.*`, `onboarding.*`, `runtime_node.*`, `recovery.*`, `dispatch.*`.** Workflow events are on a disjoint `workflow.*` root.

### 4.2 New categories added to Spec-006 registry

Spec-006 §Event Type Enumeration must be amended to append five new category sections. Proposed ordering: after §Approval Flow, before §Repo, Workspace, and Worktree Lifecycle — keeps "run-scope" categories grouped together.

| Amendment | Section to append |
|---|---|
| SPEC-006-A1 | New §Workflow Lifecycle (`workflow_lifecycle`) — 6 event types (§2.1) |
| SPEC-006-A2 | New §Workflow Phase Lifecycle (`workflow_phase_lifecycle`) — 12 event types (§2.2) |
| SPEC-006-A3 | New §Workflow Parallel Coordination (`workflow_parallel_coordination`) — 1 event type (§2.3) |
| SPEC-006-A4 | New §Workflow Channel Coordination (`workflow_channel_coordination`) — 3 event types (§2.4) |
| SPEC-006-A5 | New §Workflow Gate Resolution (`workflow_gate_resolution`) — 1 event type (§2.5) |

### 4.3 Cross-referencing Spec-006 events

Workflow events that reference existing Spec-006 events via payload identifiers (not new fields — identifiers already defined in Spec-006):

| Workflow event | References via | Spec-006 event referenced |
|---|---|---|
| `workflow.gate_resolved` | `approvalRequestId` | `approval.approved` / `approval.rejected` / `approval.expired` |
| `workflow.channel_created_for_phase` | `channelId` + `causationId` | `channel.created` |
| `workflow.channel_closed_with_records_preserved` | `channelId` + `causationId` | `channel.archived` |
| `workflow.channel_terminated_forcibly` | `channelId` + `causationId` | `channel.archived` |
| `workflow.phase_resumed` (recovery variant) | `recoveryId` + `causationId` | `recovery.succeeded` |
| `workflow.phase_progressed` (human phase claim variant) | `phaseRunId` + `causationId` | Any `assistant.*` or `tool.*` event inside the phase's execution (informational) |

### 4.4 Envelope version bump (ADR-018 discipline)

Landing these categories is an **additive MINOR bump** — `EventEnvelope.version` moves from the current Spec-006 shipping version to `1.N+1`. Per ADR-018 §Decision #11, additive-only MINOR MUST NOT rename or remove any existing field or type. All five new categories satisfy this constraint: no existing Spec-006 type changes, no envelope field added or removed, no existing enum widened in a breaking direction.

Receivers at the previous MINOR that encounter a `workflow.*` event persist it as a version stub per ADR-018 §Decision #11, preserving canonical bytes for signature verification. Dispatch to application handlers is skipped. On upgrade to the new MINOR, upcasters re-interpret persisted stubs at dispatch time.

---

## §5 Security Considerations

Carries forward Wave 1 commitments C-13 (append-only hash-chained approval log), C-15 (secrets by reference only), I2 (typed substitution), I4 (secrets never in argv/logs/artifacts), I7 (approval-history tamper-detection).

### 5.1 Field-level redaction rules

| Field | Rule | Rationale |
|---|---|---|
| `payload.*.input` (workflow inputs) | MUST NOT contain resolved secret values. If input references a secret, carry `secret://<scope>/<name>` reference only. | C-15 (secrets-by-reference); Airflow Secret Masker bypass class (`apache/airflow#54540`) — pattern-based redaction at log-write is defense-in-depth, not primary. |
| `payload.outputRef` / `payload.inputRef` | Artifact references only. Resolved artifact content is retrieved via Plan-014 artifact backend under access control. | C-15; I4. |
| `payload.failureDetail` / `payload.detail` (string fields) | MUST NOT interpolate argv or env values. Producer is responsible for sanitizing before emit — prefer structured error codes with numeric/enum identifiers over free-text that might embed user-controlled strings. | I1 (argv-only, no shell strings); script-injection class per Pass E §4.1. |
| `payload.approver` (gate_resolved) | `ParticipantId` only, never approver credentials. Approval envelope stored in Plan-012 approval backend, referenced by `approvalRequestId`. | I3 (typed capability). |
| `payload.membershipParticipants` (channel_created_for_phase) | `ParticipantId[]` — no participant-credential data. | Existing Spec-006 convention; no new surface. |
| `payload.claimedBy` (human_phase_claimed) | `ParticipantId` only. If the participant later submits input, submission content is carried on Spec-012 approval events under Cedar authorization, not on `human_phase_claimed`. | Pass C §3.2; Spec-012 integration. |
| `payload.progressMarker` + `payload.progressPayload` | MUST contain only phase-type-declared progress fields (turn count, token count, etc.). MUST NOT embed agent message content, tool output, or user-controlled strings. Agent/tool content flows through `assistant.*` / `tool.*` Spec-006 events under existing redaction. | Prevents secondary escalation of an agent's prompt-injection into the workflow timeline. |
| `payload.rationaleRef` (gate_resolved) | `ArtifactId` pointing to approval rationale; content retrieved under access control. | I7 (append-only approval log). |

### 5.2 PII handling

- `ParticipantId` is a stable identifier, not PII-on-its-face. Display-name resolution happens at read time via Spec-018 identity projection; event payload carries only the ID.
- `human_phase_claimed` and `human_phase_escalated` reveal *workflow participation* — a legitimate audit datum, but GDPR Article 17 ("right to erasure") interactions are governed by Spec-022 data retention; this pass does not reopen that contract.
- No free-text user names, emails, or profile data appear in workflow event payloads.

### 5.3 Append-only hash-chain for gate + approval events

Per C-13 / I7: `workflow.gate_resolved` and the Spec-006 `approval.*` events it references land in the append-only hash-chained log. Workflow-definition edits (Spec-017 §Definition Revision) are a **separate audit entry** emitted independently — never rewritten into a gate_resolved event. Replays use at-execution-time policy, not current definition, so `workflow_run_id` + `workflowDefinitionVersion` fields on every workflow event are **load-bearing** for replay correctness.

### 5.4 Content-addressing for external tool references

Fields referencing external tools (via `payload.progressPayload` on `automated` phases, or phase output that cites external-tool invocations) MUST carry content-hash references per C-7 when the phase definition references external tools. Workflow-event payloads themselves do not resolve these; they reference by `ArtifactId` and resolution happens in Plan-014. This pass does not add new surface — it enforces the existing C-7 constraint applies to any field in §2 that might reference externally-sourced content.

### 5.5 `human_phase_escalated` telemetry-only guardrail

Per SA-11 and the §2.2 payload-row comment: **this event is telemetry-only in V1.** Receivers MUST NOT:
- Dispatch notifications to participants based on this event.
- Treat the escalation as a policy-bearing signal (e.g. auto-fail the workflow on timeout).

V1's escalate path fires this event and stops. The event carries enough payload (`timeoutBehavior`, `dueAt`, phase identity) for the V1.x notification-routing primitive to be added as an additive consumer — no schema changes required at that point.

---

## §6 Websearch Evidence Table

Primary sources consulted 2026-04-22; each citation includes the fetched URL, source-year marker, and which Pass F section the source informs.

| # | Source | URL | Date marker | Informs |
|---|---|---|---|---|
| 1 | CloudEvents Specification v1.0.2 | https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md | v1.0.2 (ratified 2022, referenced throughout 2024-2026) | §1 reverse-DNS `workflow.*` convention; §2 required context attributes (`id`, `source`, `specversion`, `type`) map to envelope's `id`, `sessionId`-derived source, `version`, `type`; §2.5 `subject` convention informs payload-scoped fields. Per CloudEvents §3.1.1, event `type` "SHOULD be prefixed with a reverse-DNS name" — `workflow.*` under the emitting org's domain satisfies this when wrapped. |
| 2 | CloudEvents Documented Extensions v1.0.2 | https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/documented-extensions.md | v1.0.2 | §2 `traceparent` / distributed-tracing extensions inform how Spec-006's `correlationId` / `causationId` map to OpenTelemetry trace context. |
| 3 | OpenTelemetry Semantic Conventions for Events | https://opentelemetry.io/docs/specs/semconv/general/events/ | 2025 (updated semconv catalog) | §1 event-name uniqueness rule ("an event must have an event name that uniquely identifies the event structure"); §2 body-vs-attributes discipline (payload structured, not free-text body); §5 low-cardinality naming for aggregation. |
| 4 | OpenTelemetry GenAI Observability Blog (2025) | https://opentelemetry.io/blog/2025/ai-agent-observability/ | 2025 | §7 Open Questions — OpenTelemetry is actively defining AI-agent-application semantic conventions as of 2025-2026; Pass F's `workflow.*` taxonomy is ahead of the OTel semconv for workflow orchestration specifically, so V1 should not wait on OTel's workflow-event standard (not yet ratified). |
| 5 | Temporal Events and Event History | https://docs.temporal.io/workflow-execution/event | Accessed 2026-04-22 | §3.3 retry-creates-new-runId convention (`WorkflowExecutionStarted` always first in history, retries produce new `runId`); §2.3 single-event-per-semantic-decision discipline; §3 ordering invariants (deterministic replay requirement). |
| 6 | Temporal Events Reference | https://docs.temporal.io/references/events | Accessed 2026-04-22 | §2 payload-shape evidence for `WorkflowExecutionStarted`, `WorkflowExecutionCompleted`, `WorkflowExecutionFailed`, `WorkflowExecutionCancelRequested`, `WorkflowExecutionSignaled`; canonical mandatory-vs-optional field split. |
| 7 | Temporal Encyclopedia — Event History | https://docs.temporal.io/encyclopedia/event-history | Accessed 2026-04-22 | §3.3 rationale for retry-new-identity decision; per-`runId` event-history partitioning. |
| 8 | Argo Workflows — Workflow Events | https://argo-workflows.readthedocs.io/en/latest/workflow-events/ | Accessed 2026-04-22 | §1 category split (workflow-level events vs. node-level events — Argo emits `WorkflowRunning`/`WorkflowSucceeded`/`WorkflowFailed`/`WorkflowTimedOut` at workflow level + `WorkflowNodeRunning`/`WorkflowNodeSucceeded`/`WorkflowNodeFailed`/`WorkflowNodeError` at node level); §2.2 node-event annotation pattern (`workflows.argoproj.io/node-name`, `workflows.argoproj.io/node-type`) informs `phaseDefinitionId`/`phaseType` payload fields. |
| 9 | n8n Workflow Executions Docs | https://docs.n8n.io/workflows/executions/ | Accessed 2026-04-22 | §2.2 per-step lifecycle event emission pattern (n8n's `ExecutionLifecycleHooks` class); informs `phase_progressed` granularity decision. |
| 10 | CloudEvents Subject Field Prior Art (GitHub issue #112) | https://github.com/cloudevents/spec/issues/112 | 2019-ongoing; referenced in 2024-2026 patterns | §2 `subject` convention — `workflow.*` payloads use `workflowRunId` + `phaseRunId` as structured subject-equivalents rather than serialized subject strings. |

**Primary-source count: 10 (exceeds the minimum 5).** All 2024-2026-date-valid per fetch or per explicit version marker.

---

## §7 Open Questions for Wave 2 Synthesis

These require cross-Pass resolution at the Wave 2 synthesis (task #25). Each question notes the Pass(es) it depends on.

### 7.1 Does Pass G (persistence) need a dedicated `phase_waiting_on_pool` row, or is the event sufficient?

Pass G normalizes `workflow_phase_states` with per-phase rows. A phase may emit 0..N `phase_waiting_on_pool` events across multiple pool types (pty_slots, agent_memory_mb) before admission. If Pass G stores each waiting event as a row, replay is easy but write-volume is high for phases that oscillate between "ready" and "blocked" states. Alternative: store only *current* waiting state on the phase row, emit events for the audit log. Recommended resolution: **events are authoritative; Pass G row stores aggregate wait duration** (`totalPoolWaitMs`) for operational dashboards.

### 7.2 Threshold for emitting `phase_waiting_on_pool`

Emitting on every tick a phase is blocked inflates the event log. Emitting only on *entry* to blocked state loses data on how long blocking persisted. Proposal: **emit on entry and at 30-second intervals while blocked**, with `waitingSinceSeq` on each event letting readers reconstruct total wait time. Needs Pass G / Pass H validation that the 30 s cadence is tolerable under load.

### 7.3 Does `parallel_join_cancellation` need per-sibling detail, or is the ID list sufficient?

§2.3 carries `cancelledSiblingPhaseRunIds: PhaseRunId[]` inline. If a parallel join has >100 siblings (rare in practice; Pass A §3.3 noted Temporal's >1000 child caution), the event grows large. Alternative: cap the list at some N, emit a marker field `truncated: true`. Recommended resolution: **defer the cap decision to Pass H load testing** — V1 starts with no cap and surfaces a tripwire if any single `parallel_join_cancellation` event exceeds 10 KB serialized.

### 7.4 Should `human_phase_escalated` pre-declare a `nextAction` field?

Per SA-11, escalate is telemetry-only in V1 — no notification routing. When the V1.x notification-routing primitive ships, a `nextAction` / `routingHint` field may be needed. Options:
- (a) Leave the schema as-is; V1.x additive MINOR adds `nextAction?: string` when routing ships.
- (b) Reserve `nextAction?: 'none'` in V1 so schema authors know the slot exists.

Recommended: **option (a)** — strict ADR-018 additive discipline; no speculative fields. V1.x adds the field when needed.

### 7.5 `workflow.phase_progressed` granularity — per-turn, per-tool-call, per-token-batch?

Pass A and Pass B did not pin progress-event granularity. Over-emission inflates event log; under-emission loses observability signal. Proposal:
- `single-agent` / `automated` phases: emit on turn completion + on any tool invocation boundary. Align with Spec-006 `assistant.message` / `tool.result` events via causationId, so no duplication.
- `multi-agent` phases: emit on channel turn boundary + on budget milestones (25% / 50% / 75% of `turns_per_agent` budget).
- `human` phases: emit on form-section save (if daemon-side autosave lands V1.x) + on claim / re-claim.

Needs Pass H test-strategy feedback on whether this cadence stresses replay/load tests.

### 7.6 Does `workflow.resumed` need a `resumptionPoint` payload?

On daemon restart (Spec-015 recovery), a workflow run may resume from an arbitrary mid-phase state. Should `workflow.resumed` carry a structured `resumptionPoint: {activePhaseRunIds: PhaseRunId[], pendingGates: GateDefinitionId[]}` to speed up reader reconstruction? Pass G persistence may prefer readers to reconstruct this by reading `workflow_phase_states` rows directly. Recommended resolution at Wave 2 synthesis.

### 7.7 `workflow.phase_retried` — is the new `phaseRunId` deterministic on replay?

Deterministic replay (Pass G dep) requires that `phaseRunId` generation be reproducible from the event log. If retry creates a new `phaseRunId`, the generator MUST be deterministic (e.g., `hash(workflowRunId, phaseDefinitionId, attemptNumber)`). Random ULIDs break replay. Recommended: **pin deterministic `phaseRunId` generation in Pass G.**

### 7.8 Should there be an explicit `workflow.phase_deferred` event (not in original scope list)?

Pass A's `max_phase_transitions` limit (SA-1, default 100) could be hit mid-run — a phase "wants to start" but the run is at cap. Currently this fires as `workflow.failed` with `failureCategory: 'definition_cap_exceeded'`. A more granular `workflow.phase_deferred` might be useful for operators diagnosing "why did my run die with 3 phases queued?" — but adds schema surface. Recommended: **defer to Pass H** — if load tests surface a clear operator-diagnosis pain point, add; otherwise keep the simpler three-terminal model.

---

## §8 Summary

This pass concretizes 24 new workflow event types across 5 new Spec-006 categories, each with payload schemas, ordering invariants, Spec-006 alignment discipline, and security rules carrying Wave 1's C-13 / C-15 / I1–I7 commitments. The taxonomy is additive under ADR-018 MINOR-bump discipline; no existing Spec-006 event changes. Cross-references to existing `approval.*`, `channel.*`, `recovery.*` events via `approvalRequestId` / `channelId` / `recoveryId` preserve the single-source-of-truth audit trail without duplication. Retry creates a new `phaseRunId` (Temporal convention); parallel cancellation emits a single coordinator event plus per-sibling chains (replay-safe tick-boundary discipline from Pass A). Eight open questions surface for Wave 2 synthesis, all tractable without re-opening Wave 1 commitments.

*End of Pass F.*
