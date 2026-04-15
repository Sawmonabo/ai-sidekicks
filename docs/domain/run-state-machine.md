# Run State Machine

## Purpose

Define the canonical lifecycle of a run so queueing, steering, pause and resume, approvals, interruption, and failure semantics are unambiguous.

## Scope

This document covers run states, transition rules, and the meaning of control actions against a run.

## Definitions

- `RunState`: the authoritative lifecycle state of a run.
- `BlockingState`: a non-terminal run state that requires external input before normal progress can continue.
- `TerminalState`: a run state from which the run does not continue.
- `RunFailureCategory`: a machine-readable classification that explains why a run failed or degraded without creating a new run state.
- `RecoveryCondition`: a derived signal that explains whether recovery still requires operator or participant action.
- `RunHealthSignal`: a derived signal such as `stuck-suspected` that helps operators reason about a live run without changing the canonical `RunState`.

## What This Is

The run state machine is the source of truth for execution lifecycle semantics.

## What This Is Not

- It is not a UI spinner model.
- It is not provider-specific lifecycle terminology.
- It is not a queue state model.
- It is not a separate taxonomy of extra run states for every failure cause.

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
| `completed` | The run finished successfully. |
| `interrupted` | The run ended because of an interrupt or cancel path. |
| `failed` | The run ended because of an unrecovered error. |

Primary allowed transitions:

- `queued -> starting`
- `starting -> running`
- `starting -> failed`
- `running -> waiting_for_approval`
- `running -> waiting_for_input`
- `running -> paused`
- `running -> interrupted`
- `running -> completed`
- `running -> failed`
- `waiting_for_approval -> running`
- `waiting_for_approval -> interrupted`
- `waiting_for_input -> running`
- `waiting_for_input -> interrupted`
- `paused -> running`
- `paused -> interrupted`

## Derived Failure And Recovery Signals

The canonical run lifecycle has one failure terminal state: `failed`. Additional labels describe why a run failed or whether recovery still needs action; they do not create extra run states.

| Signal Or Category | Meaning | Classification |
| --- | --- | --- |
| `stuck-suspected` | The run appears active but has exceeded progress thresholds without reaching a valid blocking or terminal state. | Derived run-health signal, not `RunState` |
| `recovery-needed` | Automatic recovery did not return the run to safe progress and operator or participant action is required. | Recovery condition, not `RunState` |
| `provider failure` | The provider or driver could not safely start, continue, or resume the run. | Failure category, not `RunState` |
| `transport failure` | A required transport path failed independently of provider semantics. | Failure category, not `RunState` |
| `local persistence failure` | Canonical local storage was unavailable or inconsistent enough that recovery or safe mutation could not continue. | Failure category, not `RunState` |
| `projection failure` | Replay or projection rebuild could not produce trustworthy read state. | Failure category, not `RunState` |

- Recovery is handled by startup reconciliation: on boot the daemon detects stale runs and dispatches corrective commands. There is no visible `recovering` state.
- If recovery cannot proceed safely, the run transitions to `failed`; failure detail may then carry one or more failure categories plus `recovery-needed` when intervention is still required.

## Example Flows

- Example: A queued implementation task is admitted, moves through `starting` to `running`, pauses for approval before a risky file write, returns to `running` after approval, and ends in `completed`.
- Example: A daemon restarts during execution. Startup reconciliation detects the stale run and dispatches corrective commands to resume or fail it.
- Example: A user stops an active run. The run transitions directly from `running` to `interrupted`.
- Example: A user cancels a run via `applyIntervention(type: "cancel")`. The cancel intervention maps to the `interrupted` terminal state — cancel is a user-initiated interruption distinct from queue-level `QueueItemCancel`.

## Child-Run Behavior

- When a parent run is interrupted, all child runs are interrupted.

## Edge Cases

- A run may fail from `starting` if workspace or provider initialization cannot complete.
- Pause is an orchestration-layer construct (interrupt + persist + queue resume) that does not require driver capability support. See ADR-011.
- Interruption is a synchronous or near-synchronous provider call. There is no intermediate `interrupting` state; runs transition directly to `interrupted`.
- A run may be `failed` with `provider failure` detail after an unsuccessful resume attempt; provider-specific failure causes do not create separate run states.
- A run may be `failed` with visible `recovery-needed` condition after automatic recovery is exhausted; failed recovery remains visible through failure detail and recovery condition rather than a separate terminal run state.

## Implementation Note

Implementation uses a hybrid approach: XState v5 for internal transition logic and guard validation (with Stately Studio visualization), TypeScript discriminated union for the public API (compile-time state narrowing).

## Related Specs

- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
