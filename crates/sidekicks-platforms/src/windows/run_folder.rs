//! The daemon's run folder on Windows: `%LOCALAPPDATA%\ai-sidekicks\run`, read through the known
//! folder, holding the session token, beside the person's own named pipe, and checked to be
//! private before a client writes its first byte, since a folder another account could write to
//! could hold a token of its own.

use std::fs::OpenOptions;
use std::io;
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, READ_CONTROL,
};
use windows_sys::Win32::UI::Shell::FOLDERID_LocalAppData;

use crate::run_folder::{
    DaemonRunFolder, RUN_FOLDER_NAME, RunFolderRefused, SERVICE_STATUS_FILE_NAME,
    SESSION_TOKEN_FILE_NAME,
};
use crate::windows::folder_security::{FolderSecurity, is_admitted};
use crate::windows::known_folder::known_folder;
use crate::windows::private_folder::create_private_folder;
use crate::windows::process_user::{ProcessUser, read_user_sid_text};

// The run folder's name inside the application's own folder.
const RUN_SUBFOLDER_NAME: &str = "run";

/// The mode a file in the run folder is made with; unused on Windows, where the folder's access
/// list keeps it the person's own.
pub const RUN_FOLDER_FILE_MODE: u32 = 0o600;

/// The run folder of this process's user, under the user's local application data folder, and the
/// user's own named pipe. Fails with the system's error when that folder or the user's id cannot
/// be read.
pub fn daemon_run_folder() -> io::Result<DaemonRunFolder> {
    Ok(resolve_daemon_run_folder(
        &known_folder(&FOLDERID_LocalAppData)?,
        &read_user_sid_text()?,
    ))
}

/// Makes the run folder at `folder` and every missing folder above it; the run folder's check
/// refuses a reparse point, so a link is refused there. Fails with the system's error from the
/// make.
pub fn create_private_run_folder(folder: &Path) -> io::Result<()> {
    create_private_folder(folder)
}

/// The run folder under the local application data folder `local_app_data`, and the named pipe of
/// the user whose id, as SDDL text, is `user_sid`.
pub(crate) fn resolve_daemon_run_folder(local_app_data: &Path, user_sid: &str) -> DaemonRunFolder {
    let folder_path = local_app_data
        .join(RUN_FOLDER_NAME)
        .join(RUN_SUBFOLDER_NAME);
    DaemonRunFolder {
        socket_path: PathBuf::from(format!(r"\\.\pipe\{RUN_FOLDER_NAME}-{user_sid}")),
        token_path: folder_path.join(SESSION_TOKEN_FILE_NAME),
        status_path: folder_path.join(SERVICE_STATUS_FILE_NAME),
        folder_path,
    }
}

/// Checks that the run folder at `folder` is private: opened without following a link, it is a
/// folder, owned by this process's user, SYSTEM or the Administrators (who own what an elevated
/// process makes), whose access list lets in no account but those three. Fails with
/// [`RunFolderRefused::Read`] when it cannot be read, [`RunFolderRefused::NotOwnFolder`] for a
/// link, a file or a folder owned by an account that may not hold it, and
/// [`RunFolderRefused::OpenToAccount`] for one that lets another account in.
pub fn check_private_run_folder(folder: &Path) -> Result<(), RunFolderRefused> {
    let read_error = |source: io::Error| RunFolderRefused::Read {
        folder: folder.to_path_buf(),
        source,
    };
    let not_own_folder = || RunFolderRefused::NotOwnFolder {
        folder: folder.to_path_buf(),
    };
    let opened = OpenOptions::new()
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(folder)
        .map_err(read_error)?;
    let metadata = opened.metadata().map_err(read_error)?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(not_own_folder());
    }
    let security = FolderSecurity::read(&opened).map_err(read_error)?;
    let user = ProcessUser::of_this_process().map_err(read_error)?;
    if !is_admitted(&user, security.owner) {
        return Err(not_own_folder());
    }
    match security.first_other_account(&user).map_err(read_error)? {
        None => Ok(()),
        Some(account) => Err(RunFolderRefused::OpenToAccount {
            folder: folder.to_path_buf(),
            account,
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    use rstest::rstest;

    use super::{check_private_run_folder, resolve_daemon_run_folder};
    use crate::run_folder::RunFolderRefused;
    use crate::windows::folder_security::change_access_list;
    use crate::windows::process_user::read_user_sid_text;

    #[test]
    fn admits_a_private_folder_and_refuses_a_junction_to_it_and_one_open_to_everyone() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder = scratch.path().join("run");
        std::fs::create_dir(&folder).expect("the folder is made");
        // Only this user, its inherited entries removed, as the daemon makes the folder.
        let user = read_user_sid_text().expect("this user's id reads");
        change_access_list(
            &folder,
            &["/inheritance:r", "/grant:r", &format!("*{user}:(OI)(CI)F")],
        );
        let junction = scratch.path().join("junction");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&folder)
            .stdout(Stdio::null())
            .status()
            .expect("cmd starts");
        assert!(status.success(), "mklink exits with {status}");

        check_private_run_folder(&folder).expect("a private folder is admitted");
        let junction_refusal =
            check_private_run_folder(&junction).expect_err("a junction is refused");
        // SYSTEM (`S-1-5-18`) and the Administrators (`S-1-5-32-544`) may hold the folder too.
        change_access_list(
            &folder,
            &["/grant", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"],
        );
        check_private_run_folder(&folder)
            .expect("a folder SYSTEM and the Administrators may reach is admitted");
        // Everyone (`S-1-1-0`) may read the folder.
        change_access_list(&folder, &["/grant", "*S-1-1-0:(R)"]);
        let open_refusal =
            check_private_run_folder(&folder).expect_err("a folder open to everyone is refused");

        assert!(
            matches!(junction_refusal, RunFolderRefused::NotOwnFolder { .. }),
            "{junction_refusal:?}"
        );
        assert!(
            matches!(
                &open_refusal,
                RunFolderRefused::OpenToAccount { account, .. } if account == "S-1-1-0"
            ),
            "{open_refusal:?}"
        );
    }

    #[rstest]
    #[case::the_local_application_data_folder(
        r"C:\Users\Ada\AppData\Local",
        r"C:\Users\Ada\AppData\Local\ai-sidekicks\run"
    )]
    #[case::one_with_a_trailing_backslash(
        r"D:\Profiles\Ada\Local\",
        r"D:\Profiles\Ada\Local\ai-sidekicks\run"
    )]
    fn resolves_the_folder_under_local_application_data_and_the_pipe_from_the_sid(
        #[case] local_app_data: &str,
        #[case] folder: &str,
    ) {
        let sid = "S-1-5-21-1004336348-1177238915-682003330-1001";

        let resolved = resolve_daemon_run_folder(Path::new(local_app_data), sid);

        assert_eq!(resolved.folder_path, PathBuf::from(folder));
        assert_eq!(
            resolved.socket_path,
            PathBuf::from(format!(r"\\.\pipe\ai-sidekicks-{sid}"))
        );
        assert_eq!(
            resolved.token_path,
            PathBuf::from(format!(r"{folder}\daemon.token"))
        );
        assert_eq!(
            resolved.status_path,
            PathBuf::from(format!(r"{folder}\service-status.json"))
        );
    }
}
