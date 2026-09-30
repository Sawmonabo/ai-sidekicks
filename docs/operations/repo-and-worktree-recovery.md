# Repo And Worktree Recovery

## Purpose

Recover RepoMount records, workspace bindings, and worktrees when execution roots become stale, dirty in the wrong way, or unusable.

## Symptoms

- Repo attach or workspace bind fails
- Worktree creation fails or binds to the wrong branch context
- Workspace health becomes `stale`
- Scope and blast radius: one RepoMount, one workspace, or one worktree lineage

## Detection

- Read RepoMount and workspace health projections
- Compare canonical repo root, branch context, and worktree lifecycle state
- Inspect recent git-engine errors and diff-attribution failures

## Preconditions

- Access to the machine that holds the project's folder
- Ability to inspect and modify local worktree state
- Authority to retire or recreate affected worktrees

## Recovery Steps

1. Verify the canonical repo root still exists and is readable by the daemon on the machine that holds it.
2. Refresh repo and workspace projections before changing filesystem state.
3. If a worktree is failed or incompatible, retire it — `Remove` on it under its project on Settings › Runtime, or in the worktree switcher — and create a new clean worktree instead of mutating the broken one in place.
4. Rebind the workspace to the healthy execution root and refresh branch context.
5. Reopen Review only after the workspace and worktree state is healthy again, so its diff is read from the healthy tree.

## Validation

- RepoMount health returns to attached or healthy state
- Workspace binding resolves to the intended execution root
- One test diff or branch read succeeds against the recovered workspace

## Escalation

- When repo root canonicalization is inconsistent, repeated worktree creation fails, or local git state is damaged beyond safe automated recovery, report it to the project as a bug with the daemon's logs attached

## CLI Commands

```bash
sidekicks daemon status
```

The command line has no `workspace` or `worktree` command. A worktree the app made is removed from its project's row on Settings › Runtime or from the worktree switcher, and a project's folder is removed with `Delete` on Settings › Projects.

## SLOs and Thresholds

| Metric                   | Target |
| ------------------------ | ------ |
| Worktree creation        | < 10s  |
| Workspace rebind latency | < 5s   |
| Repo health check        | < 3s   |
| Worktree retire-to-clean | < 15s  |

## Who Runs It And Where To Report

- The machine belongs to one person, who runs this procedure on it; there is no paging, no chat alert and no on-call rotation.
- A repo or worktree that stays unusable after these steps is reported to the project as a bug, with the daemon's logs attached.

## Related Architecture Docs

- [Daemon Architecture](../architecture/daemon.md)

## Related Specs

- [Repo Attachment And Workspace Binding](../specs/007-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../specs/008-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../specs/009-gitflow-pr-and-diff-attribution.md)

## Related Plans

- [Repo Attachment And Workspace Binding](../plans/007-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../plans/008-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../plans/009-gitflow-pr-and-diff-attribution.md)
