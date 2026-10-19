//! The user a Windows process runs as, read from its token: this process's or another's by its id,
//! compared with another user's id, and written as SDDL text (`S-1-5-21-…`).

use std::ffi::c_void;
use std::io::{self, ErrorKind};
use std::os::windows::io::{
    AsHandle as _, AsRawHandle as _, BorrowedHandle, FromRawHandle as _, OwnedHandle,
};

use windows_sys::Win32::Foundation::{FALSE, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, PSID, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::windows::pinned_process::current_process;
use crate::windows::wide_text::read_wide_string;

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
        // SAFETY: the call takes plain values and answers a new handle or null.
        let raw_process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, id) };
        if raw_process.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the handle was just opened and is owned by nothing else.
        let process = unsafe { OwnedHandle::from_raw_handle(raw_process) };
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

    /// Whether `sid` is this user's id.
    pub(crate) fn has_sid(&self, sid: PSID) -> bool {
        // SAFETY: both ids are valid: this one lives in the record, `sid` is the caller's.
        unsafe { EqualSid(self.sid(), sid) != FALSE }
    }

    /// The user's id as SDDL text (`S-1-5-21-…`). Fails with the system's error when the id cannot
    /// be written.
    pub(crate) fn sid_text(&self) -> io::Result<String> {
        sid_text(self.sid())
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
    ProcessUser::of_this_process()?.sid_text()
}
