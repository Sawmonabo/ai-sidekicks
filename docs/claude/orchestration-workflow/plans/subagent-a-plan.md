# Implementation Plan: Fixing install.sh Script

## Executive Summary

The `install.sh` script has five reported issues related to backup management, uninstallation behavior, and ownership tracking. This plan details a manifest-based solution inspired by GNU Stow's adoption mechanism and dpkg's conffile handling patterns.

---

## 1. Issue Analysis

### Issue 1: Uninstall doesn't restore original files

**Root Cause Identification**
- Location: Lines 126-144 (`unlink_config` function)
- The function removes symlinks and copies source content but never checks for or restores `.bak` directories

**Why It Fails**
```bash
# Current behavior (lines 135-140):
if [[ -L "$dst" ]]; then
    rm "$dst"
    cp -r "$src" "$dst"  # Copies from ai-sidekicks source, not from backup!
fi
```

The function copies from `$SOURCE_CLAUDE/$dir` instead of restoring from `${dst}.bak`. The backup created during install (line 90) is completely ignored during uninstall.

**Impact on Users**
- Users lose their custom configurations permanently
- Custom skills, agents, and rules created before install are lost
- Trust erosion - users hesitant to try the install script

---

### Issue 2: Uninstall only works for user config

**Root Cause Identification**
- Location: Lines 171-173 (main case statement)
- The `--unlink` case calls `get_target_dir` without passing `$2` (the `--project` flag)

**Why It Fails**
```bash
# Current behavior (line 172):
--unlink)
    unlink_config "$(get_target_dir)"  # Missing: should check for --project in $2
```

The argument parsing doesn't handle combined flags like `--unlink --project`. The second argument is never examined.

**Impact on Users**
- Cannot uninstall from project directories
- Users must manually fix project `.claude/` directories
- Inconsistent behavior between install and uninstall

---

### Issue 3: Orphaned backup files

**Root Cause Identification**
- Location: Lines 88-91 (backup creation in `install_config`)
- Backups are created but never cleaned up during successful uninstall
- No tracking of which backups exist or belong to ai-sidekicks

**Why It Fails**
```bash
# Install creates backup:
mv "$dst" "${dst}.bak"

# Uninstall doesn't clean up:
# No code exists to remove .bak after restore
```

**Impact on Users**
- Disk space accumulates with unused backups
- Users confused about which `.bak` files are safe to delete
- Multiple install/uninstall cycles create nested `.bak.bak` files

---

### Issue 4: Settings not backed up

**Root Cause Identification**
- Location: Lines 97-120 (copy files section in `install_config`)
- When files differ, the script warns but doesn't offer backup

**Why It Fails**
```bash
# Current behavior (lines 107-115):
if [[ -f "$dst" ]]; then
    if diff -q "$src" "$dst" > /dev/null 2>&1; then
        echo "  (identical)"
    else
        echo "  ! exists with different content"  # Warns but doesn't backup
        # Never overwrites, but also never offers a solution
    fi
fi
```

The script refuses to overwrite different content but provides no mechanism to:
1. Backup the existing settings
2. Merge configurations
3. Allow user to proceed with backup

**Impact on Users**
- Users stuck with old settings after code updates
- No clear path to adopt new settings while preserving customizations
- Manual intervention required for every settings update

---

### Issue 5: No way to identify ownership

**Root Cause Identification**
- Location: Throughout - no manifest or tracking mechanism exists
- Backups use generic `.bak` suffix indistinguishable from user backups

**Why It Fails**
The naming convention `${name}.bak` is too generic:
- User might have `skills.bak` from their own workflow
- Multiple backup sources (other tools, manual backups) use same pattern
- No metadata about when/why backup was created

**Impact on Users**
- Users afraid to delete any `.bak` files
- Can't distinguish ai-sidekicks backups from personal backups
- Cleanup becomes impossible without detailed investigation

---

## 2. Proposed Solution Architecture

