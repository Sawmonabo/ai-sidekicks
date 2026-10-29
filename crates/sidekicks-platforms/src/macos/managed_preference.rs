//! A program's managed preference on macOS: the value a device-management profile forces, never a
//! default the person wrote, since only a forced value is the administrator's.

use std::io;

use objc2_core_foundation::{CFPreferencesAppValueIsForced, CFPreferencesCopyAppValue, CFString};

/// The text an administrator's device-management profile forces for `key` of the program whose
/// preferences are `application_id`; `None` where nothing forces it, or where it stopped being
/// forced during the read, since a value that is not forced is the person's own. Fails with
/// `InvalidData` where the forced value is not text.
pub fn read_managed_preference(application_id: &str, key: &str) -> io::Result<Option<String>> {
    let application = CFString::from_str(application_id);
    let key_text = CFString::from_str(key);
    if !CFPreferencesAppValueIsForced(&key_text, &application) {
        return Ok(None);
    }
    let Some(value) = CFPreferencesCopyAppValue(&key_text, &application) else {
        return Ok(None);
    };
    // The two calls are no one snapshot, so a value unforced in between is the person's default.
    if !CFPreferencesAppValueIsForced(&key_text, &application) {
        return Ok(None);
    }
    let text = value.downcast::<CFString>().map_err(|_value| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the managed preference {application_id}:{key} is not text"),
        )
    })?;
    Ok(Some(text.to_string()))
}
