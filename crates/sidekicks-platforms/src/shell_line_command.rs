//! A command line run through a shell, as a project's own setup commands run: the person's login
//! shell where the account names one, else the system's default shell, given the line as each
//! system's shells read one; and the shell programs a program that runs command lines looks for,
//! where each is installed, and the ones it falls back to.

use std::io;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::{default_shell, login_shell};

/// The shell a command line runs under: the account's login shell, else the system's default
/// shell. Fails with the user database's error from the login shell's read.
pub fn command_shell() -> io::Result<PathBuf> {
    login_shell().map(|shell| shell.unwrap_or_else(default_shell))
}

/// A shell program that runs command lines: the file name a search along a search path looks for,
/// and the paths the system installs it at, tried in order after that search.
pub struct LineShellProgram {
    /// The program's file name, as `zsh`.
    pub name: &'static str,
    /// Where the system installs the program.
    pub installed_paths: &'static [&'static str],
}

const ZSH: LineShellProgram = LineShellProgram {
    name: "zsh",
    installed_paths: &["/bin/zsh"],
};

const BASH: LineShellProgram = LineShellProgram {
    name: "bash",
    installed_paths: &["/bin/bash", "/usr/bin/bash"],
};

const SH: LineShellProgram = LineShellProgram {
    name: "sh",
    installed_paths: &["/bin/sh"],
};

#[cfg(windows)]
const PWSH: LineShellProgram = LineShellProgram {
    name: "pwsh",
    installed_paths: &[r"C:\Program Files\PowerShell\7\pwsh.exe"],
};

#[cfg(not(windows))]
const PWSH: LineShellProgram = LineShellProgram {
    name: "pwsh",
    installed_paths: &["/usr/local/bin/pwsh"],
};

#[cfg(windows)]
const POWERSHELL: LineShellProgram = LineShellProgram {
    name: "powershell",
    installed_paths: &[r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"],
};

#[cfg(not(windows))]
const POWERSHELL: LineShellProgram = LineShellProgram {
    name: "powershell",
    installed_paths: &[],
};

const CMD: LineShellProgram = LineShellProgram {
    name: "cmd",
    installed_paths: &[],
};

/// Every shell program a program that runs command lines may look for, each with the paths this
/// system installs it at: zsh, bash, sh, PowerShell 7, Windows PowerShell and Windows' command
/// interpreter.
pub const LINE_SHELL_PROGRAMS: &[LineShellProgram] = &[ZSH, BASH, SH, PWSH, POWERSHELL, CMD];

/// The shell programs a program that runs command lines falls back to, in order, where the
/// account's login shell is none it runs lines in: on macOS zsh, then bash.
#[cfg(target_os = "macos")]
pub const FALLBACK_LINE_SHELLS: &[LineShellProgram] = &[ZSH, BASH];

/// The shell programs a program that runs command lines falls back to, in order, where the
/// account's login shell is none it runs lines in: on Linux bash, then zsh.
#[cfg(target_os = "linux")]
pub const FALLBACK_LINE_SHELLS: &[LineShellProgram] = &[BASH, ZSH];

/// The shell programs a program that runs command lines falls back to, in order: on Windows,
/// which names no login shell, PowerShell 7, then Windows PowerShell.
#[cfg(windows)]
pub const FALLBACK_LINE_SHELLS: &[LineShellProgram] = &[PWSH, POWERSHELL];

/// The shell a program that runs command lines takes when no shell it looks for is found: `/bin/sh`
/// on macOS and Linux, Windows' command interpreter on Windows.
pub const ULTIMATE_FALLBACK_LINE_SHELL: &str = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };

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
