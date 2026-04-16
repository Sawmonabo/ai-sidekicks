# Workflow Phase Model

## Purpose

Define the execution semantics of individual workflow phases: how phases run, how gates control progression, and how iteration handles failure.

## Scope

This document covers `PhaseDefinition` (static), `WorkflowPhaseState` (runtime), gate types, gate states, phase types, and the iteration model. The parent workflow lifecycle is defined in the companion [Workflow Model](./workflow-model.md).

## Definitions

- `PhaseDefinition`: a static configuration within a workflow version that describes one step in the workflow. Identified by a stable `WorkflowPhaseId`.
- `WorkflowPhaseState`: the runtime execution record for a specific phase within a specific workflow run. Identified by the combination of `workflow_run_id` and `phase_id`.
- `WorkflowPhaseId`: a definition-side identifier. It names a phase in the template and remains stable across workflow versions that retain the same phase.
- `PhaseRunId`: an execution-side identifier. It names a specific run created to execute a phase (with iteration number, status, timestamps). This is a `RunId` from the run state machine.
- `Gate`: a checkpoint between phases that must resolve before the next phase can start.
- `GateState`: the runtime state of a phase's gate (`closed`, `open`, `bypassed`).
- `FailureBehavior`: the configured response when a phase or its gate check fails (`retry`, `go-back-to`, `stop`).

## What This Is

The workflow phase model is the source of truth for how individual steps within a workflow execute, how progression between steps is gated, and how failures within steps are handled.

## What This Is Not

- A phase is not an independent run. It is a step within a workflow that creates runs through `OrchestrationRunCreate`.
- A phase state is not the same as a run state. Phase states track workflow-level progress; the underlying run has its own lifecycle per the run state machine.
- A gate is not the same as an approval request, though `human-approval` gates use the approval primitives from Plan-012.
- Phase iteration is not unbounded retry. It is governed by configured max retries and failure behavior.

## Phase Types

V1 phase types:

| Type | Description |
| --- | --- |
| `single-agent` | One agent executes the phase autonomously. The phase creates one run in one channel. |
| `automated` | No agent. Executes a script or validation check. |

Deferred to V1.1:

| Type | Description |
| --- | --- |
| `multi-agent` | A phase spawns a multi-agent channel where agents discuss before producing output. |
| `human` | A phase requires direct human contribution rather than agent execution. |

## Phase States

| State | Meaning |
| --- | --- |
| `pending` | The phase has not started. It is waiting for prior phases to complete and their gates to open. |
| `running` | The phase is actively executing. An underlying run has been created and is in progress. |
| `completed` | The phase finished successfully and produced its outputs. |
| `failed` | The phase ended in failure after exhausting configured recovery behavior. |
| `skipped` | The phase was bypassed. This occurs when a gate is configured with `skip` failure behavior on quality-check failure. |

Allowed transitions:

- `pending -> running` (prior phase gate opens or this is the first phase)
- `running -> completed` (execution succeeds)
- `running -> failed` (execution fails and recovery behavior resolves to stop)
- `running -> pending` (retry: phase resets for another attempt)
- `pending -> skipped` (gate failure with `skip` behavior)
- `pending -> failed` (dependency failure propagates with `stop` behavior)

## Gate Types

| Gate Type | Behavior | Failure Behavior |
| --- | --- | --- |
| `auto-continue` | Phase completes, next phase starts automatically. No gate check. | N/A |
| `quality-checks` | Automated quality check runs on phase output. Evaluated by a dedicated agent or automated script -- not by the same agent that produced the output. | Configurable: `block` (halt workflow), `warn` (continue with flag), `skip` (bypass gate). Retry: re-run phase up to `max_retries`. |
| `human-approval` | Human must approve phase output before continuing. Uses approval primitives from Plan-012 with `category: 'gate'`. | Block until approved. Reject: `retry` or `stop` (configurable). |
| `done` | Terminal gate. Marks the workflow as complete. | N/A |

## Gate States

| State | Meaning |
| --- | --- |
| `closed` | The gate has not yet been evaluated or resolved. This is the default state. Gates start closed. |
| `open` | The gate has been resolved and the next phase may proceed. |
| `bypassed` | The gate was skipped due to configured `skip` failure behavior on quality-check failure, or workflow cancellation. |

Gate resolution results (event-level, not persisted as gate state):

