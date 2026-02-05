# Implementation Plan: install.sh Fixes (Enhanced)

## Executive Summary

This plan addresses five reported issues in `install.sh` related to backup management, uninstallation, and ownership tracking. The solution implements a **manifest-based tracking system** using a simple key-value format (no JSON dependencies) with a distinctive backup suffix for clear ownership identification.

This plan synthesizes the best approaches from prior analysis, adding atomic operations, dry-run support, and comprehensive error handling.

---

## 1. Issue Analysis

### Issue 1: Uninstall doesn't restore original files

**Root Cause**: Lines 126-144 (`unlink_config` function)

```bash
# Current broken behavior:
if [[ -L "$dst" ]]; then
    rm "$dst"
    cp -r "$src" "$dst"  # Copies from SOURCE, ignoring .bak backup
fi
```

The function copies fresh content from `$SOURCE_CLAUDE` instead of restoring from `${dst}.bak` created during installation.

**Impact**: Users permanently lose custom configurations after uninstall.

---

### Issue 2: Uninstall only works for user config

**Root Cause**: Lines 171-173 (main case statement)

```bash
--unlink)
    unlink_config "$(get_target_dir)"  # Never receives --project argument
```

The `$2` argument (`--project`) is never passed to `get_target_dir`, so unlink always targets `$HOME/.claude`.

**Impact**: Cannot uninstall from project directories.

---

### Issue 3: Orphaned backup files

**Root Cause**: Lines 88-91 create backups, but `unlink_config` never cleans them up.

```bash
# Install creates:
mv "$dst" "${dst}.bak"

# Uninstall ignores:
# No code to remove or restore .bak files
```

**Impact**: Disk accumulation, user confusion about which backups are safe to delete.

---

### Issue 4: Settings not backed up

**Root Cause**: Lines 97-120 warn about differing `settings.json` but don't backup.

```bash
if diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  (identical)"
else
    echo "  ! exists with different content"  # Warns only, no backup
fi
```

**Impact**: Users lose custom settings with no recovery path.

---

### Issue 5: No way to identify ownership

**Root Cause**: Generic `.bak` suffix is indistinguishable from user's manual backups.

**Impact**: Users afraid to delete any `.bak` files, cleanup becomes impossible.

---

## 2. Solution Architecture

### Design Principles

1. **No external dependencies** - Pure bash, no `jq` or other tools required
2. **Atomic operations** - Write to temp files, then rename
3. **Graceful degradation** - Legacy installations handled without data loss
4. **Distinctive naming** - `.ai-sidekicks.bak` suffix for clear ownership
5. **Dry-run support** - Preview changes before execution

### Manifest File Design

**Location**: `$TARGET_DIR/.ai-sidekicks-manifest`

**Format**: Simple key-value text (portable, no parsing libraries needed)

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

# Backup records (item=backup_path)
backup:skills=.claude/skills.ai-sidekicks.bak
backup:agents=.claude/agents.ai-sidekicks.bak
backup:settings.json=.claude/settings.json.ai-sidekicks.bak

# Copied files with checksums
copy:settings.json=a1b2c3d4e5f6...
```

### Backup Naming Convention

| Old | New |
|-----|-----|
| `skills.bak` | `skills.ai-sidekicks.bak` |
| `settings.json.bak` | `settings.json.ai-sidekicks.bak` |

This allows:
- Clear identification of ai-sidekicks-managed backups
- Coexistence with user's manual `.bak` files
- Safe cleanup (only touch `.ai-sidekicks.bak` files)

### Function Architecture

```
install.sh
├── Configuration
│   ├── PORTABLE_DIRS=("skills" "agents" "rules")
│   ├── COPY_FILES=("settings.json")
│   ├── MANIFEST_FILE=".ai-sidekicks-manifest"
│   ├── BACKUP_SUFFIX=".ai-sidekicks.bak"
│   └── MANIFEST_VERSION="1"
│
├── Argument Parsing
│   └── parse_args()              # Unified argument handler
│
├── Utility Functions
│   ├── log_verbose()             # Conditional debug output
│   ├── log_error()               # Error output to stderr
│   ├── compute_checksum()        # SHA256 with fallbacks
│   └── atomic_write()            # Write via temp file + rename
│
├── Manifest Functions
│   ├── manifest_init()           # Create new manifest
│   ├── manifest_read()           # Read value by key
│   ├── manifest_write()          # Append key-value pair
│   ├── manifest_remove()         # Remove entry by key
│   ├── manifest_exists()         # Check if manifest present
│   └── manifest_validate()       # Verify manifest integrity
│
├── Backup Functions
│   ├── create_backup()           # Backup with manifest tracking
│   ├── restore_backup()          # Restore from backup
│   ├── cleanup_backup()          # Remove backup after restore
│   └── backup_exists()           # Check for backup file
│
├── Core Functions
│   ├── install_config()          # Modified: uses manifest
│   ├── unlink_config()           # Rewritten: restores backups
│   ├── legacy_unlink()           # Handle pre-manifest installs
│   ├── show_status()             # Enhanced: shows manifest info
│   └── migrate_legacy()          # Create manifest for existing install
│
└── Main
    └── Dispatch based on parse_args()
