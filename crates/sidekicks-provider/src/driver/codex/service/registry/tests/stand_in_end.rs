use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use futures::future::join_all;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, short_socket_folder};
use tokio::io::{AsyncBufReadExt as _, BufReader};

use super::stand_in::{CRASH_WAIT, stand_in_services, this_daemon};
use crate::driver::codex::lifecycle::CODEX_SERVICE_STARTUP_TIMEOUT;
use crate::driver::codex::service::supervisor::test_service::StandInLaunches;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The test the killed test program runs: it launches a lasting stand-in and waits for its input
/// to end.
const LAUNCHING_TEST: &str =
    "driver::codex::service::registry::tests::stand_in_end::a_test_killed_while_its_service_runs";

/// The folder the launching test runs its services under; only the test that kills it sets it.
const LAUNCH_FOLDER_NAME: &str = "SIDEKICKS_TEST_LAUNCH_FOLDER";

/// The line the launching test writes once its service started.
const SERVICE_STARTED: &str = "the stand-in service started";

// Launches a lasting stand-in on the folder its killer names, says so and waits until its input
// ends, which the killer holds open while it runs, so the killer's end by any signal ends it too.
// Skips unless that test started it.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "run only by the test that kills it"]
async fn a_test_killed_while_its_service_runs() {
    let Some(folder) = std::env::var_os(LAUNCH_FOLDER_NAME).map(PathBuf::from) else {
        return;
    };
    let services = stand_in_services(&folder, |program| Arc::new(program));
    let daemon = this_daemon(&services);
    daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves")
        .ensure_started(services.dependencies.startup_timeout)
        .await
        .expect("the service starts");
    writeln!(std::io::stdout().lock(), "{SERVICE_STARTED}").expect("the start is told");
    tokio::io::copy(&mut tokio::io::stdin(), &mut tokio::io::sink())
        .await
        .expect("the input reads");
}

// Fails when a stand-in Codex service outlives the test program that launched it once that
// program is killed, where no drop runs: a lasting service runs in a session of its own, so
// nothing else ends it.
#[tokio::test(flavor = "multi_thread")]
async fn a_stand_in_ends_once_the_test_that_launched_it_is_killed() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    // Ends a stand-in this test leaves running, whatever the assertions find.
    let launches = StandInLaunches::in_folder(folder.path());
    let mut launching = tokio::process::Command::new(
        std::env::current_exe().expect("the test program names itself"),
    )
    .args([
        "--exact",
        LAUNCHING_TEST,
        "--include-ignored",
        "--nocapture",
    ])
    .env(LAUNCH_FOLDER_NAME, folder.path())
    // Kept open on `launching` while this test runs; its close ends the launching test.
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true)
    .spawn()
    .expect("the launching test starts");
    let mut lines = BufReader::new(launching.stdout.take().expect("its output is piped")).lines();
    let is_started = tokio::time::timeout(CODEX_SERVICE_STARTUP_TIMEOUT, async {
        while let Some(line) = lines.next_line().await.expect("its output reads") {
            if line == SERVICE_STARTED {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    // A kill, so no drop of the launching test runs.
    launching
        .kill()
        .await
        .expect("the launching test is killed");
    let launched = launches.read().expect("the launches read");
    let ended = join_all(launched.iter().map(|launch| async {
        let Some(process) = launch.process.pin().expect("the process table reads") else {
            return true;
        };
        tokio::time::timeout(CRASH_WAIT, process.wait_for_end())
            .await
            .is_ok_and(|ended| {
                ended.expect("the process's end is watched");
                true
            })
    }))
    .await;

    assert!(is_started, "the launching test started no service");
    assert_eq!(
        ended,
        [true],
        "the stand-in outlived the test that launched it"
    );
}
