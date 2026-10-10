# Loaded one of two ways, and either way the shell is a login shell. A bash started in posix mode
# reads only the file `ENV` names, this one: it turns posix mode off and loads the login profile
# itself. macOS's own bash, which skips `ENV`, reads its login profile as usual and loads this
# file from its first prompt command, which this file then takes back out. Then it adds the hooks
# that write the shell's marks. Runs in bash 3.2 as well as bash 5.

if builtin shopt -oq posix; then
  __sidekicks_from_prompt=
  builtin set +o posix
  # Posix mode turns this on, and turning posix mode off leaves it on.
  if ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4))); then
    builtin shopt -u inherit_errexit
  fi
  # Posix mode names its own history file where the person named none.
  if [ "${HISTFILE-}" = "$HOME/.sh_history" ]; then
    HISTFILE=$HOME/.bash_history
  fi
  if [ -n "${SIDEKICKS_ORIGINAL_ENV+set}" ]; then
    builtin export ENV="$SIDEKICKS_ORIGINAL_ENV"
    builtin unset SIDEKICKS_ORIGINAL_ENV
  else
    builtin unset ENV
  fi
else
  __sidekicks_from_prompt=1
fi

# The nonce goes from its file into an unexported variable, and the file goes at once. In a posix
# start that is before any startup file runs; loaded from the first prompt command, it is after
# the login profile, so a program the profile started could have read the file meanwhile.
__sidekicks_nonce=
if [ -r "${SIDEKICKS_SHELL_MARK_NONCE_FILE-}" ]; then
  builtin read -r __sidekicks_nonce <"$SIDEKICKS_SHELL_MARK_NONCE_FILE"
  command rm -f -- "$SIDEKICKS_SHELL_MARK_NONCE_FILE"
fi
builtin unset SIDEKICKS_SHELL_MARK_NONCE_FILE

if [ -z "$__sidekicks_from_prompt" ]; then
  if [ -r /etc/profile ]; then
    builtin . /etc/profile
  fi
  if [ -r ~/.bash_profile ]; then
    builtin . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then
    builtin . ~/.bash_login
  elif [ -r ~/.profile ]; then
    builtin . ~/.profile
  fi
else
  # The loader goes for a call that hands on the exit code it was given, so the prompt commands
  # around it read what they would have. A first line typed after it is the first command only
  # where no prompt command of the person's follows the loader.
  __sidekicks_pass_status() {
    builtin return "$?"
  }
  # The daemon hands over the loader's exact text, so it is written in one place.
  __sidekicks_loader=$SIDEKICKS_BASH_PROMPT_LOADER
  case $PROMPT_COMMAND in
    *"$__sidekicks_loader") __sidekicks_is_loader_last=1 ;;
    *) __sidekicks_is_loader_last= ;;
  esac
  PROMPT_COMMAND=${PROMPT_COMMAND//"$__sidekicks_loader"/__sidekicks_pass_status}
  builtin export -n PROMPT_COMMAND
  builtin unset SIDEKICKS_BASH_SCRIPT SIDEKICKS_BASH_PROMPT_LOADER __sidekicks_loader
fi

__sidekicks_command_started=
__sidekicks_at_prompt=

# Each mark goes to the terminal itself, so the start mark the DEBUG trap writes inside a command
# whose output is redirected, `{ echo grouped; } > file`, never lands in the file. Tracing goes off
# around the mark and comes back as it was, so a person's `set -x` never writes the nonce into the
# output; bash 3.2 has no `local -` to do it.
__sidekicks_print_mark() {
  builtin local tracing=
  case $- in
    *x*)
      tracing=1
      builtin set +x
      ;;
  esac
  builtin printf '\033]133;%s;nonce=%s\007' "$1" "$__sidekicks_nonce" >/dev/tty
  if [ -n "$tracing" ]; then
    builtin set -x
  fi
}

# Runs first before each prompt, so it reads the command's exit code before anything else; it
# returns that code so what runs after it reads it too.
__sidekicks_prompt_hook() {
  builtin local exit_code=$?
  __sidekicks_at_prompt=
  if [ -n "$__sidekicks_command_started" ]; then
    __sidekicks_print_mark "D;$exit_code"
  else
    __sidekicks_print_mark D
  fi
  __sidekicks_print_mark A
  __sidekicks_command_started=
  builtin return "$exit_code"
}

__sidekicks_command_hook() {
  __sidekicks_command_started=1
  __sidekicks_print_mark C
}

if [ -n "${bash_preexec_imported-}" ]; then
  precmd_functions=(__sidekicks_prompt_hook "${precmd_functions[@]}")
  preexec_functions+=(__sidekicks_command_hook)
else
  # Set by the last prompt command, so the first command after the prompt writes the start
  # mark; the prompt commands themselves run before it is set.
  __sidekicks_await_command() {
    __sidekicks_at_prompt=1
  }

  # The DEBUG trap runs before every command, the prompt commands included. It writes the start
  # mark once per line, then runs the person's own trap with the exit code and last argument it
  # would have seen, and ends on a call whose last argument restores `$_` for the command.
  __sidekicks_debug_hook() {
    builtin local exit_code=$?
    __sidekicks_last_argument=$1
    if [ -n "$__sidekicks_at_prompt" ] && [ "$BASH_COMMAND" != __sidekicks_prompt_hook ]; then
      __sidekicks_at_prompt=
      __sidekicks_command_hook
    fi
    builtin return "$exit_code"
  }
  __sidekicks_restore_status() {
    builtin return "$1"
  }
  # `trap -p` prints the trap as a quoted command; evaluated into an array, its third word is the
  # person's trap exactly as they wrote it.
  builtin eval "__sidekicks_trap_words=( $(builtin trap -p DEBUG) )"
  __sidekicks_person_debug_trap=${__sidekicks_trap_words[2]-}
  builtin unset __sidekicks_trap_words
  builtin trap '__sidekicks_debug_hook "$_"; builtin eval "$__sidekicks_person_debug_trap"; __sidekicks_restore_status "$?" "$__sidekicks_last_argument"' DEBUG

  # bash 5.1 runs each entry of an array PROMPT_COMMAND; older bash runs only its first, a string.
  if ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1))); then
    PROMPT_COMMAND=(__sidekicks_prompt_hook "${PROMPT_COMMAND[@]}" __sidekicks_await_command)
  else
    PROMPT_COMMAND=$'__sidekicks_prompt_hook\n'"${PROMPT_COMMAND-}"$'\n__sidekicks_await_command'
  fi
fi

# Loaded from the first prompt command, so that prompt's marks are written here. Waiting for the
# first command is the last thing done, so no command of this file writes its start mark.
if [ -n "$__sidekicks_from_prompt" ]; then
  __sidekicks_prompt_hook
  __sidekicks_at_prompt=$__sidekicks_is_loader_last
fi