### Overall Design: Manifest-Based Tracking

Inspired by:
- **GNU Stow**: Uses directory structure and symlink targets for implicit tracking; we'll use explicit manifest
- **dpkg conffiles**: Stores checksums in `/var/lib/dpkg/info/*.conffiles`; we'll track in manifest
- **chezmoi**: Uses source state directory with metadata in filenames; we'll use JSON manifest

### Manifest File Specification

**Location**: `.claude/.ai-sidekicks-manifest.json`

**Format**:
```json
{
  "version": 1,
  "source_repo": "/path/to/ai-sidekicks",
  "installed_at": "2026-02-04T10:30:00Z",
  "items": {
    "skills": {
      "type": "symlink",
      "backup_path": ".claude/skills.ai-sidekicks.bak",
      "backup_checksum": "sha256:abc123...",
      "installed_at": "2026-02-04T10:30:00Z"
    },
    "agents": {
      "type": "symlink",
      "backup_path": null,
      "installed_at": "2026-02-04T10:30:00Z"
    },
    "settings.json": {
      "type": "copy",
      "backup_path": ".claude/settings.json.ai-sidekicks.bak",
      "backup_checksum": "sha256:def456...",
      "source_checksum": "sha256:ghi789...",
      "installed_at": "2026-02-04T10:30:00Z"
    }
  }
}
```

### Function Decomposition

```
install.sh
├── Manifest Functions
│   ├── init_manifest()         # Create new manifest
│   ├── read_manifest()         # Load existing manifest
│   ├── write_manifest()        # Save manifest atomically
│   ├── add_manifest_entry()    # Add item to manifest
│   └── remove_manifest_entry() # Remove item from manifest
│
├── Backup Functions
│   ├── create_backup()         # Backup with manifest tracking
│   ├── restore_backup()        # Restore from manifest
│   ├── cleanup_backup()        # Remove backup after restore
│   └── compute_checksum()      # SHA256 of file/directory
│
├── Install Functions (existing, modified)
│   ├── install_config()        # Modified to use manifest
│   └── install_item()          # New: handles single item
│
├── Uninstall Functions (existing, modified)
│   ├── unlink_config()         # Modified to restore backups
│   └── unlink_item()           # New: handles single item
│
├── Status Functions (existing, modified)
│   └── show_status()           # Enhanced with manifest info
│
└── Utility Functions
    ├── get_target_dir()        # Existing
    ├── parse_args()            # New: proper argument parsing
    └── require_manifest()      # Ensure manifest exists
```

### Data Flow

```
INSTALL:
1. parse_args() → determine target (user vs project)
2. init_manifest() or read_manifest() → load state
3. For each item:
   a. Check if already installed (via manifest)
   b. create_backup() if original exists → record in manifest
   c. Install (symlink or copy)
   d. add_manifest_entry() → update manifest
4. write_manifest() → persist state

UNINSTALL:
1. parse_args() → determine target
2. read_manifest() → load state (fail gracefully if missing)
3. For each item in manifest:
   a. Remove installed item (symlink or copied file)
   b. restore_backup() if backup exists
   c. cleanup_backup() → remove backup
   d. remove_manifest_entry()
4. write_manifest() or remove manifest if empty
```

---

## 3. File Modifications Required

### New Functions to Add

#### 3.1 Argument Parsing

```bash
# Add after line 60
parse_args() {
    local args=("$@")
    ACTION="install"
    PROJECT_MODE=false
    VERBOSE=false

    for arg in "${args[@]}"; do
        case "$arg" in
            --project) PROJECT_MODE=true ;;
            --unlink) ACTION="unlink" ;;
            --status) ACTION="status" ;;
            --verbose|-v) VERBOSE=true ;;
            --help|-h) ACTION="help" ;;
            *) echo "Unknown option: $arg"; exit 1 ;;
        esac
    done
}
```

#### 3.2 Manifest Functions

