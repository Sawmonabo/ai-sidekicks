//! The user a Windows process runs as, read from its token: this process's or another's by its id,
//! compared with another user's id, written as SDDL text (`S-1-5-21-…`), and made into the security
//! descriptor that lets this user alone open what it guards.

use std::ffi::{OsStr, c_void};
use std::io::{self, ErrorKind};
use std::os::windows::io::{
    AsHandle as _, AsRawHandle as _, BorrowedHandle, FromRawHandle as _, OwnedHandle,
};

use windows_sys::Win32::Foundation::{FALSE, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
#[cfg(test)]
use windows_sys::Win32::Security::{
    CreateWellKnownSid, SECURITY_MAX_SID_SIZE, WELL_KNOWN_SID_TYPE,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::windows::pinned_process::{current_process, open_process};
use crate::windows::wide_text::{read_wide_string, wide_text};

/// The user a process's token names, kept in the token's own record, which holds the user's id.
pub(crate) struct ProcessUser {
    // Eight-byte words keep the record aligned for its pointer.
    record: Vec<u64>,
}

impl ProcessUser {
    /// The user this process runs as. Fails with the system's error when its token cannot be read.
    pub(crate) fn of_this_process() -> io::Result<Self> {
        Self::of_process(current_process())
    }

    /// The user process `id` runs as, its token read with the least right that reads it. Fails
    /// with the system's error when the process cannot be opened or its token read.
    pub(crate) fn of_process_id(id: u32) -> io::Result<Self> {
        let process = open_process(id, PROCESS_QUERY_LIMITED_INFORMATION)?;
        Self::of_process(process.as_handle())
    }

    // The user the token of `process` names.
    fn of_process(process: BorrowedHandle<'_>) -> io::Result<Self> {
        let mut raw_token: HANDLE = std::ptr::null_mut();
        // SAFETY: the process handle is open, and the call writes a new token handle.
        if unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &raw mut raw_token) }
            == FALSE
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the handle was just opened and is owned by nothing else.
        let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
        let mut length = 0_u32;
        // SAFETY: a null buffer of length 0 asks only for the length, which the call writes.
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                std::ptr::null_mut(),
                0,
                &raw mut length,
            )
        };
        let mut record = vec![
            0_u64;
            usize::try_from(length)
                .map_err(io::Error::other)?
                .div_ceil(8)
        ];
        // SAFETY: the buffer is live, writable and at least `length` bytes long.
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                record.as_mut_ptr().cast(),
                length,
                &raw mut length,
            )
        } == FALSE
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { record })
    }

    /// The user's id, which points into this record and lives as long as it.
    pub(crate) fn sid(&self) -> PSID {
        // SAFETY: the call filled the aligned record with a `TOKEN_USER` and the id it points at.
        unsafe { (*self.record.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    /// The well-known account `kind` (`WinLocalSystemSid` and the like), built as a token's
    /// record holds a user, for a test that needs a user no process of this account runs as.
    #[cfg(test)]
    pub(crate) fn of_well_known_account(kind: WELL_KNOWN_SID_TYPE) -> Self {
        let header_words = size_of::<TOKEN_USER>().div_ceil(8);
        let sid_words = usize::try_from(SECURITY_MAX_SID_SIZE)
            .expect("the size fits")
            .div_ceil(8);
        let mut record = vec![0_u64; header_words + sid_words];
        let base = record.as_mut_ptr();
        // SAFETY: the id's room starts past the header, inside the record.
        let sid: PSID = unsafe { base.add(header_words) }.cast();
        let mut length = SECURITY_MAX_SID_SIZE;
        // SAFETY: the room is `SECURITY_MAX_SID_SIZE` bytes long, as `length` says, and a
        // well-known account needs no domain.
        let is_made =
            unsafe { CreateWellKnownSid(kind, std::ptr::null_mut(), sid, &raw mut length) };
        assert_ne!(is_made, FALSE, "the well-known account {kind} is made");
        // SAFETY: the record starts with room for a `TOKEN_USER`, aligned for its pointer; the id
        // it points at lives in the record's own heap buffer, which moves with the record.
        unsafe { (*base.cast::<TOKEN_USER>()).User.Sid = sid };
        Self { record }
    }

    /// Whether `sid` is this user's id.
    pub(crate) fn has_sid(&self, sid: PSID) -> bool {
        // SAFETY: both ids are valid: this one lives in the record, `sid` is the caller's.
        unsafe { EqualSid(self.sid(), sid) != FALSE }
    }
}

/// The id `sid` as SDDL text (`S-1-5-21-…`), the caller keeping it alive across the call. Fails
/// with the system's error when the id cannot be written.
pub(crate) fn sid_text(sid: PSID) -> io::Result<String> {
    let mut text: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: the id is live across the call, which writes a string it allocates, freed below.
    if unsafe { ConvertSidToStringSidW(sid, &raw mut text) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call answered a NUL-terminated wide string.
    let read = unsafe { read_wide_string(text) }
        .into_string()
        .map_err(|text| {
            io::Error::new(
                ErrorKind::InvalidData,
                format!("the user id {} is not text", text.display()),
            )
        });
    // SAFETY: the string came from the conversion, which allocated it with `LocalAlloc`.
    unsafe { LocalFree(text.cast::<c_void>()) };
    read
}

/// This process's user's id as SDDL text (`S-1-5-21-…`). Fails with the system's error when its
/// token cannot be read.
pub(crate) fn read_user_sid_text() -> io::Result<String> {
    sid_text(ProcessUser::of_this_process()?.sid())
}

/// A security descriptor granting this user, and no one else, every right; freed on drop.
pub(crate) struct UserOnlyDescriptor(PSECURITY_DESCRIPTOR);

impl UserOnlyDescriptor {
    /// Reads this user's id from the process token and builds the descriptor from its SDDL. Fails
    /// with the system's error.
    pub(crate) fn new() -> io::Result<Self> {
        let user = read_user_sid_text()?;
        let mut sddl = wide_text(OsStr::new(&format!("D:P(A;;GA;;;{user})")))?;
        sddl.push(0);
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: the SDDL is a live NUL-ended UTF-16 string, and the call writes a descriptor
        // it allocates, which `Drop` frees.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &raw mut descriptor,
                std::ptr::null_mut(),
            )
        } == FALSE
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }

    /// The descriptor, for a call's security attributes; it lives as long as `self`.
    pub(crate) fn as_raw(&self) -> PSECURITY_DESCRIPTOR {
        self.0
    }
}

impl Drop for UserOnlyDescriptor {
    fn drop(&mut self) {
        // SAFETY: the descriptor came from the conversion, which allocated it with `LocalAlloc`.
        unsafe { LocalFree(self.0) };
    }
}
