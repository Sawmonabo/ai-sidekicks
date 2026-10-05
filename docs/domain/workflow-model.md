# Workflow Model

## Purpose

Define `Workflow` as the reusable, versioned execution template that structures multi-step work inside a session.

## Scope

This document covers `WorkflowDefinition`, `WorkflowVersion`, and `WorkflowRun`, and the relationships among them. Step-level execution semantics are defined in the companion [Workflow Step Model](./workflow-step-model.md).

## Definitions

- `WorkflowDefinition`: a named, durable definition record that holds the node-graph document an author wrote. Scoped to one of the three `WorkflowScope` tiers below.
- `WorkflowVersion`: an immutable snapshot of a workflow definition's document body at a point in time. Editing a definition creates a new version rather than mutating an existing one.
- `WorkflowRun`: a single execution instance of a specific workflow version within a session. Each run keeps one step record per node attempt.
- `WorkflowScope`: the boundary within which a workflow definition is visible and executable — `session` (one session, named by `scope_ref`), `project` (the sessions of one project), or `shared` (the daemon's cross-project tier). A definition carries no owning session of its own; runs, not definitions, live in sessions. Scope identity is carried by a companion `scope_ref` value — the session's id at `session`, the project record's id at `project`, the empty string at `shared` — and definitions dedupe on `(scope, scope_ref, contentHash)` ([Spec-015 §State And Data Implications](../specs/015-workflow-authoring-and-execution.md#state-and-data-implications)).

## What This Is

The workflow model describes how reusable, multi-step execution templates are defined, versioned, and instantiated. It also describes the relationship between a static definition and its runtime execution instances.

## What This Is Not

- A workflow is not a free-form conversation or ad-hoc sequence of runs. It is an authored document with an explicit node graph.
- A workflow definition is not an artifact. Definitions are first-class persisted records. Artifact publication may represent derivative exports or summaries but must not be the canonical source of workflow definition truth.
- A workflow run is not a single run in the run-state-machine sense. A workflow run executes many steps, and an agent step creates runs — `agent.run` through the run admission, `agent.multi-agent` through `orchestration.runCreate` in the run's own session.
- A workflow is not an external workflow engine (Temporal, Restate). Execution uses the existing daemon-local persistence and run primitives per ADR-002.

## Invariants

- A workflow definition has exactly one active version at a time. Previous versions remain immutable and referenceable.
- A workflow run executes exactly one version. If the definition changes while a run is in progress, the running instance continues on the version it started with.
- Workflow scope is three-valued: `session`, `project`, or `shared`. A definition is visible and executable only within its declared scope's tier; run-start resolution walks the tiers most-specific-first (`session`, then `project`, then `shared`) with no merging across tiers, and editing a `shared` definition is copy-on-write into the editor's scope — never edit-in-place ([Spec-015 §Definition scope in the builder (SA-34)](../specs/015-workflow-authoring-and-execution.md#definition-scope-in-the-builder-sa-34)).
- Every workflow run belongs to exactly one session.
- A workflow definition has exactly one trigger node. A document with no node, with no trigger, or with a second trigger is refused when it is saved.
- Version immutability is absolute: no mutation of the nodes or edges of a published version. The canvas layout sits outside the version's hashed bytes, so moving a node changes no version.

## Relationships To Adjacent Concepts

- `Session` is the containing boundary for every workflow run and for a `session`-scoped definition. A run started from a chat lives in that chat's session, an unattended run in the one session its workflow owns, and a sub-workflow's child run in its parent's session.
- `Project` and the daemon-wide `shared` tier are the broader scope tiers above `session` ([Spec-015 §State And Data Implications](../specs/015-workflow-authoring-and-execution.md#state-and-data-implications)).
- `WorkflowStep` records one attempt of one node within a workflow run. See [Workflow Step Model](./workflow-step-model.md).
- `Run` (from the run state machine) is the execution primitive an agent step uses: `agent.run` starts its run through the run admission, and `agent.multi-agent` runs a lead and its helpers in the workflow run's session through `orchestration.runCreate`.
- `Agent` (from the [Agent And Run Model](./agent-and-run-model.md)) provides the execution persona for a step's work. A multi-agent step runs its lead and helpers as an orchestration run in the workflow run's own session.
- `Artifact` holds a step payload over 64 KiB, stored with `artifactType: 'workflow_output'`, the step row keeping its reference; a smaller payload is inline on the step row. Artifacts an agent publishes are outputs of the runs a step created, not of the workflow run itself.
- `Approval` primitives from Plan-009 are used by `human.approval` steps, and every resolution is recorded in `workflow_gate_resolutions`.
- `SessionEvent` transcript captures workflow lifecycle events (`workflow.phase_started`, `workflow.phase_completed`, `workflow.phase_failed`, `workflow.phase_suspended`, `workflow.step_canceled`, `workflow.resumed`, `workflow.canceled`, `workflow.gate_resolved`). The list is illustrative; the full set of `workflow.*` types is in [Spec-015 §Workflow Transcript Integration](../specs/015-workflow-authoring-and-execution.md#workflow-transcript-integration).

## State Model

### Workflow Run States

| State | Meaning |
| --- | --- |
| `new` | The workflow run has been created but no step has started. |
| `running` | At least one step is executing, or the run is advancing between steps. |
| `waiting` | A step of the run is waiting — on a person (an approval, a form or a chat reply), on a child run held behind its chain's question, or on a spent provider account — and the run is neither progressing nor finished. The wait's cause, and the resume instant where one was armed, are per-step state ([Spec-015 §Park integrity and cancelability (SA-40)](../specs/015-workflow-authoring-and-execution.md#park-integrity-and-cancelability-sa-40)). A step held by the memory gate before it starts reads `waiting-memory` and leaves the run `running`. |
| `succeeded` | Every step reached a terminal state and the run finished successfully. |
| `failed` | A step failed and its node's `onError` is `stop` (after the retries its node allows), a `flow.stop-error` step ran, or a set run cap elapsed. A run parked on a failed step reads `failed` while it waits, with `Resume` and `Cancel` both open. |
| `canceled` | The workflow run was explicitly canceled by a user or system action, through `workflow.runCancel` ([Spec-015 §Run control (SA-43)](../specs/015-workflow-authoring-and-execution.md#run-control-sa-43)). |
| `crashed` | The daemon restarted while the run was `new` or `running`, or in a state the sweep does not recognize, so the run was swept to this state on the next start. A run in `waiting` is never swept and is never pruned. |

Allowed transitions:

- `new -> running` (the first step starts)
- `running -> succeeded` (every step has settled and none failed the run)
- `running -> failed` (a failed step whose `onError` is `stop`, a `flow.stop-error` step, or a set run cap elapsing)
- `running -> waiting` (a step waits on a person, on a child run held behind its chain's question, or on a provider usage-limit reset)
- `waiting -> running` (the wait is answered, a person resumes a parked run, or a durable auto-resume schedule fires)
- `waiting -> failed` (a waiting step reaches its `Timeout` and its node's `onError` is `stop`; time a step waits never counts against the run cap)
- `failed -> running` (`Resume` on a run parked on a failed step runs that step again)
- `running -> canceled` (explicit cancellation)
- `waiting -> canceled` (a parked run is cancelable from `waiting` without precondition)
- `new -> canceled` (canceled before execution begins)
- `failed -> canceled` (`Cancel` on a run parked on a failed step, waiting on `Resume`)
- `new -> crashed`, `running -> crashed` (swept on daemon start)

### Workflow Definition (no state machine)

Workflow definitions do not have a lifecycle state machine. They exist once created and are versioned through `WorkflowVersion`. A definition carries these flags: whether it is enabled, which arms or disarms every one of its triggers and holds until someone changes it, and whether it is deleted. It also carries its own permission level, set on the workflow and starting at `YOLO`, outside the document's hashed body, so a change mints no version: every run of the workflow uses that level wherever the run lives, a chat's session or the workflow's own, and a change reaches a live run from its next step ([Spec-015 §Node-Kind Taxonomy](../specs/015-workflow-authoring-and-execution.md#node-kind-taxonomy)). It carries its tags the same way, outside the hashed body: the person sets them beside the workflow's name in the builder header and an agent through the authoring call, and a change saves at once and mints no version ([Spec-015 §State And Data Implications](../specs/015-workflow-authoring-and-execution.md#state-and-data-implications)). Deleting a workflow is a soft delete: the definition leaves every list and its triggers are never armed again, while its runs stay readable against the versions they are pinned to, and the delete reports how many there are. The values `Keep for later runs` kept for the workflow are deleted with it.

### Workflow Version (no state machine)

Versions are immutable once created. There is no version-level state to manage. The "active version" is determined by the highest version number for a given definition.

## Entity Hierarchy

```
WorkflowDefinition (1)
  └── WorkflowVersion (many, immutable)
        ├── definition_body (the canonical document: name, the trigger node, the nodes and the edges)
        └── WorkflowRun (many)
              └── WorkflowStep (one per node attempt)
```

## Example Flows

- Example: A user authors a workflow whose trigger feeds `analyze -> plan -> implement -> review`. The system creates a `WorkflowDefinition` with one `WorkflowVersion` holding the trigger and four nodes. Starting the workflow creates a `WorkflowRun` bound to that version, and each node leaves a `WorkflowStep` record as it runs.
- Example: A user edits the workflow to add a `test` node between `implement` and `review`. The system creates version 2. An already-running instance on version 1 continues with four nodes. New runs use version 2 with five.
- Example: A workflow is exported to a file. The file is a derivative copy in the one canonical file form. Later execution still binds to the canonical persisted definition version, not to the exported file, and importing the file creates a new definition through the ordinary create path.

## Edge Cases

- A workflow run may be canceled even if some steps have already succeeded. Their outputs remain addressable, and the suspension events in the log keep each wait's cause, while each waiting step reads `canceled` with its live wait members — its `waitCause`, its instants and its spent account — cleared.
- A workflow whose trigger feeds a single node is valid. A node that waits on a person holds the run `waiting` until it is answered; any other node runs and the run ends.
- A waiting run survives a daemon restart or a client reconnect with its parks, its step state persisted in `workflow_steps`, one row per step attempt. A run that was `new` or `running` when the daemon stopped is swept to `crashed` on the next start, and the person retries it from a step or runs it again; no step resumes mid-attempt.
- A full-tier Code step or a shell step whose sandbox cannot start at the Sandboxed level refuses with `workflow.sandbox_unavailable`, and the run takes the step's own `onError` from there; it never runs unprotected.

## Related Specs

- [Workflow Authoring And Execution](../specs/015-workflow-authoring-and-execution.md)
- [Multi-Agent Orchestration](../specs/014-multi-agent-orchestration.md)
- [Session Core](../specs/001-session-core.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
