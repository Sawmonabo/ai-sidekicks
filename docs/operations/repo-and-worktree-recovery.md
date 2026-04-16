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

- Access to the RuntimeNode that owns the RepoMount
- Ability to inspect and modify local worktree state
- Authority to retire or recreate affected worktrees

## Recovery Steps

1. Verify the canonical repo root still exists and is readable by the owning runtime node.
2. Refresh repo and workspace projections before changing filesystem state.
3. If a worktree is failed or incompatible, retire it and create a new clean worktree instead of mutating the broken one in place.
4. Rebind the workspace to the healthy execution root and refresh branch context.
5. Regenerate diff artifacts only after the workspace and worktree state is healthy again.

## Validation

- RepoMount health returns to attached or healthy state
- Workspace binding resolves to the intended execution root
- One test diff or branch read succeeds against the recovered workspace

## Escalation

- Escalate when repo root canonicalization is inconsistent, repeated worktree creation fails, or local git state is damaged beyond safe automated recovery

## CLI Commands

```bash
sidekicks workspace list --session <id>
sidekicks worktree list --repo <mount-id>
sidekicks worktree retire <worktree-id>
sidekicks workspace reprovision <workspace-id>
sidekicks workspace health --session <id>
sidekicks worktree create --repo <mount-id> --branch <name>
```

## SLOs and Thresholds

| Metric | Target |
|---|---|
| Worktree creation | < 10s |
| Workspace rebind latency | < 5s |
| Repo health check | < 3s |
| Worktree retire-to-clean | < 15s |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Repo and worktree issues route to **platform on-call**.

## Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)

## Related Specs

- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../specs/011-gitflow-pr-and-diff-attribution.md)

## Related Plans

- [Repo Attachment And Workspace Binding](../plans/009-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../plans/010-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../plans/011-gitflow-pr-and-diff-attribution.md)
