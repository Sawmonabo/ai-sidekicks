---
title: "Subagent C: Implement install.sh fixes"
timestamp: "2026-02-05T01:09:01.604Z"
subagent_type: general-purpose
prompt_length: 3619
run_in_background: true
---

## Your Role
You are **Subagent C** implementing fixes for the `install.sh` script.

## Your Plan
Your implementation plan is at:
`/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/subagents/subagent-c/install-fix-plan.md`

Your task specification is at:
`/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/tasks/fix-install-script-task.md`

Read your plan first, then implement it. **Planning is already complete - proceed directly to implementation.**

## Phase 1: Setup Git Worktree

Create an isolated worktree for your work:

```bash
cd /home/sabossedgh/repos/ai-sidekicks
git checkout develop
mkdir -p .claude/tmp/worktrees
git worktree add -b fix/install-script-subagent-c-$(date +%Y%m%d-%H%M%S) \
  .claude/tmp/worktrees/fix-install-subagent-c \
  develop
cd .claude/tmp/worktrees/fix-install-subagent-c
```

## Phase 2: Implementation

Implement your enhanced plan which includes:
- `.ai-sidekicks-manifest` key-value manifest file
- `.ai-sidekicks.bak` backup suffix
- `--dry-run` mode for previewing changes
- `--verbose` mode for debugging
- `--migrate` command for legacy installations
- Atomic writes using temp file + rename
- All manifest and backup functions from your plan
- Enhanced `show_status()` with manifest info

## Phase 3: Verification

1. Run `shellcheck install.sh` and fix warnings
2. Test all 9 scenarios from your plan
3. Verify all 5 issues are fixed + additional features work

## Phase 4: Git Commit and Notes

Commit your changes with descriptive messages, then add comprehensive git notes:

```bash
git add install.sh
git commit -m "$(cat <<'EOF'
Fix install.sh with enhanced manifest tracking and dry-run support

- Add manifest-based tracking (.ai-sidekicks-manifest)
- Fix --unlink to restore backups instead of copying from source
- Fix --unlink --project argument handling
- Add .ai-sidekicks.bak suffix for ownership identification
- Backup settings.json when content differs
- Clean up orphaned backups during uninstall
- Add --dry-run mode to preview changes
- Add --verbose mode for debugging
- Add --migrate command for legacy installations
- Use atomic writes for manifest operations
- Enhanced --status with manifest information

Fixes issues: restore on unlink, project unlink, orphan cleanup,
settings backup, ownership tracking

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

git notes add -m "$(cat <<'EOF'
## Subagent C Implementation - Enhanced Key-Value Manifest

### Issues Fixed
1. Uninstall restore - rewrote unlink_config() with restore_backup()
2. Project unlink - added parse_args() with full flag support
3. Orphan cleanup - manifest-tracked backup removal
4. Settings backup - create_backup() before copy
5. Ownership - .ai-sidekicks.bak suffix + manifest tracking

### Additional Features
- --dry-run: Preview changes without executing
- --verbose: Detailed debug output
- --migrate: Create manifest for legacy installations
- atomic_write(): Prevents partial file writes
- Enhanced show_status(): Displays manifest details

### Design Choices
- Key-value manifest for pure-bash parsing
- Atomic operations for data safety
- Graceful degradation via legacy_unlink()
- Comprehensive error handling with log_error()

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
- Modified install.sh in worktree `.claude/tmp/worktrees/fix-install-subagent-c/`
- Git commit with descriptive message
- Git notes documenting implementation
