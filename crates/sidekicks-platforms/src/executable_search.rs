//! The search a shell makes for the executable a command names, along a child's own environment
//! rather than the daemon's, and the person's own programs folder a provider's installer may put
//! its command under.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use windows_sys::Win32::UI::Shell::FOLDERID_UserProgramFiles;

use crate::path::rules::PathRules;
#[cfg(unix)]
use crate::posix::executable_file::is_executable_file;
#[cfg(windows)]
use crate::windows::executable_file::is_executable_file;
#[cfg(windows)]
use crate::windows::known_folder::known_folder;

// The extensions cmd.exe tries when the environment sets no `PATHEXT`.
const DEFAULT_PATH_EXTENSIONS: [&str; 4] = [".COM", ".EXE", ".BAT", ".CMD"];

/// Each path where `command` names an executable file, in the order a shell tries them, read from
/// `environment`, the child's own: a command the system reads as a path is joined onto
/// `working_folder`; a bare one is searched along the environment's `PATH`, a relative entry
/// joined onto `working_folder` as `execvp` resolves it from the child's own folder (an empty
/// folder leaving it relative), every entry under one of `skipped_folders` passed over (the WSL
/// server passes the Windows drive mounts it read, so its search stays inside the distribution;
/// every other caller passes none). No file is examined until the iterator is advanced, and each
/// step reads the file system, so it runs on the daemon's spawner thread or in `spawn_blocking`.
pub fn find_executables<'a>(
    command: &'a str,
    environment: &'a [(String, String)],
    working_folder: &'a Path,
    skipped_folders: &'a [PathBuf],
) -> impl Iterator<Item = PathBuf> + 'a {
    find_executables_with_rules(
        PathRules::NATIVE,
        command,
        environment,
        working_folder,
        skipped_folders,
    )
}

/// The person's own programs folder a provider's installer may put its command under: on Windows
/// the known folder `%LOCALAPPDATA%\Programs`, or `AppData\Local\Programs` under the home folder
/// when the system cannot report it; `None` on macOS and Linux, which have none, and where neither
/// the known folder nor the home folder reads.
pub fn user_programs_folder() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        match known_folder(&FOLDERID_UserProgramFiles) {
            Ok(folder) => Some(folder),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the person's programs folder could not be read; the one under the home \
                     folder is used"
                );
                std::env::home_dir().map(|home| home.join(r"AppData\Local\Programs"))
            }
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Whether the system reads `command` as a path, absolute or holding a separator, which a search
/// takes as typed, rather than a bare name it looks up along `PATH`.
pub fn is_path_command(command: &str) -> bool {
    is_path_command_with_rules(PathRules::NATIVE, command)
}

fn is_path_command_with_rules(rules: PathRules, command: &str) -> bool {
    rules.is_absolute(command)
        || command
            .chars()
            .any(|character| rules.is_separator(character))
}

fn find_executables_with_rules<'a>(
    rules: PathRules,
    command: &'a str,
    environment: &'a [(String, String)],
    working_folder: &'a Path,
    skipped_folders: &'a [PathBuf],
) -> impl Iterator<Item = PathBuf> + 'a {
    let search_roots: Vec<PathBuf> = if is_path_command_with_rules(rules, command) {
        vec![working_folder.join(command)]
    } else {
        rules
            .environment_value(environment, "PATH")
            .unwrap_or_default()
            .split(rules.search_path_separator())
            .filter(|entry| !entry.is_empty())
            .map(|entry| working_folder.join(entry))
            .filter(|entry| {
                !skipped_folders
                    .iter()
                    .any(|skipped| entry.starts_with(skipped))
            })
            .map(|entry| entry.join(command))
            .collect()
    };
    let path_extensions = match rules {
        PathRules::Posix => Vec::new(),
        PathRules::Windows => read_path_extensions(environment, rules),
    };
    search_roots
        .into_iter()
        .flat_map(move |root| list_candidates(rules, root, &path_extensions))
        .filter(|candidate| is_executable_file(candidate))
}

