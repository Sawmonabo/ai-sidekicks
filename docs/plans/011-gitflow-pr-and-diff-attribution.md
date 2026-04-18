# Plan-011: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `011` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-011: Gitflow PR And Diff Attribution](../specs/011-gitflow-pr-and-diff-attribution.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) (worktree infrastructure), [Plan-014](./014-artifacts-files-and-attachments.md) (artifact manifests) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Updated Spec-011](../specs/011-gitflow-pr-and-diff-attribution.md) (Agent Trace attribution, GitHostingAdapter) |

## Goal

Implement branch-context tracking, reviewable PR preparation, and diff attribution quality modes.

## Scope

This plan covers branch context persistence for writable execution modes, diff artifact generation, PR preparation records, and desktop review surfaces.

## Non-Goals

- Final merge automation
- Full GitHub or git-host integration breadth
- Workflow-specific review logic

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/gitflow.ts`
- `packages/runtime-daemon/src/git/branch-context-service.ts`
- `packages/runtime-daemon/src/artifacts/diff-artifact-service.ts`
- `packages/runtime-daemon/src/git/pr-preparation-service.ts`
- `packages/client-sdk/src/gitflowClient.ts`
- `apps/desktop/renderer/src/diff-review/`

## Data And Storage Changes

- Add local `diff_artifacts`, `branch_contexts`, and `pr_preparations` tables.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add branch-context read, diff artifact read, and PR prepare APIs to the client SDK.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Implement branch-context persistence tied to writable execution modes and runs.
2. Build diff artifact generation with explicit attribution mode. Use Agent Trace standard and git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent-name>`) for commit-level and line-level provenance. DiffArtifact is a specialized artifact (`artifactType: "diff"`) using the OCI manifest envelope defined in Spec-014.
3. Build reviewable PR preparation records and remote mutation handoff. Implement the `GitHostingAdapter` interface with `gh` CLI as the V1 backend; use normalized `createChangeRequest` terminology and auto-detect provider from the git remote URL.
4. Add desktop diff and PR preparation review surfaces.

## Parallelization Notes

- Diff artifact generation and PR preparation services can progress in parallel once branch-context schema exists.
- Desktop review UI should wait for attribution mode and artifact payload contracts.

## Test And Verification Plan

- Attribution-mode tests for run-attributed versus workspace-fallback diffs
- PR preparation contract tests
- Manual verification from writable run to diff review to PR prepare

## Rollout Order

1. Ship branch context and diff artifact generation
2. Enable read-only review surfaces
3. Enable PR preparation and remote mutation handoff

## Rollback Or Fallback

- Disable remote PR preparation and keep local diff artifact generation if hosting integration regresses.

## Risks And Blockers

- Attribution quality may degrade unexpectedly after recovery or manual git changes
- Host integration variability may delay end-to-end PR flows

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
