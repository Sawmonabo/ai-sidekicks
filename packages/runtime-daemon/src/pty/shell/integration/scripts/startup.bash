# Loaded through --init-file, which a login bash ignores, so this loads what a login shell would
# and then adds the hooks that write the shell's marks. Runs in bash 3.2 as well as bash 5.

# The nonce goes into an unexported variable before anything else runs, so no program inherits it.
__sidekicks_nonce=$SIDEKICKS_SHELL_MARK_NONCE
builtin unset SIDEKICKS_SHELL_MARK_NONCE

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

__sidekicks_command_started=
__sidekicks_at_prompt=

# Tracing goes off around the mark and comes back as it was, so a person's `set -x` never writes
# the nonce into the output; bash 3.2 has no `local -` to do it.
__sidekicks_print_mark() {
  builtin local tracing=
  case $- in
    *x*)
      tracing=1
      builtin set +x
      ;;
  esac
  builtin printf '\033]133;%s;nonce=%s\007' "$1" "$__sidekicks_nonce"
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
