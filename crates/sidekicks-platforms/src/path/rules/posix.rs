//! How macOS and Linux spell paths: `/` between components, one root, names compared exactly and a
//! line ended by a line feed alone; and how their `sh` reads a word.

use typed_path::Utf8UnixPath;

use super::FolderCommand;

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

/// `/bin/sh -c "cd <folder> && exec <program> <arguments…>"`; `exec` replaces the shell, so the
/// shell's child is the program and a signal sent to it reaches the program.
pub(super) fn run_in_folder(folder: &str, program: &str, arguments: &[String]) -> FolderCommand {
    let mut script = format!(
        "cd {} && exec {}",
        quote_shell_word(folder),
        quote_shell_word(program)
    );
    for argument in arguments {
        script.push(' ');
        script.push_str(&quote_shell_word(argument));
    }
    FolderCommand {
        program: "/bin/sh",
        arguments: vec!["-c".to_owned(), script],
    }
}
