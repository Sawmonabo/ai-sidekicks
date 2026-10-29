use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, short_socket_folder};

use super::stand_in::{
    account_stand_in_services, another_daemon, is_running, this_daemon,
    wait_for_end_and_record_removal,
};
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::runtime_binding::test_store::test_provider_account_id;

// Fails when a restart stops the account home's service, which ends every turn it runs, when the
// next daemon launches another beside it instead of joining it, or when that daemon's stop leaves
// it running or its record kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_an_account_homes_service_and_the_next_stop_ends_it() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let services = account_stand_in_services(folder.path());
    let startup_timeout = services.dependencies.startup_timeout;

    let first = this_daemon(&services);
    let kept = first
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = kept.ensure_started(startup_timeout).await;
    let kept_process = kept.process_id().expect("the service runs a process");
    first.shutdown(DaemonStopIntent::Restart).await;
    let is_kept_running = is_running(kept_process);

    let next = another_daemon(&services);
    let joined = next
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let rejoined = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    next.shutdown(DaemonStopIntent::Stop).await;
    let is_stopped =
        wait_for_end_and_record_removal(kept_process, &services, startup_timeout).await;

    assert!(started.is_ok(), "{started:?}");
    assert!(is_kept_running, "the restart stopped the account's service");
    assert!(rejoined.is_ok(), "{rejoined:?}");
    assert_eq!(joined_process, Some(kept_process));
    assert!(
        is_stopped,
        "the stop left the account's service or its record"
    );
}
