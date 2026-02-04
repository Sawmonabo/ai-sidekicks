#!/bin/bash
# install.sh - Install ai-sidekicks config to user or project directory
#
# Usage:
#   ./install.sh           # Install to ~/.claude (user config)
#   ./install.sh --project # Install to current project's .claude
#   ./install.sh --unlink  # Remove symlinks and restore standalone copies

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_CLAUDE="$SCRIPT_DIR/.claude"

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

usage() {
    show_banner
    echo "Usage: $0 [--project|--unlink|--status]"
    echo ""
    echo "Options:"
    echo "  (none)      Install to ~/.claude (user config)"
    echo "  --project   Install to current directory's .claude"
    echo "  --unlink    Remove symlinks, restore standalone copies"
    echo "  --status    Show current installation status"
    exit 1
}

get_target_dir() {
    if [[ "$1" == "--project" ]]; then
        echo "$(pwd)/.claude"
    else
        echo "$HOME/.claude"
    fi
}

install_config() {
    local target="$1"
    local mode="$2"  # "user" or "project"

    echo "Installing to: $target"
    mkdir -p "$target"

    # Symlink directories
    for dir in "${PORTABLE_DIRS[@]}"; do
        local src="$SOURCE_CLAUDE/$dir"
        local dst="$target/$dir"

        if [[ ! -d "$src" ]]; then
            echo "  Skip $dir (not in source)"
            continue
        fi

        if [[ -L "$dst" ]]; then
            local current_target=$(readlink "$dst")
            if [[ "$current_target" == "$src" ]]; then
                echo "  ✓ $dir (already linked)"
                continue
            else
                echo "  Updating $dir symlink"
                rm "$dst"
            fi
        elif [[ -d "$dst" ]]; then
            echo "  Backing up existing $dir to ${dir}.bak"
            mv "$dst" "${dst}.bak"
        fi

        ln -s "$src" "$dst"
        echo "  ✓ $dir → $src"
    done

    # Copy settings files (don't symlink - allow local customization)
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
                echo "  ! $file exists with different content"
                echo "    Source: $src"
                echo "    Target: $dst"
                echo "    Run: diff $src $dst"
            fi
        else
            cp "$src" "$dst"
            echo "  ✓ $file (copied)"
        fi
    done

    echo ""
    echo "Done! Configuration installed to $target"
}

unlink_config() {
    local target="$1"

    echo "Unlinking from: $target"

    for dir in "${PORTABLE_DIRS[@]}"; do
        local dst="$target/$dir"
        local src="$SOURCE_CLAUDE/$dir"

        if [[ -L "$dst" ]]; then
            echo "  Converting $dir from symlink to copy"
            rm "$dst"
            cp -r "$src" "$dst"
            echo "  ✓ $dir"
        fi
    done

    echo "Done! Symlinks converted to standalone copies"
}

show_status() {
    for location in "$HOME/.claude" "$(pwd)/.claude"; do
        if [[ -d "$location" ]]; then
            echo "    Location: $location"
            for dir in "${PORTABLE_DIRS[@]}"; do
                local path="$location/$dir"
                if [[ -L "$path" ]]; then
                    echo "      $dir → $(readlink "$path") (symlink)"
                elif [[ -d "$path" ]]; then
                    echo "      $dir (standalone copy)"
                else
                    echo "      $dir (not installed)"
                fi
            done
            echo ""
        fi
    done
}

# Main
case "${1:-}" in
    --project)
        show_banner "INITIALIZING"
        install_config "$(get_target_dir --project)" "project"
        ;;
    --unlink)
        show_banner "UNINSTALLING"
        unlink_config "$(get_target_dir)"
        ;;
    --status)
        show_banner "SCANNING"
        show_status
        ;;
    --help|-h)
        usage
        ;;
    "")
        show_banner "INITIALIZING"
        install_config "$(get_target_dir)" "user"
        ;;
    *)
        usage
        ;;
esac
