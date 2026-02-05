# Implementation Task: Fix install.sh Script

## Overview

This task skips planning (plans already created) and proceeds directly to implementation and verification.

## Your Assigned Plan

Read your implementation plan at the path provided by the orchestrator. Your plan contains:
- Issue analysis with root causes
- Proposed solution architecture
- Code modifications required
- Testing strategy
- Risk mitigations

## Phase 1: Setup Git Worktree (REQUIRED)

Create an isolated worktree for your work:

```bash
# Navigate to the main repository
cd /home/sabossedgh/repos/ai-sidekicks

# Ensure you're on develop
git checkout develop 2>/dev/null || true

# Create worktree with unique branch based on your subagent ID
# Replace SUBAGENT_ID with your assigned ID (a, b, or c)
BRANCH_NAME="fix/install-script-SUBAGENT_ID-$(date +%Y%m%d-%H%M%S)"
WORKTREE_PATH=".claude/tmp/worktrees/fix-install-SUBAGENT_ID"

mkdir -p .claude/tmp/worktrees
git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" develop

# Work in the worktree
cd "$WORKTREE_PATH"
```

**CRITICAL**: All your work MUST happen in your worktree, not the main repo.

## Phase 2: Implement Your Plan

Follow your plan's implementation order:

1. **Read Current Script**: Study the existing `install.sh` thoroughly
2. **Make Changes Incrementally**: Implement changes in logical order from your plan
3. **Test Each Change**: Verify each modification works before proceeding
4. **Handle Edge Cases**: Implement the error handling from your plan

### Implementation Guidelines

- Use functions for reusable logic
- Quote all variable expansions
- Use `[[ ]]` for string comparisons
- Add comments for non-obvious logic
- Handle edge cases: missing files, permission errors, interrupted operations

## Phase 3: Verify Implementation

Run all tests from your testing strategy:

### Required Verifications

1. **Basic install/uninstall cycle**
   ```bash
   TEST_DIR=$(mktemp -d)
   mkdir -p "$TEST_DIR/.claude/skills"
   echo "original content" > "$TEST_DIR/.claude/skills/custom.md"
   echo '{"original": true}' > "$TEST_DIR/.claude/settings.json"

   cd "$TEST_DIR" && /path/to/worktree/install.sh --project
   /path/to/worktree/install.sh --unlink --project

   # Verify: original files restored
   cat "$TEST_DIR/.claude/skills/custom.md"
   cat "$TEST_DIR/.claude/settings.json"
   ```

2. **Project unlink works**
   ```bash
   ./install.sh --unlink --project  # Must target project, not home
   ```

3. **Settings backup when different**
   ```bash
   # Verify settings.json.ai-sidekicks.bak created
   ```

4. **User backups preserved**
   ```bash
   # User's *.bak files must not be touched
   ```

5. **Shellcheck compliance**
   ```bash
   shellcheck install.sh  # Must pass with no warnings
   ```

## Phase 4: Commit and Document

### Commit Your Changes

```bash
git add install.sh
git commit -m "fix(install): implement manifest-based backup/restore

- Add manifest tracking for installed items
- Use .ai-sidekicks.bak suffix for clear ownership
- Restore original files on uninstall
- Fix --unlink --project flag handling
- Backup settings.json when content differs
- Handle legacy installations gracefully

Fixes #1: Uninstall doesn't restore original files
Fixes #2: --unlink --project not working
Fixes #3: Orphaned backup files
Fixes #4: Settings not backed up
Fixes #5: No ownership identification

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Add Git Notes (REQUIRED)

After committing, add comprehensive git notes documenting your work:

```bash
git notes add -m "$(cat <<'EOF'
## Subagent [A/B/C] Implementation Notes

### Issues Found

1. **Uninstall doesn't restore original files**
   - Root cause: Lines 126-144 in unlink_config()
   - The function copies from source instead of restoring .bak
   - Fix: Added restore_backup() function

2. **Project flag ignored in unlink**
   - Root cause: Lines 171-173 in main case statement
   - $2 (--project) never passed to get_target_dir
   - Fix: [Your fix description]

3. **Orphaned backup files**
   - Root cause: No cleanup mechanism
   - Fix: [Your fix description]

4. **Settings not backed up**
   - Root cause: Lines 97-120 only warn, don't backup
   - Fix: [Your fix description]

5. **No ownership identification**
   - Root cause: Generic .bak suffix
   - Fix: .ai-sidekicks.bak suffix + manifest tracking

### Solutions Applied

1. **Manifest-based tracking**: [Describe your manifest approach]
2. **Backup suffix**: Using .ai-sidekicks.bak for clear ownership
3. **Restore logic**: [Describe your restore implementation]
4. **Argument parsing**: [Describe your fix]

### Trade-offs Considered

- [List design decisions and alternatives considered]

### Testing Results

- Basic restore: PASS/FAIL
- Project unlink: PASS/FAIL
- Orphan cleanup: PASS/FAIL
- Settings backup: PASS/FAIL
- User backups preserved: PASS/FAIL
- Shellcheck: PASS/FAIL
EOF
)" HEAD
```

## Phase 5: Report Results

After completing all work, provide a summary:

### Work Summary Format

```
## Implementation Complete

### Branch Details
- Branch: fix/install-script-[ID]-YYYYMMDD-HHMMSS
- Worktree: .claude/tmp/worktrees/fix-install-[ID]
- Commit: [SHA]

### Changes Made
- [List of modifications to install.sh]
- Lines changed: [N]
- New functions added: [List]
- Functions modified: [List]

### Test Results
| Test | Result |
|------|--------|
| Basic restore | PASS/FAIL |
| Project unlink | PASS/FAIL |
| Orphan cleanup | PASS/FAIL |
| Settings backup | PASS/FAIL |
| User backups preserved | PASS/FAIL |
| Shellcheck | PASS/FAIL |

### Git Notes
[Include the full git notes content you added]

### Files Modified
- install.sh
```

## Constraints

- **Work only in your worktree** - Never modify the main repo
- **Keep changes local** - Do NOT push to remote
- **Pass shellcheck** - No warnings allowed
- **Follow your plan** - Implement what you planned
- **Document everything** - Git notes are required

## Success Criteria

Your implementation is complete when:

1. All five reported issues are fixed
2. All test scenarios pass
3. Script passes shellcheck with no warnings
4. Git commit created with descriptive message
5. Git notes added with comprehensive documentation
6. Summary report provided to orchestrator