```bash
MANIFEST_VERSION=1
MANIFEST_FILENAME=".ai-sidekicks-manifest.json"

get_manifest_path() {
    echo "$1/$MANIFEST_FILENAME"
}

init_manifest() {
    local target="$1"
    local manifest_path
    manifest_path="$(get_manifest_path "$target")"

    cat > "$manifest_path" << EOF
{
  "version": $MANIFEST_VERSION,
  "source_repo": "$SCRIPT_DIR",
  "installed_at": "$(date -Iseconds)",
  "items": {}
}
EOF
}

# Note: JSON parsing in pure bash is limited
# Use simple key-value extraction with grep/sed
# Or consider jq dependency (optional enhancement)
```

#### 3.3 Backup Functions

```bash
BACKUP_SUFFIX=".ai-sidekicks.bak"

create_backup() {
    local target="$1"
    local item="$2"
    local src="$target/$item"
    local dst="$target/${item}${BACKUP_SUFFIX}"

    if [[ -e "$src" ]] && [[ ! -L "$src" ]]; then
        mv "$src" "$dst"
        echo "$dst"  # Return backup path
    else
        echo ""  # No backup created
    fi
}

restore_backup() {
    local target="$1"
    local item="$2"
    local backup_path="$target/${item}${BACKUP_SUFFIX}"
    local restore_path="$target/$item"

    if [[ -e "$backup_path" ]]; then
        # Remove current item (symlink or copy)
        rm -rf "$restore_path"
        mv "$backup_path" "$restore_path"
        return 0
    fi
    return 1
}
```

### Modifications to Existing Functions

#### 3.4 Modify `install_config()` (Lines 62-124)

**Before** (line 88-91):
```bash
elif [[ -d "$dst" ]]; then
    echo "  Backing up existing $dir to ${dir}.bak"
    mv "$dst" "${dst}.bak"
fi
```

**After**:
```bash
elif [[ -d "$dst" ]]; then
    local backup_path
    backup_path=$(create_backup "$target" "$dir")
    if [[ -n "$backup_path" ]]; then
        echo "  Backing up existing $dir to $backup_path"
        add_manifest_entry "$target" "$dir" "symlink" "$backup_path"
    fi
fi
```

#### 3.5 Modify `unlink_config()` (Lines 126-144)

**Current implementation**:
```bash
unlink_config() {
    local target="$1"
    for dir in "${PORTABLE_DIRS[@]}"; do
        if [[ -L "$dst" ]]; then
            rm "$dst"
            cp -r "$src" "$dst"  # WRONG: should restore backup
        fi
    done
}
```

**Proposed implementation**:
```bash
unlink_config() {
    local target="$1"
    local manifest_path
    manifest_path="$(get_manifest_path "$target")"

    if [[ ! -f "$manifest_path" ]]; then
        echo "Warning: No manifest found. Using legacy unlink behavior."
        legacy_unlink_config "$target"
        return
    fi

    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        if [[ -L "$dst" ]]; then
            rm "$dst"
            if restore_backup "$target" "$dir"; then
                echo "  Restored $dir from backup"
            else
                echo "  Removed $dir (no backup to restore)"
            fi
        fi
    done

    # Handle settings.json
    for file in "${COPY_FILES[@]}"; do
        if restore_backup "$target" "$file"; then
            echo "  Restored $file from backup"
        fi
    done

    # Clean up manifest
    rm -f "$manifest_path"
    echo "Done! Installation removed and originals restored."
}
```

#### 3.6 Modify Main Case Statement (Lines 165-189)

**Before**:
```bash
case "${1:-}" in
    --project)
        install_config "$(get_target_dir --project)" "project"
        ;;
    --unlink)
        unlink_config "$(get_target_dir)"  # Bug: doesn't honor --project
        ;;
```

