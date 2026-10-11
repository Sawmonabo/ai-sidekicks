# The last file zsh reads at startup: ZDOTDIR stays at the person's own folder from here on.
ZDOTDIR=$__sidekicks_person_zdotdir
builtin unset SIDEKICKS_ORIGINAL_ZDOTDIR __sidekicks_shim_zdotdir __sidekicks_person_zdotdir
if [[ -r $ZDOTDIR/.zlogin ]]; then
  builtin . "$ZDOTDIR/.zlogin"
fi
