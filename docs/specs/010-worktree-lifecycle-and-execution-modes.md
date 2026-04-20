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

This spec covers `read-only`, `branch`, `worktree`, and `ephemeral clone` execution modes plus worktree creation, reuse, and retirement.

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
- [ADR-006: Worktree First Execution Mode](../decisions/006-worktree-first-execution-mode.md)

## Required Behavior

- Every repo-bound run must bind to exactly one canonical execution mode: `read-only`, `branch`, `worktree`, or `ephemeral clone`.
- Repo-bound coding runs must default to `worktree` execution mode when the repository supports worktrees.
- `read-only` mode must prohibit repo mutation and support inspection, review, and diagnostic tasks.
- `branch` mode must be an explicit writable override that uses an existing checkout with explicit branch context.
- Starting a writable worktree-mode run must create or reuse a valid worktree before execution begins.
- `ephemeral clone` mode must provision a disposable isolated clone before writable execution begins.
- The system must not silently fall back from intended worktree mode to mutating the main checkout.
- The system must not silently substitute one canonical execution mode for another when the requested mode is unavailable.
- Worktree lifecycle must support `creating`, `ready`, `dirty`, `merged`, `retired`, and `failed`.
- Reusing an existing worktree must be explicit and must preserve branch and provenance context.

## Default Behavior

- Default branch naming pattern is `sidekicks/<session-short-id>/<task-slug>`.
- Default writable coding runs use one dedicated worktree per active task or branch context.
- `branch` mode and `ephemeral clone` mode are explicit selections or policy-driven overrides, not hidden defaults.
- Worktree retirement defaults to preserving metadata and artifacts even when filesystem cleanup later removes the checkout.
- Worktree or ephemeral-clone preparation must not automatically execute repository setup scripts in v1.

## Fallback Behavior

- If a repo does not support worktrees, the system may offer `ephemeral clone` or explicit `branch` mode where safe, but it must mark the selected mode distinctly from normal worktree mode.
- If worktree creation fails, the run must remain blocked in setup rather than mutating the main checkout.
- If ephemeral clone preparation fails, the run must remain blocked in setup unless an operator or participant explicitly selects a different execution mode.
- If an intended reuse candidate is dirty or incompatible with the requested branch strategy, the system must require explicit user choice.
- If a repository requires setup commands before useful execution, v1 must surface them as explicit follow-on actions or workflow steps rather than hidden execution-root side effects.

## Interfaces And Contracts

- `ExecutionModeSelect` must distinguish `read-only`, `branch`, `worktree`, and `ephemeral clone`.
- `ExecutionRootPrepare` must create or bind the execution root required by the selected mode before a run enters `running`.
- `WorktreeReuseCheck` must report branch, cleanliness, and compatibility.
- `EphemeralClonePrepare` must report clone root, lifecycle, and cleanup policy.
- `WorktreeRetire` must record retirement even if filesystem deletion happens asynchronously.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Worktree records must persist branch name, owning repo mount, lifecycle state, and provenance to the creating session and run.
- Execution mode must be stored as run setup data.
- Branch context must be persisted for writable `branch`, `worktree`, and `ephemeral clone` runs.
- Dirty and merged state belong to daemon-owned workspace projections.

## Example Flows

- `Example: A user starts an implementation run. The daemon creates a dedicated worktree, binds the run to it, and only then starts provider execution.`
- `Example: A reviewer opens the repo in read-only mode, inspects diffs, and cannot accidentally mutate the checkout.`
- `Example: A repository cannot use worktrees safely, so a participant explicitly selects ephemeral clone mode and the daemon prepares a disposable clone for the writable run.`
- `Example: A later follow-up run explicitly reuses the same worktree because it targets the same branch and task lineage.`

## Implementation Notes

- Branch-name defaults should be deterministic and human-readable, but collision handling must be explicit.
- Worktree reuse is valuable, but the system should bias toward isolation over convenience.
- `branch` mode remains important for special maintenance tasks, but it must stay clearly non-default for mutable coding work.
- Repository bootstrap or setup commands should be modeled as explicit approved work, not as an implicit part of worktree creation.

## Pitfalls To Avoid

- Mutating the main checkout as a hidden fallback
- Treating worktree reuse as implicit magic
- Losing run provenance when a worktree is later retired

## Acceptance Criteria

- [ ] A writable coding run on a git repo defaults to worktree mode.
- [ ] The execution-mode contract distinguishes `read-only`, `branch`, `worktree`, and `ephemeral clone`.
- [ ] Worktree creation failure blocks the run instead of mutating the main checkout.
- [ ] Reused worktrees remain explicitly linked to branch and prior run context.

## ADR Triggers

- If worktree-first stops being the default execution strategy, create or update `../decisions/006-worktree-first-execution-mode.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: branch prefix and slugging rules are product-defined and locked for consistency in v1. User-configurable naming rules are deferred.
- V1 decision: repository setup scripts do not run automatically during worktree or ephemeral-clone preparation in the first implementation. Setup execution requires an explicit follow-on action under normal approval and policy rules.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