| Result | Meaning |
| --- | --- |
| `passed` | The gate check succeeded. Gate transitions to `open`. |
| `failed` | The gate check failed. Behavior depends on failure configuration. |
| `waiting-human` | The gate is awaiting human resolution. Gate remains `closed`. |

## Iteration Model

Retry configuration lives in the `PhaseDefinition` within the `phase_definitions` JSON on `workflow_versions`. There is no dedicated retry-count column in the schema; iteration tracking is through session events (`workflow.phase_started` with iteration metadata).

- **Retry target**: the phase that produced the output, or a specific earlier phase (configured per gate via `go-back-to`).
- **Max retries**: configurable per gate. Default: 3.
- **Failure behaviors**:
  - `retry`: re-run the current phase. The phase transitions from `running` back to `pending`, then to `running` again. Each iteration emits a `workflow.phase_started` event with iteration context.
  - `go-back-to`: re-run from a specified earlier phase. All phases between the target and the current phase reset to `pending`.
  - `stop`: halt the workflow. The phase transitions to `failed` and the workflow run transitions to `failed`.

When retries are exhausted (iteration count exceeds `max_retries`), the phase transitions to `failed` and the workflow run's failure behavior takes effect.

## Invariants

- A phase enters exactly one terminal state (`completed`, `failed`, or `skipped`). Once terminal, it does not transition further.
- Gates resolve before the next phase starts. A phase cannot begin while the prior phase's gate is `closed` (unless the gate type is `auto-continue`, which opens immediately).
- Quality-check failures respect the configured behavior: `block` halts the workflow, `warn` opens the gate with a flag, `skip` bypasses the gate.
- Each phase execution creates runs through `OrchestrationRunCreate`. Phase execution does not bypass the run state machine.
- A phase's underlying run follows the full run lifecycle. If the run reaches `failed`, the phase's failure behavior determines the next step.
- Phase outputs are durable and addressable after workflow completion. They are stored as artifacts with `artifactType: 'workflow_output'`.
- Quality checks are evaluated by a dedicated agent or automated script, never by the same agent that produced the output.

## Relationships To Adjacent Concepts

- `WorkflowRun` (from workflow model) is the parent container. Each workflow run has one `WorkflowPhaseState` per phase in its version.
- `PhaseDefinition` (from workflow version) provides the static configuration: phase type, gate type, failure behavior, and optional config.
- `Run` (from run state machine) is the execution primitive. Each phase iteration creates at least one run.
- `Agent` executes `single-agent` phases. The agent is configured in the phase definition's `config`.
- `Channel` receives phase output. Each phase defaults to one primary target channel.
- `Artifact` stores phase outputs with `artifactType: 'workflow_output'`. Each phase produces `{artifacts: ArtifactId[], summary: string, metadata: Record<string, unknown>}`.
- `Approval` (from Plan-012) is used by `human-approval` gates. The approval request uses `category: 'gate'`.
- `SessionEvent` timeline captures phase events: `workflow.phase_started`, `workflow.phase_completed`, `workflow.phase_failed`, `workflow.gate_resolved`.

## Example Flows

- Example: A `single-agent` phase with `quality-checks` gate runs an implementation agent. The agent completes, a separate quality-check agent evaluates the output, the check passes, the gate opens, and the next phase begins.
- Example: A `human-approval` gate blocks after a planning phase. A participant reviews the plan, approves it via the approval system, the gate opens, and the implementation phase starts.
- Example: A quality check fails on a code review phase. The gate is configured with `retry` and `max_retries: 3`. The phase resets to `pending` and re-runs. After three failed attempts, the phase transitions to `failed` and the workflow stops.
- Example: A `go-back-to` failure behavior is configured on a review gate targeting the implementation phase. When review fails, both the review phase and the implementation phase reset to `pending`, and execution resumes from implementation.

## Edge Cases

- A phase may fail from `running` if the underlying run fails and the configured failure behavior is `stop` with no retries remaining.
- A `skipped` phase produces no outputs and no artifacts. Its gate transitions to `bypassed`.
- If a workflow is `canceled` while a phase is `running`, the phase's underlying run is interrupted (per run state machine child-run behavior) and the phase transitions to `failed`.
- An `automated` phase with no agent still creates a run record for provenance and timeline visibility, even though no agent persona executes.
- Retry iterations appear as sub-entries within the phase section of the session timeline. Each iteration is a distinct event, not a state mutation on a prior event.
- Phase execution is sequential by default. Parallel execution requires explicit marking in the definition and is bounded.

## Related Specs

- [Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md)
- [Multi Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