```

### Data Flow

```
INSTALL FLOW:
┌─────────────────────────────────────────────────────────────┐
│ 1. parse_args() → ACTION, PROJECT_MODE, DRY_RUN, VERBOSE   │
│ 2. Determine target directory                               │
│ 3. manifest_init() or manifest_validate()                   │
│ 4. For each PORTABLE_DIR:                                   │
│    ├─ Check if exists (not symlink)                         │
│    ├─ create_backup() if needed → record in manifest        │
│    ├─ Create symlink                                        │
│    └─ manifest_write("symlink:$dir", target)                │
│ 5. For each COPY_FILE:                                      │
│    ├─ Check if exists and differs                           │
│    ├─ create_backup() if needed → record in manifest        │
│    ├─ Copy file                                             │
│    └─ manifest_write("copy:$file", checksum)                │
└─────────────────────────────────────────────────────────────┘

UNLINK FLOW:
┌─────────────────────────────────────────────────────────────┐
│ 1. parse_args() → ACTION, PROJECT_MODE                      │
│ 2. Determine target directory                               │
│ 3. Check manifest_exists()                                  │
│    ├─ No manifest → legacy_unlink() with warning            │
│    └─ Has manifest → continue                               │
│ 4. For each symlink in manifest:                            │
│    ├─ Remove symlink                                        │
│    ├─ restore_backup() if backup exists                     │
│    ├─ cleanup_backup()                                      │
│    └─ manifest_remove() entry                               │
│ 5. For each copy in manifest:                               │
│    ├─ restore_backup() if backup exists                     │
│    └─ manifest_remove() entry                               │
│ 6. Remove manifest file                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. File Modifications

### 3.1 New Configuration Constants

Add after line 40:

```bash
# Manifest configuration
MANIFEST_FILE=".ai-sidekicks-manifest"
BACKUP_SUFFIX=".ai-sidekicks.bak"
MANIFEST_VERSION="1"

# Runtime flags (set by parse_args)
ACTION="install"
PROJECT_MODE=false
DRY_RUN=false
VERBOSE=false
```

### 3.2 Argument Parsing Function

Add new function:

```bash
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --project)
                PROJECT_MODE=true
                ;;
            --unlink)
                ACTION="unlink"
                ;;
            --status)
                ACTION="status"
                ;;
            --migrate)
                ACTION="migrate"
                ;;
            --dry-run|-n)
                DRY_RUN=true
                echo "Dry-run mode: no changes will be made"
                ;;
            --verbose|-v)
                VERBOSE=true
                ;;
            --help|-h)
                ACTION="help"
                ;;
            *)
                echo "Unknown option: $1" >&2
                echo "Run with --help for usage" >&2
                exit 1
                ;;
        esac
        shift
    done
}
```

### 3.3 Utility Functions

```bash
log_verbose() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo "  [DEBUG] $*"
    fi
}

log_error() {
    echo "  [ERROR] $*" >&2
}

compute_checksum() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        echo ""
        return
    fi

    if command -v sha256sum &>/dev/null; then
        sha256sum "$file" 2>/dev/null | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$file" 2>/dev/null | cut -d' ' -f1
    else
        # Fallback: use file size (less reliable but portable)
        wc -c < "$file" | tr -d ' '
    fi
}

atomic_write() {
    local file="$1"
    local content="$2"
    local tmp="${file}.tmp.$$"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_verbose "Would write to $file"
        return 0
    fi

    echo "$content" > "$tmp" || { log_error "Failed to write temp file"; return 1; }
    mv "$tmp" "$file" || { log_error "Failed to rename temp file"; rm -f "$tmp"; return 1; }
}
```

### 3.4 Manifest Functions

