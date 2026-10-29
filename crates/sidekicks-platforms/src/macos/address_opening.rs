//! Opening an address on macOS through LaunchServices' `LSOpenCFURLRef`, which hands it to the
//! application registered for its scheme without linking AppKit.

use std::io::{self, ErrorKind};

use objc2_core_foundation::{CFString, CFURL};
use objc2_core_services::{LSOpenCFURLRef, kLSApplicationNotFoundErr};

use crate::address_opening::no_handler_error;

/// Opens `address` in the application registered for its scheme. Fails with `NotFound` when no
/// application is registered for it (`kLSApplicationNotFoundErr`), with `InvalidInput` when it is
/// no URL, and with `Other` naming LaunchServices' status for any other refusal.
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
