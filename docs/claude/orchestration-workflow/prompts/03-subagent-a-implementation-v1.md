---
title: "Subagent A: Implement install.sh fixes"
timestamp: "2026-02-05T01:08:43.580Z"
subagent_type: general-purpose
prompt_length: 2847
run_in_background: true
---

## Your Role
You are **Subagent A** implementing fixes for the `install.sh` script.

## Your Plan
Your implementation plan is at:
`/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/subagents/subagent-a/install-fix-plan.md`

Read this plan first, then implement it.

## Phase 1: Setup Git Worktree

Create an isolated worktree for your work:

```bash
cd /home/sabossedgh/repos/ai-sidekicks
git checkout develop
mkdir -p .claude/tmp/worktrees
git worktree add -b fix/install-script-subagent-a-$(date +%Y%m%d-%H%M%S) \
  .claude/tmp/worktrees/fix-install-subagent-a \
  develop
cd .claude/tmp/worktrees/fix-install-subagent-a
```

## Phase 2: Implementation

Implement your plan which uses a **JSON manifest format**. Key components:
- `.ai-sidekicks-manifest.json` manifest file
- `.ai-sidekicks.bak` backup suffix
- Functions: `init_manifest()`, `read_manifest()`, `write_manifest()`, etc.
- Modified `install_config()` and `unlink_config()`
- New `parse_args()` function

## Phase 3: Verification

1. Run `shellcheck install.sh` and fix warnings
2. Test all scenarios from your plan
3. Verify all 5 issues are fixed

## Phase 4: Git Commit and Notes

Commit your changes with descriptive messages, then add comprehensive git notes:

```bash
git add install.sh
git commit -m "$(cat <<'EOF'
Fix install.sh backup/restore and manifest tracking

- Add manifest-based tracking (.ai-sidekicks-manifest.json)
- Fix --unlink to restore backups instead of copying from source
- Fix --unlink --project argument handling
- Add .ai-sidekicks.bak suffix for ownership identification
- Backup settings.json when content differs
- Clean up orphaned backups during uninstall

Fixes issues: restore on unlink, project unlink, orphan cleanup,
settings backup, ownership tracking

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

git notes add -m "$(cat <<'EOF'
## Subagent A Implementation - JSON Manifest Approach

### Issues Fixed
1. Uninstall restore - rewrote unlink_config() to restore from .bak
2. Project unlink - added parse_args() for proper flag handling
3. Orphan cleanup - restore_backup() removes backup after restoring
4. Settings backup - create_backup() called before copying settings
5. Ownership - .ai-sidekicks.bak suffix + JSON manifest tracking

### Design Choices
- JSON manifest for structured data and potential future extensibility
- Function decomposition for testability
- Legacy mode for backwards compatibility

### Testing Results
[Include test results here]
EOF
)" HEAD
```

## Constraints
- Do NOT push to remote
- Must pass shellcheck
- Must work on Linux and macOS

## Deliverables
- Modified install.sh in worktree `.claude/tmp/worktrees/fix-install-subagent-a/`
- Git commit with descriptive message
- Git notes documenting implementation
