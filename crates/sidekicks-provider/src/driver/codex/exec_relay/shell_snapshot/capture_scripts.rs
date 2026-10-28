//! The scripts a login shell runs to print its state for a snapshot, as Codex's own capture writes
//! them for a snapshot replayed by sourcing it whole: the shell's interactive startup file read
//! first, then its functions and options, a NUL, its aliases and a NUL; no export is captured,
//! since every command's environment is set whole by its start.

use crate::driver::codex::exec_relay::shell_snapshot::SnapshotShell;

/// Runs a capture's helper commands from `PATH`, or the system's default path where `PATH` lacks
/// one.
const COMMAND_HELPER: &str = r##"__codex_snapshot_command() {
  if command -v "$1" >/dev/null 2>&1; then
    "$@"
  else
    command -p "$@"
  fi
}"##;

/// Zsh's interactive startup file, read before the capture.
const ZSH_STARTUP: &str = r##"if [[ -n "${ZDOTDIR-}" ]]; then
  rc="$ZDOTDIR/.zshrc"
elif [[ -n "${HOME-}" ]]; then
  rc="$HOME/.zshrc"
else
  rc=
fi
[[ -r "$rc" ]] && . "$rc"
"##;

/// Bash's interactive startup file, read before the capture where `BASH_ENV` names none.
const BASH_STARTUP: &str = r##"if [ -z "${BASH_ENV-}" ] && [ -n "${HOME-}" ] && [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
"##;

