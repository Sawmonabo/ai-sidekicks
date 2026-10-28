//! The scripts a login shell runs to print its state for a snapshot, as Codex's own capture writes
//! them for a snapshot replayed by sourcing it whole: the shell's interactive startup file read
//! first, then its functions and options, a NUL, its aliases and a NUL, then each export as its
//! name, a NUL, its native declaration and a NUL, closed by one more NUL. The POSIX shell, whose
//! declarations carry no value, prints only its unset exports there and then its whole environment
//! as NUL-ended entries, closed by an empty one.

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

/// The POSIX shell's environment, each entry NUL-ended.
const ENVIRONMENT_ENTRIES: &str = r#"if command -v env >/dev/null 2>&1; then
  "env" -0
else
  # Resolve the fallback separately: Bash's command -p changes the utility's PATH.
  "$(PATH="$(command -p getconf PATH)" command -v env)" -0
fi
"#;

/// Bash's exports, each by its native declaration.
const BASH_EXPORTS: &str = r#"(
  while IFS= read -r __codex_snapshot_export_name; do
    case "$__codex_snapshot_export_name" in
      ""|[0-9]*|*[!A-Za-z0-9_]*|PWD|OLDPWD) continue ;;
    esac
    RECORD_START
    declare -xp "$__codex_snapshot_export_name" 2>/dev/null || true
    RECORD_END
  done < <(compgen -e)
)
"#;

/// Zsh's exports, each by its native declaration, read-only ones left out.
const ZSH_EXPORTS: &str = r#"(
  unsetopt rcquotes
  # Some Zsh builds do not include the zsh/parameter module.
  for __codex_snapshot_export_name in ${(f)"$(typeset +x)"}; do
    case "$__codex_snapshot_export_name" in
      ""|[0-9]*|*[!A-Za-z0-9_]*|PWD|OLDPWD) continue ;;
    esac
    case "${(tP)__codex_snapshot_export_name}" in
      *readonly*) continue ;;
      *export*) ;;
      *) continue ;;
    esac
    RECORD_START
    typeset -xp "$__codex_snapshot_export_name"
    RECORD_END
  done
)
"#;

/// The POSIX shell's exports that hold no value, which its environment entries cannot show.
const SH_EXPORTS: &str = r#"if export -p >/dev/null 2>&1; then
export -p | __codex_snapshot_command awk '
/^(export|declare -x|typeset -x) [A-Za-z_][A-Za-z0-9_]*$/ {
  name=$0
  sub(/^(export|declare -x|typeset -x) /, "", name)
  if (name ~ /^(PWD|OLDPWD)$/) {
    next
  }
  if (!seen[name]++) {
    print name
  }
}' | while IFS= read -r __codex_snapshot_export_name; do
  # Only the validated identifier enters eval. Set values come from the bulk environment.
  if eval '[ "${'"$__codex_snapshot_export_name"'+x}" = x ]'; then
    continue
  fi
  # Only preserve an unset export if the native shell confirms it already exists.
  if (
    set +a
    set -- "$__codex_snapshot_export_name" "$(export -p)"
    export "$1"
    [ "$2" = "$(export -p)" ]
  ); then
    RECORD_START
    printf 'export %s\n' "$__codex_snapshot_export_name"
    RECORD_END
  fi
done
fi
"#;

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
EXPORTS
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
EXPORTS
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
EXPORTS
printf '\0'
ENVIRONMENT_ENTRIES
printf '\0'
"##;

/// The script `shell` runs, as a login shell, to print its state, aliases and exports.
pub(super) fn capture_script(shell: SnapshotShell) -> String {
    let (startup, state, exports) = match shell {
        SnapshotShell::Zsh => (ZSH_STARTUP, ZSH_STATE, ZSH_EXPORTS),
        SnapshotShell::Bash => (BASH_STARTUP, BASH_STATE, BASH_EXPORTS),
        SnapshotShell::Sh => (SH_STARTUP, SH_STATE, SH_EXPORTS),
    };
    let exports = exports
        .replace(
            "RECORD_START",
            "printf '%s\\0' \"$__codex_snapshot_export_name\"",
        )
        .replace("RECORD_END", "printf '\\0'");
    let state = state
        .replace("COMMAND_HELPER", COMMAND_HELPER)
        .replace("ENVIRONMENT_ENTRIES", ENVIRONMENT_ENTRIES)
        .replace("EXPORTS", &exports);
    format!("{startup}{state}")
}