**After**:
```bash
# Replace entire main block with:
parse_args "$@"

TARGET_DIR="$(get_target_dir "$PROJECT_MODE")"

case "$ACTION" in
    install)
        show_banner "INITIALIZING"
        install_config "$TARGET_DIR"
        ;;
    unlink)
        show_banner "UNINSTALLING"
        unlink_config "$TARGET_DIR"
        ;;
    status)
        show_banner "SCANNING"
        show_status
        ;;
    help)
        usage
        ;;
esac
```

#### 3.7 Modify Settings Handling (Lines 97-120)

**Add backup for settings.json**:
```bash
for file in "${COPY_FILES[@]}"; do
    local src="$SOURCE_CLAUDE/$file"
    local dst="$target/$file"

    if [[ ! -f "$src" ]]; then
        echo "  Skip $file (not in source)"
        continue
    fi

    if [[ -f "$dst" ]]; then
        if diff -q "$src" "$dst" > /dev/null 2>&1; then
            echo "  ✓ $file (identical)"
        else
            echo "  Backing up existing $file"
            local backup_path
            backup_path=$(create_backup "$target" "$file")
            add_manifest_entry "$target" "$file" "copy" "$backup_path"
            cp "$src" "$dst"
            echo "  ✓ $file (updated, original backed up to $backup_path)"
        fi
    else
        cp "$src" "$dst"
        echo "  ✓ $file (copied)"
    fi
done
```

---

## 4. Testing Strategy

### Test Scenarios

#### Scenario A: Basic Install/Uninstall Cycle
```bash
TEST_DIR=$(mktemp -d)
mkdir -p "$TEST_DIR/.claude/skills" "$TEST_DIR/.claude/agents"
echo '{"original": true}' > "$TEST_DIR/.claude/settings.json"
echo "custom skill" > "$TEST_DIR/.claude/skills/custom.md"

# Install
cd "$TEST_DIR" && ./install.sh --project

# Verify: symlinks created, backups exist with .ai-sidekicks.bak suffix
[[ -L "$TEST_DIR/.claude/skills" ]] || fail "skills not symlinked"
[[ -d "$TEST_DIR/.claude/skills.ai-sidekicks.bak" ]] || fail "skills backup missing"

# Uninstall
./install.sh --unlink --project

# Verify: originals restored
[[ -d "$TEST_DIR/.claude/skills" ]] && [[ ! -L "$TEST_DIR/.claude/skills" ]] || fail "skills not restored"
[[ -f "$TEST_DIR/.claude/skills/custom.md" ]] || fail "custom.md not restored"
cat "$TEST_DIR/.claude/settings.json" | grep '"original": true' || fail "settings not restored"
```

#### Scenario B: Settings Backup When Different
```bash
TEST_DIR=$(mktemp -d)
mkdir -p "$TEST_DIR/.claude"
echo '{"custom": "value"}' > "$TEST_DIR/.claude/settings.json"

cd "$TEST_DIR" && ./install.sh --project

# Verify: original settings backed up
[[ -f "$TEST_DIR/.claude/settings.json.ai-sidekicks.bak" ]] || fail "settings backup missing"
grep '"custom"' "$TEST_DIR/.claude/settings.json.ai-sidekicks.bak" || fail "backup content wrong"
```

#### Scenario C: User Backup Preservation
```bash
mkdir -p ~/.claude
mkdir ~/.claude/myconfig.bak  # User's own backup

./install.sh
./install.sh --unlink

# Verify: user's backup untouched
[[ -d ~/.claude/myconfig.bak ]] || fail "user backup was deleted"
```

#### Scenario D: Manifest Presence
```bash
TEST_DIR=$(mktemp -d)
cd "$TEST_DIR" && ./install.sh --project

# Verify: manifest exists and is valid
[[ -f "$TEST_DIR/.claude/.ai-sidekicks-manifest.json" ]] || fail "manifest missing"
grep '"version":' "$TEST_DIR/.claude/.ai-sidekicks-manifest.json" || fail "manifest invalid"
```

