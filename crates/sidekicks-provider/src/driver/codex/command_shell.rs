//! The shell Codex starts a command's line with, found as Codex finds it: the account's login
//! shell when Codex runs lines in its kind of shell and its file is there, else that kind's program
//! along the search path, else the system's fallback line shells in order. Codex never reads
//! `SHELL` for it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_platforms::{FALLBACK_LINE_SHELLS, find_executables, login_shell};

// The kinds of shell Codex runs lines in, each by the name Codex reads it from a shell's file
// name, with the programs it looks for that kind under, in order.
const CODEX_SHELL_KINDS: [(&str, &[&str]); 6] = [
    ("zsh", &["zsh"]),
    ("bash", &["bash"]),
    ("sh", &["sh"]),
    ("pwsh", &["pwsh", "powershell"]),
    ("powershell", &["pwsh", "powershell"]),
    ("cmd", &["cmd"]),
];

/// The shell Codex starts a command's line with, searched along `base_environment`'s `PATH`, the
/// environment Codex starts from; `None` where no shell is found. Reads the user database and the
/// file system, once per driver.
pub(super) fn read_command_shell(base_environment: &[(String, String)]) -> Option<Arc<Path>> {
    let login_shell = login_shell()
        .inspect_err(|error| {
            tracing::warn!(
                error = error as &(dyn std::error::Error + 'static),
                "the account's login shell could not be read, so Codex's command shell is taken \
                 from the fallback shells"
            );
        })
        .ok()
        .flatten();
    let search = |name: &str| find_executables(name, base_environment, Path::new(""), &[]).next();
    find_command_shell(login_shell.as_deref(), search, Path::is_file).map(Arc::from)
}

// The command shell Codex takes with `login_shell`, `search` finding a program along the search
// path and `is_file` telling whether a path is a file.
fn find_command_shell(
    login_shell: Option<&Path>,
    search: impl Fn(&str) -> Option<PathBuf>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let login_programs = login_shell.and_then(codex_shell_programs);
    if let Some(shell) = login_shell
        && login_programs.is_some()
        && is_file(shell)
    {
        return Some(shell.to_path_buf());
    }
    let find_program = |name: &str| {
        search(name).or_else(|| {
            FALLBACK_LINE_SHELLS
                .iter()
                .filter(|program| program.name == name)
                .flat_map(|program| program.installed_paths)
                .map(Path::new)
                .find(|path| is_file(path))
                .map(Path::to_path_buf)
        })
    };
    login_programs
        .into_iter()
        .flatten()
        .copied()
        .chain(FALLBACK_LINE_SHELLS.iter().map(|program| program.name))
        .find_map(find_program)
}

// The programs Codex looks for the kind of `shell` under, read as Codex reads it: the whole path,
// else its file name with one extension dropped at a time; `None` for a kind Codex runs no line in.
fn codex_shell_programs(shell: &Path) -> Option<&'static [&'static str]> {
    let mut name = shell.as_os_str();
    loop {
        if let Some((_, programs)) = CODEX_SHELL_KINDS.iter().find(|(kind, _)| name == *kind) {
            return Some(programs);
        }
        let stem = Path::new(name).file_stem()?;
        if stem == name {
            return None;
        }
        name = stem;
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::FALLBACK_LINE_SHELLS;

    use super::find_command_shell;

    const HOMEBREW_ZSH: &str = "/opt/homebrew/bin/zsh";

    // Killed by taking the login shell whatever its kind, by skipping its file check, or by
    // looking for no fallback shell past it.
    #[rstest]
    #[case::login_shell_codex_runs("/opt/homebrew/bin/zsh", &[HOMEBREW_ZSH], Some(HOMEBREW_ZSH))]
    #[case::missing_login_shell_found_by_its_kind("/usr/local/bin/zsh", &[], Some(HOMEBREW_ZSH))]
    fn a_login_shell_of_a_kind_codex_runs_is_taken_when_its_file_is_there(
        #[case] login_shell: &str,
        #[case] files: &[&str],
        #[case] expected: Option<&str>,
    ) {
        let search = |name: &str| (name == "zsh").then(|| PathBuf::from(HOMEBREW_ZSH));
        let is_file = |path: &Path| files.iter().any(|file| path == Path::new(file));

        assert_eq!(
            find_command_shell(Some(Path::new(login_shell)), search, is_file),
            expected.map(PathBuf::from)
        );
    }

    #[test]
    fn a_fish_login_shell_takes_the_zsh_fallback() {
        let search = |name: &str| (name == "zsh").then(|| PathBuf::from(HOMEBREW_ZSH));
        let is_zsh_a_fallback = FALLBACK_LINE_SHELLS
            .iter()
            .any(|program| program.name == "zsh");

        assert_eq!(
            find_command_shell(Some(Path::new("/opt/homebrew/bin/fish")), search, |_| true),
            is_zsh_a_fallback.then(|| PathBuf::from(HOMEBREW_ZSH))
        );
    }
}
