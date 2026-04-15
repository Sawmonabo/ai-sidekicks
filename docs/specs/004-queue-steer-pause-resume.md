# Spec-004: Queue Steer Pause Resume

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `004` |
| **Slug** | `queue-steer-pause-resume` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Run State Machine](../domain/run-state-machine.md), [Queue And Intervention Model](../domain/queue-and-intervention-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Shared Session Core](../specs/001-shared-session-core.md) |
| **Implementation Plan** | [Plan-004: Queue Steer Pause Resume](../plans/004-queue-steer-pause-resume.md) |

## Purpose

Define the canonical control semantics for queued work, active-run steering, pause and resume, and interrupt behavior.

## Scope

This spec covers queue admission, interventions, blocked states, and operator-visible control outcomes.

## Non-Goals

- Provider-specific transport details
- Workflow-level orchestration semantics
- Notification policy

## Domain Dependencies

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Data Architecture](../architecture/data-architecture.md)

## Required Behavior

- Follow-up work created while a run is active must be stored as persisted queue items unless the user explicitly requests steer and the target run supports it.
- `pause` must transition a run into `paused`; it must not mean queue-drain suspension or blocked waiting.
- `resume` must return a `paused` run to active execution with the same run id.
- `interrupt` must transition a run directly to `interrupted`. Interruption is a synchronous or near-synchronous provider call with no intermediate state.
- Waiting for approval or input must remain `waiting_for_approval` or `waiting_for_input`, not `paused`.
- Every intervention outcome must be visible in the canonical event stream.
- Queue items must support cancellation before admission.

## Default Behavior

- The default follow-up behavior while a run is active is `queue`.
- Queue ordering default is FIFO within the target scheduling scope.
- If a driver does not advertise pause support, the product must default to `queue` and `interrupt` controls only.

## Fallback Behavior

- If `steer` is requested against a run that cannot accept it, the system must either reject the intervention or explicitly downgrade it to a new queue item.
- If a paused run cannot be resumed because driver state is lost, the system must transition it through recovery logic and then to `failed` or `interrupted`; it must not pretend the same run resumed.
- If queue persistence is temporarily unavailable, the system must reject new queue creation rather than silently storing queue state only in client memory.

## Interfaces And Contracts

- `QueueItemCreate`, `QueueItemList`, and `QueueItemCancel` must operate against runtime-owned durable state.
- `InterventionRequest` must include target id, intervention type, initiator, and requested scope.
- `InterventionResult` must distinguish the 6 canonical intervention states: `requested`, `accepted`, `applied`, `rejected`, `degraded`, and `expired`.
- `RunStateChange` events must reflect the canonical state machine defined in `../domain/run-state-machine.md`.

## State And Data Implications

- Queue items require durable storage and ordering metadata.
- Interventions require durable audit records even when they fail.
- Blocked states must remain associated with the same run id and same event lineage.

## Example Flows

- `Example: A queued follow-up becomes a persisted QueueItem and is later steered into the active run.`
- `Example: A user pauses a long-running implementation run, later resumes it, and the run id remains unchanged throughout the pause cycle.`
- `Example: A run waits for approval. A second follow-up is queued but does not change the blocked run into paused state.`

## Implementation Notes

- Queueing and intervention logic must live in the daemon or equivalent runtime authority, not in the currently open client.
- UI affordances may be optimistic, but canonical run state changes must come from runtime truth.
- Capability-aware controls are required so unsupported operations do not masquerade as working.
- Pause is an orchestration-layer construct. The daemon interrupts the active run, persists conversation history and run state to local SQLite, and queues a resume. The driver never needs to know about pause.

## Pitfalls To Avoid

- Using client memory as the queue of record
- Calling reread or reattach semantics `resume`
- Treating waiting states as paused states

## Acceptance Criteria

- [ ] Follow-up work while a run is active is durably queued by default.
- [ ] Pause and resume operate on the same run id and same run history.
- [ ] Unsupported steer or pause requests result in explicit degraded or rejected outcomes rather than silent behavior changes.

## ADR Triggers

- If the product stops using daemon-backed queue state, create or update `../decisions/003-daemon-backed-queue-and-interventions.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: queue priority overrides are deferred. The first implementation uses canonical queue order plus explicit steer, pause, resume, and interrupt controls only.

## References

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
