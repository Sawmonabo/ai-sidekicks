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

## Intervention Entity Relationship

- `InterventionRequest`: the inbound command that initiates an intervention.
- `InterventionResult`: the outcome record produced after evaluation and execution.
- `Intervention`: the lifecycle entity encompassing both the request and the result.

## Intervention Payloads

Intervention payloads are a discriminated union by type:

- `steer`: `{targetRunId, expectedTurnId, expectedRunVersion, content, attachments?}`
- `interrupt`: `{targetRunId, expectedRunVersion, reason?}`
- `cancel`: `{targetRunId, expectedRunVersion, reason?}`

All intervention types carry version guards (`expectedRunVersion`). A guard mismatch produces `expired`. An authorization failure produces `rejected`.

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
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