/// The POSIX shell's startup file `ENV` names, its path expanded only in the forms that run no
/// code, read before the capture.
const SH_STARTUP: &str = r##"__codex_snapshot_expand_env() (
  set +u
  __codex_snapshot_getenv() {
    # Preserve the value separately from lookup status and its formatting newline.
    __codex_env_expanded=$(
      if command -v printenv >/dev/null 2>&1; then
        printenv "$1"
      elif [ "$1" = PATH ]; then
        [ "${PATH+x}" = x ] && printf '%s\n' "$PATH"
      else
        command -p printenv "$1"
      fi && printf '.'
    ) || return 1
    __codex_env_expanded=${__codex_env_expanded%?}
    __codex_env_expanded=${__codex_env_expanded%?}
  }
  __codex_env_file=$1
  case "$__codex_env_file" in
    '~/'*) __codex_env_file="${HOME-}/${__codex_env_file#*/}" ;;
    '${PATH%%:*}') __codex_env_file="${PATH%%:*}" ;;
    '${PATH%%:*}/'*) __codex_env_file="${PATH%%:*}/${__codex_env_file#*/}" ;;
    '${'*)
      __codex_env_body=${__codex_env_file#\$\{}
      case "$__codex_env_body" in
        *\}*)
          __codex_env_name=${__codex_env_body%%\}*}
          __codex_env_suffix=${__codex_env_body#*\}}
          case "$__codex_env_name" in
            *:-*)
              __codex_env_default=${__codex_env_name#*:-}
              __codex_env_name=${__codex_env_name%%:-*}
              __codex_env_has_default=1
              ;;
            *) __codex_env_has_default= ;;
          esac
          case "$__codex_env_name" in
            ''|[0-9]*|*[!A-Za-z0-9_]*) ;;
            *)
              case "$__codex_env_suffix" in
                ''|/*)
                  if __codex_snapshot_getenv "$__codex_env_name" 2>/dev/null &&
                    { [ -n "$__codex_env_expanded" ] || [ -z "$__codex_env_has_default" ]; }; then
                    __codex_env_file="$__codex_env_expanded$__codex_env_suffix"
                  elif [ -n "$__codex_env_has_default" ]; then
                    __codex_env_default=$(__codex_snapshot_expand_env "$__codex_env_default")
                    __codex_env_file="$__codex_env_default$__codex_env_suffix"
                  fi
                  ;;
              esac
              ;;
          esac
          ;;
      esac
      ;;
    '$'*)
      __codex_env_name=${__codex_env_file%%/*}
      __codex_env_name=${__codex_env_name#\$}
      case "$__codex_env_name" in
        ''|[0-9]*|*[!A-Za-z0-9_]*) ;;
        *)
          if __codex_snapshot_getenv "$__codex_env_name" 2>/dev/null; then
            if [ "$__codex_env_file" = "\$$__codex_env_name" ]; then
              __codex_env_file=$__codex_env_expanded
            else
              __codex_env_file="$__codex_env_expanded/${__codex_env_file#*/}"
            fi
          fi
          ;;
      esac
      ;;
  esac
  printf '%s' "$__codex_env_file"
)
if [ -n "${ENV-}" ]; then
  __codex_env_file=$(__codex_snapshot_expand_env "$ENV")
  if [ -r "$__codex_env_file" ] && [ ! -d "$__codex_env_file" ]; then
    case "$__codex_env_file" in
      /*) . "$__codex_env_file" ;;
      *) . "./$__codex_env_file" ;;
    esac
  fi
  command unset __codex_env_file
fi
command unset -f __codex_snapshot_expand_env
"##;

const ZSH_STATE: &str = r##"print '# Snapshot file'
print '# Unset all aliases to avoid conflicts with functions'
print 'unalias -a 2>/dev/null || true'
print '# Functions'
functions
print ''
COMMAND_HELPER
setopt_count=$(setopt | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
print "# setopts $setopt_count"
setopt | __codex_snapshot_command sed 's/^/setopt /'
print ''
printf '\0'
alias_count=$(\alias -L | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
print "# aliases $alias_count"
\alias -L
print ''
printf '\0'
"##;

const BASH_STATE: &str = r##"echo '# Snapshot file'
echo '# Unset all aliases to avoid conflicts with functions'
echo 'unalias -a 2>/dev/null || true'
shopt -p || true
echo '# Functions'
declare -f
echo ''
COMMAND_HELPER
bash_opts=$(set -o | __codex_snapshot_command awk '$2=="on"{print $1}')
bash_opt_count=$(printf '%s\n' "$bash_opts" | __codex_snapshot_command sed '/^$/d' | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
echo "# setopts $bash_opt_count"
if [ -n "$bash_opts" ]; then
  printf 'set -o %s\n' $bash_opts
fi
echo ''
printf '\0'
alias_count=$(\alias -p | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
echo "# aliases $alias_count"
\alias -p
echo ''
printf '\0'
"##;

const SH_STATE: &str = r##"echo '# Snapshot file'
if [ -n "${BASH_VERSINFO-}" ]; then
  echo '# Bash-backed sh'
  shopt -p || true
fi
echo '# Unset all aliases to avoid conflicts with functions'
unalias -a 2>/dev/null || true
echo '# Functions'
if command -v typeset >/dev/null 2>&1; then
  typeset -f
elif command -v declare >/dev/null 2>&1; then
  declare -f
fi
echo ''
COMMAND_HELPER
if set -o >/dev/null 2>&1; then
  sh_opts=$(set -o | __codex_snapshot_command awk '$2=="on"{print $1}')
  sh_opt_count=$(printf '%s\n' "$sh_opts" | __codex_snapshot_command sed '/^$/d' | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
  echo "# setopts $sh_opt_count"
  if [ -n "$sh_opts" ]; then
    printf 'set -o %s\n' $sh_opts
  fi
else
  echo '# setopts 0'
fi
echo ''
printf '\0'
if alias >/dev/null 2>&1; then
  alias_count=$(alias | __codex_snapshot_command wc -l | __codex_snapshot_command tr -d ' ')
  echo "# aliases $alias_count"
  alias
  echo ''
else
  echo '# aliases 0'
fi
printf '\0'
"##;

/// The script `shell` runs, as a login shell, to print its state and aliases.
pub(super) fn capture_script(shell: SnapshotShell) -> String {
    let (startup, state) = match shell {
        SnapshotShell::Zsh => (ZSH_STARTUP, ZSH_STATE),
        SnapshotShell::Bash => (BASH_STARTUP, BASH_STATE),
        SnapshotShell::Sh => (SH_STARTUP, SH_STATE),
    };
    format!(
        "{startup}{}",
        state.replace("COMMAND_HELPER", COMMAND_HELPER)
    )
}