// The extensions `PATHEXT` lists, trimmed, or cmd.exe's own where it lists none.
fn read_path_extensions(environment: &[(String, String)], rules: PathRules) -> Vec<String> {
    let listed: Vec<String> = rules
        .environment_value(environment, "PATHEXT")
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|extension| !extension.is_empty())
        .map(str::to_owned)
        .collect();
    if listed.is_empty() {
        DEFAULT_PATH_EXTENSIONS
            .into_iter()
            .map(str::to_owned)
            .collect()
    } else {
        listed
    }
}

// The files a shell tries for `root`, in order: on macOS and Linux the root alone; on Windows a
// name with an extension as written first and then through `PATHEXT`, a name without one through
// `PATHEXT` first and bare last.
fn list_candidates(rules: PathRules, root: PathBuf, path_extensions: &[String]) -> Vec<PathBuf> {
    match rules {
        PathRules::Posix => vec![root],
        PathRules::Windows => {
            let mut candidates: Vec<PathBuf> = path_extensions
                .iter()
                .map(|extension| {
                    let mut candidate = OsString::from(root.as_os_str());
                    candidate.push(extension);
                    PathBuf::from(candidate)
                })
                .collect();
            if root.extension().is_none() {
                candidates.push(root);
            } else {
                candidates.insert(0, root);
            }
            candidates
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use super::find_executables;

    // Writes a file at `path`, its folders made, with the permission bits `mode`.
    fn write_program(path: &Path, mode: u32) {
        fs::create_dir_all(path.parent().expect("the program sits in a folder"))
            .expect("the folder is made");
        fs::write(path, "#!/bin/sh\n").expect("the program is written");
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("the mode is set");
    }

    fn search_path(folders: &[&Path]) -> Vec<(String, String)> {
        let joined = folders
            .iter()
            .map(|folder| folder.to_str().expect("the temporary folder is UTF-8"))
            .collect::<Vec<_>>()
            .join(":");
        vec![("PATH".to_owned(), joined)]
    }

    // Kills: dropping the `X_OK` check (the plain `a/tool` would come first), and yielding every
    // candidate unprobed (likewise).
    #[test]
    fn find_executables_passes_over_a_file_without_the_execute_bit() {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let folders = ["a", "b", "c"].map(|name| root.path().join(name));
        write_program(&folders[0].join("tool"), 0o644);
        write_program(&folders[1].join("tool"), 0o755);
        write_program(&folders[2].join("tool"), 0o755);
        let environment = search_path(&folders.each_ref().map(PathBuf::as_path));

        let first = find_executables("tool", &environment, root.path(), &[]).next();

        assert_eq!(first, Some(folders[1].join("tool")));
    }

    // Kills: ignoring `skipped_folders` (the mount's `tool` would come first).
    #[test]
    fn find_executables_passes_over_a_skipped_folder() {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let mounted = root.path().join("mnt/c/bin");
        let own = root.path().join("real/bin");
        write_program(&mounted.join("tool"), 0o755);
        write_program(&own.join("tool"), 0o755);
        let environment = search_path(&[mounted.as_path(), own.as_path()]);
        let skipped = [root.path().join("mnt/c")];

        let first = find_executables("tool", &environment, root.path(), &skipped).next();

        assert_eq!(first, Some(own.join("tool")));
    }

    // Kills: checking a relative entry from the test's own folder, where no `tool` sits.
    #[test]
    fn find_executables_joins_a_relative_entry_onto_the_working_folder() {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        write_program(&root.path().join("node_modules/.bin/tool"), 0o755);
        let environment = vec![("PATH".to_owned(), "node_modules/.bin".to_owned())];

        let first = find_executables("tool", &environment, root.path(), &[]).next();

        assert_eq!(first, Some(root.path().join("node_modules/.bin/tool")));
    }
}
