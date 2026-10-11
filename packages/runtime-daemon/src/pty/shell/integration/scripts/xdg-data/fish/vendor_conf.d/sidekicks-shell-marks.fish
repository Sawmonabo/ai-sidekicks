# Found through XDG_DATA_DIRS, which the daemon names this folder's parent in first, so fish runs it
# with its vendor configuration, before the person's config.fish, to add the handlers that write
# the shell's marks.

# The nonce goes from its file into an unexported variable at once, and the file goes, so no
# program the shell starts can read it.
set -g __sidekicks_nonce
if test -r "$SIDEKICKS_SHELL_MARK_NONCE_FILE"
    read -g __sidekicks_nonce <$SIDEKICKS_SHELL_MARK_NONCE_FILE
    command rm -f -- $SIDEKICKS_SHELL_MARK_NONCE_FILE
end
set -eg SIDEKICKS_SHELL_MARK_NONCE_FILE

# The person's own XDG_DATA_DIRS comes back, or none where they had none.
if set -q SIDEKICKS_ORIGINAL_XDG_DATA_DIRS
    set -gx XDG_DATA_DIRS $SIDEKICKS_ORIGINAL_XDG_DATA_DIRS
    set -eg SIDEKICKS_ORIGINAL_XDG_DATA_DIRS
else
    set -eg XDG_DATA_DIRS
end

set -g __sidekicks_command_started 0
set -g __sidekicks_exit_code 0

# Each mark goes to the terminal itself, never into where a person sent the shell's output.
# Tracing is off inside, so a person's `fish_trace` never writes the nonce into the output.
function __sidekicks_print_mark --argument-names body
    set -l fish_trace
    builtin printf '\e]133;%s;nonce=%s\a' $body $__sidekicks_nonce >/dev/tty
end

function __sidekicks_prompt_hook --on-event fish_prompt
    if test $__sidekicks_command_started = 1
        __sidekicks_print_mark "D;$__sidekicks_exit_code"
    else
        __sidekicks_print_mark D
    end
    __sidekicks_print_mark A
    set -g __sidekicks_command_started 0
end

function __sidekicks_command_hook --on-event fish_preexec
    set -g __sidekicks_command_started 1
    __sidekicks_print_mark C
end

function __sidekicks_end_hook --on-event fish_postexec
    set -g __sidekicks_exit_code $status
end