```bash
manifest_path() {
    local target="$1"
    echo "$target/$MANIFEST_FILE"
}

manifest_exists() {
    local target="$1"
    [[ -f "$(manifest_path "$target")" ]]
}

manifest_init() {
    local target="$1"
    local manifest
    manifest="$(manifest_path "$target")"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  Would create manifest at $manifest"
        return 0
    fi

    cat > "$manifest" << EOF
# AI-Sidekicks Installation Manifest
# DO NOT EDIT - Managed by install.sh
version=$MANIFEST_VERSION
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_dir=$SCRIPT_DIR
EOF
    log_verbose "Created manifest at $manifest"
}

manifest_read() {
    local target="$1"
    local key="$2"
    local manifest
    manifest="$(manifest_path "$target")"

    if [[ ! -f "$manifest" ]]; then
        return 1
    fi

    grep "^${key}=" "$manifest" 2>/dev/null | head -1 | cut -d'=' -f2-
}

manifest_write() {
    local target="$1"
    local key="$2"
    local value="$3"
    local manifest
    manifest="$(manifest_path "$target")"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_verbose "Would write manifest entry: $key=$value"
        return 0
    fi

    # Remove existing entry if present, then append
    if grep -q "^${key}=" "$manifest" 2>/dev/null; then
        local tmp="${manifest}.tmp.$$"
        grep -v "^${key}=" "$manifest" > "$tmp"
        mv "$tmp" "$manifest"
    fi

    echo "${key}=${value}" >> "$manifest"
    log_verbose "Manifest entry: $key=$value"
}

manifest_remove() {
    local target="$1"
    local key="$2"
    local manifest
    manifest="$(manifest_path "$target")"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_verbose "Would remove manifest entry: $key"
        return 0
    fi

    if [[ -f "$manifest" ]]; then
        local tmp="${manifest}.tmp.$$"
        grep -v "^${key}=" "$manifest" > "$tmp"
        mv "$tmp" "$manifest"
    fi
}

manifest_validate() {
    local target="$1"
    local manifest
    manifest="$(manifest_path "$target")"

    if [[ ! -f "$manifest" ]]; then
        return 1
    fi

    # Check version
    local version
    version=$(manifest_read "$target" "version")
    if [[ -z "$version" || "$version" -gt "$MANIFEST_VERSION" ]]; then
        log_error "Invalid or incompatible manifest version: $version"
        return 1
    fi

    # Check source_dir exists
    local source_dir
    source_dir=$(manifest_read "$target" "source_dir")
    if [[ -n "$source_dir" && ! -d "$source_dir" ]]; then
        echo "  Warning: Original source directory no longer exists: $source_dir"
        echo "  Backups will still be restored if available."
    fi

    return 0
}
```

### 3.5 Backup Functions

```bash
create_backup() {
    local target="$1"
    local item="$2"
    local src="$target/$item"
    local backup="$target/${item}${BACKUP_SUFFIX}"

    # Don't backup if source doesn't exist or is already a symlink
    if [[ ! -e "$src" ]] || [[ -L "$src" ]]; then
        log_verbose "No backup needed for $item (doesn't exist or is symlink)"
        return 0
    fi

    # Check for existing backup (don't overwrite)
    if [[ -e "$backup" ]]; then
        echo "  Warning: Backup already exists at ${item}${BACKUP_SUFFIX}"
        echo "  Skipping backup to avoid data loss"
        return 1
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  Would backup $item to ${item}${BACKUP_SUFFIX}"
        return 0
    fi

    if mv "$src" "$backup"; then
        manifest_write "$target" "backup:$item" "$backup"
        echo "  Backed up $item to ${item}${BACKUP_SUFFIX}"
        return 0
    else
        log_error "Failed to create backup for $item"
        return 1
    fi
}

restore_backup() {
    local target="$1"
    local item="$2"
    local backup="$target/${item}${BACKUP_SUFFIX}"
    local dst="$target/$item"

    if [[ ! -e "$backup" ]]; then
        log_verbose "No backup to restore for $item"
        return 1
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  Would restore $item from ${item}${BACKUP_SUFFIX}"
        return 0
    fi

    # Remove current item (symlink or file/dir)
    if [[ -e "$dst" ]] || [[ -L "$dst" ]]; then
        rm -rf "$dst"
    fi

    if mv "$backup" "$dst"; then
        manifest_remove "$target" "backup:$item"
        echo "  Restored $item from backup"
        return 0
    else
        log_error "Failed to restore backup for $item"
        return 1
    fi
}

backup_exists() {
    local target="$1"
    local item="$2"
    [[ -e "$target/${item}${BACKUP_SUFFIX}" ]]
}
```

### 3.6 Modified install_config Function

Replace lines 62-124:

```bash
install_config() {
    local target="$1"
    local mode="${2:-user}"

    echo "Installing to: $target ($mode config)"

    # Initialize or validate manifest
    if manifest_exists "$target"; then
        if ! manifest_validate "$target"; then
            log_error "Invalid existing manifest. Run --unlink first."
            return 1
        fi
        echo "  Updating existing installation..."
    else
        manifest_init "$target"
    fi

    # Symlink directories
    echo ""
    echo "Linking directories:"
    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        local src="$SOURCE_CLAUDE/$dir"

        if [[ ! -d "$src" ]]; then
            echo "  Skip $dir (not in source)"
            continue
        fi

        if [[ -L "$dst" ]]; then
            local current_target
            current_target=$(readlink "$dst")
            if [[ "$current_target" == "$src" ]]; then
                echo "  ✓ $dir (already linked)"
                continue
            else
                echo "  Updating $dir symlink..."
                rm "$dst"
            fi
        elif [[ -d "$dst" ]]; then
            create_backup "$target" "$dir" || continue
        fi

        if [[ "$DRY_RUN" == "true" ]]; then
            echo "  Would link $dir → $src"
        else
            ln -s "$src" "$dst"
            manifest_write "$target" "symlink:$dir" "$src"
            echo "  ✓ $dir → $src"
        fi
    done

    # Copy files
    echo ""
    echo "Copying files:"
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
                continue
            else
                echo "  $file differs from source"
                create_backup "$target" "$file"
                if [[ "$DRY_RUN" == "true" ]]; then
                    echo "  Would copy $file"
                else
                    cp "$src" "$dst"
                    manifest_write "$target" "copy:$file" "$(compute_checksum "$dst")"
                    echo "  ✓ $file (updated, original backed up)"
                fi
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  Would copy $file"
            else
                cp "$src" "$dst"
                manifest_write "$target" "copy:$file" "$(compute_checksum "$dst")"
                echo "  ✓ $file (copied)"
            fi
        fi
    done

    echo ""
    echo "Done! Configuration installed."
    if [[ "$DRY_RUN" != "true" ]]; then
        echo "Run './install.sh --status' to verify installation."
    fi
}
```

