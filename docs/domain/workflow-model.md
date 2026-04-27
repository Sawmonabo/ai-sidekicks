# Workflow Model

## Purpose

Define `Workflow` as the reusable, versioned execution template that structures multi-phase work inside a session.

## Scope

This document covers `WorkflowDefinition`, `WorkflowVersion`, and `WorkflowRun`, and the relationships among them. Phase-level execution semantics are defined in the companion [Workflow Phase Model](./workflow-phase-model.md).

## Definitions

- `WorkflowDefinition`: a named, durable definition record that describes a reusable sequence of phases. Scoped to a session or channel.
- `WorkflowVersion`: an immutable snapshot of a workflow definition's phase structure at a point in time. Editing a definition creates a new version rather than mutating an existing one.
- `WorkflowRun`: a single execution instance of a specific workflow version within a session. Each run tracks phase-level execution state independently.
- `WorkflowScope`: the boundary within which a workflow definition is visible and executable -- either `session` or `channel`.

## What This Is

The workflow model is the source of truth for how reusable, multi-phase execution templates are defined, versioned, and instantiated. It governs the relationship between a static definition and its runtime execution instances.

## What This Is Not

- A workflow is not a free-form conversation or ad-hoc sequence of runs. It is an authored definition with explicit phase structure.
- A workflow definition is not an artifact. Definitions are first-class persisted records. Artifact publication may represent derivative exports or summaries but must not be the canonical source of workflow definition truth.
- A workflow run is not a single run in the run-state-machine sense. A workflow run orchestrates multiple phase executions, each of which may create runs through `OrchestrationRunCreate`.
- A workflow is not an external workflow engine (Temporal, Restate). Execution uses the existing local-first persistence and run primitives per ADR-002.

## Invariants

- A workflow definition has exactly one active version at a time. Previous versions remain immutable and referenceable.
- A workflow run executes exactly one version. If the definition changes while a run is in progress, the running instance continues on the version it started with.
- Workflow scope is `session` or `channel`. A definition is visible and executable only within its declared scope.
- Every workflow run belongs to exactly one session.
- A workflow definition must contain at least one phase definition.
- Version immutability is absolute: no mutation of phase definitions within a published version.

## Relationships To Adjacent Concepts

- `Session` is the containing boundary for workflow definitions and runs.
- `Channel` is the optional narrower scope for workflow definitions.
- `WorkflowPhaseState` tracks per-phase execution progress within a workflow run. See [Workflow Phase Model](./workflow-phase-model.md).
- `Run` (from the run state machine) is the execution primitive used by individual phases. Each phase execution routes through `OrchestrationRunCreate` per Spec-016/017 constraints.
- `Agent` and `Channel` (from agent-channel-and-run model) provide the execution persona and communication surface for phase work.
- `Artifact` stores phase outputs with `artifactType: 'workflow_output'`. Artifacts are outputs of runs created during phase execution, not of the workflow run itself.
- `Approval` primitives from Plan-012 are used by `human-approval` gates within phases.
- `SessionEvent` timeline captures workflow lifecycle events (`workflow.phase_started`, `workflow.phase_completed`, `workflow.phase_failed`, `workflow.gate_resolved`).

## State Model

### Workflow Run States

| State       | Meaning                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `pending`   | The workflow run has been created but phase execution has not started.                            |
| `running`   | At least one phase is actively executing or the workflow is advancing between phases.             |
| `completed` | All phases have reached terminal states and the workflow finished successfully.                   |
| `failed`    | The workflow ended because a phase failed and the configured failure behavior resulted in a stop. |
| `canceled`  | The workflow was explicitly canceled by a participant or system action.                           |

Allowed transitions:

- `pending -> running` (first phase starts)
- `running -> completed` (final phase completes successfully and terminal gate resolves)
- `running -> failed` (phase failure with `stop` behavior, or retry exhaustion)
- `running -> canceled` (explicit cancellation)
- `pending -> canceled` (canceled before execution begins)

### Workflow Definition (no state machine)

Workflow definitions do not have a lifecycle state. They exist once created and are versioned through `WorkflowVersion`. Deletion or archival semantics, if needed, follow from the containing session's lifecycle.

### Workflow Version (no state machine)

Versions are immutable once created. There is no version-level state to manage. The "active version" is determined by the highest version number for a given definition.

## Entity Hierarchy

```
WorkflowDefinition (1)
  └── WorkflowVersion (many, immutable)
        ├── phase_definitions (JSON array of PhaseDefinition)
        └── WorkflowRun (many)
              └── WorkflowPhaseState (one per phase in the version)
```

## Example Flows

- Example: A user authors a workflow `analyze -> plan -> implement -> review`. The system creates a `WorkflowDefinition` with one `WorkflowVersion` containing four phase definitions. Starting the workflow creates a `WorkflowRun` bound to that version with four `WorkflowPhaseState` rows, all initially `pending`.
- Example: A user edits the workflow to add a `test` phase between `implement` and `review`. The system creates version 2. An already-running instance on version 1 continues with four phases. New runs use version 2 with five phases.
- Example: A workflow is exported as an artifact for team review. The exported artifact is a derivative view. Later execution still binds to the canonical persisted definition version, not to the artifact copy.

## Edge Cases

- A workflow run may be `canceled` even if some phases have already `completed`. Completed phase outputs remain addressable.
- A workflow definition with a single phase is valid. The phase's gate type determines whether the workflow completes immediately (`auto-continue` or `done`) or blocks for approval.
- A workflow run survives daemon restart or client reconnect. Phase state is persisted in `workflow_phase_states` and is recoverable.
- If a workflow version's phase definitions reference capabilities unavailable at runtime, the workflow pauses in a blocked state rather than silently skipping phases.

## Related Specs

- [Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md)
- [Multi Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md)
- [Shared Session Core](../specs/001-shared-session-core.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
