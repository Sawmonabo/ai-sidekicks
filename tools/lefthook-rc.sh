# shellcheck shell=sh
# lefthook rc file — wired in by `lefthook.yml` (`rc: tools/lefthook-rc.sh`) and
# sourced by lefthook's GENERATED git hooks via `[ -f <rc> ] && . <rc>`, which
# `internal/templates/hook.tmpl` emits immediately before `call_lefthook`.
#
# That placement is the whole point. lefthook's unstaged-changes backup opens
# before its first job runs and closes after its last one, so nothing declared
# inside `lefthook.yml` can wrap it — the rc file is the only repo-owned code
# that runs on both sides of a lefthook invocation.
#
# For `pre-commit` this takes a repository-wide mutex (see
# `tools/lefthook-worktree-lock.mjs` for the hazard it closes and the primary
# sources) and releases it from an EXIT trap, so two linked worktrees never sit
# inside that backup window at once. Every other hook is left alone: lefthook
# only takes the backup for a hook named exactly `pre-commit`
# (`internal/config/available_hooks.go`, `HookUsesStagedFiles`).
#
# `$0` is the hook path even inside a sourced file — POSIX `.` does not rebind
# it — so it is what tells one hook from another here.

# The environment marker makes a nested commit — a `git commit` started from
# inside a running pre-commit hook — skip the lock its own ancestor already
# holds. Without it the inner hook would wait on a live pid that cannot finish
# until the inner hook does, and settle by timing out after minutes.
if [ "${0##*/}" = "pre-commit" ] && [ -z "${LEFTHOOK_WORKTREE_BACKUP_LOCK_HELD:-}" ]; then
  __lefthook_worktree_lock_root="$(git rev-parse --show-toplevel 2>/dev/null)"
  __lefthook_worktree_lock_script="${__lefthook_worktree_lock_root}/tools/lefthook-worktree-lock.mjs"

  if ! command -v node >/dev/null 2>&1; then
    # Fail closed. Skipping the lock would leave the commit sharing lefthook's
    # backup with every other worktree, and this repo cannot run its hooks
    # without node anyway (lint-staged, the docs-corpus screens).
    echo "lefthook: node is required to serialize the pre-commit unstaged-changes backup." >&2
    echo "lefthook: install Node >= 22.14.0 per CONTRIBUTING.md, or set LEFTHOOK=0 to skip hooks." >&2
    exit 1
  fi

  if [ ! -f "$__lefthook_worktree_lock_script" ]; then
    echo "lefthook: missing $__lefthook_worktree_lock_script — cannot serialize the pre-commit backup." >&2
    exit 1
  fi

  if ! node "$__lefthook_worktree_lock_script" acquire \
    --owner-pid="$$" \
    --worktree="$__lefthook_worktree_lock_root" \
    --hook-name=pre-commit; then
    exit 1
  fi

  LEFTHOOK_WORKTREE_BACKUP_LOCK_HELD=1
  export LEFTHOOK_WORKTREE_BACKUP_LOCK_HELD

  __lefthook_worktree_lock_release() {
    node "$__lefthook_worktree_lock_script" release --owner-pid="$$" >/dev/null 2>&1 || true
  }

  # `exit` with the status captured on entry, so releasing the lock never
  # rewrites the hook's own verdict. Each signal trap exits, which runs the EXIT
  # trap, which is the single place the lock is released.
  trap '__lefthook_worktree_lock_status=$?; __lefthook_worktree_lock_release; exit $__lefthook_worktree_lock_status' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
fi
