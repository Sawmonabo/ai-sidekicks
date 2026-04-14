# Spec-010: Worktree Lifecycle And Execution Modes

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `010` |
| **Slug** | `worktree-lifecycle-and-execution-modes` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md) |
| **Implementation Plan** | [Plan-010: Worktree Lifecycle And Execution Modes](../plans/010-worktree-lifecycle-and-execution-modes.md) |

## Purpose

Define the lifecycle of worktrees and the execution modes available for repo-bound runs.

## Scope

This spec covers local checkout mode, worktree mode, worktree creation and reuse, and worktree retirement.

## Non-Goals

- PR preparation details
- Merge policy
- Diff artifact rendering

## Domain Dependencies

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Deployment Topology](../architecture/deployment-topology.md)

## Required Behavior

- Repo-bound coding runs must default to `worktree` execution mode when the repository supports worktrees.
- `local` execution mode must be an explicit override, not the default for mutable coding runs.
- Starting a writable worktree-mode run must create or reuse a valid worktree before execution begins.
- The system must not silently fall back from intended worktree mode to mutating the main checkout.
- Worktree lifecycle must support `creating`, `ready`, `dirty`, `merged`, `retired`, and `failed`.
- Reusing an existing worktree must be explicit and must preserve branch and provenance context.

## Default Behavior

- Default branch naming pattern is `sidekick/<session-short-id>/<task-slug>`.
- Default writable coding runs use one dedicated worktree per active task or branch context.
- Worktree retirement defaults to preserving metadata and artifacts even when filesystem cleanup later removes the checkout.

## Fallback Behavior

- If a repo does not support worktrees, the system may offer an isolated directory workspace fallback, but it must mark that mode distinctly from normal worktree mode.
- If worktree creation fails, the run must remain blocked in setup rather than mutating the main checkout.
- If an intended reuse candidate is dirty or incompatible with the requested branch strategy, the system must require explicit user choice.

## Interfaces And Contracts

- `ExecutionModeSelect` must distinguish at least `local` and `worktree`.
- `WorktreePrepare` must create or bind the execution root before a run enters `running`.
- `WorktreeReuseCheck` must report branch, cleanliness, and compatibility.
- `WorktreeRetire` must record retirement even if filesystem deletion happens asynchronously.

## State And Data Implications

- Worktree records must persist branch name, owning repo mount, lifecycle state, and provenance to the creating session and run.
- Execution mode must be stored as run setup data.
- Dirty and merged state belong to daemon-owned workspace projections.

## Example Flows

- `Example: A user starts an implementation run. The daemon creates a dedicated worktree, binds the run to it, and only then starts provider execution.`
- `Example: A later follow-up run explicitly reuses the same worktree because it targets the same branch and task lineage.`

## Implementation Notes

- Branch-name defaults should be deterministic and human-readable, but collision handling must be explicit.
- Worktree reuse is valuable, but the system should bias toward isolation over convenience.
- Local mode remains important for read-only or special maintenance tasks, but it must stay clearly non-default for mutable coding work.

## Pitfalls To Avoid

- Mutating the main checkout as a hidden fallback
- Treating worktree reuse as implicit magic
- Losing run provenance when a worktree is later retired

## Acceptance Criteria

- [ ] A writable coding run on a git repo defaults to worktree mode.
- [ ] Worktree creation failure blocks the run instead of mutating the main checkout.
- [ ] Reused worktrees remain explicitly linked to branch and prior run context.

## ADR Triggers

- If worktree-first stops being the default execution strategy, create or update `../decisions/006-worktree-first-execution-mode.md`.

## Open Questions

- Whether branch prefix and slugging rules should be user-configurable in v1 or locked for consistency.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
