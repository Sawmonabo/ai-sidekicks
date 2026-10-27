# Sources the person's .zprofile with ZDOTDIR at their folder, then points it back here.
if [[ -r $__sidekicks_person_zdotdir/.zprofile ]]; then
  ZDOTDIR=$__sidekicks_person_zdotdir
  builtin . "$__sidekicks_person_zdotdir/.zprofile"
  __sidekicks_person_zdotdir=$ZDOTDIR
  ZDOTDIR=$__sidekicks_shim_zdotdir
fi
