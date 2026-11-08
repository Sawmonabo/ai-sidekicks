//! The daemon's run folder on macOS and Linux: resolved from the home folder and, on Linux, the
//! session's runtime folder, as desktop main resolves it, and checked to be private before the
//! daemon binds and before a client writes its first byte, since a folder another account made
//! could hold a stand-in socket and a token of its own.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use nix::unistd::getuid;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;

use crate::posix::private_folder::create_private_folder;
use crate::run_folder::{
    DaemonRunFolder, RUN_FOLDER_NAME, RunFolderRefused, SERVICE_STATUS_FILE_NAME,
    SESSION_TOKEN_FILE_NAME,
};

// The local socket's file name in the run folder.
const SOCKET_FILE_NAME: &str = "daemon.sock";

// The run folder's name inside the service's data folder.
const RUN_SUBFOLDER_NAME: &str = "run";

// The permission bits of the folder's group and other accounts.
const OTHERS_PERMISSION_BITS: u32 = 0o077;

/// The mode a file in the run folder is made with, less the umask: the person's alone, and on
/// Linux also sticky, which tells a session manager that cleans the runtime folder to keep it.
#[cfg(target_os = "linux")]
pub const RUN_FOLDER_FILE_MODE: u32 = 0o1600;

/// The mode a file in the run folder is made with, less the umask: the person's alone.
#[cfg(target_os = "macos")]
pub const RUN_FOLDER_FILE_MODE: u32 = 0o600;

/// The run folder of this process's user, from its home folder and environment. Fails with
/// `NotFound` when no home folder is known.
pub fn daemon_run_folder() -> io::Result<DaemonRunFolder> {
    let home = std::env::home_dir().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "this account has no home folder")
    })?;
    Ok(resolve_daemon_run_folder(
        |name| std::env::var_os(name),
        &home,
    ))
}

/// Makes the run folder at `folder`, and every missing folder above it, readable by its owner
/// alone. Fails with `InvalidInput` when `folder` is a link, before anything is made or changed, so
/// no mode lands on the link's target, and with the system's error from the make or the mode
/// change.
pub fn create_private_run_folder(folder: &Path) -> io::Result<()> {
    match fs::symlink_metadata(folder) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is a link, so it is not made private", folder.display()),
            ));
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    create_private_folder(folder)
}

/// Checks that the run folder at `folder` is private: read without following a link, it is a
/// folder, owned by this process's user, with no group or other permission bit. Fails with
/// [`RunFolderRefused::Read`] when it cannot be read, [`RunFolderRefused::NotOwnFolder`] for a
/// link, a file or another account's folder, and [`RunFolderRefused::OpenToOthers`] for an open
/// one.
pub fn check_private_run_folder(folder: &Path) -> Result<(), RunFolderRefused> {
    let metadata = fs::symlink_metadata(folder).map_err(|source| RunFolderRefused::Read {
        folder: folder.to_path_buf(),
        source,
    })?;
    if !metadata.is_dir() || metadata.uid() != getuid().as_raw() {
        return Err(RunFolderRefused::NotOwnFolder {
            folder: folder.to_path_buf(),
        });
    }
    let mode = metadata.permissions().mode();
    if mode & OTHERS_PERMISSION_BITS != 0 {
        return Err(RunFolderRefused::OpenToOthers {
            folder: folder.to_path_buf(),
            mode: mode & 0o777,
        });
    }
    Ok(())
}

/// The run folder under the home folder `home`, with the environment read through
/// `read_variable`: on Linux `$XDG_RUNTIME_DIR/ai-sidekicks` when it is set and not empty, else
/// `<home>/.ai-sidekicks/run`; on macOS always the latter, since nothing cleans it there.
pub(crate) fn resolve_daemon_run_folder(
    read_variable: impl Fn(&str) -> Option<OsString>,
    home: &Path,
) -> DaemonRunFolder {
    let runtime_folder = read_variable("XDG_RUNTIME_DIR").filter(|value| !value.is_empty());
    let folder_path = match runtime_folder {
        Some(runtime_folder) if cfg!(target_os = "linux") => {
            join_name(runtime_folder, RUN_FOLDER_NAME)
        }
        _ => {
            join_name(home.as_os_str().to_owned(), DAEMON_DATA_FOLDER_NAME).join(RUN_SUBFOLDER_NAME)
        }
    };
    DaemonRunFolder {
        socket_path: folder_path.join(SOCKET_FILE_NAME),
        token_path: folder_path.join(SESSION_TOKEN_FILE_NAME),
        status_path: folder_path.join(SERVICE_STATUS_FILE_NAME),
        folder_path,
    }
}

