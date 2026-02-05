---
title: "Subagent B: Implement install.sh fixes"
timestamp: "2026-02-05T01:08:50.939Z"
subagent_type: general-purpose
prompt_length: 2921
run_in_background: true
---

## Your Role
You are **Subagent B** implementing fixes for the `install.sh` script.

## Your Plan
Your implementation plan is at:
`/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/subagents/subagent-b/install-fix-plan.md`

Read this plan first, then implement it.

## Phase 1: Setup Git Worktree

Create an isolated worktree for your work:

```bash
cd /home/sabossedgh/repos/ai-sidekicks
git checkout develop
mkdir -p .claude/tmp/worktrees
git worktree add -b fix/install-script-subagent-b-$(date +%Y%m%d-%H%M%S) \
  .claude/tmp/worktrees/fix-install-subagent-b \
  develop
cd .claude/tmp/worktrees/fix-install-subagent-b
```

## Phase 2: Implementation

Implement your plan which uses a **simple key-value manifest format**. Key components:
- `.ai-sidekicks-manifest` manifest file (text format)
- `.ai-sidekicks.bak` backup suffix
- Functions: `manifest_init()`, `manifest_read()`, `manifest_write()`, etc.
- Modified `install_config()` and `unlink_config()`
- `legacy_unlink()` for backwards compatibility

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

- Add manifest-based tracking (.ai-sidekicks-manifest)
- Fix --unlink to restore backups instead of copying from source
- Fix --unlink --project argument handling
- Add .ai-sidekicks.bak suffix for ownership identification
- Backup settings.json when content differs
- Clean up orphaned backups during uninstall
- Add legacy_unlink() for pre-manifest installations

Fixes issues: restore on unlink, project unlink, orphan cleanup,
settings backup, ownership tracking

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

git notes add -m "$(cat <<'EOF'
## Subagent B Implementation - Key-Value Manifest Approach

### Issues Fixed
1. Uninstall restore - rewrote unlink_config() to restore from .bak
2. Project unlink - fixed argument handling for --unlink --project
3. Orphan cleanup - restore_backup() removes backup after restoring
4. Settings backup - create_backup() called before copying settings
5. Ownership - .ai-sidekicks.bak suffix + text manifest tracking

### Design Choices
- Simple key-value manifest for pure-bash parsing (no jq needed)
- legacy_unlink() for backwards compatibility
- Graceful degradation when manifest missing

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
- Modified install.sh in worktree `.claude/tmp/worktrees/fix-install-subagent-b/`
- Git commit with descriptive message
- Git notes documenting implementation
