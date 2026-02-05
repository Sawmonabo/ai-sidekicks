# Implementation Plan: install.sh Fixes

## Executive Summary

This plan addresses five reported issues in the `install.sh` script for the ai-sidekicks portable Claude Code configuration. The core problem is that the script lacks a state tracking mechanism, leading to inability to restore backups, orphaned files, and ownership confusion. The recommended solution is implementing a **manifest-based tracking system** inspired by GNU Stow and dpkg conffile handling patterns.

---

## 1. Issue Analysis

### Issue 1: Uninstall doesn't restore original files

**Root Cause Location**: Lines 126-144 (`unlink_config` function)

**Current Implementation**:
```bash
unlink_config() {
    local target="$1"
    echo "Unlinking from: $target"
    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        local src="$SOURCE_CLAUDE/$dir"
        if [[ -L "$dst" ]]; then
            echo "  Converting $dir from symlink to copy"
            rm "$dst"
            cp -r "$src" "$dst"  # Copies from source, NOT from .bak
            echo "  ✓ $dir"
        fi
    done
    echo "Done! Symlinks converted to standalone copies"
}
```

**Why It Fails**:
- The function removes the symlink but then copies fresh content from `$SOURCE_CLAUDE`
- It never checks for `.bak` directories created during installation (line 89-90)
- The backup created at `${dst}.bak` is completely ignored during unlink
- User's original configuration is permanently lost after uninstall

**Impact on Users**:
- Users lose their original custom configurations (skills, agents, rules)
- No way to recover original state after running uninstall
- Creates distrust in the installation process

### Issue 2: Uninstall only works for user config

**Root Cause Location**: Lines 171-173 (main case statement)

**Current Implementation**:
```bash
--unlink)
    show_banner "UNINSTALLING"
    unlink_config "$(get_target_dir)"  # get_target_dir() called without args
    ;;
```

**Why It Fails**:
- `get_target_dir` is called without the `--project` argument
- Without arguments, `get_target_dir` always returns `$HOME/.claude` (line 58)
- The `$2` argument (which would be `--project`) is never passed through
- Command `./install.sh --unlink --project` effectively runs `unlink_config "$HOME/.claude"`

**Impact on Users**:
- Cannot uninstall project-specific configurations
- Users must manually remove symlinks in project directories
- Inconsistent behavior between install and uninstall operations

### Issue 3: Orphaned backup files

**Root Cause Location**: Lines 88-90 (install_config) and absence of cleanup in unlink_config

**Current Implementation**:
```bash
elif [[ -d "$dst" ]]; then
    echo "  Backing up existing $dir to ${dir}.bak"
    mv "$dst" "${dst}.bak"
fi
```

**Why It Fails**:
- Backups are created with a simple `.bak` suffix
- No tracking of which backups were created by which installation
- `unlink_config` never removes or restores `.bak` directories
- Multiple install/uninstall cycles create layered backups (e.g., `skills.bak`, `skills.bak.bak`)

**Impact on Users**:
- Disk space accumulation from orphaned backups
- Confusion about which backups are relevant
- Manual cleanup required, risking deletion of important files

### Issue 4: Settings not backed up

**Root Cause Location**: Lines 97-120 (COPY_FILES handling in install_config)

**Current Implementation**:
```bash
if [[ -f "$dst" ]]; then
    if diff -q "$src" "$dst" > /dev/null 2>&1; then
        echo "  ✓ $file (identical)"
    else
        echo "  ! $file exists with different content"
        echo "    Source: $src"
        echo "    Target: $dst"
        echo "    Run: diff $src $dst"
    fi
else
    cp "$src" "$dst"
    echo "  ✓ $file (copied)"
fi
```

**Why It Fails**:
- When files differ, the script only prints a warning message
- User's customized `settings.json` is never backed up
- No mechanism to preserve user settings while still providing updates
- The script should backup before copying, similar to how directories are handled

