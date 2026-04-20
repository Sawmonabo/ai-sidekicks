# Plan-017: Workflow Authoring And Execution

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `017` |
| **Slug** | `workflow-authoring-and-execution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-017: Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-016](./016-multi-agent-channels-and-orchestration.md) (orchestration), [Plan-004](./004-queue-steer-pause-resume.md) (queue/steer) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Updated Spec-017](../specs/017-workflow-authoring-and-execution.md); Plan-017 deferred to V1.1+ per [ADR-015 §V1 Feature Inventory](../decisions/015-v1-feature-scope-definition.md) — see [cross-plan-dependencies.md §V1.1+ Plans](../architecture/cross-plan-dependencies.md#v11-plans-out-of-v1-tier-set) |

## Goal

Implement versioned workflow definitions and durable workflow execution using the same session, run, approval, and artifact primitives as free-form collaboration.

## Scope

This plan covers workflow definition persistence, versioning, workflow run state, phase execution, phase outputs, and workflow-level gate resolution.

## Non-Goals

- Marketplace or global workflow distribution
- External workflow-engine integration
- Final workflow editor polish

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/workflows/`
- `packages/runtime-daemon/src/workflows/workflow-definition-service.ts`
- `packages/runtime-daemon/src/workflows/workflow-run-service.ts`
- `packages/runtime-daemon/src/workflows/phase-executor.ts`
- `packages/runtime-daemon/src/workflows/workflow-projector.ts`
- `packages/client-sdk/src/workflowClient.ts`
- `apps/desktop/renderer/src/workflows/`

## Data And Storage Changes

- Add durable `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_phase_states`, and workflow-gate records.
- Store phase outputs as artifact references or equivalent durable output records linked back to workflow version and phase id.
- Keep workflow definitions and versions as first-class persisted records rather than artifact manifests. Any workflow export artifact remains derivative only.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add `WorkflowDefinitionCreate`, `WorkflowDefinitionRead`, `WorkflowRunStart`, `PhaseOutputRead`, and `WorkflowGateResolve` to shared contracts and the typed client SDK.
- Carry workflow version ids, phase ids, and gate states through timeline and run-link events so workflow history remains replayable.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define workflow-definition, version, phase-state, gate, and definition-read contracts in shared packages.
   - Full type hierarchy: `WorkflowDefinition`, `WorkflowVersion`, `WorkflowPhaseDefinition`, `WorkflowRun`, `WorkflowPhaseRun`.
   - All 4 gate types: `auto-continue`, `quality-checks`, `human-approval`, `done`.
   - Entity separation: `WorkflowPhaseId` (identifies a phase in the definition) vs `PhaseRunId` (identifies a specific execution instance with iteration number, status, timestamps).
   - Failure behaviors per phase: `retry`, `go-back-to`, `stop`.
2. Implement durable workflow definition versioning and workflow-run persistence in the daemon. Persistence uses the LangGraph checkpoint pattern on the existing SQLite store (per Spec-015). No external workflow engines.
3. Implement phase execution, gate resolution, and restart-safe workflow resumption. V1 scope: `single-agent` and `automated` phase types only (`multi-agent` and `human` deferred to V1.1). Phase execution routes through `OrchestrationRunCreate` per Spec-016/017 constraints.
4. Add desktop workflow authoring and workflow-run visibility surfaces backed by the shared client SDK.

## Parallelization Notes

- Definition-versioning work and workflow-run persistence can proceed in parallel once contract ids and phase semantics are fixed.
- UI work should wait for phase-output and restart-resume semantics to stabilize.

## Test And Verification Plan

- Versioning tests proving running workflow instances stay pinned to the version they started on
- Restart and reconnect tests proving workflow phase state and gates survive daemon recovery
- Phase-output tests proving durable artifact references remain readable after workflow completion
- Definition-read tests proving workflow execution resolves from canonical definition records rather than derivative artifact exports

## Rollout Order

1. Land workflow definition and versioning contracts plus persistence
2. Enable sequential workflow execution and workflow-gate handling
3. Enable authoring surfaces and explicit parallel-phase execution where the definition allows it

## Rollback Or Fallback

- Disable workflow editing and keep execution to a smaller internal-definition set if versioning or resumption behavior regresses.

## Risks And Blockers

- Global workflow libraries remain out of scope and unresolved for the first implementation
- Workflow execution can drift from core session or run semantics if phase state is not modeled as durable product state
- Workflow exports can create confusion if the product blurs derivative artifact copies with the canonical definition store

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
