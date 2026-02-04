---
name: git
description: Advanced git workflows for parallel development and commit metadata. Use when working with git worktrees (multiple branches simultaneously, context switching without stashing, reviewing PRs while developing, branch isolation) or git notes (attaching metadata to commits, tracking review status, test results, audit trails without changing history). Triggers on "worktree", "git notes", "parallel branches", "multiple working directories", "commit metadata", "branch isolation".
---

# Git Advanced Workflows

Specialized guidance for git worktrees and git notes - features that enable parallel development and non-invasive commit metadata.

## Quick Reference

### Worktrees - Parallel Development

Work on multiple branches simultaneously without stashing or cloning.

```bash
# Create worktree for existing branch
git worktree add ../project-feature feature-branch

# Create worktree with new branch
git worktree add -b hotfix ../project-hotfix origin/main

# List all worktrees
git worktree list

# Remove when done
git worktree remove ../project-feature
```

**Key concept:** Each branch can only be checked out in ONE worktree. Switch contexts by changing directories.

For complete reference: `references/worktrees.md`

### Notes - Commit Metadata

Attach metadata to commits without modifying history.

```bash
# Add note to commit
git notes add -m "Reviewed-by: Alice" abc1234

# Use namespace for organization
git notes --ref=reviews add -m "APPROVED" abc1234

# View notes in log
git log --notes=reviews

# Share notes
git push origin refs/notes/reviews
```

**Key concept:** Notes are stored separately and never change commit SHAs.

For complete reference: `references/notes.md`

## When to Use What

| Scenario | Solution |
|----------|----------|
| Need to review PR while developing | Worktree |
| Urgent hotfix during feature work | Worktree |
| Compare code across branches | Worktree |
| Run long tests without blocking dev | Worktree |
| Track code review status | Notes |
| Record test results on commits | Notes |
| Add audit trail without rewriting | Notes |
| Supplement commit messages post-hoc | Notes |

## Common Workflows

### Hotfix While Feature Development

```bash
# Create isolated hotfix worktree
git worktree add -b hotfix-123 ../project-hotfix origin/main
cd ../project-hotfix

# Fix, commit, push
git commit -am "fix: critical bug"
git push origin hotfix-123

# Return and cleanup
cd ../project
git worktree remove ../project-hotfix
```

### Review Tracking with Notes

```bash
# Configure to show review notes
git config notes.displayRef refs/notes/reviews

# Mark commit as reviewed
git notes --ref=reviews add -m "Reviewed-by: $(git config user.name)" HEAD

# View review status
git log --notes=reviews --oneline -10
```

### Preserve Notes Through Rebase

```bash
git config notes.rewrite.rebase true
git config notes.rewriteMode concatenate
```

## Troubleshooting

### Worktrees

| Issue | Fix |
|-------|-----|
| "Branch already checked out" | `git worktree list` to find where, remove or use that worktree |
| Stale worktree after `rm -rf` | `git worktree prune` |
| Moved worktree manually | `git worktree repair` |

### Notes

| Issue | Fix |
|-------|-----|
| Notes not showing in log | `git log --notes=<ref>` or configure `notes.displayRef` |
| Notes lost after rebase | `git config notes.rewrite.rebase true` |
| Notes not on remote | `git push origin refs/notes/<name>` |
| "Note already exists" | Use `-f` to overwrite or `append` |

## References

- **Worktrees**: See `references/worktrees.md` for complete command reference, workflow patterns, and best practices
- **Notes**: See `references/notes.md` for complete command reference, namespaces, merging, and configuration
