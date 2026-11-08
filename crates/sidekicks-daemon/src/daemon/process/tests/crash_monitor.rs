use std::time::Duration;

use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, Spawner, create_missing_private_folders, pin_running_process,
};

use super::TestHome;
use crate::daemon::crash::monitor::connect_crash_monitor;
use crate::daemon::process::crash_monitor::CrashMonitor;

// The longest the test waits for the killed monitor to end.
const END_WAIT: Duration = Duration::from_secs(10);

// A crash monitor whose child is killed is replaced: once the killed one has ended, so its socket
// answers no more, a new monitor answers there within the connect's bound, and the end then fails
// nothing. The test's own connection stays up until the end, so its disconnect never ends the new
// monitor. Killed by a watch that never starts a new monitor, by a restart bound that admits none
// and by no watch at all, where the connect finds no monitor.
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
    let client = tokio::task::spawn_blocking(move || connect_crash_monitor(&socket_path))
        .await
        .expect("the connect ends")
        .expect("a new monitor answers");

    let failures = monitor.end().await;
    drop(client);
    assert!(failures.is_empty(), "{failures:?}");
}
