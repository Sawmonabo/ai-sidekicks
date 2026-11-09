use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, Spawner, create_missing_private_folders, pin_running_process,
};
use tokio_util::sync::CancellationToken;

use super::TestHome;
use crate::daemon::crash::monitor::connect_crash_monitor;
use crate::daemon::panic_hook::panic_monitor;
use crate::daemon::process::crash_monitor::{CrashMonitor, RESTART_GAP_MIN};

// The longest the test waits for the watch to connect to the first monitor.
const FIRST_CONNECT_WAIT: Duration = Duration::from_secs(30);

// The longest the test waits for the watch to connect to a new monitor: the shortest restart gap
// after the killed monitor's attempt, then the new monitor's own start, with room to spare.
const RESTART_WAIT: Duration = RESTART_GAP_MIN.saturating_add(Duration::from_secs(30));

// The longest the test's own connect tries to reach the new monitor.
const OWN_CONNECT_WAIT: Duration = Duration::from_secs(10);

// The one deadline every stage of the test runs against, short of the test runner's two-minute end
// of a hung test: the first connect, the killed monitor's end and the restart, with room for the
// test's own connect after it.
const TEST_WAIT: Duration = FIRST_CONNECT_WAIT
    .saturating_add(RESTART_WAIT)
    .saturating_add(Duration::from_secs(10));

// A crash monitor whose child is killed is replaced: once the killed one has ended, so its socket
// answers no more, the watch connects to a new monitor and points later panics at it, the new
// monitor then answers the test's own connect too, and the end fails nothing. The test's
// connection stays up until the end, so its disconnect never ends the new monitor. Killed by a
// watch that never starts or never connects to a new monitor, by no watch at all, and by a
// replacement that leaves the panic hook on the killed monitor's client.
#[tokio::test(flavor = "multi_thread")]
async fn a_killed_crash_monitor_is_replaced_by_one_that_answers() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    create_missing_private_folders(&home.run_folder.folder_path).expect("the run folder is made");
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let socket_path = home.monitor_socket_path();
    let deadline = tokio::time::Instant::now() + TEST_WAIT;
    let monitor = CrashMonitor::start(&spawner, &home.daemon_program, socket_path.clone());
    let mut progress = monitor.progress();
    let killed_id = tokio::time::timeout(
        FIRST_CONNECT_WAIT,
        progress.wait_for(|progress| progress.connected >= 1),
    )
    .await
    .expect("the first monitor answers")
    .expect("the watch counts it")
    .newest_child_id
    .expect("the monitor runs");
    let killed_client = panic_monitor().expect("panics go to the first monitor");

    let killed = pin_running_process(killed_id)
        .expect("the monitor reads")
        .expect("the monitor runs");
    assert!(
        killed.kill().expect("the kill is sent"),
        "the monitor was running when killed"
    );
    tokio::time::timeout_at(deadline, killed.wait_for_end())
        .await
        .expect("the killed monitor ends")
        .expect("the wait for its end reads");
    tokio::time::timeout_at(
        deadline,
        progress.wait_for(|progress| progress.connected >= 2),
    )
    .await
    .expect("the watch connects to a new monitor")
    .expect("the watch counts it");
    let new_client = panic_monitor().expect("panics go to a monitor");
    assert!(
        !Arc::ptr_eq(&killed_client, &new_client),
        "panics go to the new monitor"
    );
    let connect_stop = CancellationToken::new();
    let give_up = connect_stop.clone();
    let give_up_at = deadline.min(tokio::time::Instant::now() + OWN_CONNECT_WAIT);
    tokio::spawn(async move {
        tokio::time::sleep_until(give_up_at).await;
        give_up.cancel();
    });
    let client =
        tokio::task::spawn_blocking(move || connect_crash_monitor(&socket_path, &connect_stop))
            .await
            .expect("the connect ends")
            .expect("a new monitor answers");

    let failures = monitor.end().await;
    drop(client);
    assert!(failures.is_empty(), "{failures:?}");
}
