# Repo Workspace Worktree Model

## Purpose

Define the code-bearing execution contexts used by sessions and runs.

## Scope

This document covers `RepoMount`, `Workspace`, `Worktree`, and the places a session works in.

## Definitions

- `RepoMount`: a git repository attached to the machine as a project's folder, once per machine; every session of that project binds to it. A chat's managed workspace is a mount too, with a managed origin naming its one chat.
- `Workspace`: a session's execution context, rooted at one checkout: the project's checkout, a worktree the daemon created, or a chat's managed workspace.
- `Worktree`: an isolated checkout derived from a repository and used as a write target.
- `ExecutionMode`: which of the two places a session's runs work in: `bound-root` (the root already bound to the workspace) or `provisioned-worktree` (a worktree the daemon's worktree lifecycle made).

## What This Is

This model explains how a session gains code context, how execution roots are chosen, and how isolation is maintained for coding runs.

## What This Is Not

- A repo mount is not itself a workspace.
- A workspace is not automatically a git worktree.
- A worktree is not a branch name.
- An execution mode is not itself a workspace lifecycle state.

## Invariants

- A repository is attached once per machine: one repo mount, which any number of that project's sessions bind to. A chat's managed workspace is the one mount a single session owns.
- Every repo mount is a git repository; a folder that is not one is refused at attach.
- A workspace must resolve to one concrete filesystem root at execution time.
- A worktree must belong to one repo mount.
- Every repo-bound run works in exactly one of the places.
- A new project session starts in a new worktree of its own unless the person chose the project's checkout when creating it; the machine's default for a new project session is a setting whose own default is a new worktree.
- The daemon never moves a session into the project's checkout on its own: the checkout is a place the person picks.

## Relationships To Adjacent Concepts

- `RuntimeNode` provides the local filesystem access and git operations used by repo mounts and workspaces.
- `Run` executes against a workspace.
- A diff compares workspace or repository states; the daemon reads it each time Review shows it, and it is not an artifact.
- `Approval` can gate worktree creation, workspace binding changes, or branch promotion.
- `ExecutionMode` says whether a run works in the checkout its workspace is bound to or in a worktree of its own. How much the run may change is the session's permission level, never its place.

## Execution Mode Model

| Mode | Meaning |
| --- | --- |
| `bound-root` | The run works at the root already bound to its workspace — the project's checkout, or a chat's managed workspace — and the daemon makes nothing. It carries no worktree. |
| `provisioned-worktree` | The run works in a worktree the daemon's worktree lifecycle made, created for the session or reused; reuse accepts only a worktree this daemon created. This is where a new project session starts by default. |

- A project session works in one of these places; a chat session is always `bound-root` on its own managed workspace and never gets a worktree.
- There is no read-only place and no disposable copy: how much a session may change is its permission level.
- `ExecutionMode` holds whether the bound root is the repository's main working tree or a linked worktree.

## Lifecycle

Repo mount lifecycle:

| State      | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `attached` | The repository is available to the sessions of its project.       |
| `detached` | The repository is no longer mounted for active work.              |
| `archived` | The repository remains referenced historically but is not active. |

Workspace lifecycle:

| State       | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `preparing` | The execution root is being made ready, for either place.               |
| `ready`     | The workspace is valid for execution.                                   |
| `stale`     | The workspace exists but needs refresh or repair before safe execution. |
| `archived`  | The workspace is historical only.                                       |

Worktree lifecycle:

| State      | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| `creating` | The worktree is being created or rebound.                     |
| `ready`    | The worktree is available for execution.                      |
| `dirty`    | The worktree contains uncommitted changes.                    |
| `merged`   | The worktree's branch has been integrated and can be retired. |
| `retired`  | The worktree is intentionally preserved but no longer active. |
| `failed`   | Creation or maintenance of the worktree failed.               |

## Example Flows

- Example: A person attaches a repository as a project and starts a session in it; the session starts in a new worktree of its own, and its runs work there.
- Example: A second session of the same project works at the `Read-only` permission level in the project's checkout, reviewing, while the first continues in its own worktree.
- Example: Two sessions work in one worktree at the same time; nothing holds the folder for either one's turn, and `Undo to here` in one puts back only what that session changed.
- Example: A merged feature branch marks its worktree `merged`, after which the worktree can be retired without deleting the historical artifacts tied to that workspace.

## Edge Cases

- A folder that is not a git repository is refused at attach (`Could not attach: not a git repository`): a project is a repository, and a chat's own folder is one from its first byte.
- Two sessions may work in one worktree, or in the project's checkout, at the same time: nothing holds a folder for one session's turn, and `Undo to here` puts back only its own session's changes, naming a file another session also changed and leaving it unless the person includes it.
- A stale workspace can remain historically linked to completed runs even after the filesystem path is no longer usable.

## Related Specs

- [Repo Attachment And Workspace Binding](../specs/007-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../specs/008-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../specs/009-gitflow-pr-and-diff-attribution.md)

## Related ADRs

- [Worktree First Execution Mode](../decisions/006-worktree-first-execution-mode.md)
