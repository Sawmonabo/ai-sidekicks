# Queue And Intervention Model

## Purpose

Define how deferred work is stored and how control actions against active or queued work are represented.

## Scope

This document covers `QueueItem` and `Intervention`.

## Definitions

- `QueueItem`: a persisted unit of deferred work waiting for execution admission.
- `Intervention`: an auditable control action against an active run or queued work item.
- `Admission`: the act of converting a queue item into a running lifecycle.

## What This Is

This model defines how the system stores follow-up work, prioritizes it, and records deliberate operator changes to execution.

## What This Is Not

- A queue item is not a run.
- A queue is not a client draft buffer.
- An intervention is not a normal user message.

## Invariants

- Queue items are persisted by the runtime, not only by the client.
- Every queue item belongs to exactly one session and targets a defined execution context.
- Every intervention has an initiator, a target, a timestamp, and an outcome.
- Queue admission and intervention effects must be visible in the session timeline.
- A failed or downgraded intervention must still be recorded as an outcome.

## Relationships To Adjacent Concepts

- A `QueueItem` can create a future `Run`.
- An `Intervention` targets a `Run` via `targetRunId`. Queue-item cancellation uses `QueueItemCancel`, not the intervention model.
- `Approval` can be required before certain interventions take effect.
- `Channel` context determines where admitted queued work will publish.

## State Model

Queue item states:

| State | Meaning |
| --- | --- |
| `queued` | Waiting for admission. |
| `admitted` | Accepted by the run engine and being converted into a run. |
| `superseded` | No longer eligible because newer work replaced it. |
| `canceled` | Intentionally removed before admission. |
| `expired` | No longer valid because its context or timing window lapsed. |

Intervention states (6 canonical states):

| State | Meaning |
| --- | --- |
| `requested` | Recorded and awaiting evaluation. |
| `accepted` | Determined to be valid for the target. |
| `applied` | Successfully changed runtime or scheduling state. |
| `rejected` | Determined to be invalid or unauthorized. Authorization failure produces `rejected`. |
| `degraded` | The driver does not support the intervention type and the orchestration layer fell back (e.g., steer degrades to queue + interrupt for providers without native steer). |
| `expired` | No longer meaningful because the target state changed first. Version guard mismatch produces `expired`. |

### Intervention State Transition Table

| From | To | Trigger | Condition |
| --- | --- | --- | --- |
| `requested` | `accepted` | Valid target, authorized | Target run is in a state that accepts this intervention type |
| `requested` | `rejected` | Invalid target or unauthorized | Target run state incompatible, or participant lacks permission |
| `requested` | `expired` | Version guard mismatch | `expectedRunVersion` does not match current run version |
| `accepted` | `applied` | Driver successfully executed | Provider confirmed the intervention took effect |
| `accepted` | `degraded` | Driver fallback used | Driver does not support this type natively; orchestration layer fell back |
| `accepted` | `expired` | Target state changed | Run transitioned between accept and apply (e.g., run completed before steer could be applied) |

## Intervention Entity Relationship

- `InterventionRequest`: the inbound command that initiates an intervention.
- `InterventionResult`: the outcome record produced after evaluation and execution.
- `Intervention`: the lifecycle entity encompassing both the request and the result.

Lifecycle: an `InterventionRequest` is created by a participant or the orchestration layer, validated against the target run state and version guard, and then produces an `Intervention` entity that progresses through the state transitions defined above. When the intervention reaches a terminal state (`applied`, `rejected`, `degraded`, or `expired`), the system records an `InterventionResult` capturing the final outcome and any fallback action taken.

One `InterventionRequest` produces exactly one `Intervention`, which produces exactly one `InterventionResult`. This is a strict 1:1:1 cardinality.

The `interventions` SQLite table (Plan-004) stores the full lifecycle entity — request fields, current state, and result — in a single row rather than splitting request and result into separate tables. See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## Intervention Payloads

Intervention payloads are a discriminated union by type:

- `steer`: `{targetRunId, expectedTurnId?, expectedRunVersion?, content, attachments?}`
- `interrupt`: `{targetRunId, expectedRunVersion?, reason?}`
- `cancel`: `{targetRunId, expectedRunVersion?, reason?}`

All intervention types support an optional version guard (`expectedRunVersion`). When present, a guard mismatch produces `expired`. An authorization failure produces `rejected`.

## Field-Level Consistency

The following field inventory maps each intervention payload to the canonical sources and confirms cross-document consistency.

**`steer` payload:**

| Field | Required | Source: API Contracts | Source: Spec-005 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | no | `InterventionRequestPayload` (optional) | `ApplyInterventionParams.expectedRunVersion` (optional) |
| `content` | yes | `InterventionRequestPayload` | `SteerPayload.content` |
| `attachments` | no | `InterventionRequestPayload` (optional) | `SteerPayload.attachments` (optional) |
| `expectedTurnId` | no | `InterventionRequestPayload` (optional) | `SteerPayload.expectedTurnId` (optional) |

**`interrupt` payload:**

| Field | Required | Source: API Contracts | Source: Spec-005 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | no | `InterventionRequestPayload` (optional) | `ApplyInterventionParams.expectedRunVersion` (optional) |
| `reason` | no | `InterventionRequestPayload` (optional) | `InterruptPayload.reason` (optional) |

**`cancel` payload:**

| Field | Required | Source: API Contracts | Source: Spec-005 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | no | `InterventionRequestPayload` (optional) | `ApplyInterventionParams.expectedRunVersion` (optional) |
| `reason` | no | `InterventionRequestPayload` (optional) | `CancelPayload.reason` (optional) |

Note: The `ApplyInterventionParams` interface in Spec-005 splits the payload into `targetRunId` and `expectedRunVersion` at the top level and routes the remaining type-specific fields through `SteerPayload`, `InterruptPayload`, or `CancelPayload`. The `InterventionRequestPayload` in the API contracts flattens all fields into a single discriminated union. Both representations carry the same field set per intervention type. The `InterventionDriverResult` returned by the driver uses `status: 'applied' | 'degraded'` — the orchestration layer maps this to the full 6-state lifecycle.

## Boundary: Interventions vs Interactive Requests

- `respondToRequest` (from Spec-005 `ProviderDriver` interface) is the driver's mechanism for handling PROVIDER-initiated interactive requests (tool confirmations, clarification questions). It is REACTIVE — the provider asked for input.
- `applyIntervention(type: "steer")` is PARTICIPANT-initiated content injection into an active run. It is PROACTIVE — the participant wants to redirect.
- The two never overlap: a steer targets a `running` state, a response targets a `waiting_for_input` state.
- `interrupt` intervention targets `running` specifically — it stops active computation.
- `cancel` intervention targets any non-terminal state — it ends the run regardless of whether it is `running`, `paused`, or waiting.
- Queue-item cancellation (`QueueItemCancel`) is separate from `cancel` intervention — `QueueItemCancel` targets queue items that have not yet been admitted as runs, while `cancel` intervention targets runs that already exist in the run state machine.

## Example Flows

- Example: A queued follow-up becomes a persisted `QueueItem` and is later steered into the active run.
- Example: A user requests `pause` against a running task. The orchestration layer records an intervention, interrupts the run, persists state, and queues a resume event. The driver never needs to know about pause.
- Example: A later urgent fix supersedes an older queued follow-up. The old queue item is marked `superseded`, not silently discarded.

## Edge Cases

- A steer intervention against a run with no active steer capability must be rejected or degraded to a new queue item explicitly.
- A queued item can expire if its required workspace, branch, or participant authority is no longer valid.
- A canceled queue item remains in history for audit and replay.

## Related Specs

- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
