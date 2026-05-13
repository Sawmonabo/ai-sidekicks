#!/usr/bin/env bash
# WorktreeCreate / WorktreeRemove hook dispatch.
# Wired in .claude/settings.json for both events.
# Subcommands: create | remove | probe.

set -euo pipefail

# Hook cwd is under-documented; force repo root.
cd "$(git rev-parse --show-toplevel)"

payload=$(cat)

# Keep IDENTICAL to the Python equivalent in command-guard.py.
NAME_REGEX='^[a-zA-Z0-9_-]{1,64}$'

die() {
  echo "worktree.sh: $*" >&2
  exit 1
}

validate_name() {
  local n="$1"
  [[ -n "$n" ]] || die "name is empty"
  [[ "$n" =~ $NAME_REGEX ]] || die "name '$n' fails validation"
  [[ "$n" != *..* ]] || die "name '$n' contains '..'"
}

cmd_create() {
  local name
  name=$(jq -r '.name // empty' <<<"$payload")
  validate_name "$name"

  mkdir -p .worktrees

  local dir=".worktrees/${name}"
  local branch="worktree-${name}"

  git worktree add "$dir" -b "$branch" >&2

  # Docs: .worktreeinclude is bypassed under a custom WorktreeCreate hook.
  # https://code.claude.com/docs/en/worktrees
  if [[ -f .worktreeinclude ]]; then
    git ls-files --others --ignored --exclude-from=.worktreeinclude -z \
      | while IFS= read -r -d '' f; do
          mkdir -p "$dir/$(dirname "$f")"
          cp "$f" "$dir/$f"
        done
  fi

  realpath "$dir"
}

cmd_remove() {
  # WorktreeRemove stdin schema is undocumented as of 2026-05-12;
  # try .path, fall back to deriving from .name.
  local path
  path=$(jq -r '.path // empty' <<<"$payload")
  if [[ -z "$path" ]]; then
    local name
    name=$(jq -r '.name // empty' <<<"$payload")
    [[ -n "$name" ]] || die "WorktreeRemove payload missing both .path and .name"
    validate_name "$name"
    path=".worktrees/${name}"
  fi

  if [[ ! -d "$path" ]]; then
    echo "worktree.sh: nothing to remove at $path" >&2
    exit 0
  fi

  git worktree remove "$path" >&2 || die "git worktree remove '$path' failed"

  # Best-effort branch cleanup — delete only fully-merged branches. `-d`
  # refuses unmerged branches; `|| true` swallows the refusal so the hook
  # never fails. Never force-delete here — a stale convention branch with
  # unmerged commits shouldn't lose work when its worktree is removed.
  local branch="worktree-$(basename "$path")"
  if git show-ref --quiet "refs/heads/$branch"; then
    git branch -d "$branch" >&2 2>/dev/null || true
  fi
}

cmd_probe() {
  # Diagnostic: capture stdin to disk while WorktreeRemove schema is undocumented.
  local out
  out="/tmp/worktree-probe-$(date +%s).json"
  printf '%s\n' "$payload" >"$out"
  echo "worktree.sh: probe payload at $out" >&2
}

case "${1:-}" in
  create) cmd_create ;;
  remove) cmd_remove ;;
  probe)  cmd_probe ;;
  *) die "usage: worktree.sh {create|remove|probe}" ;;
esac