**Impact on Users**:
- Loss of custom settings configurations
- User must manually backup settings before running install
- Inconsistent treatment between directories and files

### Issue 5: No way to identify ownership

**Root Cause Location**: Entire script - no manifest or ownership tracking exists

**Current State**:
- Backups use generic `.bak` suffix (same as user might use manually)
- No metadata stored about installation origin, timestamp, or what was backed up
- No way to distinguish ai-sidekicks backups from user's personal backups

**Why It Fails**:
- Simple naming convention (`*.bak`) collides with common backup naming patterns
- No machine-readable record of what the script created
- Cannot safely clean up without risking user data

**Impact on Users**:
- Fear of accidentally deleting important personal backups
- Manual inspection required to determine file origins
- Accumulation of files users are afraid to remove

---

## 2. Proposed Solution Architecture

### Overall Design Approach

Implement a **manifest-based tracking system** inspired by:

1. **GNU Stow**: Uses marker files (`.stow`) for package ownership, but operates statelessly within sessions. Our manifest approach adds explicit tracking. Reference: [GNU Stow Manual](https://www.gnu.org/software/stow/manual/stow.html)

2. **dpkg conffile handling**: Creates `.dpkg-old` and `.dpkg-dist` backups with checksums to track changes. We adapt the backup-with-metadata pattern. Reference: [Debian dpkg conffile handling](https://raphaelhertzog.com/2010/09/21/debian-conffile-configuration-file-managed-by-dpkg/)

3. **chezmoi**: Stores desired state in a dedicated directory and calculates minimal changes. We adopt the explicit state tracking concept. Reference: [chezmoi documentation](https://www.chezmoi.io/)

### Manifest File Design

**Location**: `$TARGET_DIR/.ai-sidekicks-manifest`

**Format**: Simple key-value text format (no JSON dependency for portability)

```
# AI-Sidekicks Installation Manifest
# DO NOT EDIT - Managed by install.sh
version=1
installed_at=2026-02-04T10:30:00Z
source_dir=/home/user/repos/ai-sidekicks

# Symlinked directories
symlink:skills=/home/user/repos/ai-sidekicks/.claude/skills
symlink:agents=/home/user/repos/ai-sidekicks/.claude/agents
symlink:rules=/home/user/repos/ai-sidekicks/.claude/rules

# Backed up items (original location -> backup location)
backup:skills=/path/to/.claude/skills.ai-sidekicks.bak
backup:agents=/path/to/.claude/agents.ai-sidekicks.bak
backup:settings.json=/path/to/.claude/settings.json.ai-sidekicks.bak

# Copied files
copy:settings.json=checksum_here
```

### Backup Naming Convention

Change from generic `.bak` to identifiable suffix:

- **Old**: `skills.bak`
- **New**: `skills.ai-sidekicks.bak`

This allows:
1. Clear identification of ai-sidekicks-managed backups
2. Coexistence with user's manual `.bak` files
3. Manifest validation of ownership

### Function Decomposition

```
install.sh
├── Configuration
│   ├── PORTABLE_DIRS[]
│   ├── COPY_FILES[]
│   ├── MANIFEST_FILE=".ai-sidekicks-manifest"
│   └── BACKUP_SUFFIX=".ai-sidekicks.bak"
│
├── Utility Functions
│   ├── show_banner()           # Existing
│   ├── usage()                 # Existing
│   ├── get_target_dir()        # Existing - needs fix for --unlink
│   ├── log_verbose()           # NEW - verbose output support
│   └── compute_checksum()      # NEW - for file comparison
│
├── Manifest Functions (NEW)
│   ├── manifest_init()         # Create/reset manifest file
│   ├── manifest_read()         # Read value from manifest
│   ├── manifest_write()        # Write key-value to manifest
│   ├── manifest_has_backup()   # Check if item has backup entry
│   └── manifest_exists()       # Check if manifest file exists
│
├── Backup Functions (NEW)
│   ├── create_backup()         # Backup item with manifest tracking
│   ├── restore_backup()        # Restore from manifest-tracked backup
│   └── cleanup_backup()        # Remove backup after successful restore
│
├── Core Functions
│   ├── install_config()        # Modified - use manifest & new backup
│   ├── unlink_config()         # Modified - restore from manifest
│   └── show_status()           # Modified - show manifest info
│
└── Main
    └── Argument parsing        # Fixed - pass --project to unlink
```

### Data Flow

```
INSTALL FLOW:
1. Parse args → determine target dir
2. Initialize manifest (create or update)
3. For each PORTABLE_DIR:
   a. Check if backup needed (existing dir/symlink)
   b. Create backup with manifest entry if needed
   c. Create symlink
   d. Record symlink in manifest
4. For each COPY_FILE:
   a. Check if backup needed (exists and differs)
   b. Create backup with manifest entry if needed
   c. Copy file
   d. Record copy with checksum in manifest

UNLINK FLOW:
1. Parse args → determine target dir
2. Check manifest exists (error if not - legacy handling)
3. For each symlink in manifest:
   a. Remove symlink
   b. Check for backup entry
   c. Restore backup if exists
   d. Remove backup entry from manifest
4. For each copy in manifest:
   a. Check for backup entry
   b. Restore backup if exists OR leave current
   d. Remove entry from manifest
5. Remove manifest file (installation complete)
```

---

## 3. File Modifications Required

### install.sh - Sections to Modify

#### Section 1: Configuration Block (after line 40)
Add new constants:

```bash
# Manifest configuration
MANIFEST_FILE=".ai-sidekicks-manifest"
BACKUP_SUFFIX=".ai-sidekicks.bak"
MANIFEST_VERSION="1"
```

#### Section 2: New Functions Block (after line 60)
Add manifest and backup functions:

**New Functions to Add:**

1. `log_verbose()` - Optional verbose logging
2. `compute_checksum()` - SHA256 checksum for files (use `sha256sum` or `shasum`)
3. `manifest_init()` - Initialize manifest with header
4. `manifest_read()` - Read value by key from manifest
5. `manifest_write()` - Append key-value to manifest
6. `manifest_remove()` - Remove entry from manifest
7. `manifest_exists()` - Check if manifest file exists
8. `create_backup()` - Create backup with manifest tracking
9. `restore_backup()` - Restore backup using manifest
10. `cleanup_orphaned_backups()` - Remove untracked ai-sidekicks backups

#### Section 3: install_config Function (lines 62-124)
Modify to:

- Call `manifest_init()` at start
- Use `create_backup()` instead of direct `mv` for directories
- Add backup logic for `settings.json` when content differs
- Record all operations in manifest

**Key Changes:**

```bash
# OLD (line 89-90):
elif [[ -d "$dst" ]]; then
    echo "  Backing up existing $dir to ${dir}.bak"
    mv "$dst" "${dst}.bak"
fi

# NEW:
elif [[ -d "$dst" ]]; then
    create_backup "$dst" "$dir"
fi
```

```bash
# OLD (line 107-115):
if [[ -f "$dst" ]]; then
    if diff -q "$src" "$dst" > /dev/null 2>&1; then
        echo "  ✓ $file (identical)"
    else
        echo "  ! $file exists with different content"
        ...
    fi

# NEW:
if [[ -f "$dst" ]]; then
    if diff -q "$src" "$dst" > /dev/null 2>&1; then
        echo "  ✓ $file (identical)"
    else
        create_backup "$dst" "$file"
        cp "$src" "$dst"
        manifest_write "copy:$file" "$(compute_checksum "$dst")"
        echo "  ✓ $file (backed up and updated)"
    fi
```

#### Section 4: unlink_config Function (lines 126-144)
Complete rewrite to:

- Check for manifest
- Iterate through manifest entries
- Restore backups for each entry
- Handle legacy installations gracefully
- Remove manifest file when complete

**New Implementation:**

```bash
unlink_config() {
    local target="$1"
    local manifest="$target/$MANIFEST_FILE"

    echo "Unlinking from: $target"

    if [[ ! -f "$manifest" ]]; then
        echo "  Warning: No manifest found. Attempting legacy unlink..."
        legacy_unlink "$target"
        return
    fi

    # Process symlinks
    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        if [[ -L "$dst" ]]; then
            rm "$dst"
            restore_backup "$target" "$dir"
        fi
    done

    # Process copied files
    for file in "${COPY_FILES[@]}"; do
        restore_backup "$target" "$file"
    done

    # Remove manifest
    rm "$manifest"
    echo "Done! Configuration unlinked and original files restored."
}
```

#### Section 5: show_status Function (lines 146-163)
Add manifest status display:

- Show if manifest exists
- Show installation date
- Show source directory
- List tracked backups

#### Section 6: Main Block (lines 165-189)
Fix argument handling:

```bash
# OLD (line 171-173):
--unlink)
    show_banner "UNINSTALLING"
    unlink_config "$(get_target_dir)"
    ;;

# NEW:
--unlink)
    show_banner "UNINSTALLING"
    shift
    unlink_config "$(get_target_dir "${1:-}")"
    ;;

# Also need to handle combined --unlink --project
--unlink)
    show_banner "UNINSTALLING"
    if [[ "${2:-}" == "--project" ]]; then
        unlink_config "$(get_target_dir --project)"
    else
        unlink_config "$(get_target_dir)"
    fi
    ;;
```

### New Functions - Detailed Specifications

#### manifest_init()
```bash
manifest_init() {
    local target="$1"
    local manifest="$target/$MANIFEST_FILE"

    cat > "$manifest" << EOF
# AI-Sidekicks Installation Manifest
# DO NOT EDIT - Managed by install.sh
version=$MANIFEST_VERSION
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_dir=$SCRIPT_DIR
EOF
}
```

#### manifest_write()
```bash
manifest_write() {
    local manifest="$1"
    local key="$2"
    local value="$3"
    echo "${key}=${value}" >> "$manifest"
}
```

#### manifest_read()
```bash
manifest_read() {
    local manifest="$1"
    local key="$2"
    grep "^${key}=" "$manifest" 2>/dev/null | cut -d'=' -f2-
}
```

#### create_backup()
```bash
create_backup() {
    local target_dir="$1"
    local item="$2"
    local src="$target_dir/$item"
    local backup="$target_dir/${item}${BACKUP_SUFFIX}"
    local manifest="$target_dir/$MANIFEST_FILE"

    if [[ -e "$src" ]]; then
        mv "$src" "$backup"
        manifest_write "$manifest" "backup:$item" "$backup"
        echo "  Backed up $item to ${item}${BACKUP_SUFFIX}"
    fi
}
```

#### restore_backup()
```bash
restore_backup() {
    local target_dir="$1"
    local item="$2"
    local backup="$target_dir/${item}${BACKUP_SUFFIX}"
    local dst="$target_dir/$item"

    if [[ -e "$backup" ]]; then
        # Remove current item if exists (symlink or file)
        [[ -e "$dst" || -L "$dst" ]] && rm -rf "$dst"
        mv "$backup" "$dst"
        echo "  Restored $item from backup"
    else
        # No backup - check if we should copy from source
        local src="$SOURCE_CLAUDE/$item"
        if [[ -e "$src" ]]; then
            cp -r "$src" "$dst"
            echo "  Created standalone copy of $item"
        fi
    fi
}
```

#### legacy_unlink()
```bash
legacy_unlink() {
    local target="$1"
    echo "  No manifest found - this may be a pre-manifest installation"
    echo "  Converting symlinks to copies (backups will not be restored)"

    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        local src="$SOURCE_CLAUDE/$dir"

        if [[ -L "$dst" ]]; then
            rm "$dst"
            cp -r "$src" "$dst"
            echo "  ✓ $dir (converted to copy)"
        fi
    done

    echo "  Note: Check for *.bak files that may be from previous installations"
}
```

#### compute_checksum()
```bash
compute_checksum() {
    local file="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "$file" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$file" | cut -d' ' -f1
    else
        # Fallback: use file size and mtime
        stat -c '%s-%Y' "$file" 2>/dev/null || stat -f '%z-%m' "$file"
    fi
}
```

---

## 4. Testing Strategy

### Test Environment Setup

```bash
# Create test harness script
TEST_BASE=$(mktemp -d)
AI_SIDEKICKS_DIR="/home/sabossedgh/repos/ai-sidekicks"

setup_test_env() {
    local name="$1"
    local test_dir="$TEST_BASE/$name"
    mkdir -p "$test_dir/.claude"
    echo "$test_dir"
}

cleanup_test_env() {
    rm -rf "$TEST_BASE"
}
```

### Test Cases

#### Test 1: Basic Install/Uninstall Cycle with Restore

**Setup:**
```bash
TEST_DIR=$(setup_test_env "basic-restore")
mkdir -p "$TEST_DIR/.claude/skills" "$TEST_DIR/.claude/agents"
echo "custom skill content" > "$TEST_DIR/.claude/skills/custom.md"
echo '{"user": "settings"}' > "$TEST_DIR/.claude/settings.json"
```

**Actions:**
```bash
cd "$TEST_DIR" && "$AI_SIDEKICKS_DIR/install.sh" --project
"$AI_SIDEKICKS_DIR/install.sh" --unlink --project
```

**Verify:**
- [ ] Original `skills/custom.md` restored with content "custom skill content"
- [ ] Original `settings.json` restored with `{"user": "settings"}`
- [ ] No `.ai-sidekicks.bak` files remain
- [ ] No manifest file remains

#### Test 2: Project Unlink Works

**Setup:**
```bash
TEST_DIR=$(setup_test_env "project-unlink")
mkdir -p "$TEST_DIR/.claude"
```

**Actions:**
```bash
cd "$TEST_DIR" && "$AI_SIDEKICKS_DIR/install.sh" --project
# Verify symlinks point to ai-sidekicks
"$AI_SIDEKICKS_DIR/install.sh" --unlink --project
```

**Verify:**
- [ ] Symlinks removed from project directory
- [ ] `$HOME/.claude` unchanged
- [ ] Standalone copies created in project

#### Test 3: Orphaned Backup Cleanup

**Setup:**
```bash
TEST_DIR=$(setup_test_env "orphan-cleanup")
mkdir -p "$TEST_DIR/.claude/skills"
echo "original" > "$TEST_DIR/.claude/skills/test.md"
```

**Actions:**
```bash
cd "$TEST_DIR"
"$AI_SIDEKICKS_DIR/install.sh" --project  # Creates .ai-sidekicks.bak
"$AI_SIDEKICKS_DIR/install.sh" --unlink --project  # Should restore and clean
```

**Verify:**
- [ ] No `*.ai-sidekicks.bak` files exist after unlink
- [ ] Original content restored

#### Test 4: Settings Backup on Differ

**Setup:**
```bash
TEST_DIR=$(setup_test_env "settings-backup")
mkdir -p "$TEST_DIR/.claude"
echo '{"custom": "config"}' > "$TEST_DIR/.claude/settings.json"
```

**Actions:**
```bash
cd "$TEST_DIR" && "$AI_SIDEKICKS_DIR/install.sh" --project
```

**Verify:**
- [ ] `settings.json.ai-sidekicks.bak` created
- [ ] Backup contains `{"custom": "config"}`
- [ ] Current `settings.json` contains ai-sidekicks content
- [ ] Manifest records backup

#### Test 5: Ownership Identification

**Setup:**
```bash
TEST_DIR=$(setup_test_env "ownership")
mkdir -p "$TEST_DIR/.claude"
# Create user's own backup
mkdir "$TEST_DIR/.claude/myconfig.bak"
echo "my backup" > "$TEST_DIR/.claude/myconfig.bak/data.txt"
```

**Actions:**
```bash
cd "$TEST_DIR"
"$AI_SIDEKICKS_DIR/install.sh" --project
"$AI_SIDEKICKS_DIR/install.sh" --unlink --project
```

**Verify:**
- [ ] User's `myconfig.bak` untouched (still exists with content)
- [ ] Only `*.ai-sidekicks.bak` files managed
- [ ] Manifest only tracks ai-sidekicks items

#### Test 6: Backwards Compatibility (No Manifest)

**Setup:**
```bash
TEST_DIR=$(setup_test_env "legacy")
mkdir -p "$TEST_DIR/.claude"
# Simulate pre-manifest installation
ln -s "$AI_SIDEKICKS_DIR/.claude/skills" "$TEST_DIR/.claude/skills"
ln -s "$AI_SIDEKICKS_DIR/.claude/agents" "$TEST_DIR/.claude/agents"
# Old-style backup
mkdir "$TEST_DIR/.claude/rules.bak"
```

**Actions:**
```bash
cd "$TEST_DIR" && "$AI_SIDEKICKS_DIR/install.sh" --unlink --project
```

**Verify:**
- [ ] Warning about missing manifest displayed
- [ ] Symlinks converted to copies
- [ ] Legacy `.bak` files left untouched (user responsibility)
- [ ] No errors or crashes

#### Test 7: Shellcheck Compliance

```bash
shellcheck "$AI_SIDEKICKS_DIR/install.sh"
```

**Verify:**
- [ ] No errors
- [ ] No warnings (or documented exceptions with comments)

### Edge Cases to Test

1. **Empty target directory** - Install to fresh `.claude` with no existing content
2. **Partial installation** - Interrupt mid-install, run again
3. **Read-only filesystem** - Graceful error handling
4. **Symlink to non-existent target** - Handle broken symlinks
5. **Circular symlinks** - Detect and report
6. **Special characters in paths** - Spaces, quotes in directory names
7. **macOS vs Linux** - `stat` command differences, `sha256sum` vs `shasum`

### Cross-Platform Testing

```bash
# Test stat command portability
if [[ "$(uname)" == "Darwin" ]]; then
    # macOS uses different stat flags
    stat -f '%z' file
else
    # Linux
    stat -c '%s' file
fi

# Test checksum command portability
if command -v sha256sum &>/dev/null; then
    sha256sum file
elif command -v shasum &>/dev/null; then
    shasum -a 256 file
fi
```

---

## 5. Risk Assessment

### Risk 1: Breaking Existing Installations

**Probability**: Medium
**Impact**: High

**What Could Go Wrong:**
- Existing installations without manifest become unmanageable
- Users with current `.bak` files lose ability to restore

**Mitigation:**
- Implement `legacy_unlink()` function for pre-manifest installations
- Detect missing manifest and warn user
- Never delete `.bak` files not tracked in manifest
- Provide migration command: `./install.sh --migrate` to create manifest for existing installations

**Fallback:**
- If legacy mode causes issues, symlinks can still be manually removed
- Old `.bak` files remain untouched

### Risk 2: Manifest Corruption

**Probability**: Low
**Impact**: High

**What Could Go Wrong:**
- Manifest file deleted or corrupted
- Partial write during crash
- User manually edits manifest incorrectly

**Mitigation:**
- Validate manifest format on read
- Use atomic writes (write to temp, then mv)
- Clear header comments warning not to edit
- Graceful degradation to legacy mode if manifest invalid

**Fallback:**
- Fall back to legacy unlink behavior
- `.ai-sidekicks.bak` suffix allows manual identification

### Risk 3: Backup Naming Collision

**Probability**: Low
**Impact**: Medium

**What Could Go Wrong:**
- User happens to have files named `*.ai-sidekicks.bak`
- Multiple installations create nested backups

**Mitigation:**
- Check if backup destination already exists before creating
- Refuse to overwrite existing `.ai-sidekicks.bak` files not in manifest
- Log warning and skip if collision detected

**Fallback:**
- Manual intervention required for rare collision cases
- User can rename conflicting files

### Risk 4: Cross-Platform Incompatibility

**Probability**: Medium
**Impact**: Medium

**What Could Go Wrong:**
- `stat` command has different flags on macOS vs Linux
- `sha256sum` not available on macOS (use `shasum -a 256`)
- `date` format differences

**Mitigation:**
- Test both platforms in CI
- Use command detection with fallbacks
- Avoid GNU-specific bash features
- Use POSIX-compatible date formats where possible

**Fallback:**
- Degrade gracefully (skip checksum if unavailable)
- Document platform requirements

### Risk 5: Race Conditions

**Probability**: Low
**Impact**: Low

**What Could Go Wrong:**
- Multiple install.sh instances running simultaneously
- File changes between read and write

**Mitigation:**
- Use atomic operations where possible
- Not implementing file locking (adds complexity)
- Document that concurrent runs are unsupported

**Fallback:**
- Manual cleanup if race condition occurs
- Re-run install should recover

### Risk 6: Permission Errors

**Probability**: Medium
**Impact**: Medium

**What Could Go Wrong:**
- Target directory not writable
- Backup file can't be created
- Symlink creation fails

**Mitigation:**
- Check permissions before operations
- Provide clear error messages
- Continue with other items if one fails
- Use `set -e` carefully (don't exit on first error)

**Fallback:**
- User runs with appropriate permissions
- Partial installation can be fixed by re-running

---

## 6. Implementation Order

Recommended sequence of changes:

1. **Add configuration constants** - Low risk, enables later work
2. **Add utility functions** (`log_verbose`, `compute_checksum`) - Low risk
3. **Add manifest functions** - Independent, testable unit
4. **Add backup/restore functions** - Depends on manifest functions
5. **Modify `install_config`** - Use new backup functions
6. **Modify main block argument handling** - Fix `--project` passing
7. **Rewrite `unlink_config`** - Use new restore functions
8. **Update `show_status`** - Display manifest information
9. **Add legacy support** - Handle pre-manifest installations
10. **Run shellcheck and fix** - Final polish

---

## 7. Success Criteria Checklist

Upon completion, the following must be true:

- [ ] `./install.sh --unlink` restores original files from backup
- [ ] `./install.sh --unlink --project` works correctly in project directories
- [ ] No orphaned `.ai-sidekicks.bak` files after clean uninstall
- [ ] `settings.json` is backed up when content differs before overwrite
- [ ] User's manual `.bak` files are never touched
- [ ] Manifest file tracks all ai-sidekicks managed items
- [ ] Legacy installations (no manifest) handled gracefully with warning
- [ ] Script passes `shellcheck install.sh` with no warnings
- [ ] Works on both Linux and macOS
- [ ] All test cases pass

---

## References

- [GNU Stow Manual](https://www.gnu.org/software/stow/manual/stow.html) - Symlink farm management approach
- [dpkg conffile handling](https://wiki.debian.org/DpkgConffileHandling) - Backup/restore patterns
- [chezmoi documentation](https://www.chezmoi.io/) - State tracking concepts
- [Debian conffile details](https://raphaelhertzog.com/2010/09/21/debian-conffile-configuration-file-managed-by-dpkg/) - `.dpkg-old` and `.dpkg-dist` naming conventions
