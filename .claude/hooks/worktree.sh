#!/usr/bin/env bash
# WorktreeCreate / WorktreeRemove hook dispatch.
# Wired in .claude/settings.json for both events.
# Subcommands: create | remove | probe.

set -euo pipefail

# Force the MAIN checkout root, not the current toplevel: the WorktreeRemove
# hook runs with cwd INSIDE the worktree being removed (probe 2026-07-07),
# where --show-toplevel returns the worktree root and every .worktrees/ path
# below would silently mis-resolve. The common git dir always lives in the
# main checkout.
cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

payload=$(cat)

# Keep IDENTICAL to the Python equivalent in command-guard.py.
NAME_REGEX='^[a-zA-Z0-9_-]{1,64}$'

die() {
  echo "worktree.sh: $*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || die "jq is required"

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
  # WorktreeRemove stdin schema (docs.claude.com): `.worktree_path` is the
  # canonical absolute-path field. Older / undocumented variants used
  # `.path`; keep it as a fallback before deriving from `.name`.
  local path
  path=$(jq -r '.worktree_path // .path // empty' <<<"$payload")
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

  # Refuse to delete a live process's cwd — that breaks every later command
  # spawn in the occupying session (ENOENT posix_spawn '/bin/sh'). The
  # occupancy engine excludes this hook's own process lineage, so a
  # legitimate auto-clean (whose cwd sits inside the worktree being removed)
  # does not deadlock; only OTHER sessions' processes block. The hook owns
  # removal (replace semantics, probed 2026-07-07): a non-zero exit here
  # aborts the harness removal entirely, so failing is safe.
  local python_bin script_dir abs_path occupants occupancy_status
  python_bin="$(command -v python3 || command -v python)" \
    || die "python3/python is required for the occupancy check"
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  abs_path="$(cd "$path" && pwd -P)" || die "cannot resolve '$path'"
  occupancy_status=0
  occupants="$("$python_bin" "$script_dir/command-guard.py" --occupancy "$abs_path")" \
    || occupancy_status=$?
  if [[ $occupancy_status -ne 0 ]]; then
    die "could not verify occupancy of '$path' (exit $occupancy_status); refusing removal"
  fi
  if [[ -n "$occupants" ]]; then
    die "refusing to remove occupied worktree '$path' — live occupants (pid/command/cwd):
$occupants
Exit the occupying session or kill the PIDs, then retry. (This harness-side
path has no escape hatch; a Bash-side \`git worktree remove\` offers the
WORKTREE_REMOVE_ALLOW_OCCUPIED=1 prefix.)"
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
