# Sources the person's .zshrc, then adds the hooks that write the shell's marks.

# The system's zshrc names the history file from ZDOTDIR, which still points here.
if [[ $HISTFILE == $__sidekicks_shim_zdotdir/* ]]; then
  HISTFILE=$__sidekicks_person_zdotdir/.zsh_history
fi

if [[ -r $__sidekicks_person_zdotdir/.zshrc ]]; then
  ZDOTDIR=$__sidekicks_person_zdotdir
  builtin . "$__sidekicks_person_zdotdir/.zshrc"
  __sidekicks_person_zdotdir=$ZDOTDIR
  ZDOTDIR=$__sidekicks_shim_zdotdir
fi

__sidekicks_command_started=0

# Each hook runs under zsh's own options with tracing off, so a person's `set -x` never writes
# the nonce into the output.
__sidekicks_print_mark() {
  builtin emulate -L zsh -o no_xtrace
  builtin printf '\033]133;%s;nonce=%s\007' "$1" "$__sidekicks_nonce"
}

# Runs first before each prompt, so it reads the command's exit code before any other hook; it
# returns that code so the hooks after it read it too.
__sidekicks_prompt_hook() {
  builtin local exit_code=$?
  builtin emulate -L zsh -o no_xtrace
  if (( __sidekicks_command_started )); then
    __sidekicks_print_mark "D;$exit_code"
  else
    __sidekicks_print_mark D
  fi
  __sidekicks_print_mark A
  __sidekicks_command_started=0
  builtin return $exit_code
}

__sidekicks_command_hook() {
  builtin emulate -L zsh -o no_xtrace
  __sidekicks_command_started=1
  __sidekicks_print_mark C
}

precmd_functions=(__sidekicks_prompt_hook "${precmd_functions[@]}")
preexec_functions+=(__sidekicks_command_hook)