### 3.7 Rewritten unlink_config Function

Replace lines 126-144:

```bash
unlink_config() {
    local target="$1"

    echo "Unlinking from: $target"

    if ! manifest_exists "$target"; then
        echo "  Warning: No manifest found."
        legacy_unlink "$target"
        return
    fi

    if ! manifest_validate "$target"; then
        echo "  Warning: Manifest validation failed."
        echo "  Proceeding with best-effort unlink..."
    fi

    # Remove symlinks and restore backups
    echo ""
    echo "Restoring directories:"
    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"

        if [[ -L "$dst" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  Would remove symlink $dir"
            else
                rm "$dst"
                log_verbose "Removed symlink $dir"
            fi

            if backup_exists "$target" "$dir"; then
                restore_backup "$target" "$dir"
            else
                # No backup - create standalone copy from source
                local src="$SOURCE_CLAUDE/$dir"
                if [[ -d "$src" ]]; then
                    if [[ "$DRY_RUN" == "true" ]]; then
                        echo "  Would create standalone copy of $dir"
                    else
                        cp -r "$src" "$dst"
                        echo "  Created standalone copy of $dir"
                    fi
                else
                    echo "  Warning: No backup or source for $dir"
                fi
            fi
            manifest_remove "$target" "symlink:$dir"
        elif [[ -d "$dst" ]]; then
            echo "  $dir is not a symlink (skipping)"
        else
            echo "  $dir does not exist (skipping)"
        fi
    done

    # Restore copied files
    echo ""
    echo "Restoring files:"
    for file in "${COPY_FILES[@]}"; do
        if backup_exists "$target" "$file"; then
            restore_backup "$target" "$file"
        else
            echo "  $file has no backup (keeping current)"
        fi
        manifest_remove "$target" "copy:$file"
    done

    # Remove manifest
    if [[ "$DRY_RUN" == "true" ]]; then
        echo ""
        echo "Would remove manifest file"
    else
        rm -f "$(manifest_path "$target")"
        echo ""
        echo "Done! Configuration unlinked and originals restored."
    fi
}

legacy_unlink() {
    local target="$1"

    echo "  No manifest found - this appears to be a pre-manifest installation"
    echo "  Converting symlinks to standalone copies (backups will NOT be restored)"
    echo ""

    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        local src="$SOURCE_CLAUDE/$dir"

        if [[ -L "$dst" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  Would convert $dir to standalone copy"
            else
                rm "$dst"
                if [[ -d "$src" ]]; then
                    cp -r "$src" "$dst"
                    echo "  ✓ $dir (converted to standalone copy)"
                else
                    echo "  Warning: Source not found for $dir"
                fi
            fi
        fi
    done

    echo ""
    echo "Legacy unlink complete."
    echo "Note: Check for *.bak files that may contain your original configuration."
    echo "      Files matching *.ai-sidekicks.bak are safe to delete."
}
```

### 3.8 New migrate_legacy Function

```bash
migrate_legacy() {
    local target="$1"

    echo "Migrating legacy installation to manifest-based tracking"

    if manifest_exists "$target"; then
        echo "  Manifest already exists. No migration needed."
        return 0
    fi

    # Check if this looks like an ai-sidekicks installation
    local found_symlinks=false
    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        if [[ -L "$dst" ]]; then
            local link_target
            link_target=$(readlink "$dst")
            if [[ "$link_target" == *"ai-sidekicks"* ]]; then
                found_symlinks=true
                break
            fi
        fi
    done

    if [[ "$found_symlinks" == "false" ]]; then
        echo "  No ai-sidekicks symlinks detected. Nothing to migrate."
        return 1
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  Would create manifest for existing installation"
        return 0
    fi

    manifest_init "$target"

    # Record existing symlinks
    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        if [[ -L "$dst" ]]; then
            local link_target
            link_target=$(readlink "$dst")
            manifest_write "$target" "symlink:$dir" "$link_target"
            echo "  Recorded symlink: $dir → $link_target"
        fi
    done

    # Record existing backups (old .bak style)
    for dir in "${PORTABLE_DIRS[@]}"; do
        local old_backup="$target/${dir}.bak"
        local new_backup="$target/${dir}${BACKUP_SUFFIX}"

        if [[ -e "$old_backup" ]] && [[ ! -e "$new_backup" ]]; then
            echo "  Found legacy backup: ${dir}.bak"
            echo "  Renaming to ${dir}${BACKUP_SUFFIX}"
            mv "$old_backup" "$new_backup"
            manifest_write "$target" "backup:$dir" "$new_backup"
        fi
    done

    echo ""
    echo "Migration complete. Manifest created at $(manifest_path "$target")"
}
```

