//! The daemon's run folder on macOS and Linux: resolved from the environment and the user id as
//! desktop main resolves it, and checked to be private before the daemon binds and before a client
//! writes its first byte, since a folder another account made could hold a stand-in socket and a
//! token of its own.

use std::ffi::OsString;
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use nix::unistd::getuid;

use crate::run_folder::{DaemonRunFolder, RunFolderRefused};

// The run folder's name inside `XDG_RUNTIME_DIR`, and the start of its name, before the user id,
// inside the temporary folder.
const RUN_FOLDER_NAME: &str = "ai-sidekicks";

const SOCKET_FILE_NAME: &str = "daemon.sock";
const SESSION_TOKEN_FILE_NAME: &str = "daemon.token";

// The temporary folder's variables, read in this order, and the folder where none is set.
const TEMPORARY_FOLDER_VARIABLES: [&str; 3] = ["TMPDIR", "TMP", "TEMP"];
const DEFAULT_TEMPORARY_FOLDER: &str = "/tmp";

// The permission bits of the folder's group and other accounts.
const OTHERS_PERMISSION_BITS: u32 = 0o077;

/// The run folder of this process's user, from its own environment. Never fails on macOS and
/// Linux.
pub fn daemon_run_folder() -> std::io::Result<DaemonRunFolder> {
    Ok(resolve_daemon_run_folder(
        |name| std::env::var_os(name),
        getuid().as_raw(),
    ))
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

/// The run folder of the user `user_id`, with the environment read through `read_variable`:
/// `$XDG_RUNTIME_DIR/ai-sidekicks` when it is set and not empty, else
/// `<temporary folder>/ai-sidekicks-<user_id>`, the temporary folder being the first of `TMPDIR`,
/// `TMP` and `TEMP` that is set and not empty, else `/tmp`; never `std::env::temp_dir()`.
pub(crate) fn resolve_daemon_run_folder(
    read_variable: impl Fn(&str) -> Option<OsString>,
    user_id: u32,
) -> DaemonRunFolder {
    let set_variable = |name: &str| read_variable(name).filter(|value| !value.is_empty());
    let folder_path = if let Some(runtime_folder) = set_variable("XDG_RUNTIME_DIR") {
        join_name(runtime_folder, RUN_FOLDER_NAME)
    } else {
        let temporary_folder = TEMPORARY_FOLDER_VARIABLES
            .iter()
            .find_map(|name| set_variable(name))
            .unwrap_or_else(|| OsString::from(DEFAULT_TEMPORARY_FOLDER));
        join_name(temporary_folder, &format!("{RUN_FOLDER_NAME}-{user_id}"))
    };
    DaemonRunFolder {
        socket_path: folder_path.join(SOCKET_FILE_NAME),
        token_path: folder_path.join(SESSION_TOKEN_FILE_NAME),
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
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::fs::{self, Permissions};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;

    use rstest::rstest;
    use serde_json::Value;

    use super::{check_private_run_folder, resolve_daemon_run_folder};
    use crate::run_folder::RunFolderRefused;

    // The case table desktop main's resolver runs too, so the two cannot drift.
    const CASES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../sidekicks-contracts/tests/fixtures/run-folder.json"
    ));

    #[test]
    fn resolves_every_case_of_the_shared_table() {
        let cases: Vec<Value> = serde_json::from_str(CASES).expect("the case table parses");
        assert_eq!(cases.len(), 7, "the shared table's cases");
        for case in cases {
            let environment: HashMap<String, OsString> = case["environment"]
                .as_object()
                .expect("a case's environment is an object")
                .iter()
                .map(|(name, value)| {
                    let value = value.as_str().expect("a variable's value is text");
                    (name.clone(), OsString::from(value))
                })
                .collect();
            let user_id = case["userId"]
                .as_u64()
                .and_then(|id| u32::try_from(id).ok())
                .expect("a case's user id is a u32");

            let resolved =
                resolve_daemon_run_folder(|name| environment.get(name).cloned(), user_id);

            let expected = PathBuf::from(case["folderPath"].as_str().expect("a folder path"));
            assert_eq!(resolved.folder_path, expected, "{}", case["case"]);
            assert_eq!(resolved.socket_path, expected.join("daemon.sock"));
            assert_eq!(resolved.token_path, expected.join("daemon.token"));
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
}
