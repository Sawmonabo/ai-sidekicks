//! Whether the person allows a legacy launchd property list in the system's login items: the
//! answer of `SMAppService.statusForLegacyURL` for the list, read beside whether the list is still
//! in place. The wake helper's list and the command line's own login agent are read through it.
//! A list turned off there is still started by launchd when asked, so whoever starts it reads this
//! first.

use std::fs;
use std::io;
use std::path::Path;

use objc2_foundation::NSURL;
use objc2_service_management::{SMAppService, SMAppServiceStatus};

/// What the login items say of a legacy property list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LoginItemStatus {
    /// The list is in place and allowed to run.
    Allowed,
    /// The list is in place, but the person turned it off in the login items.
    TurnedOff,
    /// The list is gone, or the login items do not know it.
    Missing,
}

/// Why the login items' status of a list could not be read.
#[derive(Debug)]
pub(crate) enum LoginItemStatusError {
    /// Whether the list is in place could not be read.
    File(io::Error),
    /// The system answered a status this build does not know.
    UnknownStatus {
        /// The status's number.
        value: isize,
    },
}

/// The login items' status of the legacy property list at `list_path`, which is absolute. Blocks
/// on the system's answer. Fails with [`LoginItemStatusError::File`] when the list's folder cannot
/// be read, and with [`LoginItemStatusError::UnknownStatus`] on a status this build does not know.
pub(crate) fn read_login_item_status(
    list_path: &Path,
) -> Result<LoginItemStatus, LoginItemStatusError> {
    let has_list = match fs::symlink_metadata(list_path) {
        Ok(_) => true,
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => false,
        Err(source) => return Err(LoginItemStatusError::File(source)),
    };
    let list_url = NSURL::from_file_path(list_path).expect("the property list's path is absolute");
    // SAFETY: the URL is a live file URL for the call, which only reads the login items.
    let status = unsafe { SMAppService::statusForLegacyURL(&list_url) };
    login_item_status(status, has_list)
}

// The status from the login items' answer for a list and whether the list is in place: a list gone
// is missing whatever the login items still record.
fn login_item_status(
    status: SMAppServiceStatus,
    has_list: bool,
) -> Result<LoginItemStatus, LoginItemStatusError> {
    if !has_list {
        return Ok(LoginItemStatus::Missing);
    }
    match status {
        SMAppServiceStatus::Enabled => Ok(LoginItemStatus::Allowed),
        SMAppServiceStatus::RequiresApproval => Ok(LoginItemStatus::TurnedOff),
        SMAppServiceStatus::NotRegistered | SMAppServiceStatus::NotFound => {
            Ok(LoginItemStatus::Missing)
        }
        SMAppServiceStatus(value) => Err(LoginItemStatusError::UnknownStatus { value }),
    }
}

#[cfg(test)]
mod tests {
    use objc2_service_management::SMAppServiceStatus;
    use rstest::rstest;

    use super::{LoginItemStatus, LoginItemStatusError, login_item_status};

    /// Each login items answer reads its status while the list is in place, and every answer reads
    /// missing once the list is gone. Mutations: map `RequiresApproval` to allowed; drop the
    /// list's check.
    #[rstest]
    #[case::enabled(SMAppServiceStatus::Enabled, true, LoginItemStatus::Allowed)]
    #[case::turned_off(SMAppServiceStatus::RequiresApproval, true, LoginItemStatus::TurnedOff)]
    #[case::not_registered(SMAppServiceStatus::NotRegistered, true, LoginItemStatus::Missing)]
    #[case::not_found(SMAppServiceStatus::NotFound, true, LoginItemStatus::Missing)]
    #[case::enabled_list_gone(SMAppServiceStatus::Enabled, false, LoginItemStatus::Missing)]
    #[case::turned_off_list_gone(
        SMAppServiceStatus::RequiresApproval,
        false,
        LoginItemStatus::Missing
    )]
    fn the_login_item_status_reads_the_login_items_beside_the_list(
        #[case] status: SMAppServiceStatus,
        #[case] has_list: bool,
        #[case] expected: LoginItemStatus,
    ) {
        assert_eq!(
            login_item_status(status, has_list).expect("a known status reads"),
            expected
        );
    }

    /// An answer this build does not know is an error naming it, never a status it guesses.
    #[test]
    fn the_login_item_status_refuses_an_unknown_login_items_answer() {
        let refusal = login_item_status(SMAppServiceStatus(7), true);
        assert!(
            matches!(
                refusal,
                Err(LoginItemStatusError::UnknownStatus { value: 7 })
            ),
            "{refusal:?}"
        );
    }
}
