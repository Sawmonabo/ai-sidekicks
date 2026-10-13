//! A value written into a POSIX shell command line exactly, whatever it holds.

/// `value` single-quoted for a POSIX shell. Nothing inside `'...'` is interpreted, so an embedded
/// `'` is written as `'\''`: close, an escaped quote, reopen.
pub(crate) fn quote_for_posix_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}
