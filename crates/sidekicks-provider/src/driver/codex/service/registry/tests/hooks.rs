use std::sync::Arc;

use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, short_socket_folder};

use super::stand_in::{last_launch_arguments, stand_in_services, this_daemon};
use crate::driver::daemon_stop::DaemonStopIntent;

// Fails when the terminal service is launched with the daemon's hook switches, or trusts hooks,
// while the daemon's program dispatches no hook mode: each such hook exits 1 on every tool call.
// The stand-in refuses every config write, so a trust write fails the start.
#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_service_with_no_hook_mode_launches_and_trusts_no_hook() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let services = stand_in_services(folder.path(), |program| Arc::new(program));
    let daemon = this_daemon(&services);
    let service = daemon.service_for(None).await.expect("the home resolves");

    let started = service
        .ensure_started(services.dependencies.startup_timeout)
        .await;
    let is_launched = service.process_id().is_some();
    daemon.shutdown(DaemonStopIntent::Stop).await;
    let arguments = last_launch_arguments(&services);

    assert!(started.is_ok(), "{started:?}");
    assert!(is_launched, "the start joined rather than launched");
    assert!(
        !arguments
            .iter()
            .any(|argument| argument.starts_with("hooks.")),
        "{arguments:?}"
    );
}
