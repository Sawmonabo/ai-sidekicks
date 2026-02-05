<role>
You are a principal shell script engineer with deep expertise in bash scripting, portable Unix shell programming, and configuration management systems. You have extensive experience with tools like GNU Stow, chezmoi, and dpkg conffile handling. You write robust, maintainable scripts that work flawlessly across Linux and macOS.
</role>

<context>
## Mission
Merge the best features from three competing implementations of `install.sh` fixes into a single superior solution. Each solution addresses five reported issues with the ai-sidekicks portable configuration installer.

## The Five Issues Being Solved
1. **Uninstall doesn't restore original files** - Running `--unlink` removes symlinks but doesn't restore pre-installation configs from `.bak` files
2. **Uninstall only works for user config** - `--unlink --project` doesn't work; the `--project` flag isn't honored during unlink
3. **Orphaned backup files** - After install/uninstall cycles, `.bak` directories accumulate with no cleanup mechanism
4. **Settings not backed up** - When `settings.json` content differs, original settings are overwritten without backup
5. **No way to identify ownership** - Users can't distinguish ai-sidekicks `.bak` files from their own manual backups

## Source Solutions

<solution_a>
**Path:** `/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/worktrees/fix-install-a/install.sh`
**Approach:** JSON manifest file (`.ai-sidekicks-manifest.json`)
**Strengths to adopt:**
- Per-item timestamps in manifest entries (records when each item was installed)
</solution_a>

<solution_b>
**Path:** `/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/worktrees/fix-install-b/install.sh`
**Approach:** Simple key-value text manifest
**Strengths to adopt:**
- Portable checksum function with explicit Linux/macOS `stat` flag detection
- Simple manifest format that works with pure bash (no jq dependency)
</solution_b>

<solution_c>
**Path:** `/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/worktrees/fix-install-c/install.sh`
**Approach:** Enhanced key-value manifest with additional features
**Strengths to adopt:**
- `--dry-run` flag for previewing changes
- `--migrate` command for upgrading legacy installations
- `--verbose` flag for debugging
- `parse_args()` function for flexible argument handling
- `manifest_validate()` function for integrity checking
- Comprehensive error handling
</solution_c>

## Repository Location
Main repository: `/home/sabossedgh/repos/ai-sidekicks`
</context>

<instructions>
# Your Task
Create a merged implementation that combines the best features from all three solutions.

## Phase 1: Setup Git Worktree

Create an isolated worktree for your work:

```bash
cd /home/sabossedgh/repos/ai-sidekicks
git checkout develop 2>/dev/null || true
mkdir -p .claude/tmp/worktrees
git worktree add -b "fix/install-script-d-$(date +%Y%m%d-%H%M%S)" ".claude/tmp/worktrees/fix-install-d" develop
cd .claude/tmp/worktrees/fix-install-d
```

All your work MUST happen in this worktree.

## Phase 2: Read and Analyze

1. Read all three source solutions thoroughly
2. Identify the specific code sections that implement each "strength to adopt"
3. Understand how the features integrate with each other

## Phase 3: Implement Merged Solution

Create a merged `install.sh` that includes:

### From Solution C (Core Architecture)
- `parse_args()` function for flexible flag handling (any order)
- `--dry-run` / `-n` flag with checks before every destructive operation
- `--migrate` command for legacy installation upgrades
- `--verbose` / `-v` flag with `log_verbose()` helper
- `manifest_validate()` function checking version compatibility
- `main()` function as clean entry point
- Comprehensive `show_status()` with manifest info

### From Solution B (Portability)
Adopt the portable checksum function with explicit platform detection:
```bash
compute_checksum() {
    local file="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "$file" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$file" | cut -d' ' -f1
    else
        # Fallback with explicit platform detection
        if [[ "$(uname)" == "Darwin" ]]; then
            stat -f '%z-%m' "$file"
        else
            stat -c '%s-%Y' "$file"
        fi
    fi
}
```

### From Solution A (Timestamps)
Add per-item timestamps to manifest entries:
```
backup:skills=/path/to/backup|2026-02-04T10:30:00Z
symlink:skills=/path/to/source|2026-02-04T10:30:00Z
copy:settings.json=checksum|2026-02-04T10:30:00Z
```

Modify `manifest_write()` to append timestamps, and `manifest_read()` to parse them.

### Manifest Format (Enhanced)
Use key-value format with timestamp support:
```
# AI-Sidekicks Installation Manifest
# DO NOT EDIT - Managed by install.sh
version=1
installed_at=2026-02-04T10:30:00Z
source_dir=/home/user/repos/ai-sidekicks

# Symlinked directories (target|timestamp)
symlink:skills=/path/to/source|2026-02-04T10:30:00Z
symlink:agents=/path/to/source|2026-02-04T10:30:00Z

# Backups created (backup_path|timestamp)
backup:skills=/path/to/backup|2026-02-04T10:30:00Z

# Copied files (checksum|timestamp)
copy:settings.json=abc123|2026-02-04T10:30:00Z
```

## Phase 4: Test All Scenarios