### 3.9 Enhanced show_status Function

Replace lines 146-163:

```bash
show_status() {
    local user_target="$HOME/.claude"
    local project_target
    project_target="$(pwd)/.claude"

    echo "=== User Configuration ($user_target) ==="
    show_target_status "$user_target"

    if [[ -d "$project_target" ]] && [[ "$project_target" != "$user_target" ]]; then
        echo ""
        echo "=== Project Configuration ($project_target) ==="
        show_target_status "$project_target"
    fi
}

show_target_status() {
    local target="$1"

    if [[ ! -d "$target" ]]; then
        echo "  Not found"
        return
    fi

    # Manifest info
    if manifest_exists "$target"; then
        echo "  Manifest: Present"
        echo "    Version: $(manifest_read "$target" "version")"
        echo "    Installed: $(manifest_read "$target" "installed_at")"
        echo "    Source: $(manifest_read "$target" "source_dir")"
    else
        echo "  Manifest: Not found (legacy or manual installation)"
    fi

    echo ""
    echo "  Directories:"
    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        if [[ -L "$dst" ]]; then
            local link_target
            link_target=$(readlink "$dst")
            echo "    $dir → $link_target (symlink)"
        elif [[ -d "$dst" ]]; then
            echo "    $dir (standalone directory)"
        else
            echo "    $dir (not present)"
        fi

        # Check for backups
        if [[ -e "$target/${dir}${BACKUP_SUFFIX}" ]]; then
            echo "      └── backup: ${dir}${BACKUP_SUFFIX}"
        fi
        if [[ -e "$target/${dir}.bak" ]]; then
            echo "      └── legacy backup: ${dir}.bak"
        fi
    done

    echo ""
    echo "  Files:"
    for file in "${COPY_FILES[@]}"; do
        local dst="$target/$file"
        if [[ -f "$dst" ]]; then
            echo "    $file (present)"
        else
            echo "    $file (not present)"
        fi

        if [[ -e "$target/${file}${BACKUP_SUFFIX}" ]]; then
            echo "      └── backup: ${file}${BACKUP_SUFFIX}"
        fi
    done
}
```

### 3.10 New Main Block

Replace lines 165-189:

```bash
# Main execution
main() {
    parse_args "$@"

    case "$ACTION" in
        install)
            show_banner "INITIALIZING"
            if [[ "$PROJECT_MODE" == "true" ]]; then
                install_config "$(get_target_dir --project)" "project"
            else
                install_config "$(get_target_dir)" "user"
            fi
            ;;
        unlink)
            show_banner "UNINSTALLING"
            if [[ "$PROJECT_MODE" == "true" ]]; then
                unlink_config "$(get_target_dir --project)"
            else
                unlink_config "$(get_target_dir)"
            fi
            ;;
        status)
            show_banner "SCANNING"
            show_status
            ;;
        migrate)
            show_banner "MIGRATING"
            if [[ "$PROJECT_MODE" == "true" ]]; then
                migrate_legacy "$(get_target_dir --project)"
            else
                migrate_legacy "$(get_target_dir)"
            fi
            ;;
        help)
            usage
            ;;
        *)
            log_error "Unknown action: $ACTION"
            exit 1
            ;;
    esac
}

main "$@"
```

### 3.11 Updated usage Function

```bash
usage() {
    cat << EOF
AI-Sidekicks Configuration Installer

Usage: ./install.sh [OPTIONS]

Options:
    (none)          Install to user config (~/.claude)
    --project       Install to current project (./.claude)
    --unlink        Remove installation and restore backups
    --status        Show installation status
    --migrate       Create manifest for legacy installation
    --dry-run, -n   Preview changes without making them
    --verbose, -v   Show detailed output
    --help, -h      Show this help message

Examples:
    ./install.sh                    # Install to ~/.claude
    ./install.sh --project          # Install to ./.claude
    ./install.sh --unlink           # Uninstall from ~/.claude
    ./install.sh --unlink --project # Uninstall from ./.claude
    ./install.sh --dry-run          # Preview installation
    ./install.sh --status           # Check installation status
    ./install.sh --migrate          # Migrate legacy install to manifest

For more information, see: https://github.com/user/ai-sidekicks
EOF
}
```

---

