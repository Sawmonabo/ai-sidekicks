# Spec-011: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `011` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| **Implementation Plan** | [Plan-011: Gitflow PR And Diff Attribution](../plans/011-gitflow-pr-and-diff-attribution.md) |

## Purpose

Define the branch, PR, and diff-attribution behavior for repo-bound coding runs.

## Scope

This spec covers branch strategy, PR preparation, diff artifacts, and attribution quality levels.

## Non-Goals

- Code review workflow semantics beyond diff publication
- Git hosting vendor-specific features
- Merge automation policy

## Domain Dependencies

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- Every writable coding run in `branch`, `worktree`, or `ephemeral clone` mode must execute against an explicit branch context.
- The git engine must track base branch, head branch, and worktree association for each writable coding context.
- Diff artifacts must carry provenance to the producing run when that attribution is available.
- DiffArtifact is a specialized artifact with `artifactType: "diff"` in the shared manifest envelope (defined in Spec-014).
- When precise run attribution is unavailable, the system must emit a clearly labeled workspace-level diff artifact rather than implying precise run attribution.
- Code attribution uses Agent Trace standard + git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent-name>`) for both commit-level and line-level provenance.
- PR preparation must use the recorded base and head branch context rather than inferring it from the currently selected client tab.
- Commit, push, and PR preparation actions must be reviewable before execution.

## Default Behavior

- The default PR target branch is the worktree's recorded base branch.
- The default attribution mode is `run_attributed` when the daemon can correlate a diff to run provenance.
- `read-only` runs do not produce writable branch context or PR-preparation side effects.
- If multiple commits occur within one worktree during one run lineage, the system may prepare one cumulative PR by default.

## Fallback Behavior

- If precise attribution fails, the system must emit `workspace_fallback` diff artifacts with explicit labeling.
- If git hosting integration is unavailable, the system must still produce a PR-ready branch summary and diff artifact bundle.
- If the current branch is already checked out in an incompatible execution context, the system must require explicit user choice before proceeding.

## Interfaces And Contracts

- `BranchContextRead` must expose base, head, upstream, and worktree association.
- `DiffArtifactCreate` must identify attribution mode and compared states.
- `PRPrepare` must generate a reviewable proposal before any remote mutation.
- `GitActionExecute` must preserve causation to the requesting run or participant.
- Git hosting uses a `GitHostingAdapter` interface with `gh` CLI as the V1 implementation. Normalized terminology: `createChangeRequest` (not `createPullRequest`). Auto-detect provider from git remote URL.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.

## State And Data Implications

- Branch and PR metadata belong to daemon-owned git projections.
- Diff artifacts must store attribution mode, provenance, and compared-state identifiers.
- The `diff_artifacts` table references `artifact_manifests` via foreign key. Plan-014 (artifacts) is a dependency of Plan-011 (git flow).
- Reviewable git actions require durable audit records.

## Example Flows

- `Example: A coding run edits files in a worktree, publishes a run-attributed diff artifact, and later prepares a PR against the recorded base branch.`
- `Example: Attribution metadata is incomplete after a recovery path. The system publishes a workspace fallback diff artifact and labels it as such in the timeline.`

## Implementation Notes

- Attribution quality is a first-class field, not an inferred UI decoration.
- PR preparation and diff production are related but distinct operations.
- Head or base branch changes after worktree creation must be explicit updates to the stored branch context.

## Pitfalls To Avoid

- Pretending workspace diffs are run-attributed when they are not
- Inferring PR base or head from transient client state
- Mutating remote git state without a reviewable preparation step

## Acceptance Criteria

- [ ] Writable coding runs in `branch`, `worktree`, or `ephemeral clone` mode always have an explicit branch context.
- [ ] Diff artifacts distinguish run-attributed and workspace-fallback attribution modes.
- [ ] PR preparation produces a reviewable proposal tied to base and head branch context.

## ADR Triggers

- If the system abandons worktree-centered gitflow as the default coding path, create or update `../decisions/006-worktree-first-execution-mode.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: stacked PR workflows are deferred. The first release supports single-branch, single-PR proposal flow only.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md)
- [Spec-014](./014-artifacts-files-and-attachments.md)
