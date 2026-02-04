# Comparing Multiple Claude Solutions with Git Worktrees

When exploring solutions with Claude, you may want to generate multiple plans or
implementations from the same starting point and compare them before committing
to one approach. Git worktrees provide an elegant way to manage this workflow.

## Table of Contents

- [Overview](#overview)
- [Worktrees Are Local](#worktrees-are-local)
  - [What Stays Local](#what-stays-local)
  - [What Can Optionally Be Pushed](#what-can-optionally-be-pushed)
- [Worktree Storage Location](#worktree-storage-location)
  - [Storage Options](#storage-options)
  - [Recommended Structure](#recommended-structure)
- [Git Worktree Approach](#git-worktree-approach)
  - [Setting Up Worktrees](#setting-up-worktrees)
  - [Running Claude in Each Worktree](#running-claude-in-each-worktree)
- [Comparing Solutions](#comparing-solutions)
  - [Command Line Diff](#command-line-diff)
  - [Visual Comparison](#visual-comparison)
- [Using Git Notes for Documentation](#using-git-notes-for-documentation)
  - [Adding Notes to Track Context](#adding-notes-to-track-context)
  - [Viewing Notes](#viewing-notes)
  - [Notes Persist After Merging](#notes-persist-after-merging)
- [Selecting and Merging the Best Solution](#selecting-and-merging-the-best-solution)
- [Cleanup](#cleanup)
- [Alternative: Plan-Only Comparison](#alternative-plan-only-comparison)
- [Best Practices](#best-practices)

## Overview

Git worktrees allow you to check out multiple branches simultaneously in
separate directories. This is ideal for:

- Generating N different solutions from the same starting point
- Running Claude sessions in parallel without conflicts
- Easily comparing implementations side-by-side
- Merging the best solution back to your main branch

## Worktrees Are Local

Git worktrees are **purely local** and do not need to be pushed or committed to
a remote repository.

### What Stays Local

| Component | Location | Pushed to Remote? |
|-----------|----------|-------------------|
| Worktree directories | `.claude/tmp/worktrees/solution-1/`, etc. | No |
| Worktree metadata | `.git/worktrees/` | No |
| Worktree list | Local git config | No |

### What Can Optionally Be Pushed

The **branches** you create in worktrees are regular git branches. You can push
them if needed:

```bash
# Push a branch from a worktree (optional)
cd .claude/tmp/worktrees/solution-1
git push -u origin solution-attempt-1
```

Pushing is only necessary if you want to:

- Back up your work remotely
- Collaborate with others on that branch
- Open a pull request for review

For comparing multiple Claude solutions locally, you typically:

1. Create worktrees and branches locally
2. Generate solutions in each
3. Compare locally
4. Merge the winner to your main branch
5. Push only the final merged result

```bash
# Only push the final result after merging
git checkout main
git merge solution-attempt-2
git push origin main  # Only this goes to remote
```

The worktrees and experimental branches can stay local and be deleted after
you're done.

## Worktree Storage Location

Worktrees can be stored inside or outside your repository. The modern best
practice is to keep them inside the repo in a dedicated, gitignored directory.

### Storage Options

| Location | Example | Pros | Cons |
|----------|---------|------|------|
| Inside repo (recommended) | `.claude/tmp/worktrees/` | Self-contained, follows tmp conventions | Must gitignore |
| Dedicated folder | `.worktrees/` | Simple, visible | Another gitignore entry |
| Sibling directories | `../solution-1` | Traditional | Clutters parent directory |
| External folder | `~/worktrees/myrepo/` | Centralized | Separated from project |

### Recommended Structure

Use a dedicated worktrees directory inside your repository's tmp folder:

```text
my-project/
├── .git/
├── .gitignore              # Contains ".claude/tmp/"
├── .claude/
│   └── tmp/                # Gitignored - temp files live here
│       └── worktrees/      # Worktrees stored here
│           ├── solution-1/
│           ├── solution-2/
│           └── solution-3/
├── src/
└── package.json
```

**One-time setup:**

```bash
# Ensure .claude/tmp/ is gitignored (may already be configured)
echo ".claude/tmp/" >> .gitignore
mkdir -p .claude/tmp/worktrees
```

**Key rules:**

- Worktrees inside the repo **must be gitignored** - git won't allow creating
  worktrees inside tracked paths
- Worktrees **cannot be nested** - one worktree cannot contain another
- Worktree **metadata stays in the main repo** at `.git/worktrees/` regardless
  of where worktree directories are stored

## Git Worktree Approach

### Setting Up Worktrees

First, create a base branch at the point where you want to explore solutions:

```bash
# Ensure you're at the commit where exploration should begin
git checkout -b explore-base
```

Then create N worktrees for N parallel solution attempts:

```bash
# Create the worktrees directory if it doesn't exist
mkdir -p .claude/tmp/worktrees

# Create three worktrees for three parallel attempts
git worktree add .claude/tmp/worktrees/solution-1 -b solution-attempt-1
git worktree add .claude/tmp/worktrees/solution-2 -b solution-attempt-2
git worktree add .claude/tmp/worktrees/solution-3 -b solution-attempt-3
```

This creates three directories inside `.claude/tmp/worktrees/`, each containing
a full working copy starting from the same commit.

### Running Claude in Each Worktree

Open separate terminal sessions for each worktree:

```bash
# Terminal 1
cd .claude/tmp/worktrees/solution-1
claude  # Generate solution A

# Terminal 2
cd .claude/tmp/worktrees/solution-2
claude  # Generate solution B

# Terminal 3
cd .claude/tmp/worktrees/solution-3
claude  # Generate solution C
```

Each Claude session operates independently on its own branch.

## Comparing Solutions

### Command Line Diff

Compare any two solution branches directly:

```bash
# Compare solution 1 and solution 2
git diff solution-attempt-1 solution-attempt-2

# Compare solution 2 and solution 3
git diff solution-attempt-2 solution-attempt-3

# See what changed from the base in each solution
git diff explore-base..solution-attempt-1
git diff explore-base..solution-attempt-2
git diff explore-base..solution-attempt-3
```

### Visual Comparison

Use visual diff tools for easier comparison:

```bash
# Using git's configured difftool
git difftool solution-attempt-1 solution-attempt-2

# View commit history for each attempt
git log --oneline explore-base..solution-attempt-1
git log --oneline explore-base..solution-attempt-2
git log --oneline explore-base..solution-attempt-3

# Compare file statistics
git diff --stat explore-base..solution-attempt-1
git diff --stat explore-base..solution-attempt-2
```

## Using Git Notes for Documentation

Git notes allow you to attach metadata to commits without modifying commit
history. This is useful for documenting:

- **The problem** being solved (on the base commit)
- **The approach** taken in each solution branch
- **Evaluation notes** after comparing solutions
- **Decision rationale** for why one solution was chosen

### Adding Notes to Track Context

When setting up the exploration, document the problem on the base commit:

```bash
# Create base branch and document the problem
git checkout -b explore-base
git notes add -m "Problem: Auth tokens expire without refresh mechanism.
Goal: Implement token refresh with minimal breaking changes.
Constraints: Must maintain backward compatibility with existing clients."
```

After creating worktrees and implementing solutions, add notes describing each
approach:

```bash
# In solution-1 worktree, after committing your implementation
cd .claude/tmp/worktrees/solution-1
git notes add -m "Approach: JWT refresh tokens with sliding expiration.
Trade-offs: More complex implementation, but fully stateless.
Files changed: auth.ts, middleware.ts, token-service.ts"

# In solution-2 worktree
cd .claude/tmp/worktrees/solution-2
git notes add -m "Approach: Extend server-side session on activity.
Trade-offs: Simpler code, but requires Redis for session storage.
Files changed: session.ts, middleware.ts"
```

You can also add notes to specific commits within a branch:

```bash
# Add note to a specific commit
git notes add <commit-hash> -m "This commit handles the edge case for expired
tokens during active requests."
```

### Viewing Notes

View notes alongside commit logs:

```bash
# Show notes in log output
git log --show-notes

# View notes across all branches
git log --all --show-notes --oneline

# View a specific commit's note
git notes show HEAD

# View note on the base commit
git notes show explore-base
```

Compare approaches by viewing notes from each branch:

```bash
# Quick comparison of approaches
echo "=== Solution 1 ===" && git notes show solution-attempt-1
echo "=== Solution 2 ===" && git notes show solution-attempt-2
echo "=== Solution 3 ===" && git notes show solution-attempt-3
```

### Notes Persist After Merging

Notes remain accessible even after merging and cleanup:

```bash
# After merging the winning solution
git checkout main
git merge solution-jwt-refresh

# Notes are still accessible by commit hash or ref
git notes show <original-commit-hash>

# Add a final note documenting the decision
git notes add HEAD -m "Selected JWT refresh approach.
Reasoning: Better scalability, no additional infrastructure needed.
Rejected alternatives: Session extension (required Redis)."
```

To share notes with your team (optional):

```bash
# Push notes to remote
git push origin refs/notes/commits

# Fetch notes from remote
git fetch origin refs/notes/commits:refs/notes/commits
```

## Selecting and Merging the Best Solution

Once you've reviewed all solutions and chosen the best one:

```bash
# Switch to your target branch (e.g., main or develop)
git checkout main

# Merge the winning solution (e.g., solution-attempt-2)
git merge solution-attempt-2 -m "Merge solution: descriptive message"
```

If you want to cherry-pick specific commits from different solutions:

```bash
# Cherry-pick specific commits from different attempts
git cherry-pick <commit-hash-from-solution-1>
git cherry-pick <commit-hash-from-solution-3>
```

## Cleanup

After merging your chosen solution, clean up the worktrees and branches:

```bash
# Remove worktree directories
git worktree remove .claude/tmp/worktrees/solution-1
git worktree remove .claude/tmp/worktrees/solution-2
git worktree remove .claude/tmp/worktrees/solution-3

# Delete branches you no longer need
git branch -D solution-attempt-1
git branch -D solution-attempt-3

# Keep or delete the winning branch as needed
git branch -d solution-attempt-2  # Safe delete if already merged

# Remove the exploration base branch
git branch -D explore-base
```

Verify cleanup is complete:

```bash
# List remaining worktrees (should only show main worktree)
git worktree list

# List branches to confirm cleanup
git branch -a
```

## Alternative: Plan-Only Comparison

If you only want to compare **plans** before any implementation:

```bash
# Create a plans directory for the session
mkdir -p .claude/tmp/sessions/$(date +%Y-%m-%d)/plans
```

Then run Claude multiple times, asking it to enter plan mode each time. Save
each plan to a numbered file before approving:

| Plan File | Description |
|-----------|-------------|
| `plan-1.md` | First approach - conservative refactor |
| `plan-2.md` | Second approach - complete rewrite |
| `plan-3.md` | Third approach - incremental changes |

Compare the plan files and approve only the one you want to implement.

## Best Practices

1. **Name branches descriptively** - Use names like `solution-auth-jwt` and
   `solution-auth-session` instead of generic numbers when the approaches differ
   fundamentally.

2. **Commit frequently in each worktree** - This makes it easier to cherry-pick
   specific changes later.

3. **Document your evaluation** - Keep notes on why you chose one solution over
   others for future reference.

4. **Use consistent prompts** - When generating multiple solutions, use the same
   initial prompt to ensure fair comparison.

5. **Consider hybrid solutions** - Sometimes the best result combines elements
   from multiple attempts.

6. **Clean up promptly** - Remove worktrees and branches after making your
   decision to avoid confusion.
