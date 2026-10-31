//! The shells Codex starts command lines and hooks with, found as Codex finds them: a kind's shell
//! is the account's login shell when it is of that kind and its file is there, else the kind's
//! programs along the search path, else at the paths the system installs them at. The session's
//! shell is the login shell's kind, else the system's fallback shells in order, else the system's
//! ultimate fallback. Codex never reads `SHELL` for it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_platforms::{
    FALLBACK_LINE_SHELLS, LINE_SHELL_PROGRAMS, ULTIMATE_FALLBACK_LINE_SHELL, find_executables,
    login_shell,
};

/// A kind of shell Codex runs lines in, which decides how it hands the shell a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexShellKind {
    /// zsh, handed a line with `-c`.
    Zsh,
    /// bash, handed a line with `-c`.
    Bash,
    /// A POSIX `sh`, handed a line with `-c`.
    Sh,
    /// PowerShell 7 or Windows PowerShell, handed a line with `-NoProfile -Command`.
    PowerShell,
    /// Windows' command interpreter, handed a line with `/c`.
    Cmd,
}

impl CodexShellKind {
    // The kinds Codex hands a line with `-c`, which a command's `shell` argument may name.
    const LINE_KINDS: [Self; 3] = [Self::Zsh, Self::Bash, Self::Sh];

    // The kind of `shell` as Codex reads it: the whole path, else its file name with one extension
    // dropped at a time; `None` for a shell Codex runs no line in.
    fn of_shell(shell: &Path) -> Option<Self> {
        let mut name = shell.as_os_str();
        loop {
            let kind = match name.to_str() {
                Some("zsh") => Some(Self::Zsh),
                Some("bash") => Some(Self::Bash),
                Some("sh") => Some(Self::Sh),
                Some("pwsh" | "powershell") => Some(Self::PowerShell),
                Some("cmd") => Some(Self::Cmd),
                Some(_) | None => None,
            };
            if kind.is_some() {
                return kind;
            }
            let stem = Path::new(name).file_stem()?;
            if stem == name {
                return None;
            }
            name = stem;
        }
    }

    // The programs Codex looks for this kind under, in order.
    fn programs(self) -> &'static [&'static str] {
        match self {
            Self::Zsh => &["zsh"],
            Self::Bash => &["bash"],
            Self::Sh => &["sh"],
            Self::PowerShell => &["pwsh", "powershell"],
            Self::Cmd => &["cmd"],
        }
    }
}

/// The shells Codex runs a session's lines and hooks with, read once per driver.
#[derive(Clone, Debug)]
pub(crate) struct CodexShells {
    /// The kind of the session's shell, which runs the session's hook commands.
    pub(crate) session_kind: CodexShellKind,
    /// Every path Codex may start a command's `-c` shell at: the zsh, bash and sh it finds, which
    /// a command's `shell` argument picks among and the session's shell is one of when it is of
    /// those kinds, and the ultimate fallback, which an unknown `shell` argument takes.
    pub(crate) line_shells: Arc<[PathBuf]>,
}

/// The shells Codex runs lines with, searched along `base_environment`'s `PATH`, the environment
/// Codex starts from. Reads the user database and the file system.
pub(crate) fn read_codex_shells(base_environment: &[(String, String)]) -> CodexShells {
    let login_shell = login_shell()
        .inspect_err(|error| {
            tracing::warn!(
                error = error as &(dyn std::error::Error + 'static),
                "the account's login shell could not be read, so Codex's shells are taken from \
                 the fallback shells"
            );
        })
        .ok()
        .flatten();
    let search = |name: &str| find_executables(name, base_environment, Path::new(""), &[]).next();
    ShellSearch {
        login_shell: login_shell.as_deref(),
        search,
        is_file: Path::is_file,
    }
    .codex_shells()
}

// Codex's search for its shells: the account's login shell, a search along the search path and a
// check that a path is a file.
struct ShellSearch<'l, S, F> {
    login_shell: Option<&'l Path>,
    search: S,
    is_file: F,
}