## 4. Testing Strategy

### Test Environment Setup

```bash
#!/bin/bash
# test-install.sh - Test harness for install.sh

TEST_BASE=$(mktemp -d)
AI_SIDEKICKS_DIR="$(cd "$(dirname "$0")" && pwd)"
PASSED=0
FAILED=0

setup_test() {
    local name="$1"
    local test_dir="$TEST_BASE/$name"
    mkdir -p "$test_dir/.claude"
    echo "$test_dir"
}

assert_exists() {
    if [[ -e "$1" ]]; then
        echo "  ✓ $1 exists"
        return 0
    else
        echo "  ✗ $1 does not exist"
        return 1
    fi
}

assert_not_exists() {
    if [[ ! -e "$1" ]]; then
        echo "  ✓ $1 does not exist"
        return 0
    else
        echo "  ✗ $1 exists (should not)"
        return 1
    fi
}

assert_symlink() {
    if [[ -L "$1" ]]; then
        echo "  ✓ $1 is symlink"
        return 0
    else
        echo "  ✗ $1 is not symlink"
        return 1
    fi
}

assert_not_symlink() {
    if [[ ! -L "$1" ]]; then
        echo "  ✓ $1 is not symlink"
        return 0
    else
        echo "  ✗ $1 is symlink (should not be)"
        return 1
    fi
}

assert_content() {
    local file="$1"
    local expected="$2"
    if grep -q "$expected" "$file" 2>/dev/null; then
        echo "  ✓ $file contains expected content"
        return 0
    else
        echo "  ✗ $file does not contain: $expected"
        return 1
    fi
}

cleanup() {
    rm -rf "$TEST_BASE"
}

trap cleanup EXIT
```

### Test Cases

#### Test 1: Basic Install/Uninstall Cycle with Restore