#### Scenario E: Legacy Installation (No Manifest)
```bash
# Simulate legacy installation with .bak files but no manifest
TEST_DIR=$(mktemp -d)
mkdir -p "$TEST_DIR/.claude"
ln -s /tmp/fake "$TEST_DIR/.claude/skills"
mkdir "$TEST_DIR/.claude/skills.bak"

cd "$TEST_DIR" && ./install.sh --unlink --project

# Verify: graceful handling (converts symlink to copy, warns about legacy)
[[ -d "$TEST_DIR/.claude/skills" ]] && [[ ! -L "$TEST_DIR/.claude/skills" ]] || fail "legacy unlink failed"
```

### Edge Cases to Test

1. **Interrupted installation**: Kill script mid-install, verify partial state is recoverable
2. **Permission errors**: Read-only target directory handling
3. **Missing source**: ai-sidekicks repo moved/deleted after installation
4. **Nested backups**: Prevent `.bak.bak.bak` accumulation
5. **Empty directories**: Handle empty skills/agents/rules directories
6. **Symlink chains**: Target is already a symlink to somewhere else
7. **Concurrent access**: Two install.sh instances running simultaneously

### Backwards Compatibility Testing

```bash
# Test 1: Old installation without manifest
# Should: warn and use legacy behavior

# Test 2: Old .bak files without .ai-sidekicks suffix
# Should: NOT delete (could be user's backup)

# Test 3: Mixed state (some items in manifest, some not)
# Should: handle manifest items, warn about others
```

### Shellcheck Validation

```bash
shellcheck install.sh
# Expected: 0 warnings, 0 errors
```

---

## 5. Risk Assessment

### Risk 1: Data Loss During Migration

**What Could Go Wrong**
- Users with existing `.bak` files might have them mistakenly deleted
- Manifest parsing errors could cause incorrect restore behavior

**Mitigations**
1. Only manage backups with `.ai-sidekicks.bak` suffix
2. Never delete files not tracked in manifest
3. Validate manifest JSON before operations
4. Add `--dry-run` flag to preview changes

**Fallback**
- Preserve legacy unlink behavior when no manifest exists
- Print warnings but don't fail on manifest errors

### Risk 2: JSON Parsing in Bash

**What Could Go Wrong**
- Pure bash JSON parsing is fragile
- Special characters in paths could break parsing

**Mitigations**
1. Use simple, flat JSON structure
2. Escape special characters in paths
3. Validate JSON structure before use
4. Consider optional `jq` dependency with fallback

**Fallback**
- Use simple key-value format instead of JSON
- Format: `item|type|backup_path|timestamp`

### Risk 3: Concurrent Modifications

**What Could Go Wrong**
- Two scripts running simultaneously could corrupt manifest
- User editing `.claude/` during install could cause conflicts

**Mitigations**
1. Use atomic file writes (write to temp, then mv)
2. Lock file during operations (optional)
3. Verify expected state before each operation

**Fallback**
- Detect corrupted manifest and offer to regenerate

### Risk 4: Cross-Platform Compatibility

**What Could Go Wrong**
- `date -Iseconds` not available on all macOS versions
- `readlink -f` not available on macOS
- Different sed/grep behavior

**Mitigations**
1. Use POSIX-compatible date format
2. Implement portable readlink function
3. Test on both Linux and macOS

**Fallback**
- Degrade gracefully with simpler timestamp format
- Use bash built-ins where possible

### Risk 5: Breaking Existing Workflows

**What Could Go Wrong**
- Users scripting around current behavior
- Changed exit codes or output format

**Mitigations**
1. Keep same CLI interface
2. Add new features as opt-in initially
3. Document migration path
4. Maintain same output format where possible

**Fallback**
- Add `--legacy` flag to use old behavior

---

## 6. Implementation Order

### Phase 1: Foundation (Estimated: 1 hour)
1. Add `parse_args()` function
2. Fix `--unlink --project` argument handling
3. Add tests for Phase 1