// `folder`, with one trailing `/` removed when it is longer than one byte, then `/` and `name`,
// byte for byte as desktop main joins them.
fn join_name(folder: OsString, name: &str) -> PathBuf {
    let mut bytes = folder.into_vec();
    if bytes.len() > 1 && bytes.last() == Some(&b'/') {
        bytes.pop();
    }
    bytes.push(b'/');
    bytes.extend_from_slice(name.as_bytes());
    PathBuf::from(OsString::from_vec(bytes))
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::fs::{self, Permissions};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::Path;

    use rstest::rstest;
    use serde::Deserialize;

    use super::{check_private_run_folder, create_private_run_folder, resolve_daemon_run_folder};
    use crate::run_folder::RunFolderRefused;

    fn mode_of(folder: &Path) -> u32 {
        fs::symlink_metadata(folder)
            .expect("the folder reads")
            .permissions()
            .mode()
            & 0o777
    }

    /// The run-folder table the TypeScript resolver's suite reads too.
    const CASES: &str = include_str!("../../../sidekicks-contracts/tests/fixtures/run-folder.json");

    /// A system, its runtime-folder variable (`null` where unset), the home folder and the run
    /// folder they resolve.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct PosixCase {
        system: System,
        runtime_folder: Option<String>,
        home: String,
        folder: String,
    }

    /// The system a case resolves on, in Node's spelling.
    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "lowercase")]
    enum System {
        Linux,
        Darwin,
    }

    /// The table's macOS and Linux half.
    #[derive(Deserialize)]
    struct RunFolderCases {
        posix: Vec<PosixCase>,
    }

    #[test]
    fn resolves_the_runtime_folder_on_linux_and_the_home_folder_otherwise() {
        let cases: RunFolderCases = serde_json::from_str(CASES).expect("the cases read");
        let system = if cfg!(target_os = "linux") {
            System::Linux
        } else {
            System::Darwin
        };
        let cases: Vec<PosixCase> = cases
            .posix
            .into_iter()
            .filter(|case| case.system == system)
            .collect();
        assert!(!cases.is_empty(), "the table holds cases for {system:?}");

        for case in cases {
            let resolved = resolve_daemon_run_folder(
                |name| {
                    (name == "XDG_RUNTIME_DIR")
                        .then(|| case.runtime_folder.clone())
                        .flatten()
                        .map(OsString::from)
                },
                Path::new(&case.home),
            );

            // Compared as bytes: a path's own equality ignores a doubled or trailing `/`.
            let folder = &case.folder;
            let context = format!("{:?} under {}", case.runtime_folder, case.home);
            assert_eq!(
                resolved.folder_path.as_os_str(),
                OsStr::new(folder),
                "{context}"
            );
            assert_eq!(
                resolved.socket_path.as_os_str(),
                OsStr::new(&format!("{folder}/daemon.sock")),
                "{context}"
            );
            assert_eq!(
                resolved.token_path.as_os_str(),
                OsStr::new(&format!("{folder}/daemon.token")),
                "{context}"
            );
            assert_eq!(
                resolved.status_path.as_os_str(),
                OsStr::new(&format!("{folder}/service-status.json")),
                "{context}"
            );
        }
    }

    #[rstest]
    #[case::open_to_the_group(0o750)]
    #[case::open_to_others(0o701)]
    fn refuses_a_folder_open_to_other_accounts(#[case] mode: u32) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder = scratch.path().join("run");
        fs::create_dir(&folder).expect("the folder is made");
        fs::set_permissions(&folder, Permissions::from_mode(mode)).expect("the mode is set");

        let refusal = check_private_run_folder(&folder).expect_err("an open folder is refused");

        assert!(
            matches!(
                refusal,
                RunFolderRefused::OpenToOthers { mode: refused, .. } if refused == mode
            ),
            "{refusal:?}"
        );
    }

    #[test]
    fn admits_a_private_folder_and_refuses_a_link_to_it_and_a_file() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder = scratch.path().join("run");
        fs::create_dir(&folder).expect("the folder is made");
        fs::set_permissions(&folder, Permissions::from_mode(0o700)).expect("the mode is set");
        let link = scratch.path().join("link");
        symlink(&folder, &link).expect("the link is made");
        let file = scratch.path().join("file");
        fs::write(&file, b"").expect("the file is made");
        fs::set_permissions(&file, Permissions::from_mode(0o600)).expect("the mode is set");

        check_private_run_folder(&folder).expect("a private folder is admitted");
        let link_refusal = check_private_run_folder(&link).expect_err("a link is refused");
        let file_refusal = check_private_run_folder(&file).expect_err("a file is refused");

        assert!(
            matches!(link_refusal, RunFolderRefused::NotOwnFolder { .. }),
            "{link_refusal:?}"
        );
        assert!(
            matches!(file_refusal, RunFolderRefused::NotOwnFolder { .. }),
            "{file_refusal:?}"
        );
    }

    // Fails when the mode is set before the link is refused, so the link's target turns private.
    #[test]
    fn a_link_is_refused_and_its_target_keeps_its_mode() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let target = scratch.path().join("target");
        fs::create_dir(&target).expect("the target is made");
        fs::set_permissions(&target, Permissions::from_mode(0o755)).expect("the mode is set");
        let link = scratch.path().join("link");
        symlink(&target, &link).expect("the link is made");

        let refusal = create_private_run_folder(&link).expect_err("the link is refused");

        assert_eq!(refusal.kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(mode_of(&target), 0o755);
    }
}
