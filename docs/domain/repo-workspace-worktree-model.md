# Repo Workspace Worktree Model

## Purpose

Define the code-bearing execution surfaces used by sessions and runs.

## Scope

This document covers `RepoMount`, `Workspace`, and `Worktree`.

## Definitions

- `RepoMount`: a repository attached to a session.
- `Workspace`: a session-bound execution context rooted at a directory or checkout.
- `Worktree`: an isolated checkout derived from a repository and used as a write target.

## What This Is

This model explains how a session gains code context, how execution roots are chosen, and how isolation is maintained for coding runs.

## What This Is Not

- A repo mount is not itself a workspace.
- A workspace is not automatically a git worktree.
- A worktree is not a branch name.

## Invariants

- Every repo mount belongs to exactly one session.
- A workspace must resolve to one concrete filesystem root at execution time.
- A worktree must belong to one repo mount.
- Worktree-backed execution is the default for coding runs when the repository supports it.
- The main checkout must not be the default write target for agent editing.

## Relationships To Adjacent Concepts

- `RuntimeNode` provides the local filesystem access and git operations used by repo mounts and workspaces.
- `Run` executes against a workspace.
- `DiffArtifact` compares workspace or repository states over time.
- `Approval` can gate worktree creation, workspace binding changes, or branch promotion.

## Lifecycle

Repo mount lifecycle:

| State | Meaning |
| --- | --- |
| `attached` | The repository is available to the session. |
| `detached` | The repository is no longer mounted for active work. |
| `archived` | The repository remains referenced historically but is not active. |

Workspace lifecycle:

| State | Meaning |
| --- | --- |
| `provisioning` | The execution root is being prepared. |
| `ready` | The workspace is valid for execution. |
| `busy` | The workspace is currently bound to active work. |
| `stale` | The workspace exists but needs refresh or repair before safe execution. |
| `archived` | The workspace is historical only. |

Worktree lifecycle:

| State | Meaning |
| --- | --- |
| `creating` | The worktree is being created or rebound. |
| `ready` | The worktree is available for execution. |
| `dirty` | The worktree contains uncommitted changes. |
| `merged` | The worktree's branch has been integrated and can be retired. |
| `retired` | The worktree is intentionally preserved but no longer active. |
| `failed` | Creation or maintenance of the worktree failed. |

## Example Flows

- Example: A participant attaches a repository to a session, provisions a coding workspace backed by a feature worktree, and binds the next run to that workspace.
- Example: A reviewer run opens the same repo mount in a read-only workspace while the implementer continues on a dedicated worktree.
- Example: A merged feature branch marks its worktree `merged`, after which the worktree can be retired without deleting the historical artifacts tied to that workspace.

## Edge Cases

- A session can use a plain directory workspace when no git repository is available, but the worktree model applies whenever a repo mount is present.
- Two runs may reuse the same worktree only under explicit concurrency rules; reuse is not implicit.
- A stale workspace can remain historically linked to completed runs even after the filesystem path is no longer usable.

## Related Specs

- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../specs/011-gitflow-pr-and-diff-attribution.md)

## Related ADRs

- [Worktree First Execution Mode](../decisions/006-worktree-first-execution-mode.md)
