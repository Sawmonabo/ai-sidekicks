# State Recovery

Resumption protocol when a Claude session ends mid-PR (compaction, crash, or explicit handoff).

## Why this matters

Per ADR-024, the canonicality order is **branch commits > TaskCreate > PR description**. The branch is the durable cross-session truth; TaskCreate is in-session bookkeeping. On resume, you read the branch first and reconstruct intent from there.

Do not assume TaskCreate state survived. Do not trust a PR description's "next steps" section as authoritative — it can lag the branch by minutes.

## Resumption checklist

When the user says `resume Plan-NNN` or `continue Plan-NNN`, or when you find yourself on a `feat/plan-NNN-*` branch with an open draft PR at session start:

### 1. Read the branch

```bash
git branch --show-current
git log --oneline develop..HEAD
git status --short
```

The current branch tells you which plan + (typically) which PR. The commit log tells you how far implementation progressed. `git status` tells you whether there's uncommitted work — if there is, **decide whether to commit it before proceeding**, do not silently discard.

### 2. Read the PR

```bash
gh pr view --json number,title,isDraft,statusCheckRollup,reviews
```

Confirm:
- PR exists and matches the branch.
- Draft vs ready (ready means CI is the next gate; draft means we're still implementing or reviewing).
- CI status (green / pending / failed).
- Any reviews already submitted (rare for AI-only sessions, but check).

### 3. Read TaskList

```
TaskList()
```

Find any in_progress tasks tagged for this plan / PR. They tell you the *intent* of where you paused. If TaskList is empty (new session), that's fine — the branch and PR tell you the state.

### 4. Re-read the plan task

Read the plan section for this PR (`docs/plans/NNN-*.md` PR #M). Compare the plan task's deliverables against the branch's current commits. The delta is what's left to do.

### 5. Decide the resume point

Match the branch state to a workflow step:

| Branch state | Resume from |
|--------------|-------------|
| Only the scaffold commit (chore: scaffold ...) | Step 4 — dispatch implementer |
| Implementation commits but no review evidence | Step 5 — dispatch reviewers |
| Review-fix commits after reviewer feedback | Step 4 — dispatch implementer with the feedback |
| PR is `ready`, CI pending | Step 6 — wait for CI |
| PR is `ready`, CI green, not merged | Step 7 — squash-merge |
| Branch deleted, PR merged | Step 8 — next PR or done |

If the branch state doesn't match any row (e.g., merge conflicts, broken history), surface to the user. Do not auto-resolve.

### 6. Confirm the resume to the user

Report in one sentence: *"Resuming Plan-NNN PR #M at <step name> — branch is at <commit SHA short>, CI is <status>, next action is <action>."* Then proceed unless the user redirects.

## Edge cases

### Uncommitted changes on resume

`git status --short` shows modified files.

- If they look like a partial implementer output (e.g., a half-finished file, a stale draft) — surface to the user before deciding. Don't auto-stash without consent.
- If they look like local-only artifacts (e.g., `.DS_Store`, editor swap files) — leave them alone, they'll be ignored.

### Branch has diverged from `develop`

`git log develop..HEAD` shows commits, but `git log HEAD..develop` also shows commits (merges happened on `develop` since this branch was cut).

- Run `git pull origin develop --rebase` (or `git fetch && git rebase origin/develop`) to bring the branch up to date.
- If conflicts arise, surface to the user — do not auto-resolve. Conflicts indicate a cross-plan dependency surface that needs human judgment.

### PR is closed but branch exists

Someone (or you in a prior session) closed the PR without merging. Do not silently re-open. Ask the user whether to re-open, retire the branch, or open a fresh PR.

### TaskCreate state contradicts branch state

E.g., TaskList says "implementer DONE" but the branch has only the scaffold commit. Trust the branch. Update TaskCreate to match. Re-dispatch the implementer.

## What durable state means

**Durable across sessions:**
- Git commits on the branch (origin and local in sync).
- Files in the working tree that have been committed.
- The PR (number, title, body, draft/ready status, reviews, comments).
- This skill file and ADR-024.

**Not durable across sessions:**
- TaskCreate task list.
- Conversation context.
- In-flight subagent dispatches.
- Anything in `.agents/tmp/` (gitignored, deleted at commit time per AGENTS.md).
- Working-tree changes not yet committed.

When in doubt, commit. A scaffold or "WIP — implementer in flight" commit is cheap durability insurance and gets squashed at the end anyway.
