//! A program's managed preference, which only an administrator's device-management profile sets:
//! read through Core Foundation on macOS, and absent on every other system, which has none.

#[cfg(not(target_os = "macos"))]
use std::io;

/// The text an administrator's device-management profile forces for `key` of the program whose
/// preferences are `application_id`; `None` on a system with no managed preferences.
#[cfg(not(target_os = "macos"))]
pub fn read_managed_preference(_application_id: &str, _key: &str) -> io::Result<Option<String>> {
    Ok(None)
}