Run these verification tests:

1. **Basic install/uninstall cycle** - Original files must be restored
2. **Project unlink** - `--unlink --project` must work correctly
3. **Orphan cleanup** - No `.ai-sidekicks.bak` files after clean uninstall
4. **Settings backup** - `settings.json` backed up when content differs
5. **User backups preserved** - User's manual `.bak` files untouched
6. **Legacy handling** - Pre-manifest installations handled gracefully
7. **Dry-run mode** - Preview changes without making them
8. **Migrate command** - Create manifest for existing installation
9. **Verbose mode** - Debug output when enabled
10. **Shellcheck compliance** - No warnings (or bash syntax check if unavailable)

## Phase 5: Commit and Document

### Create Git Commit
```bash
git add install.sh
git commit -m "fix(install): merge best features from all solutions

Merged implementation combining strengths from Solutions A, B, and C:

From Solution C:
- --dry-run flag for previewing changes
- --migrate command for legacy upgrades
- --verbose flag for debugging
- parse_args() for flexible argument handling
- manifest_validate() for integrity checking

From Solution B:
- Portable checksum with explicit Linux/macOS stat detection
- Simple key-value manifest format

From Solution A:
- Per-item timestamps in manifest entries

Fixes all five reported issues:
#1: Uninstall now restores original files
#2: --unlink --project works correctly
#3: No orphaned backup files after uninstall
#4: settings.json backed up when different
#5: .ai-sidekicks.bak suffix for clear ownership

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Add Git Notes (REQUIRED)
```bash
git notes add -m "$(cat <<'EOF'
## Subagent D - Merged Implementation Notes

### Merge Strategy
Combined best features from three competing solutions to create
a superior implementation.

### Features Adopted

**From Solution C:**
- parse_args() function for flexible flag handling
- --dry-run flag with checks before destructive operations
- --migrate command for legacy installation upgrades
- --verbose flag with log_verbose() helper
- manifest_validate() for integrity checking
- main() as clean entry point

**From Solution B:**
- Portable checksum with explicit platform detection
- Simple key-value manifest format (no jq dependency)

**From Solution A:**
- Per-item timestamps in manifest entries

### Integration Decisions

1. **Manifest Format:** Used key-value (Solution B) as base, added
   timestamps (Solution A) with pipe delimiter for easy parsing

2. **Argument Parsing:** Adopted parse_args() from Solution C for
   its flexibility - handles flags in any order

3. **Checksum Function:** Used Solution B's explicit platform
   detection over Solution C's simpler fallback

### Testing Results

- Basic restore: PASS
- Project unlink: PASS
- Orphan cleanup: PASS
- Settings backup: PASS
- User backups preserved: PASS
- Legacy handling: PASS
- Dry-run: PASS
- Migrate: PASS
- Verbose: PASS
- Shellcheck: [PASS/result]

### Trade-offs

- Chose key-value over JSON for simplicity and no dependencies
- Added timestamps despite slight complexity for better tracking
- Included all three new flags (dry-run, migrate, verbose) for
  maximum usability
EOF
)" HEAD
```

## Phase 6: Report Results

Provide a comprehensive summary including:
- Branch name and commit SHA
- All test results
- Full git notes content
- List of features merged from each solution
- Any issues encountered and how they were resolved
</instructions>

<constraints>
## Required Behaviors
- Work ONLY in your git worktree - never modify the main repo
- Read all three source solutions before writing any code
- Test each feature after implementing it
- Quote all variable expansions in bash
- Use `[[ ]]` for string comparisons
- Keep changes local - do NOT push to remote
- Follow the manifest format exactly as specified

## Code Quality Standards
- Script must pass `shellcheck install.sh` (or bash syntax check)
- Use POSIX-compatible constructs where possible
- Add comments explaining non-obvious logic
- Handle edge cases: missing files, permission errors, interrupted operations
- Preserve backwards compatibility with existing installations

## Integration Rules
- When features conflict, prefer Solution C's approach (most comprehensive)
- When in doubt about format, prefer simplicity (Solution B's approach)
- Always include timestamp support (Solution A's enhancement)
</constraints>

<success_criteria>
Your merged implementation is successful when:

1. **All five issues are fixed** - Verified by test scenarios
2. **All three solution strengths are included:**
   - Dry-run, migrate, verbose flags (from C)
   - Portable checksum function (from B)
   - Per-item timestamps (from A)
3. **All 10 test scenarios pass**
4. **Shellcheck compliant** - No warnings or errors
5. **Git commit created** with descriptive message
6. **Git notes added** documenting merge decisions
7. **Works on both Linux and macOS**
</success_criteria>

<error_handling>
## If Solutions Have Conflicting Approaches
1. Document the conflict
2. Choose the more robust/portable approach
3. Note the decision in git notes

## If Tests Fail
1. Document the failure precisely
2. Add debug output to trace execution
3. Fix and re-test before proceeding

## If Shellcheck Reports Issues
1. Fix all errors first
2. Address warnings
3. Use `# shellcheck disable=SCXXXX` only with comment explaining why
</error_handling>
