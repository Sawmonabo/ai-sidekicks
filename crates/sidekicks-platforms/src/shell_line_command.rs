//! A command line run through a shell, as a project's own setup commands run: the person's login
//! shell where the account names one, else the system's default shell, given the line as each
//! system's shells read one.

use std::io;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::{default_shell, login_shell};

/// The shell a command line runs under: the account's login shell, else the system's default
/// shell. Fails with the user database's error from the login shell's read.
pub fn command_shell() -> io::Result<PathBuf> {
    login_shell().map(|shell| shell.unwrap_or_else(default_shell))
}

/// A command that runs `line` through `shell`: `-c <line>` on macOS and Linux and for any shell on
/// Windows but its command interpreter, which takes `/d /s /c "<line>"` as written, so the line
/// reaches it unquoted. Only the program and its arguments are set.
pub fn shell_line_command(shell: &Path, line: &str) -> Command {
    let mut command = Command::new(shell);
    #[cfg(windows)]
    if is_command_interpreter(shell) {
        command
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{line}\""));
        return command;
    }
    command.arg("-c").arg(line);
    command
}

// Whether `shell` is Windows' command interpreter: a path whose last part is `cmd` or `cmd.exe`,
// in any case.
#[cfg(windows)]
fn is_command_interpreter(shell: &Path) -> bool {
    shell.file_name().is_some_and(|name| {
        name.eq_ignore_ascii_case("cmd") || name.eq_ignore_ascii_case("cmd.exe")
    })
}

#[cfg(all(test, windows))]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::is_command_interpreter;

    #[rstest]
    #[case::bare("cmd", true)]
    #[case::program("cmd.exe", true)]
    #[case::any_case(r"C:\Windows\System32\CMD.EXE", true)]
    #[case::folder_named_like_it(r"C:\cmd\pwsh.exe", false)]
    #[case::longer_name(r"C:\tools\xcmd.exe", false)]
    fn a_shell_is_the_command_interpreter_by_its_last_part(
        #[case] shell: &str,
        #[case] is_interpreter: bool,
    ) {
        assert_eq!(is_command_interpreter(Path::new(shell)), is_interpreter);
    }
}