```bash
test_basic_restore() {
    echo "TEST: Basic install/uninstall with restore"
    local test_dir
    test_dir=$(setup_test "basic-restore")

    # Setup: Create original content
    mkdir -p "$test_dir/.claude/skills"
    echo "custom skill content" > "$test_dir/.claude/skills/custom.md"
    echo '{"user": "settings"}' > "$test_dir/.claude/settings.json"

    # Install
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --project

    # Verify installation
    assert_symlink "$test_dir/.claude/skills" || return 1
    assert_exists "$test_dir/.claude/skills.ai-sidekicks.bak" || return 1
    assert_exists "$test_dir/.claude/.ai-sidekicks-manifest" || return 1

    # Uninstall
    "$AI_SIDEKICKS_DIR/install.sh" --unlink --project

    # Verify restoration
    assert_not_symlink "$test_dir/.claude/skills" || return 1
    assert_exists "$test_dir/.claude/skills/custom.md" || return 1
    assert_content "$test_dir/.claude/skills/custom.md" "custom skill content" || return 1
    assert_content "$test_dir/.claude/settings.json" '"user": "settings"' || return 1
    assert_not_exists "$test_dir/.claude/skills.ai-sidekicks.bak" || return 1
    assert_not_exists "$test_dir/.claude/.ai-sidekicks-manifest" || return 1

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 2: Project Unlink Works

```bash
test_project_unlink() {
    echo "TEST: Project unlink works correctly"
    local test_dir
    test_dir=$(setup_test "project-unlink")

    # Install to project
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --project

    # Verify symlinks exist
    assert_symlink "$test_dir/.claude/skills" || return 1

    # Unlink from project
    "$AI_SIDEKICKS_DIR/install.sh" --unlink --project

    # Verify unlink worked in project (not home)
    assert_not_symlink "$test_dir/.claude/skills" || return 1
    assert_exists "$test_dir/.claude/skills" || return 1  # Should be standalone copy

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 3: Orphaned Backup Cleanup

```bash
test_backup_cleanup() {
    echo "TEST: No orphaned backups after uninstall"
    local test_dir
    test_dir=$(setup_test "backup-cleanup")

    # Setup
    mkdir -p "$test_dir/.claude/skills"
    echo "original" > "$test_dir/.claude/skills/test.md"

    # Install (creates backup)
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --project
    assert_exists "$test_dir/.claude/skills.ai-sidekicks.bak" || return 1

    # Uninstall (should restore and remove backup)
    "$AI_SIDEKICKS_DIR/install.sh" --unlink --project

    # Verify no .ai-sidekicks.bak files remain
    local backup_count
    backup_count=$(find "$test_dir/.claude" -name "*.ai-sidekicks.bak" 2>/dev/null | wc -l)
    if [[ "$backup_count" -eq 0 ]]; then
        echo "  ✓ No orphaned backups"
    else
        echo "  ✗ Found $backup_count orphaned backup(s)"
        return 1
    fi

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 4: Settings Backup When Different

```bash
test_settings_backup() {
    echo "TEST: Settings backed up when different"
    local test_dir
    test_dir=$(setup_test "settings-backup")

    # Setup with custom settings
    mkdir -p "$test_dir/.claude"
    echo '{"custom": "config"}' > "$test_dir/.claude/settings.json"

    # Install
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --project

    # Verify backup created
    assert_exists "$test_dir/.claude/settings.json.ai-sidekicks.bak" || return 1
    assert_content "$test_dir/.claude/settings.json.ai-sidekicks.bak" '"custom"' || return 1

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 5: User Backups Not Touched

```bash
test_user_backup_preserved() {
    echo "TEST: User's own backups preserved"
    local test_dir
    test_dir=$(setup_test "user-backup")

    # Setup with user's own backup
    mkdir -p "$test_dir/.claude"
    mkdir "$test_dir/.claude/myconfig.bak"
    echo "my backup" > "$test_dir/.claude/myconfig.bak/data.txt"

    # Install and uninstall
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --project
    "$AI_SIDEKICKS_DIR/install.sh" --unlink --project

    # Verify user's backup untouched
    assert_exists "$test_dir/.claude/myconfig.bak" || return 1
    assert_content "$test_dir/.claude/myconfig.bak/data.txt" "my backup" || return 1

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 6: Legacy Installation Handling

```bash
test_legacy_unlink() {
    echo "TEST: Legacy installation handled gracefully"
    local test_dir
    test_dir=$(setup_test "legacy")

    # Simulate legacy installation (symlinks but no manifest)
    mkdir -p "$test_dir/.claude"
    ln -s "$AI_SIDEKICKS_DIR/.claude/skills" "$test_dir/.claude/skills" 2>/dev/null || true
    mkdir -p "$test_dir/.claude/rules.bak"  # Old-style backup

    # Unlink (should warn about missing manifest)
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --unlink --project 2>&1 | grep -q "No manifest" || {
        echo "  ✗ Should warn about missing manifest"
        return 1
    }

    # Legacy backup should be untouched
    assert_exists "$test_dir/.claude/rules.bak" || return 1

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 7: Dry-Run Mode

```bash
test_dry_run() {
    echo "TEST: Dry-run makes no changes"
    local test_dir
    test_dir=$(setup_test "dry-run")

    # Setup
    mkdir -p "$test_dir/.claude/skills"
    echo "original" > "$test_dir/.claude/skills/test.md"

    # Dry-run install
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --project --dry-run

    # Verify nothing changed
    assert_not_symlink "$test_dir/.claude/skills" || return 1
    assert_content "$test_dir/.claude/skills/test.md" "original" || return 1
    assert_not_exists "$test_dir/.claude/.ai-sidekicks-manifest" || return 1

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 8: Migrate Legacy

```bash
test_migrate() {
    echo "TEST: Migrate legacy installation"
    local test_dir
    test_dir=$(setup_test "migrate")

    # Simulate legacy installation
    mkdir -p "$test_dir/.claude"
    ln -s "$AI_SIDEKICKS_DIR/.claude/skills" "$test_dir/.claude/skills" 2>/dev/null || true
    mkdir -p "$test_dir/.claude/agents.bak"  # Old backup

    # Migrate
    cd "$test_dir" && "$AI_SIDEKICKS_DIR/install.sh" --migrate --project

    # Verify manifest created
    assert_exists "$test_dir/.claude/.ai-sidekicks-manifest" || return 1

    # Verify old backup renamed
    assert_exists "$test_dir/.claude/agents.ai-sidekicks.bak" || return 1
    assert_not_exists "$test_dir/.claude/agents.bak" || return 1

    echo "  PASSED"
    ((PASSED++))
}
```

#### Test 9: Shellcheck Compliance

```bash
test_shellcheck() {
    echo "TEST: Shellcheck compliance"

    if ! command -v shellcheck &>/dev/null; then
        echo "  SKIPPED (shellcheck not installed)"
        return 0
    fi

    if shellcheck "$AI_SIDEKICKS_DIR/install.sh"; then
        echo "  ✓ No shellcheck warnings"
    else
        echo "  ✗ Shellcheck found issues"
        return 1
    fi

    echo "  PASSED"
    ((PASSED++))
}
```

### Edge Cases

| Case | Expected Behavior |
|------|-------------------|
| Empty target directory | Install proceeds normally |
| Interrupted mid-install | Re-run recovers (idempotent) |
| Read-only filesystem | Graceful error message |
| Broken symlinks | Detect and replace |
| Spaces in paths | Handle with proper quoting |
| macOS vs Linux | Cross-platform compatible |
| Source repo moved | Warn but still restore backups |

### Run All Tests

```bash
run_all_tests() {
    echo "Running install.sh test suite"
    echo "=============================="
    echo ""

    test_basic_restore
    test_project_unlink
    test_backup_cleanup
    test_settings_backup
    test_user_backup_preserved
    test_legacy_unlink
    test_dry_run
    test_migrate
    test_shellcheck

    echo ""
    echo "=============================="
    echo "Results: $PASSED passed, $FAILED failed"

    if [[ "$FAILED" -gt 0 ]]; then
        exit 1
    fi
}

run_all_tests
```

---

## 5. Risk Assessment

### Risk 1: Breaking Existing Installations

| Attribute | Value |
|-----------|-------|
| **Probability** | Medium |
| **Impact** | High |

**What Could Go Wrong:**
- Legacy installations without manifest become harder to manage
- Users with existing `.bak` files might be confused

**Mitigations:**
1. `legacy_unlink()` preserves current behavior when no manifest
2. Never touch files not matching `.ai-sidekicks.bak` pattern
3. `--migrate` command to create manifest for existing installs
4. Clear warnings when operating without manifest

**Fallback:**
- Symlinks can always be manually removed
- Old `.bak` files remain untouched

---

### Risk 2: Manifest Corruption

| Attribute | Value |
|-----------|-------|
| **Probability** | Low |
| **Impact** | High |

**What Could Go Wrong:**
- File deleted or truncated during write
- User manually edits and corrupts

**Mitigations:**
1. Atomic writes via temp file + rename
2. `manifest_validate()` checks integrity before operations
3. Clear "DO NOT EDIT" header
4. Graceful degradation to legacy mode if invalid

**Fallback:**
- Fall back to `legacy_unlink()` behavior
- `.ai-sidekicks.bak` suffix allows manual identification

---

### Risk 3: Backup Naming Collision

| Attribute | Value |
|-----------|-------|
| **Probability** | Very Low |
| **Impact** | Medium |

**What Could Go Wrong:**
- User already has `*.ai-sidekicks.bak` files
- Multiple installations create nested backups

**Mitigations:**
1. Check if backup destination exists before creating
2. Refuse to overwrite existing backups not in manifest
3. Log warning and skip if collision detected

**Fallback:**
- Manual intervention for rare collision cases

---

### Risk 4: Cross-Platform Incompatibility

| Attribute | Value |
|-----------|-------|
| **Probability** | Medium |
| **Impact** | Medium |

**What Could Go Wrong:**
- `sha256sum` vs `shasum -a 256` (macOS)
- `stat` flag differences
- `date` format variations

**Mitigations:**
1. `compute_checksum()` tries multiple commands with fallbacks
2. Use POSIX-compatible date format
3. Test on both Linux and macOS

**Fallback:**
- Degrade gracefully (skip checksum if unavailable)

---

### Risk 5: Source Repository Moved/Deleted

| Attribute | Value |
|-----------|-------|
| **Probability** | Low |
| **Impact** | Medium |

**What Could Go Wrong:**
- User moves ai-sidekicks repo after installation
- Symlinks point to non-existent location

**Mitigations:**
1. `manifest_validate()` warns if source_dir doesn't exist
2. Unlink still restores backups regardless of source
3. `--status` shows broken symlinks clearly

**Fallback:**
- Backups restored even without source
- Clear error messages guide user

---

## 6. Implementation Order

Recommended sequence to minimize risk:

1. **Add configuration constants** - No behavior change, enables later work
2. **Add `parse_args()`** - Fixes `--unlink --project` immediately
3. **Add utility functions** - Independent, testable
4. **Add manifest functions** - Independent module
5. **Add backup functions** - Depends on manifest
6. **Modify `install_config()`** - Use new backup/manifest
7. **Rewrite `unlink_config()`** - Core fix for restore behavior
8. **Add `legacy_unlink()`** - Backwards compatibility
9. **Add `migrate_legacy()`** - Migration path for existing users
10. **Enhance `show_status()`** - Display manifest info
11. **Update main block** - Wire everything together
12. **Run shellcheck** - Final polish
13. **Run test suite** - Verify all behaviors

---

## 7. Success Criteria

Upon completion, the following must be true:

- [ ] `./install.sh --unlink` restores original files from `.ai-sidekicks.bak` backups
- [ ] `./install.sh --unlink --project` works correctly in project directories
- [ ] No orphaned `.ai-sidekicks.bak` files remain after clean uninstall
- [ ] `settings.json` is backed up when content differs before overwrite
- [ ] User's manual `.bak` files are never modified or deleted
- [ ] Manifest file (`.ai-sidekicks-manifest`) tracks all managed items
- [ ] Legacy installations (no manifest) handled gracefully with warning
- [ ] `--dry-run` shows what would happen without making changes
- [ ] `--migrate` creates manifest for existing installations
- [ ] Script passes `shellcheck install.sh` with no warnings
- [ ] Works on both Linux and macOS
- [ ] All test cases pass

---

## References

- [GNU Stow Manual](https://www.gnu.org/software/stow/manual/stow.html) - Symlink farm management
- [dpkg conffile handling](https://wiki.debian.org/DpkgConffileHandling) - Backup/restore patterns
- [chezmoi documentation](https://www.chezmoi.io/) - State tracking concepts
- [Shellcheck](https://www.shellcheck.net/) - Shell script analysis
