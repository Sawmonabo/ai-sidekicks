use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_contracts::daemon::lifecycle::DaemonRestart;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::test_registry::{
    serve_as_codex_service_stand_in, stand_in_codex_service,
};
use tokio_util::sync::CancellationToken;

use super::{STOP_WAIT, TestHome};

// The Codex service the daemons in these tests launch: this test binary, run through the
// stand-in's script as `codex`, serving as a lasting terminal service. Run only that way.
#[tokio::test]
#[ignore = "the restarted daemons' Codex service, run through its script"]
async fn codex_service_stand_in() {
    serve_as_codex_service_stand_in().await;
}

// A `daemon.restart` keeps the terminal service the first daemon launched on the person's own
// Codex folder, and the next start joins that same process before it binds its socket, so before
// its recovery pass: every connection the second daemon makes to a service on the folder reaches
// the process the first launched, the first of them, the join, while the second daemon's socket
// is not yet there. Killed by the restart ending the service, where the second daemon launches
// one of its own, and by the stored rows applied after the recovery pass, where the join comes
// after the socket is bound.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_the_terminal_service_and_the_next_start_joins_it_first() {
    let stand_in_test = format!(
        "{}::codex_service_stand_in",
        module_path!()
            .split_once("::")
            .map(|(_crate, path)| path)
            .expect("the module path names its crate")
    );
    let home = TestHome::new();
    let Some(stand_in) = stand_in_codex_service(
        &stand_in_test,
        &home.run_folder.socket_path,
        &home.data_folder(),
    ) else {
        return;
    };
    let home = home.with_provider_environment(stand_in.provider_environment());

    let mut first = home
        .start(CancellationToken::new())
        .await
        .expect("the first daemon starts");
    let launched = stand_in.launches();
    let first_daemons_connections = stand_in.connections().len();
    let caller = DaemonConnection::connect(DaemonEndpoint::new(home.run_folder.clone()))
        .await
        .expect("the caller connects");
    caller
        .client()
        .call::<DaemonRestart>(&EmptyPayload {})
        .await
        .expect("the restart is accepted");
    caller.close().await;
    let asked = tokio::time::timeout(STOP_WAIT, first.wait_for_stop())
        .await
        .expect("the restart reaches the process");
    first
        .stop(asked)
        .await
        .expect("the first daemon's stop fails nothing");
    let second = home
        .start(CancellationToken::new())
        .await
        .expect("the second daemon starts");
    let launches = stand_in.launches();
    let connections = stand_in.connections();
    second
        .stop(DaemonStopIntent::Stop)
        .await
        .expect("the second daemon's stop fails nothing");

    assert_eq!(asked, DaemonStopIntent::Restart);
    assert_eq!(launched.len(), 1, "the first daemon launches its service");
    assert_eq!(launches, launched, "the second daemon launched a service");
    let second_daemons = connections
        .get(first_daemons_connections..)
        .expect("the first daemon's connections stay recorded");
    let join = second_daemons
        .first()
        .expect("the second daemon reaches the service");
    assert!(
        !join.is_daemon_socket_bound,
        "the join came after the socket: {second_daemons:?}"
    );
}
