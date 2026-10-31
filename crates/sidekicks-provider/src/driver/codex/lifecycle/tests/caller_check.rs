//! The caller check over the provider services the driver dials.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::caller_process::descent::CallerCheck;
use sidekicks_ipc::caller_process::descent::test_reader::ScriptedReader;
use sidekicks_ipc::protocol_negotiation::CallerAdmission;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, ParentProcess, ResponsibleProcess, short_socket_folder,
    this_process,
};

use super::{driver_on_codex_folder, listen_on_codex_folder};
use crate::driver::daemon_stop::DaemonStopIntent;

// A service already listening on the person's Codex folder, joined through the driver's registry,
// its serving process this test's own; the daemon's caller check, over the services' one set of
// held provider services, then refuses that process. Killed by building the driver's own set of
// held services again in `CodexDriver::new`: the check, reading the daemon's set, would find no
// service held and answer that the caller needs the session token.
#[tokio::test]
async fn the_caller_check_refuses_the_process_serving_a_codex_service_the_driver_dialed() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let (driver, services) = driver_on_codex_folder(folder.path());
    listen_on_codex_folder(folder.path());

    driver
        .registry
        .start_terminal_service()
        .await
        .expect("the driver joins the listening service");
    let check = CallerCheck::new(
        Arc::new(ScriptedReader {
            responsible: ResponsibleProcess::Itself,
            parent: ParentProcess::Root,
            is_desktop_client: false,
            was_signature_read: AtomicBool::new(false),
        }) as Arc<dyn CallerProcessReader>,
        Arc::new(HashSet::new),
        Arc::clone(&services.provider_services),
    );

    assert_eq!(
        check.admission_check()(this_process(), true)
            .await
            .expect("the check answers"),
        CallerAdmission::Refused
    );
    driver.shutdown(DaemonStopIntent::Stop).await;
}
