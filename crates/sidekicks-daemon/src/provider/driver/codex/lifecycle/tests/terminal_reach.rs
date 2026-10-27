//! The terminal-reach switch: its row read from the folder's terminal service, its value applied.

use std::sync::atomic::Ordering;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::place::{Place, WindowsPlace};
use sidekicks_contracts::provider::declaration::{
    ProviderDeclarationId, ProviderRow, ProviderSettingControl, ProviderValue,
};
use sidekicks_platforms::short_socket_folder;

use super::super::CodexDriver;
use super::{driver_on_codex_folder, listen_on_codex_folder};
use crate::provider::driver::codex::service::home::CodexHomeKind;
use crate::provider::driver::contract::{ApplyRowValueParams, DriverError};
use crate::provider::driver::daemon_stop::DaemonStopIntent;

// The switch's value turned to `is_on` on the computer's one place.
fn switched(is_on: bool) -> ApplyRowValueParams {
    ApplyRowValueParams {
        row_id: ProviderDeclarationId::new("terminalReach".to_owned()).expect("the id fits"),
        place: None,
        value: Some(ProviderValue::Switch(is_on)),
    }
}

// Whether the row reads on, on the computer's one place.
fn reads_on(driver: &CodexDriver) -> bool {
    let rows = driver.read_rows(&ProviderRowValues::default());
    let [
        ProviderRow::Setting {
            control: ProviderSettingControl::Switch { places },
            ..
        },
    ] = rows.as_slice()
    else {
        panic!("the row is one switch: {rows:?}");
    };
    let [switch] = places.as_slice() else {
        panic!("the switch has one place: {places:?}");
    };
    assert_eq!(switch.place, None);
    switch.enabled
}

// Killed by storing the switch's value before the start answers: the failed start would leave the
// folder's next service the terminal one while the row reads off.
#[tokio::test]
async fn a_failed_switch_on_reads_off_and_leaves_the_folder_s_service_off() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let (driver, _services) = driver_on_codex_folder(folder.path());

    let applied = driver.apply_row_value(switched(true)).await;
    let is_on = reads_on(&driver);
    let next = driver
        .registry
        .service_for(None)
        .await
        .expect("the folder's service is made");
    driver.shutdown(DaemonStopIntent::Stop).await;

    assert!(applied.is_err());
    assert!(!is_on);
    assert!(!driver.is_terminal_reach_on.load(Ordering::Acquire));
    assert_eq!(
        next.home().kind,
        CodexHomeKind::PersonalFolder {
            is_terminal_reach_on: false
        }
    );
}

// Killed by dropping the check of the value already on: the second switch-on would retire the
// running service and start another in its place.
#[tokio::test]
async fn a_repeated_switch_on_starts_nothing_more() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let (driver, _services) = driver_on_codex_folder(folder.path());
    listen_on_codex_folder(folder.path());

    driver
        .apply_row_value(switched(true))
        .await
        .expect("the switch joins the listening service");
    let first = driver.registry.services();
    let is_on = reads_on(&driver);
    let repeated = driver.apply_row_value(switched(true)).await;
    let second = driver.registry.services();
    let is_still_serving = first.iter().all(|service| service.is_serving());
    driver.shutdown(DaemonStopIntent::Stop).await;

    assert!(is_on);
    assert!(repeated.is_ok());
    assert!(
        first.len() == 1 && second.len() == 1 && std::sync::Arc::ptr_eq(&first[0], &second[0]),
        "the repeated switch-on replaced the folder's service"
    );
    assert!(is_still_serving);
}

// Killed by acting on a place the computer does not have, as the computer's one place.
#[tokio::test]
async fn a_switch_in_a_place_the_computer_lacks_is_refused_and_starts_nothing() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let (driver, _services) = driver_on_codex_folder(folder.path());

    let applied = driver
        .apply_row_value(ApplyRowValueParams {
            place: Some(Place::Windows(WindowsPlace::Value)),
            ..switched(true)
        })
        .await;
    let services = driver.registry.services();
    driver.shutdown(DaemonStopIntent::Stop).await;

    let Err(DriverError::Refused(refusal)) = applied else {
        panic!("the place was not refused: {applied:?}");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderPlaceNotOffered);
    assert!(services.is_empty());
}
