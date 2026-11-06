//! Opening an address on macOS through `LaunchServices`' `LSOpenCFURLRef`, which hands it to the
//! application registered for its scheme without linking `AppKit`, and whether a browser opened
//! from this process reaches its person, read from the process's security session.

use std::io::{self, ErrorKind};

use objc2_core_foundation::{CFString, CFURL};
use objc2_core_services::{LSOpenCFURLRef, kLSApplicationNotFoundErr};
use objc2_security::{
    SessionAttributeBits, SessionGetInfo, callerSecuritySession, errSessionSuccess,
};

use crate::address_opening::no_handler_error;

/// Opens `address` in the application registered for its scheme. Fails with `NotFound` when no
/// application is registered for it (`kLSApplicationNotFoundErr`), with `InvalidInput` when it is
/// no URL, and with `Other` naming `LaunchServices`' status for any other refusal.
pub fn open_address(address: &str) -> io::Result<()> {
    let url = CFURL::from_string(None, &CFString::from_str(address), None).ok_or_else(|| {
        io::Error::new(ErrorKind::InvalidInput, "the address to open is not a URL")
    })?;
    // SAFETY: `url` is a live CFURL, and a null out-pointer asks for no launched URL back.
    let status = unsafe { LSOpenCFURLRef(&url, std::ptr::null_mut()) };
    match status {
        0 => Ok(()),
        _ if status == kLSApplicationNotFoundErr => Err(no_handler_error()),
        _ => Err(io::Error::other(format!(
            "LaunchServices could not open the address (status {status})"
        ))),
    }
}

/// Whether a browser opened from this process reaches its person on macOS: its security session,
/// one per login, has graphics access and was not made over the network. A system daemon's root
/// session has no graphics access; a failed read answers no. The environment holds nothing macOS
/// reads for it.
pub(crate) fn can_reach_display(_environment: &[(String, String)]) -> bool {
    let mut attributes = SessionAttributeBits::empty();
    // SAFETY: the caller's own session is asked for, a null id pointer asks for no id back, and
    // `attributes` is a live value the call writes.
    let status = unsafe {
        SessionGetInfo(
            callerSecuritySession,
            std::ptr::null_mut(),
            &raw mut attributes,
        )
    };
    status == errSessionSuccess && can_session_show_browser(attributes)
}

// Whether a session with `attributes` shows a browser to the person at the machine.
fn can_session_show_browser(attributes: SessionAttributeBits) -> bool {
    attributes.contains(SessionAttributeBits::sessionHasGraphicAccess)
        && !attributes.contains(SessionAttributeBits::sessionIsRemote)
}

#[cfg(test)]
mod tests {
    use objc2_security::SessionAttributeBits;
    use rstest::rstest;

    use super::can_session_show_browser;

    // Killed by the remote bit ignored, and by the graphics bit not required.
    #[rstest]
    #[case::graphics(SessionAttributeBits::sessionHasGraphicAccess, true)]
    #[case::none(SessionAttributeBits::empty(), false)]
    #[case::graphics_over_the_network(
        SessionAttributeBits::sessionHasGraphicAccess | SessionAttributeBits::sessionIsRemote,
        false
    )]
    fn a_mac_session_opens_a_browser_only_with_graphics_and_not_remote(
        #[case] attributes: SessionAttributeBits,
        #[case] opens: bool,
    ) {
        assert_eq!(can_session_show_browser(attributes), opens);
    }
}
