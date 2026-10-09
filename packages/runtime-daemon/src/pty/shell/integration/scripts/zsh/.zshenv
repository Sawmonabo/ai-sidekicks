# The first file zsh reads from this folder, which the daemon names as ZDOTDIR. Each file here
# points ZDOTDIR at the person's own folder only while it sources their file of the same name.

# The nonce goes from its file into an unexported variable before anything else runs, and the
# file goes at once, so no program the shell starts can read it.
__sidekicks_nonce=
if [[ -r $SIDEKICKS_SHELL_MARK_NONCE_FILE ]]; then
  builtin read -r __sidekicks_nonce <"$SIDEKICKS_SHELL_MARK_NONCE_FILE"
  command rm -f -- "$SIDEKICKS_SHELL_MARK_NONCE_FILE"
fi
builtin unset SIDEKICKS_SHELL_MARK_NONCE_FILE
__sidekicks_shim_zdotdir=$ZDOTDIR
# Left exported until .zlogin, so a zsh the startup files start still reads the person's .zshenv.
__sidekicks_person_zdotdir=$SIDEKICKS_ORIGINAL_ZDOTDIR

if [[ -r $__sidekicks_person_zdotdir/.zshenv ]]; then
  ZDOTDIR=$__sidekicks_person_zdotdir
  builtin . "$__sidekicks_person_zdotdir/.zshenv"
  # A person's .zshenv may move ZDOTDIR; their later files are read from where it points.
  __sidekicks_person_zdotdir=$ZDOTDIR
  ZDOTDIR=$__sidekicks_shim_zdotdir
fi
