//! How Claude Code reads a variable that turns a behavior on or off: `1`, `true`, `yes` or `on`
//! turn it on and `0`, `false`, `no` or `off` turn it off, trimmed of white space and in any case.

use sidekicks_contracts::wire::text::is_ecmascript_whitespace;

/// Whether a variable's `value` turns its behavior on, as Claude Code reads it.
pub(crate) fn is_switched_on(value: &str) -> bool {
    matches!(fold_switch(value).as_str(), "1" | "true" | "yes" | "on")
}

/// Whether a variable's `value` turns its behavior off, as Claude Code reads it.
pub(crate) fn is_switched_off(value: &str) -> bool {
    matches!(fold_switch(value).as_str(), "0" | "false" | "no" | "off")
}

// A switch's value as Claude Code compares it: trimmed of ECMAScript white space, lower-cased.
fn fold_switch(value: &str) -> String {
    value.trim_matches(is_ecmascript_whitespace).to_lowercase()
}
