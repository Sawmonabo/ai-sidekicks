---
title: "Subagent C: Implement install.sh fixes"
timestamp: "2026-02-05T01:17:38.460Z"
subagent_type: general-purpose
prompt_length: 2088
run_in_background: false
---

## Your Role
You are **Subagent C** implementing fixes to the `install.sh` script.

## Your Assigned Plan
Your implementation plan is at:
`/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/subagents/subagent-c/install-fix-plan.md`

## Implementation Task
Follow the task instructions at:
`/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/tasks/fix-install-script-task.md`

## Your Subagent ID
Use `c` as your subagent identifier in all branch names and paths.

## Critical Instructions

### 1. Git Worktree Setup (DO FIRST)
```bash
cd /home/sabossedgh/repos/ai-sidekicks
git checkout develop 2>/dev/null || true
mkdir -p .claude/tmp/worktrees
git worktree add -b "fix/install-script-c-$(date +%Y%m%d-%H%M%S)" ".claude/tmp/worktrees/fix-install-c" develop
cd .claude/tmp/worktrees/fix-install-c
```

### 2. Implement Your Plan
- Read your plan thoroughly
- Implement the ENHANCED key-value manifest approach with:
  - Atomic writes
  - Dry-run support (--dry-run flag)
  - Migration command (--migrate flag)
  - Enhanced status display
- Follow your implementation order
- Test each change

### 3. Required Deliverables
1. Modified `install.sh` in your worktree
2. All tests passing (run each test scenario from your plan - you have 9 tests)
3. `shellcheck install.sh` passes with no warnings
4. Git commit with descriptive message
5. Git notes documenting your work

### 4. Git Notes (REQUIRED)
After your commit, add git notes:
```bash
git notes add -m "Subagent C implementation notes..." HEAD
```

### 5. Report Back
When complete, provide:
- Branch name and commit SHA
- Test results for all scenarios (including dry-run and migrate tests)
- Full git notes content
- Summary of changes made

## Permissions
You have FULL permissions to:
- Create git worktrees and branches
- Read and write files
- Run bash commands
- Run shellcheck
- Create commits and git notes

Proceed with implementation now.
