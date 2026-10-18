//! How macOS and Linux spell paths: `/` between components, one root, names compared exactly and a
//! line ended by a line feed alone; and how their `sh` reads a word.

use typed_path::Utf8UnixPath;

/// The separator between a POSIX path's components.
pub(super) const SEPARATOR: char = '/';

/// Whether `path` starts at the root.
pub(super) fn is_absolute(path: &str) -> bool {
    Utf8UnixPath::new(path).is_absolute()
}

/// `path` joined onto `base`, an absolute `path` replacing it.
pub(super) fn join(base: &str, path: &str) -> String {
    Utf8UnixPath::new(base).join(path).into_string()
}

/// `word` single-quoted for `sh`. Nothing inside `'...'` is interpreted, so an embedded `'` is
/// written `'\''`: close, an escaped quote, reopen.
pub(super) fn quote_shell_word(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}
