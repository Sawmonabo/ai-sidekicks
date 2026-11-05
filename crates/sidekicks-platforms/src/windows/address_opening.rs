//! Opening an address on Windows through the shell's `ShellExecuteExW`, which hands it to the
//! application registered for its scheme, and whether a browser opened from this process reaches
//! its person, read from the process's window station.

use std::ffi::OsStr;
use std::io;

use windows_sys::Win32::Foundation::{ERROR_NO_ASSOCIATION, RPC_E_CHANGED_MODE};
use windows_sys::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
};
use windows_sys::Win32::System::StationsAndDesktops::{
    GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
};
use windows_sys::Win32::UI::Shell::{
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{SW_SHOWNORMAL, WSF_VISIBLE};

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

/// Whether a browser opened from this process reaches its person on Windows: its window station
/// has visible display surfaces, which a service's noninteractive one has not. A failed read
/// answers no. The environment holds nothing Windows reads for it.
pub(crate) fn can_reach_display(_environment: &[(String, String)]) -> bool {
    // SAFETY: the call takes no argument and answers the process's own station, which is not
    // closed.
    let station = unsafe { GetProcessWindowStation() };
    if station.is_null() {
        return false;
    }
    // SAFETY: the structure is plain data, for which all zeros is a valid value.
    let mut flags: USEROBJECTFLAGS = unsafe { std::mem::zeroed() };
    let length = u32::try_from(size_of::<USEROBJECTFLAGS>())
        .expect("the flags' size fits the length the call reads");
    // SAFETY: `station` is the live station handle, and `flags` is a live structure of `length`
    // bytes the call writes; a null needed-length pointer asks for none back.
    let is_read = unsafe {
        GetUserObjectInformationW(
            station,
            UOI_FLAGS,
            (&raw mut flags).cast(),
            length,
            std::ptr::null_mut(),
        )
    } != 0;
    is_read && has_visible_display(flags.dwFlags)
}

// Whether a window station with `flags` shows its windows on a display.
fn has_visible_display(flags: u32) -> bool {
    flags & WSF_VISIBLE.cast_unsigned() != 0
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use windows_sys::Win32::UI::WindowsAndMessaging::WSF_VISIBLE;

    use super::has_visible_display;

    const VISIBLE: u32 = WSF_VISIBLE.cast_unsigned();

    // Killed by a mask that reads another bit as the visible one, or that misses the visible bit
    // among others.
    #[rstest]
    #[case::visible(VISIBLE, true)]
    #[case::none(0, false)]
    #[case::every_other_bit(!VISIBLE, false)]
    #[case::visible_among_others(VISIBLE | 0x0100, true)]
    fn a_windows_station_opens_a_browser_only_with_a_visible_display(
        #[case] flags: u32,
        #[case] opens: bool,
    ) {
        assert_eq!(has_visible_display(flags), opens);
    }
}
