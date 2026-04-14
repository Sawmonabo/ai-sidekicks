# Run State Machine

## Purpose

Define the canonical lifecycle of a run so queueing, steering, pause and resume, approvals, recovery, and failure semantics are unambiguous.

## Scope

This document covers run states, transition rules, and the meaning of control actions against a run.

## Definitions

- `RunState`: the authoritative lifecycle state of a run.
- `BlockingState`: a non-terminal run state that requires external input before normal progress can continue.
- `TerminalState`: a run state from which the run does not continue.

## What This Is

The run state machine is the source of truth for execution lifecycle semantics.

## What This Is Not

- It is not a UI spinner model.
- It is not provider-specific lifecycle terminology.
- It is not a queue state model.

## Invariants

- A run has exactly one current state at a time.
- A run enters exactly one terminal state.
- `resume` is valid only from `paused`.
- Reattach after reconnect is not the same thing as `resume`.
- Waiting for approval or input keeps the same run id; it does not create a replacement run.

## Relationships To Adjacent Concepts

- `QueueItem` may create a run in `queued` state.
- `Intervention` can alter a run's state when permitted.
- `Approval` and participant input can unblock waiting states.
- `Artifact` publication can occur while a run is active or when it becomes terminal.

## State Model

| State | Meaning |
| --- | --- |
| `queued` | The run exists but has not yet been admitted to execution. |
| `starting` | The runtime is preparing provider, workspace, or execution state. |
| `running` | The run is actively executing. |
| `waiting_for_approval` | The run is blocked on an approval request. |
| `waiting_for_input` | The run is blocked on participant input or structured answers. |
| `paused` | The run has been intentionally suspended and can later continue with the same run id. |
| `recovering` | The runtime is reconstructing the run after restart or transport failure. |
| `interrupting` | An interrupt or cancel action has been accepted but not yet finalized. |
| `completed` | The run finished successfully. |
| `interrupted` | The run ended because of an interrupt or cancel path. |
| `failed` | The run ended because of an unrecovered error. |

Primary allowed transitions:

- `queued -> starting`
- `starting -> running`
- `running -> waiting_for_approval`
- `running -> waiting_for_input`
- `running -> paused`
- `running -> interrupting`
- `running -> completed`
- `running -> failed`
- `waiting_for_approval -> running`
- `waiting_for_input -> running`
- `paused -> running`
- `interrupting -> interrupted`
- `recovering -> running`
- `recovering -> waiting_for_approval`
- `recovering -> waiting_for_input`
- `recovering -> failed`

## Example Flows

- Example: A queued implementation task is admitted, moves through `starting` to `running`, pauses for approval before a risky file write, returns to `running` after approval, and ends in `completed`.
- Example: A daemon restarts during execution. The run enters `recovering`, reconstructs provider and workspace bindings, then returns to `running`.
- Example: A user stops an active run. The run moves to `interrupting` and then `interrupted`.

## Edge Cases

- A run may fail from `starting` if workspace or provider initialization cannot complete.
- A driver that cannot truly support `paused` must not advertise pause capability for that run.
- A reconnecting client may observe a run return from `recovering` to a blocking state without ever seeing the intermediate live transport loss.

## Related Specs

- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
