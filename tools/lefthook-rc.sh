# shellcheck shell=sh
# lefthook rc file (`rc: tools/lefthook-rc.sh` in `lefthook.yml`), sourced by every generated git
# hook right before lefthook runs. lefthook's unstaged-changes backup opens before its first job
# and closes after its last, so only code that runs on both sides of lefthook can wrap it.
#
# For `pre-commit` this takes a repository-wide lock (`tools/lefthook-worktree-lock.mjs`) and
# releases it from an EXIT trap, so two linked worktrees never sit inside that backup at once.
# Other hooks are left alone: lefthook takes the backup only for a hook named `pre-commit`.
#
# `$0` is the hook path even in a sourced file, which is how one hook is told from another.

# A nested commit (a `git commit` started inside a running pre-commit hook) skips the lock its
# ancestor holds; otherwise it would wait on a live pid until the timeout.
if [ "${0##*/}" = "pre-commit" ] && [ -z "${LEFTHOOK_WORKTREE_BACKUP_LOCK_HELD:-}" ]; then
  __lefthook_worktree_lock_root="$(git rev-parse --show-toplevel 2>/dev/null)"
  __lefthook_worktree_lock_script="${__lefthook_worktree_lock_root}/tools/lefthook-worktree-lock.mjs"

  if ! command -v node >/dev/null 2>&1; then
    # Fail closed: without the lock the commit would share lefthook's backup with other worktrees,
    # and the hooks need node anyway.
    echo "lefthook: node is required to serialize the pre-commit unstaged-changes backup." >&2
    echo "lefthook: install Node >= 24.21.0 (see .nvmrc), or set LEFTHOOK=0 to skip hooks." >&2
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

  # Exit with the status captured on entry so releasing never rewrites the hook's verdict. Each
  # signal trap exits, which runs the EXIT trap, the one place the lock is released.
  trap '__lefthook_worktree_lock_status=$?; __lefthook_worktree_lock_release; exit $__lefthook_worktree_lock_status' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
fi
