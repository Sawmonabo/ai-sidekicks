//! The daemon's run folder on Windows: `%LOCALAPPDATA%\ai-sidekicks\run`, read through the known
//! folder, holding the session token, beside the person's own named pipe, and checked to be
//! private before a client writes its first byte, since a folder another account could write to
//! could hold a token of its own.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::os::windows::io::AsRawHandle as _;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{ERROR_SUCCESS, FALSE, LocalFree};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, GetAce, INHERIT_ONLY_ACE,
    IsWellKnownSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, READ_CONTROL,
};
use windows_sys::Win32::System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE};
use windows_sys::Win32::UI::Shell::FOLDERID_LocalAppData;

use crate::run_folder::{
    DaemonRunFolder, RUN_FOLDER_NAME, RunFolderRefused, SESSION_TOKEN_FILE_NAME,
};
use crate::windows::known_folder::known_folder;
use crate::windows::process_user::{ProcessUser, read_user_sid_text, sid_text};

// The run folder's name inside the application's own folder.
const RUN_SUBFOLDER_NAME: &str = "run";

/// The run folder of this process's user, under the user's local application data folder, and the
/// user's own named pipe. Fails with the system's error when that folder or the user's id cannot
/// be read.
pub fn daemon_run_folder() -> io::Result<DaemonRunFolder> {
    Ok(resolve_daemon_run_folder(
        &known_folder(&FOLDERID_LocalAppData)?,
        &read_user_sid_text()?,
    ))
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
        folder_path,
    }
}

/// Checks that the run folder at `folder` is private: opened without following a link, it is a
/// folder, owned by this process's user, SYSTEM or the Administrators (who own what an elevated
/// process makes), whose access list lets in no account but those three. Fails with
/// [`RunFolderRefused::Read`] when it cannot be read, [`RunFolderRefused::NotOwnFolder`] for a
/// link, a file or another account's folder, and [`RunFolderRefused::OpenToAccount`] for one that
/// lets another account in.
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

/// A folder's owner and access list, which point into the security descriptor it holds and frees
/// on drop.
struct FolderSecurity {
    owner: PSID,
    access_list: *mut ACL,
    descriptor: PSECURITY_DESCRIPTOR,
}

impl FolderSecurity {
    // The owner and access list of the folder `opened`.
    fn read(opened: &File) -> io::Result<Self> {
        let mut owner: PSID = std::ptr::null_mut();
        let mut access_list: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: the handle is open with `READ_CONTROL`, and the call writes the owner and access
        // list pointers into the descriptor it allocates, which `Drop` frees.
        let status = unsafe {
            GetSecurityInfo(
                opened.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &raw mut owner,
                std::ptr::null_mut(),
                &raw mut access_list,
                std::ptr::null_mut(),
                &raw mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status.cast_signed()));
        }
        Ok(Self {
            owner,
            access_list,
            descriptor,
        })
    }

    // The first account the access list lets in other than `user`, SYSTEM and the
    // Administrators, as SDDL text, or the kind of an allowing entry that names no plain account;
    // a missing access list lets everyone in. Entries that only pass to what the folder holds, and
    // entries that deny, let no one into the folder itself.
    fn first_other_account(&self, user: &ProcessUser) -> io::Result<Option<String>> {
        if self.access_list.is_null() {
            return Ok(Some("everyone, as it has no access list".to_owned()));
        }
        // SAFETY: the access list lives in the descriptor this value holds.
        let entry_count = unsafe { (*self.access_list).AceCount };
        for index in 0..entry_count {
            let mut entry: *mut std::ffi::c_void = std::ptr::null_mut();
            // SAFETY: the index is below the list's count, and the call writes a pointer into the
            // list.
            if unsafe { GetAce(self.access_list, u32::from(index), &raw mut entry) } == FALSE {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: every entry starts with its header.
            let header = unsafe { *entry.cast::<ACE_HEADER>() };
            if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0
                || u32::from(header.AceType) == ACCESS_DENIED_ACE_TYPE
            {
                continue;
            }
            if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE {
                return Ok(Some(format!("an access entry of type {}", header.AceType)));
            }
            // SAFETY: an allowing entry's id starts at its `SidStart` member, inside the entry.
            let sid: PSID =
                unsafe { (&raw mut (*entry.cast::<ACCESS_ALLOWED_ACE>()).SidStart) }.cast();
            if !is_admitted(user, sid) {
                return sid_text(sid).map(Some);
            }
        }
        Ok(None)
    }
}

impl Drop for FolderSecurity {
    fn drop(&mut self) {
        // SAFETY: the descriptor came from `GetSecurityInfo`, which allocated it with
        // `LocalAlloc`.
        unsafe { LocalFree(self.descriptor) };
    }
}

// Whether `sid` is an account that may own the run folder or be let in: the user, SYSTEM or the
// Administrators.
fn is_admitted(user: &ProcessUser, sid: PSID) -> bool {
    let is_well_known = |kind| {
        // SAFETY: `sid` points at a live id inside the folder's security descriptor.
        let is_kind = unsafe { IsWellKnownSid(sid, kind) };
        is_kind != FALSE
    };
    user.has_sid(sid)
        || is_well_known(WinLocalSystemSid)
        || is_well_known(WinBuiltinAdministratorsSid)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use super::resolve_daemon_run_folder;

    // The case table desktop main's resolver runs too, so the two cannot drift.
    const CASES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../sidekicks-contracts/tests/fixtures/run-folder.json"
    ));

    #[test]
    fn resolves_every_windows_case_of_the_shared_table() {
        let cases: Vec<Value> = serde_json::from_str(CASES).expect("the case table parses");
        let windows_cases: Vec<&Value> = cases
            .iter()
            .filter(|case| case.get("userSid").is_some())
            .collect();
        assert_eq!(windows_cases.len(), 2, "the shared table's Windows cases");
        for case in windows_cases {
            let text = |name: &str| case[name].as_str().expect("a case's member is text");

            let resolved =
                resolve_daemon_run_folder(Path::new(text("localAppData")), text("userSid"));

            assert_eq!(
                resolved.folder_path,
                PathBuf::from(text("folderPath")),
                "{}",
                case["case"]
            );
            assert_eq!(resolved.socket_path, PathBuf::from(text("socketPath")));
            assert_eq!(resolved.token_path, PathBuf::from(text("tokenPath")));
        }
    }
}
