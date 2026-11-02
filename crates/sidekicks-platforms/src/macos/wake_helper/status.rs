//! The wake helper's status: the login items' answer for its legacy property list, read beside
//! whether the list is still in place.

use super::install::{WAKE_HELPER_LIST_FILE, wake_helper_list_path};
use crate::macos::login_items::{LoginItemStatus, LoginItemStatusError, read_login_item_status};
use crate::{WakeHelperError, WakeHelperStatus};

/// The helper's status as the login items and its property list's presence say it. Blocks on the
/// system's answer. Fails as [`super::WakeHelper::status`] says.
pub(crate) fn read_status() -> Result<WakeHelperStatus, WakeHelperError> {
    let status =
        read_login_item_status(&wake_helper_list_path()).map_err(|failure| match failure {
            LoginItemStatusError::File(source) => WakeHelperError::File {
                file: WAKE_HELPER_LIST_FILE,
                source,
            },
            LoginItemStatusError::UnknownStatus { value } => {
                WakeHelperError::UnknownStatus { value }
            }
        })?;
    Ok(match status {
        LoginItemStatus::Allowed => WakeHelperStatus::Installed,
        LoginItemStatus::TurnedOff => WakeHelperStatus::TurnedOff,
        LoginItemStatus::Missing => WakeHelperStatus::Missing,
    })
}

#[cfg(test)]
mod tests {
    /// What the login items answer for the helper's list on this Mac, for the probe of an absent,
    /// an unloaded and a toggled-off helper: run once in each state and read the printed answer.
    #[test]
    #[ignore = "a probe of this Mac's login items, run by a person in each of the helper's states"]
    fn the_wake_helper_status_probe_prints_this_macs_answer() {
        let list_path = super::wake_helper_list_path();
        let list_url = objc2_foundation::NSURL::from_file_path(&list_path)
            .expect("the property list's path is absolute");
        // SAFETY: the URL is a live file URL for the call, which only reads the login items.
        let status =
            unsafe { objc2_service_management::SMAppService::statusForLegacyURL(&list_url) };
        eprintln!(
            "statusForLegacyURL answered {} with the list {}",
            status.0,
            if list_path.exists() {
                "present"
            } else {
                "absent"
            }
        );
    }
}
