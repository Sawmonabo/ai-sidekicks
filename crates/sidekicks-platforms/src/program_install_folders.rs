//! The folders the system's package manager, npm and the Node version and package managers put a
//! program's command in, for one person, each where its own documentation puts it; a provider's
//! own installer's folders are its driver's, never here.

use std::path::{Path, PathBuf};

/// A folder a program's command may sit in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProgramFolder {
    /// This folder.
    Folder(PathBuf),
    /// `child` inside each folder of `versions`, as a Node version manager keeps one folder per
    /// installed version (`~/.nvm/versions/node/v22.11.0/bin`); the caller lists the versions and
    /// orders them newest first by their parsed version, never by name.
    EachVersion {
        /// The folder holding one folder per installed version.
        versions: PathBuf,
        /// The folder inside each version's folder.
        child: &'static str,
    },
}

/// The folders where the system's package manager, npm, nvm, fnm, Volta, bun, pnpm and, on
/// Windows, Node's installer and scoop put a command, in search order, for the person whose home
/// folder is `home`. `read_variable` reads the environment the command would run in and answers
/// `None` for a variable that is unset or empty. Lists no folder and never fails.
pub fn program_install_folders(
    home: &Path,
    read_variable: impl Fn(&str) -> Option<String>,
) -> Vec<ProgramFolder> {
    #[cfg(target_os = "macos")]
    let folders = posix_program_install_folders(
        home,
        &read_variable,
        // Homebrew's prefix on Apple silicon, then on Intel, where other installers link too.
        &["/opt/homebrew/bin", "/usr/local/bin"],
        "Library/pnpm",
    );
    #[cfg(target_os = "linux")]
    let folders = posix_program_install_folders(
        home,
        &read_variable,
        &["/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin"],
        ".local/share/pnpm",
    );
    #[cfg(windows)]
    let folders = windows_program_install_folders(home, &read_variable);
    folders
}

// The folders on macOS and Linux: `system_folders` are the package manager's and the usual
// installers' folders, and `pnpm_home` pnpm's default home under the home folder.
#[cfg(unix)]
fn posix_program_install_folders(
    home: &Path,
    read_variable: &dyn Fn(&str) -> Option<String>,
    system_folders: &[&str],
    pnpm_home: &str,
) -> Vec<ProgramFolder> {
    let folder_or_default =
        |name: &str, default: PathBuf| read_variable(name).map_or(default, PathBuf::from);
    let mut folders: Vec<ProgramFolder> = system_folders
        .iter()
        .map(|folder| ProgramFolder::Folder(PathBuf::from(folder)))
        .collect();
    // npm puts a global command in its prefix's `bin`.
    if let Some(prefix) = read_npm_prefix(read_variable) {
        folders.push(ProgramFolder::Folder(prefix.join("bin")));
    }
    folders.push(ProgramFolder::Folder(home.join(".npm-global/bin")));
    folders.push(ProgramFolder::EachVersion {
        versions: folder_or_default("NVM_DIR", home.join(".nvm")).join("versions/node"),
        child: "bin",
    });
    if let Some(multishell) = read_variable("FNM_MULTISHELL_PATH") {
        folders.push(ProgramFolder::Folder(PathBuf::from(multishell).join("bin")));
    }
    folders.push(ProgramFolder::Folder(
        folder_or_default("FNM_DIR", home.join(".local/share/fnm")).join("aliases/default/bin"),
    ));
    folders.push(ProgramFolder::Folder(
        folder_or_default("VOLTA_HOME", home.join(".volta")).join("bin"),
    ));
    folders.push(ProgramFolder::Folder(home.join(".bun/bin")));
    folders.extend(pnpm_folders(folder_or_default(
        "PNPM_HOME",
        home.join(pnpm_home),
    )));
    folders
}

// The folders on Windows, where npm's prefix holds its commands itself.
#[cfg(windows)]
fn windows_program_install_folders(
    home: &Path,
    read_variable: &dyn Fn(&str) -> Option<String>,
) -> Vec<ProgramFolder> {
    let folder_or_default =
        |name: &str, default: PathBuf| read_variable(name).map_or(default, PathBuf::from);
    let app_data = folder_or_default("APPDATA", home.join(r"AppData\Roaming"));
    let local_app_data = folder_or_default("LOCALAPPDATA", home.join(r"AppData\Local"));
    let mut folders = Vec::new();
    if let Some(prefix) = read_npm_prefix(read_variable) {
        folders.push(ProgramFolder::Folder(prefix));
    }
    folders.push(ProgramFolder::Folder(app_data.join("npm")));
    folders.extend(pnpm_folders(folder_or_default(
        "PNPM_HOME",
        local_app_data.join("pnpm"),
    )));
    folders.push(ProgramFolder::Folder(
        local_app_data.join(r"Programs\nodejs"),
    ));
    if let Some(symlink) = read_variable("NVM_SYMLINK") {
        folders.push(ProgramFolder::Folder(PathBuf::from(symlink)));
    }
    folders.push(ProgramFolder::Folder(
        folder_or_default("SCOOP", home.join("scoop")).join("shims"),
    ));
    folders.push(ProgramFolder::Folder(home.join(r".bun\bin")));
    folders
}

// npm's prefix, as either spelling of its variable sets it.
fn read_npm_prefix(read_variable: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    read_variable("npm_config_prefix")
        .or_else(|| read_variable("NPM_CONFIG_PREFIX"))
        .map(PathBuf::from)
}

// pnpm's command folders under its home: the `bin` folder pnpm 11 puts a global command in, then
// the home itself, where earlier releases put it.
fn pnpm_folders(pnpm_home: PathBuf) -> [ProgramFolder; 2] {
    [
        ProgramFolder::Folder(pnpm_home.join("bin")),
        ProgramFolder::Folder(pnpm_home),
    ]
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{ProgramFolder, program_install_folders};

    fn folder(path: &str) -> ProgramFolder {
        ProgramFolder::Folder(PathBuf::from(path))
    }

    // Fails when a set variable does not move its manager's folder, when pnpm's `bin` folder is
    // missing, or when an unset prefix leaves an empty folder in the list.
    #[test]
    fn program_install_folders_follow_the_managers_variables() {
        let home = Path::new("/Users/person");
        let set = |name: &str| match name {
            "NVM_DIR" => Some("/opt/nvm".to_owned()),
            "PNPM_HOME" => Some("/opt/pnpm".to_owned()),
            "npm_config_prefix" => Some("/opt/npm".to_owned()),
            _ => None,
        };

        let with_variables = program_install_folders(home, set);
        let without = program_install_folders(home, |_| None);

        assert_eq!(
            with_variables,
            vec![
                folder("/opt/homebrew/bin"),
                folder("/usr/local/bin"),
                folder("/opt/npm/bin"),
                folder("/Users/person/.npm-global/bin"),
                ProgramFolder::EachVersion {
                    versions: PathBuf::from("/opt/nvm/versions/node"),
                    child: "bin",
                },
                folder("/Users/person/.local/share/fnm/aliases/default/bin"),
                folder("/Users/person/.volta/bin"),
                folder("/Users/person/.bun/bin"),
                folder("/opt/pnpm/bin"),
                folder("/opt/pnpm"),
            ]
        );
        assert_eq!(without.len(), with_variables.len() - 1);
        assert_eq!(without.last(), Some(&folder("/Users/person/Library/pnpm")));
        assert!(without.contains(&folder("/Users/person/Library/pnpm/bin")));
    }
}
