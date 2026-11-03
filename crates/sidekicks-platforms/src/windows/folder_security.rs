//! A folder's owner and access list on Windows, read through a handle open on it, and the accounts
//! a private folder of the user's may be owned by or let in.

use std::fs::File;
use std::io;
use std::os::windows::io::AsRawHandle as _;

use windows_sys::Win32::Foundation::{ERROR_SUCCESS, FALSE, LocalFree};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, GetAce, INHERIT_ONLY_ACE,
    IsWellKnownSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows_sys::Win32::System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE};

use crate::windows::process_user::{ProcessUser, sid_text};

/// A folder's owner and access list, which point into the security descriptor it holds and frees
/// on drop.
pub(crate) struct FolderSecurity {
    /// The folder's owner, alive as long as this value.
    pub(crate) owner: PSID,
    access_list: *mut ACL,
    descriptor: PSECURITY_DESCRIPTOR,
}

impl FolderSecurity {
    /// The owner and access list of the folder `opened`, a handle open with `READ_CONTROL`. Fails
    /// with the system's error from the read.
    pub(crate) fn read(opened: &File) -> io::Result<Self> {
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

    /// The first account the access list lets in other than `user`, SYSTEM and the
    /// Administrators, as SDDL text, or the kind of an allowing entry that names no plain account;
    /// a missing access list lets everyone in. Entries that only pass to what the folder holds, and
    /// entries that deny, let no one into the folder itself. Fails with the system's error from an
    /// entry's read.
    pub(crate) fn first_other_account(&self, user: &ProcessUser) -> io::Result<Option<String>> {
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

/// Whether `sid` is an account that may own a private folder of the user's or be let in: the
/// user, SYSTEM or the Administrators (who own what an elevated process makes).
pub(crate) fn is_admitted(user: &ProcessUser, sid: PSID) -> bool {
    let is_well_known = |kind| {
        // SAFETY: `sid` points at a live id inside the folder's security descriptor.
        let is_kind = unsafe { IsWellKnownSid(sid, kind) };
        is_kind != FALSE
    };
    user.has_sid(sid)
        || is_well_known(WinLocalSystemSid)
        || is_well_known(WinBuiltinAdministratorsSid)
}

/// Runs `icacls` on `folder` with `arguments`, which change its access list; panics when it fails.
#[cfg(test)]
pub(crate) fn change_access_list(folder: &std::path::Path, arguments: &[&str]) {
    use std::process::{Command, Stdio};

    let status = Command::new("icacls")
        .arg(folder)
        .args(arguments)
        .stdout(Stdio::null())
        .status()
        .expect("icacls starts");
    assert!(status.success(), "icacls {arguments:?} exits with {status}");
}
