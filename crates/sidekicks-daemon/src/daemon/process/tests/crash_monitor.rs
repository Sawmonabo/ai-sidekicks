use std::time::Duration;

use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, Spawner, create_missing_private_folders, pin_running_process,
};

use super::TestHome;
use crate::daemon::crash::monitor::{CONNECT_BOUND, connect_crash_monitor};
use crate::daemon::process::crash_monitor::CrashMonitor;

// The longest the test waits for the killed monitor to end.
const END_WAIT: Duration = Duration::from_secs(10);

// The longest the test waits for the watch to connect to a new monitor: the first gap after the
// killed monitor's attempt, then the connect's own bound, with room to spare.
const RESTART_WAIT: Duration = CONNECT_BOUND.saturating_mul(3);

// A crash monitor whose child is killed is replaced: once the killed one has ended, so its socket
// answers no more, the watch connects to a new monitor, which then answers the test's own connect
// too, and the end fails nothing. The test's connection stays up until the end, so its disconnect
// never ends the new monitor. Killed by a watch that never starts or never connects to a new
// monitor and by no watch at all.
#[tokio::test(flavor = "multi_thread")]
async fn a_killed_crash_monitor_is_replaced_by_one_that_answers() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    create_missing_private_folders(&home.run_folder.folder_path).expect("the run folder is made");
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let socket_path = home.monitor_socket_path();
    let mut monitor = CrashMonitor::spawn(&spawner, &home.daemon_program, socket_path.clone())
        .await
        .expect("the monitor starts");
    let killed_id = monitor.unwatched_child_id().expect("the monitor runs");
    monitor.connect().await.expect("the monitor answers");
    let mut restarted = monitor.restarted_count().expect("the monitor is watched");

    let killed = pin_running_process(killed_id)
        .expect("the monitor reads")
        .expect("the monitor runs");
    assert!(
        killed.kill().expect("the kill is sent"),
        "the monitor was running when killed"
    );
    tokio::time::timeout(END_WAIT, killed.wait_for_end())
        .await
        .expect("the killed monitor ends")
        .expect("the wait for its end reads");
    tokio::time::timeout(RESTART_WAIT, restarted.wait_for(|count| *count >= 1))
        .await
        .expect("the watch connects to a new monitor")
        .expect("the watch counts it");
    let client = tokio::task::spawn_blocking(move || connect_crash_monitor(&socket_path))
        .await
        .expect("the connect ends")
        .expect("a new monitor answers");

    let failures = monitor.end().await;
    drop(client);
    assert!(failures.is_empty(), "{failures:?}");
}
