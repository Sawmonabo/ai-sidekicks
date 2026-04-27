# Spec-004: Queue Steer Pause Resume

| Field                   | Value                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**              | `approved`                                                                                                                                                                                                                                                                                |
| **NNN**                 | `004`                                                                                                                                                                                                                                                                                     |
| **Slug**                | `queue-steer-pause-resume`                                                                                                                                                                                                                                                                |
| **Date**                | `2026-04-14`                                                                                                                                                                                                                                                                              |
| **Author(s)**           | `Codex`                                                                                                                                                                                                                                                                                   |
| **Depends On**          | [Run State Machine](../domain/run-state-machine.md), [Queue And Intervention Model](../domain/queue-and-intervention-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Shared Session Core](../specs/001-shared-session-core.md) |
| **Implementation Plan** | [Plan-004: Queue Steer Pause Resume](../plans/004-queue-steer-pause-resume.md)                                                                                                                                                                                                            |

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
- [ADR-003: Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)

## Required Behavior

- Follow-up work created while a run is active must be stored as persisted queue items unless the user explicitly requests steer and the target run supports it.
- `pause` is an orchestration-layer construct: the daemon interrupts the active run, persists conversation history and run state, and queues a resume event. The resulting `paused` state must not mean queue-drain suspension or blocked waiting.
- `resume` must return a `paused` run to active execution with the same run id.
- `interrupt` must transition a run directly to `interrupted`. Interruption is a synchronous or near-synchronous provider call with no intermediate state.
- Waiting for approval or input must remain `waiting_for_approval` or `waiting_for_input`, not `paused`.
- Every intervention outcome must be visible in the canonical event stream.
- Queue items must support cancellation before admission.

## Default Behavior

- The default follow-up behavior while a run is active is `queue`.
- Queue ordering default is FIFO within the target scheduling scope.
- If a driver does not support steer natively, the intervention must be rejected or degraded to a new queue item. Pause does not require driver support — it is handled entirely by the orchestration layer via `applyIntervention`.

## Fallback Behavior

- If `steer` is requested against a run that cannot accept it, the system must either reject the intervention or explicitly degrade it to a new queue item.
- If a paused run cannot be resumed because driver state is lost, the system must transition it through recovery logic and then to `failed` or `interrupted`; it must not pretend the same run resumed.
- If queue persistence is temporarily unavailable, the system must reject new queue creation rather than silently storing queue state only in client memory.

## Interfaces And Contracts

- `QueueItemCreate`, `QueueItemList`, and `QueueItemCancel` must operate against runtime-owned durable state.
- `InterventionRequest` must include target run id, intervention type, and version guard (`expectedRunVersion`). Payload fields vary by type: `steer` includes `expectedTurnId`, `content`, and optional `attachments`; `interrupt` and `cancel` include optional `reason`. See [Queue And Intervention Model](../domain/queue-and-intervention-model.md) for canonical payload shapes.
- `InterventionResult` must distinguish the 6 canonical intervention states: `requested`, `accepted`, `applied`, `rejected`, `degraded`, and `expired`. A version guard mismatch produces `expired`. An authorization failure produces `rejected`.
- Intervention dispatch uses `applyIntervention` (see [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) and [ADR-011](../decisions/011-generic-intervention-dispatch.md)), which routes to the appropriate driver-specific handler based on intervention type and declared capabilities. The Cedar `principal` for authorizing an intervention is the verified PASETO `sub` of the caller; `initiatorId` and any body-level actor fields are informational only. See [API Payload Contracts §Authenticated Principal And Authorization Model](../architecture/contracts/api-payload-contracts.md#authenticated-principal-and-authorization-model).
- See [Queue And Intervention Model](../domain/queue-and-intervention-model.md) § Boundary: Interventions vs Interactive Requests for the steer/respondToRequest distinction.
- `RunStateChange` events must reflect the canonical state machine defined in `../domain/run-state-machine.md`.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Queue items require durable storage and ordering metadata.
- Interventions require durable audit records even when they fail.
- Blocked states must remain associated with the same run id and same event lineage.

## Example Flows

- `Example: A queued follow-up becomes a persisted QueueItem and is later steered into the active run.`
- `Example: A user pauses a long-running implementation run, later resumes it, and the run id remains unchanged throughout the pause cycle.`
- `Example: A run waits for approval. A second follow-up is queued but does not change the blocked run into paused state.`

## Driver-Level Steer Mechanics

- **Codex driver**: native `turn/steer` API — content is injected mid-conversation as a new user turn. The active generation is interrupted and the model continues from the steer content.
- **Claude driver**: no native steer support — degrades to queue + interrupt. The orchestration layer: (1) interrupts the active run (transitioning it to `interrupted`), (2) creates a new queue item with the steer content, (3) admits the queue item as a new run. The conversation history is preserved.
- **Generic driver fallback**: same as Claude (queue + interrupt).

### Steer Content Injection Point

- For native steer (Codex): content appears as a new user message in the conversation, immediately after the point of interruption. The model sees it as if the user sent a follow-up.
- For degraded steer (queue + interrupt): content becomes the initial message of the new run. Previous conversation history is loaded from the session event log.
- In both cases: steer content is marked with `source: 'steer'` in the event payload so the timeline can distinguish it from normal user messages.

The typed payload shapes for steer, interrupt, and cancel interventions are defined in [Queue And Intervention Model](../domain/queue-and-intervention-model.md) and verified against API contracts in that document's Field-Level Consistency section.

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
- [ ] Pause (orchestration-layer interrupt + persist + queue resume) and resume operate on the same run id and same run history.
- [ ] Unsupported intervention requests result in explicit `degraded` or `rejected` outcomes rather than silent behavior changes.

## ADR Triggers

- If the product stops using daemon-backed queue state, create or update `../decisions/003-daemon-backed-queue-and-interventions.md`.
- If the product changes how interventions are dispatched to drivers, create or update `../decisions/011-generic-intervention-dispatch.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: queue priority overrides are deferred. The first implementation uses canonical queue order plus explicit steer, pause, resume, and interrupt controls only.

## References

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
