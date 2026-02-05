#!/bin/bash
# install.sh - Install ai-sidekicks config to user or project directory
#
# Usage:
#   ./install.sh           # Install to ~/.claude (user config)
#   ./install.sh --project # Install to current project's .claude
#   ./install.sh --unlink  # Remove symlinks and restore backups
#   ./install.sh --status  # Show current installation status
#   ./install.sh --migrate # Create manifest for legacy installation
#   ./install.sh --dry-run # Preview changes without making them

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_CLAUDE="$SCRIPT_DIR/.claude"

# Manifest configuration
MANIFEST_FILE=".ai-sidekicks-manifest"
BACKUP_SUFFIX=".ai-sidekicks.bak"
MANIFEST_VERSION="1"

# Runtime flags (set by parse_args)
ACTION="install"
PROJECT_MODE=false
DRY_RUN=false
VERBOSE=false

# What to symlink (portable config)
PORTABLE_DIRS=(
    "skills"
    "agents"
    "rules"
)

# What to copy (not symlink - allows local customization)
COPY_FILES=(
    "settings.json"
)

show_banner() {
    local action="${1:-}"
    echo ""
    echo "        o"
    echo "       .-."
    echo "    .--┴-┴--."
    echo "    | O   O |   AI-SIDEKICKS"
    echo "    | ||||| |   >> portable ai configuration"
    echo "    '--___--'"
    echo ""
    if [[ -n "$action" ]]; then
        echo "    [■■■■■■■■■■] ${action}..."
        echo ""
    fi
}

usage() {
    show_banner
    cat << EOF
Usage: $0 [OPTIONS]

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
    $0                    # Install to ~/.claude
    $0 --project          # Install to ./.claude
    $0 --unlink           # Uninstall from ~/.claude
    $0 --unlink --project # Uninstall from ./.claude
    $0 --dry-run          # Preview installation
    $0 --status           # Check installation status
    $0 --migrate          # Migrate legacy install to manifest

For more information, see: https://github.com/user/ai-sidekicks
EOF
    exit 0
}

# ==============================================================================
# Argument Parsing
# ==============================================================================

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

# ==============================================================================
# Utility Functions
# ==============================================================================

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

get_target_dir() {
    if [[ "$1" == "--project" ]]; then
        echo "$(pwd)/.claude"
    else
        echo "$HOME/.claude"
    fi
}

# ==============================================================================
# Manifest Functions
# ==============================================================================

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
        grep -v "^${key}=" "$manifest" > "$tmp" || true
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
    if [[ -z "$version" ]]; then
        log_error "Invalid manifest: missing version"
        return 1
    fi

    if [[ "$version" -gt "$MANIFEST_VERSION" ]]; then
        log_error "Incompatible manifest version: $version (max supported: $MANIFEST_VERSION)"
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

# ==============================================================================
# Backup Functions
# ==============================================================================

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

# ==============================================================================
# Core Functions
# ==============================================================================

install_config() {
    local target="$1"
    local mode="${2:-user}"

    echo "Installing to: $target ($mode config)"

    # Create target directory if needed
    if [[ "$DRY_RUN" != "true" ]]; then
        mkdir -p "$target"
    fi

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
                echo "  [OK] $dir (already linked)"
                continue
            else
                echo "  Updating $dir symlink..."
                if [[ "$DRY_RUN" != "true" ]]; then
                    rm "$dst"
                fi
            fi
        elif [[ -d "$dst" ]]; then
            create_backup "$target" "$dir" || continue
        fi

        if [[ "$DRY_RUN" == "true" ]]; then
            echo "  Would link $dir -> $src"
        else
            ln -s "$src" "$dst"
            manifest_write "$target" "symlink:$dir" "$src"
            echo "  [OK] $dir -> $src"
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
                echo "  [OK] $file (identical)"
                continue
            else
                echo "  $file differs from source"
                create_backup "$target" "$file"
                if [[ "$DRY_RUN" == "true" ]]; then
                    echo "  Would copy $file"
                else
                    cp "$src" "$dst"
                    manifest_write "$target" "copy:$file" "$(compute_checksum "$dst")"
                    echo "  [OK] $file (updated, original backed up)"
                fi
            fi
        else
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "  Would copy $file"
            else
                cp "$src" "$dst"
                manifest_write "$target" "copy:$file" "$(compute_checksum "$dst")"
                echo "  [OK] $file (copied)"
            fi
        fi
    done

    echo ""
    echo "Done! Configuration installed."
    if [[ "$DRY_RUN" != "true" ]]; then
        echo "Run '$0 --status' to verify installation."
    fi
}

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
                    echo "  [OK] $dir (converted to standalone copy)"
                else
                    echo "  Warning: Source not found for $dir"
                fi
            fi
        fi
    done

    echo ""
    echo "Legacy unlink complete."
    echo "Note: Check for *.bak files that may contain your original configuration."
    echo "      Files matching *${BACKUP_SUFFIX} are safe to delete."
}

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
            if [[ "$link_target" == *"ai-sidekicks"* ]] || [[ "$link_target" == *".claude"* ]]; then
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
            echo "  Recorded symlink: $dir -> $link_target"
        fi
    done

    # Record existing backups (old .bak style) and rename them
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

    # Check for settings.json backup
    local old_settings_backup="$target/settings.json.bak"
    local new_settings_backup="$target/settings.json${BACKUP_SUFFIX}"
    if [[ -e "$old_settings_backup" ]] && [[ ! -e "$new_settings_backup" ]]; then
        echo "  Found legacy backup: settings.json.bak"
        echo "  Renaming to settings.json${BACKUP_SUFFIX}"
        mv "$old_settings_backup" "$new_settings_backup"
        manifest_write "$target" "backup:settings.json" "$new_settings_backup"
    fi

    echo ""
    echo "Migration complete. Manifest created at $(manifest_path "$target")"
}

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
            echo "    $dir -> $link_target (symlink)"
        elif [[ -d "$dst" ]]; then
            echo "    $dir (standalone directory)"
        else
            echo "    $dir (not present)"
        fi

        # Check for backups
        if [[ -e "$target/${dir}${BACKUP_SUFFIX}" ]]; then
            echo "      backup: ${dir}${BACKUP_SUFFIX}"
        fi
        if [[ -e "$target/${dir}.bak" ]]; then
            echo "      legacy backup: ${dir}.bak"
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
            echo "      backup: ${file}${BACKUP_SUFFIX}"
        fi
        if [[ -e "$target/${file}.bak" ]]; then
            echo "      legacy backup: ${file}.bak"
        fi
    done
}

# ==============================================================================
# Main Execution
# ==============================================================================

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
