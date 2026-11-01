//! The wake helper's status: the login items' answer for its legacy property list
//! (`SMAppService.statusForLegacyURL`), read beside whether the list is still in place.

use std::fs;
use std::io;

use objc2_foundation::NSURL;
use objc2_service_management::{SMAppService, SMAppServiceStatus};

use super::install::wake_helper_list_path;
use crate::{WakeHelperError, WakeHelperStatus};

/// The helper's status as the login items and its property list's presence say it. Blocks on the
/// system's answer. Fails as [`super::WakeHelper::status`] says.
pub(crate) fn read_status() -> Result<WakeHelperStatus, WakeHelperError> {
    let list_path = wake_helper_list_path();
    let has_list = match fs::symlink_metadata(&list_path) {
        Ok(_) => true,
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => false,
        Err(source) => {
            return Err(WakeHelperError::File {
                path: list_path,
                source,
            });
        }
    };
    let list_url = NSURL::from_file_path(&list_path).expect("the property list's path is absolute");
    // SAFETY: the URL is a live file URL for the call, which only reads the login items.
    let status = unsafe { SMAppService::statusForLegacyURL(&list_url) };
    wake_helper_status(status, has_list)
}

// The helper's status from the login items' `status` for its list and whether the list is in
// place: a list gone is missing whatever the login items still record.
fn wake_helper_status(
    status: SMAppServiceStatus,
    has_list: bool,
) -> Result<WakeHelperStatus, WakeHelperError> {
    if !has_list {
        return Ok(WakeHelperStatus::Missing);
    }
    match status {
        SMAppServiceStatus::Enabled => Ok(WakeHelperStatus::Installed),
        SMAppServiceStatus::RequiresApproval => Ok(WakeHelperStatus::TurnedOff),
        SMAppServiceStatus::NotRegistered | SMAppServiceStatus::NotFound => {
            Ok(WakeHelperStatus::Missing)
        }
        SMAppServiceStatus(value) => Err(WakeHelperError::UnknownStatus { value }),
    }
}

#[cfg(test)]
mod tests {
    use objc2_service_management::SMAppServiceStatus;
    use rstest::rstest;

    use super::wake_helper_status;
    use crate::{WakeHelperError, WakeHelperStatus};

    /// Each login items answer reads its status while the list is in place, and every answer reads
    /// missing once the list is gone. Mutations: map `RequiresApproval` to installed; drop the
    /// list's check.
    #[rstest]
    #[case::enabled(SMAppServiceStatus::Enabled, true, WakeHelperStatus::Installed)]
    #[case::turned_off(
        SMAppServiceStatus::RequiresApproval,
        true,
        WakeHelperStatus::TurnedOff
    )]
    #[case::not_registered(SMAppServiceStatus::NotRegistered, true, WakeHelperStatus::Missing)]
    #[case::not_found(SMAppServiceStatus::NotFound, true, WakeHelperStatus::Missing)]
    #[case::enabled_list_gone(SMAppServiceStatus::Enabled, false, WakeHelperStatus::Missing)]
    #[case::turned_off_list_gone(
        SMAppServiceStatus::RequiresApproval,
        false,
        WakeHelperStatus::Missing
    )]
    fn the_wake_helper_status_reads_the_login_items_beside_its_list(
        #[case] status: SMAppServiceStatus,
        #[case] has_list: bool,
        #[case] expected: WakeHelperStatus,
    ) {
        assert_eq!(
            wake_helper_status(status, has_list).expect("a known status reads"),
            expected
        );
    }

    /// An answer this build does not know is an error naming it, never a status it guesses.
    #[test]
    fn the_wake_helper_status_refuses_an_unknown_login_items_answer() {
        let refusal = wake_helper_status(SMAppServiceStatus(7), true);
        assert!(
            matches!(refusal, Err(WakeHelperError::UnknownStatus { value: 7 })),
            "{refusal:?}"
        );
    }

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