impl<S: Fn(&str) -> Option<PathBuf>, F: Fn(&Path) -> bool> ShellSearch<'_, S, F> {
    fn codex_shells(&self) -> CodexShells {
        let (session_kind, _) = self.session_shell();
        let mut line_shells: Vec<PathBuf> = CodexShellKind::LINE_KINDS
            .into_iter()
            .filter_map(|kind| self.find_kind(kind))
            .collect();
        let ultimate = PathBuf::from(ULTIMATE_FALLBACK_LINE_SHELL);
        if !line_shells.contains(&ultimate) {
            line_shells.push(ultimate);
        }
        CodexShells {
            session_kind,
            line_shells: line_shells.into(),
        }
    }

    // The session's shell and its kind: the login shell's kind, else each fallback shell's kind
    // in the system's order, else the ultimate fallback.
    fn session_shell(&self) -> (CodexShellKind, PathBuf) {
        let ultimate = Path::new(ULTIMATE_FALLBACK_LINE_SHELL);
        self.login_shell
            .and_then(CodexShellKind::of_shell)
            .into_iter()
            .chain(
                FALLBACK_LINE_SHELLS
                    .iter()
                    .filter_map(|program| CodexShellKind::of_shell(Path::new(program.name))),
            )
            .find_map(|kind| Some((kind, self.find_kind(kind)?)))
            .unwrap_or_else(|| {
                let kind = CodexShellKind::of_shell(ultimate)
                    .expect("the ultimate fallback is a shell Codex runs lines in");
                (kind, ultimate.to_path_buf())
            })
    }

    // The shell of `kind`: the login shell when it is of that kind and a file, else each of the
    // kind's programs along the search path, then at its install paths.
    fn find_kind(&self, kind: CodexShellKind) -> Option<PathBuf> {
        if let Some(login_shell) = self.login_shell
            && CodexShellKind::of_shell(login_shell) == Some(kind)
            && (self.is_file)(login_shell)
        {
            return Some(login_shell.to_path_buf());
        }
        kind.programs().iter().find_map(|&name| {
            (self.search)(name).or_else(|| {
                LINE_SHELL_PROGRAMS
                    .iter()
                    .filter(|program| program.name == name)
                    .flat_map(|program| program.installed_paths)
                    .map(Path::new)
                    .find(|path| (self.is_file)(path))
                    .map(Path::to_path_buf)
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::{
        FALLBACK_LINE_SHELLS, LINE_SHELL_PROGRAMS, ULTIMATE_FALLBACK_LINE_SHELL,
    };

    use super::{CodexShellKind, ShellSearch};

    const HOMEBREW_ZSH: &str = "/opt/homebrew/bin/zsh";

    // Each program a search finds, in a folder of its own.
    fn found(name: &str) -> PathBuf {
        PathBuf::from(format!("/found/{name}"))
    }

    fn session_shell(
        login_shell: Option<&str>,
        search: impl Fn(&str) -> Option<PathBuf>,
        is_file: impl Fn(&Path) -> bool,
    ) -> PathBuf {
        ShellSearch {
            login_shell: login_shell.map(Path::new),
            search,
            is_file,
        }
        .session_shell()
        .1
    }

    // Killed by taking the login shell whatever its kind, by skipping its file check, or by
    // looking for no program of its kind past it.
    #[rstest]
    #[case::login_shell_codex_runs(HOMEBREW_ZSH, &[HOMEBREW_ZSH], PathBuf::from(HOMEBREW_ZSH))]
    #[case::missing_login_shell_found_by_its_kind("/usr/local/bin/zsh", &[], found("zsh"))]
    fn a_login_shell_of_a_kind_codex_runs_is_taken_when_its_file_is_there(
        #[case] login_shell: &str,
        #[case] files: &[&str],
        #[case] expected: PathBuf,
    ) {
        let is_file = |path: &Path| files.iter().any(|file| path == Path::new(file));

        assert_eq!(
            session_shell(Some(login_shell), |name| Some(found(name)), is_file),
            expected
        );
    }

    // On macOS and Linux, killed by any order but the system's own fallback order; on Windows
    // both fallbacks are PowerShell, so the order is not read there.
    #[test]
    fn a_fish_login_shell_takes_the_systems_first_fallback_shell() {
        assert_eq!(
            session_shell(
                Some("/opt/homebrew/bin/fish"),
                |name| Some(found(name)),
                |_| true
            ),
            found(FALLBACK_LINE_SHELLS[0].name)
        );
    }

    // Killed by searching a kind only along the search path, or by answering no shell where none
    // is found.
    #[test]
    fn a_kind_found_nowhere_on_the_search_path_is_taken_at_its_install_path() {
        let pwsh_installed = Path::new(
            LINE_SHELL_PROGRAMS
                .iter()
                .find(|program| program.name == "pwsh")
                .and_then(|program| program.installed_paths.first())
                .expect("pwsh has an install path on every system"),
        );

        assert_eq!(
            session_shell(
                Some("/opt/missing/pwsh"),
                |_| None,
                |path| path == pwsh_installed
            ),
            pwsh_installed
        );
        assert_eq!(
            session_shell(Some("/opt/missing/pwsh"), |_| None, |_| false),
            Path::new(ULTIMATE_FALLBACK_LINE_SHELL)
        );
    }

    // Killed by reading only the session's shell for the unwrap, so a command whose `shell`
    // argument names another kind keeps its wrapper.
    #[test]
    fn every_kind_codex_hands_a_line_is_among_the_line_shells() {
        let shells = ShellSearch {
            login_shell: Some(Path::new(HOMEBREW_ZSH)),
            search: |name: &str| Some(found(name)),
            is_file: |_: &Path| true,
        }
        .codex_shells();

        assert_eq!(shells.session_kind, CodexShellKind::Zsh);
        assert_eq!(
            &*shells.line_shells,
            [
                PathBuf::from(HOMEBREW_ZSH),
                found("bash"),
                found("sh"),
                PathBuf::from(ULTIMATE_FALLBACK_LINE_SHELL)
            ]
        );
    }
}
