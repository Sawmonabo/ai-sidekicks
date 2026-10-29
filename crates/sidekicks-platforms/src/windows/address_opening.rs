//! Opening an address on Windows through the shell's `ShellExecuteExW`, which hands it to the
//! application registered for its scheme.

use std::ffi::OsStr;
use std::io;

use windows_sys::Win32::Foundation::{ERROR_NO_ASSOCIATION, RPC_E_CHANGED_MODE};
use windows_sys::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
};
use windows_sys::Win32::UI::Shell::{
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::address_opening::no_handler_error;
use crate::windows::wide_text::wide_text;

/// Opens `address` in the application registered for its scheme, showing no dialog of the
/// shell's own. Fails with `NotFound` when no application is registered for it
/// (`ERROR_NO_ASSOCIATION`), with `InvalidInput` when it holds a NUL, and with the system's error
/// for any other refusal.
pub fn open_address(address: &str) -> io::Result<()> {
    let mut file = wide_text(OsStr::new(address))?;
    file.push(0);
    // The shell may hand the address to an extension reached through COM, so the thread joins an
    // apartment first; one the thread already joined in another mode serves as it is.
    // SAFETY: the reserved argument is null, as the call requires.
    let com_result = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).cast_unsigned(),
        )
    };
    if com_result < 0 && com_result != RPC_E_CHANGED_MODE {
        return Err(io::Error::from_raw_os_error(com_result));
    }
    // SAFETY: the structure is plain data, for which all zeros is the empty request.
    let mut request: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    request.cbSize = u32::try_from(size_of::<SHELLEXECUTEINFOW>())
        .expect("the request's size fits the field the call reads it from");
    // No dialog on a failure, which is answered here instead, and the open finished before the
    // call returns, since the command line exits right after it.
    request.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
    request.lpFile = file.as_ptr();
    request.nShow = SW_SHOWNORMAL;
    // SAFETY: `request` is a live, sized request whose one string, `file`, is NUL-terminated and
    // outlives the call.
    let opened = unsafe { ShellExecuteExW(&raw mut request) } != 0;
    // Read before the apartment is left, which may set the thread's last error again.
    let failure = (!opened).then(io::Error::last_os_error);
    if com_result >= 0 {
        // SAFETY: this call joined the apartment, so it leaves it once.
        unsafe { CoUninitialize() };
    }
    match failure {
        None => Ok(()),
        Some(error) if error.raw_os_error() == Some(ERROR_NO_ASSOCIATION.cast_signed()) => {
            Err(no_handler_error())
        }
        Some(error) => Err(error),
    }
}
