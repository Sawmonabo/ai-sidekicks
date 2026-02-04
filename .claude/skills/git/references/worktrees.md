# Git Worktrees Reference

Git worktrees enable checking out multiple branches simultaneously in separate directories, all sharing the same repository.

**Core principle:** One worktree per active branch. Switch contexts by changing directories, not branches.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Main worktree** | Original working directory from `git clone` or `git init` |
| **Linked worktree** | Additional directories created with `git worktree add` |
| **Shared `.git`** | All worktrees share same Git object database (no duplication) |
| **Branch lock** | Each branch can only be checked out in ONE worktree at a time |
| **Worktree metadata** | Administrative files in `.git/worktrees/` tracking linked worktrees |

## Command Reference

### Create Worktree

```bash
# Existing branch
git worktree add ../feature-x feature-x

# New branch from HEAD
git worktree add -b new-feature ../new-feature

# New branch from specific commit
git worktree add -b hotfix-123 ../hotfix origin/main

# Track remote branch
git worktree add --track -b feature ../feature origin/feature

# Detached HEAD (experiments)
git worktree add --detach ../experiment HEAD~5
```

### List Worktrees

```bash
git worktree list           # Simple
git worktree list -v        # Verbose
git worktree list --porcelain  # Machine-readable
```

Example output:
```text
/home/user/project           abc1234 [main]
/home/user/project-feature   def5678 [feature-x]
```

### Remove Worktree

```bash
git worktree remove ../feature-x           # Clean only
git worktree remove --force ../feature-x   # Discard changes
```

### Move Worktree

```bash
git worktree move ../old-path ../new-path
```

### Lock/Unlock

```bash
git worktree lock ../feature-x
git worktree lock --reason "On USB drive" ../feature-x
git worktree unlock ../feature-x
```

### Maintenance

```bash
git worktree prune              # Remove stale metadata
git worktree prune --dry-run    # Preview
git worktree repair             # Fix after manual moves
git worktree repair ../path     # Repair specific worktree
```

## Workflow Patterns

### Feature + Hotfix in Parallel

```bash
# Create hotfix worktree from main
git worktree add -b hotfix-456 ../project-hotfix origin/main

# Work on hotfix
cd ../project-hotfix
git add . && git commit -m "fix: resolve critical bug #456"
git push origin hotfix-456

# Return to feature work
cd ../project
git worktree remove ../project-hotfix
```

### PR Review While Working

```bash
# Fetch PR and create worktree
git fetch origin pull/123/head:pr-123
git worktree add ../project-review pr-123

# Review
cd ../project-review
# ... run tests, inspect code ...

# Cleanup
cd ../project
git worktree remove ../project-review
git branch -d pr-123
```

### Compare Implementations

```bash
git worktree add ../project-v1 v1.0.0
git worktree add ../project-v2 v2.0.0

diff ../project-v1/src/module.js ../project-v2/src/module.js

git worktree remove ../project-v1
git worktree remove ../project-v2
```

### Long-Running Tasks

```bash
# Create isolated worktree for testing
git worktree add ../project-test main

# Run tests in background
cd ../project-test && npm test &

# Continue development
cd ../project
```

### Stable Reference

```bash
# Permanent main checkout
git worktree add ../project-main main
git worktree lock --reason "Reference checkout" ../project-main
```

## Directory Conventions

```text
~/projects/
  myproject/              # Main worktree
  myproject-feature-x/    # Feature branch
  myproject-hotfix/       # Hotfix
  myproject-review/       # Temporary PR review
```

**Naming:** `<project>-<purpose>` or `<project>-<branch>`

## Troubleshooting

### "Branch is already checked out"

Find where: `git worktree list`

Solution: Work in that worktree or remove it first.

### Stale worktree after manual deletion

Cause: Deleted directory without `git worktree remove`.

Fix: `git worktree prune`

### Worktree moved manually

Cause: Moved directory without `git worktree move`.

Fix: `git worktree repair` or `git worktree repair /new/path`

### Worktree on removed drive

Lock if temporary: `git worktree lock ../usb-worktree`

Prune if permanent: `git worktree prune`

## Best Practices

| Practice | Rationale |
|----------|-----------|
| Use sibling directories | Easy navigation (`../project-feature`) |
| Name by purpose | `project-review` > `project-pr-123` |
| Clean up promptly | Avoid confusion |
| Lock remote worktrees | Prevent pruning on network/USB |
| Use `--detach` for experiments | No throwaway branches |
| Commit before removing | Always commit/stash first |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using `rm -rf` to delete | Use `git worktree remove`, then `prune` if needed |
| Forgetting branch is locked | Run `git worktree list` first |
| Not cleaning up temp worktrees | Remove immediately after task |
| Creating nested worktrees | Use sibling directories |
| Moving directory manually | Use `git worktree move` or `repair` after |
