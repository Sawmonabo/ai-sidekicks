//! The arm a sign-in runs on, from the arm its request names and where it was started.

use sidekicks_contracts::provider::account::sign_in::ProviderSignInArm;

use super::{ProviderSignInError, SignInOrigin};

/// The arm a sign-in started at `origin` runs on: the one `requested` names, else the browser arm
/// at this machine and the device-code arm from another device. Fails with
/// [`ProviderSignInError::BrowserFromAnotherDevice`] where another device names the browser arm,
/// whose callback that device's browser cannot reach.
pub(super) fn resolve_sign_in_arm(
    requested: Option<ProviderSignInArm>,
    origin: SignInOrigin,
) -> Result<ProviderSignInArm, ProviderSignInError> {
    match (origin, requested) {
        (SignInOrigin::ThisMachine, requested) => {
            Ok(requested.unwrap_or(ProviderSignInArm::Browser))
        }
        (SignInOrigin::AnotherDevice, Some(ProviderSignInArm::Browser)) => {
            Err(ProviderSignInError::BrowserFromAnotherDevice)
        }
        (SignInOrigin::AnotherDevice, None | Some(ProviderSignInArm::DeviceCode)) => {
            Ok(ProviderSignInArm::DeviceCode)
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::account::sign_in::ProviderSignInArm::{
        self, Browser, DeviceCode,
    };
    use sidekicks_ipc::registry::HandlerError;

    use super::resolve_sign_in_arm;
    use crate::account::sign_in::SignInOrigin::{self, AnotherDevice, ThisMachine};

    // Killed by the default at this machine flipped to device code, which sends a person at this
    // machine through a cross-device flow, by a named arm ignored at this machine, and by the
    // browser arm accepted from another device, whose callback that device cannot reach.
    #[rstest]
    #[case::this_machine_names_none(ThisMachine, None, Some(Browser))]
    #[case::this_machine_names_browser(ThisMachine, Some(Browser), Some(Browser))]
    #[case::this_machine_names_device_code(ThisMachine, Some(DeviceCode), Some(DeviceCode))]
    #[case::another_device_names_none(AnotherDevice, None, Some(DeviceCode))]
    #[case::another_device_names_device_code(AnotherDevice, Some(DeviceCode), Some(DeviceCode))]
    #[case::another_device_names_browser(AnotherDevice, Some(Browser), None)]
    #[test]
    fn the_arm_follows_the_request_and_where_it_came_from(
        #[case] origin: SignInOrigin,
        #[case] requested: Option<ProviderSignInArm>,
        #[case] expected: Option<ProviderSignInArm>,
    ) {
        match (resolve_sign_in_arm(requested, origin), expected) {
            (Ok(arm), Some(expected)) => assert_eq!(arm, expected),
            (Err(error), None) => {
                let HandlerError::Refused(refusal) = HandlerError::from(error) else {
                    panic!("the browser arm from another device is a refusal");
                };
                assert_eq!(refusal.code, RefusalCode::ProviderAccountSignInUnsupported);
            }
            (resolved, expected) => panic!("{resolved:?} where {expected:?} was expected"),
        }
    }
}
