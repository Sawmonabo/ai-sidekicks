# Spec-017: Workflow Authoring And Execution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `017` |
| **Slug** | `workflow-authoring-and-execution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Multi Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md), [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md), [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md) |
| **Implementation Plan** | [Plan-017: Workflow Authoring And Execution](../plans/017-workflow-authoring-and-execution.md) |

## Purpose

Define how reusable workflows are authored, versioned, and executed inside sessions.

## Scope

This spec covers workflow definitions, phase execution, phase outputs, and workflow-level gates.

## Non-Goals

- General-purpose external workflow engines
- Marketplace or sharing semantics for workflow templates
- Full UI design for workflow editors

## Domain Dependencies

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)

## Required Behavior

- V1 scope: `single-agent` and `automated` phase types. All 4 gate types (`auto-continue`, `quality-checks`, `human-approval`, `done`). Sequential phase execution. `multi-agent` and `human` phase types deferred to V1.1.
- Full type hierarchy (define now, implement V1 subset):
  - Phase types: `single-agent`, `multi-agent` (V1.1), `automated`, `human` (V1.1)
  - Gate types: `auto-continue`, `quality-checks`, `human-approval`, `done`
  - Failure behaviors: `retry`, `go-back-to`, `stop`
  - Phase run statuses: `pending`, `running`, `completed`, `failed`, `skipped`
  - Gate result statuses: `passed`, `failed`, `waiting-human`
- Workflows must be authored as explicit phase definitions with stable ids and versioned structure.
- Workflow definitions must be stored as first-class durable definition and version records. Artifact publication may represent workflow exports or summaries, but it must not be the canonical source of workflow definition truth.
- A workflow phase may create runs, request approvals, emit artifacts, or block on participant input.
- Workflow execution must remain visible in the session timeline and must preserve per-phase provenance.
- Phase outputs must be durable and addressable after workflow completion.
- Workflow execution must be resumable after daemon restart or client reconnect.
- All phase execution routes through existing `OrchestrationRunCreate` per Spec-016/017 constraints.

## Default Behavior

- Workflow phases default to sequential execution unless the definition explicitly marks safe parallelism.
- Each phase defaults to one primary target channel and one primary producing run.
- Workflow definitions default to immutable-by-version: editing a workflow creates a new version rather than mutating a running definition in place.
- Workflow definition reads default to the canonical persisted definition record for the requested scope and version rather than to an artifact manifest.

## Fallback Behavior

- If a later phase depends on unavailable capabilities, the workflow must pause in a blocked state instead of silently skipping the phase.
- If a workflow definition changes while an older version is running, the running instance must continue on the version it started with.
- If a phase output is large or unavailable inline, the workflow timeline must link to a durable artifact reference instead of dropping the output.

## Interfaces And Contracts

- `WorkflowDefinitionCreate` must persist phase definitions and version metadata.
- `WorkflowDefinitionRead` must return the canonical definition record and selected version metadata for the requested scope.
- `WorkflowRunStart` must bind a workflow version to a session and create phase execution state.
- Definition/execution entity separation: `WorkflowPhaseId` identifies a phase in the definition (static); `PhaseRunId` identifies a specific execution (with iteration number, status, timestamps).
- `PhaseOutputRead` must expose durable phase outputs and artifact references.
- `WorkflowGateResolve` must resolve workflow-scoped approvals or participant questions.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.

## State And Data Implications

- Workflow definitions, versions, and phase outputs must be durable and replayable.
- Workflow definitions and workflow versions are first-class persisted records distinct from artifact manifests.
- Running workflows require phase-state persistence separate from UI state.
- Workflow and run histories must remain cross-linked for audit and replay.
- Optional workflow exports, previews, or summaries may be published as artifacts, but those artifacts are derivative views and must not replace the canonical definition store.

## Example Flows

- Example: A workflow runs `analyze -> plan -> implement -> review`, pausing between plan and implement for a human approval gate.
- Example: A workflow is edited after one instance has already started. The running instance continues on the old version while new runs use the new version.
- Example: A project-scoped workflow definition is exported as a review artifact for discussion. Later workflow execution still binds to the canonical persisted definition version rather than to the artifact copy.

## Implementation Notes

- Workflow authoring belongs in the product, but workflow execution still uses the same run, approval, and artifact primitives as free-form sessions.
- Version immutability simplifies replay and support.
- Phase-level parallelism should remain explicit and bounded.
- Persistence uses LangGraph-inspired checkpoint pattern on existing SQLite store (Spec-015). No external workflow engines (Temporal, Restate) -- contradicts ADR-002 (local-first).

## Pitfalls To Avoid

- Mutating running workflow definitions in place
- Hiding workflow phase outputs outside the session timeline
- Treating workflow pause as a UI-only banner with no durable execution state

## Acceptance Criteria

- [ ] Workflows can be authored as versioned phase definitions.
- [ ] Workflow runs survive reconnect and restart with phase state intact.
- [ ] Workflow phase outputs remain addressable after workflow completion.

## ADR Triggers

- If workflow execution requires a materially different orchestration model than session and run primitives allow, create a new ADR before implementation.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: the first implementation supports session-scoped and project-scoped workflow definitions only. Global workflow libraries are out of scope.
- V1 decision: workflow definitions are canonical durable definition records, not canonical artifacts. Artifact publication is allowed only for derivative exports, previews, or summaries.

## References

- [Multi Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