### Phase 2: Manifest Infrastructure (Estimated: 2 hours)
1. Add manifest file functions
2. Add backup functions with new suffix
3. Integrate manifest into `install_config()`
4. Add tests for Phase 2

### Phase 3: Restore Logic (Estimated: 1.5 hours)
1. Modify `unlink_config()` to restore backups
2. Add legacy mode detection
3. Add tests for Phase 3

### Phase 4: Settings Handling (Estimated: 1 hour)
1. Add settings backup on install
2. Add settings restore on uninstall
3. Add tests for Phase 4

### Phase 5: Polish (Estimated: 1 hour)
1. Add `--verbose` flag
2. Enhance `show_status()` with manifest info
3. Run shellcheck and fix warnings
4. Final integration testing

---

## 7. Alternative Approaches Considered

### Alternative 1: Naming Convention Only (No Manifest)

**Approach**: Use `.ai-sidekicks.bak` suffix without manifest file

**Pros**:
- Simpler implementation
- No JSON parsing needed

**Cons**:
- Can't store metadata (checksums, timestamps)
- Can't distinguish between multiple install sources
- No way to track partial installations

**Decision**: Rejected - insufficient for complex scenarios

### Alternative 2: SQLite Database

**Approach**: Use SQLite for robust state tracking

**Pros**:
- Robust, battle-tested storage
- Easy queries
- ACID compliance

**Cons**:
- External dependency
- Overkill for this use case
- Not portable

**Decision**: Rejected - violates single-script constraint

### Alternative 3: Stow-Style Directory Structure

**Approach**: Store backups in `.claude/.ai-sidekicks-backups/` directory

**Pros**:
- Clear separation
- Easy to find all backups

**Cons**:
- Different from standard `.bak` convention
- More complex path management

**Decision**: Partially adopted - using unique suffix while keeping files in place

---

## 8. References

Research sources consulted for this plan:

- [GNU Stow Manual](https://www.gnu.org/software/stow/manual/stow.html) - Symlink farm management and conflict handling
- [Why GNU Stow for dotfile management](https://rickcogley.github.io/dotfiles/explanations/gnu-stow.html) - Ownership tracking patterns
- [Stowaway GitHub](https://github.com/jamesbehr/stowaway) - Package manifest extension for Stow
- [dpkg Conffile Handling - Debian Wiki](https://wiki.debian.org/DpkgConffileHandling) - Backup/restore mechanisms
- [chezmoi Design](https://www.chezmoi.io/user-guide/frequently-asked-questions/design/) - Source state management
- [chezmoi Source State Attributes](https://www.chezmoi.io/reference/source-state-attributes/) - Metadata in filenames

---

## Appendix A: Proposed Manifest Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "source_repo", "installed_at", "items"],
  "properties": {
    "version": {
      "type": "integer",
      "minimum": 1,
      "description": "Manifest format version for future compatibility"
    },
    "source_repo": {
      "type": "string",
      "description": "Absolute path to ai-sidekicks repository"
    },
    "installed_at": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of installation"
    },
    "items": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["type", "installed_at"],
        "properties": {
          "type": {
            "enum": ["symlink", "copy"],
            "description": "How item was installed"
          },
          "backup_path": {
            "type": ["string", "null"],
            "description": "Relative path to backup, or null if no backup"
          },
          "backup_checksum": {
            "type": ["string", "null"],
            "description": "SHA256 checksum of backup for verification"
          },
          "source_checksum": {
            "type": ["string", "null"],
            "description": "SHA256 of source at install time (for copies)"
          },
          "installed_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  }
}
```

## Appendix B: Shellcheck Compliance Notes

Current script has potential shellcheck warnings to address:

1. **Line 80**: `local current_target=$(readlink "$dst")` - Quote command substitution
2. **Line 108**: Use `[[ ]]` instead of string comparison in diff check
3. **Throughout**: Ensure all variable expansions are quoted

Fixes will be applied during implementation.
