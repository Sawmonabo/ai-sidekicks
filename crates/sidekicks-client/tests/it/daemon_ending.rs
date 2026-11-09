//! Ending the daemon for a stop: a daemon that takes the stop and never exits is ended only once
//! the drain bound has passed, with the grace before the kill, and a process whose identity no
//! longer matches the one the daemon named is never ended; a daemon on a protocol this client
//! cannot speak, which refuses every mutating call, is ended at once with a grace that covers the
//! drain, its identity read from a status this client cannot otherwise read. A daemon repairing
//! its database file is stopped on the link it refused, and the ending waits until that link
//! closes and its socket stops answering. A `stopping` record is removed once its process has
//! ended.

use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use interprocess::local_socket::tokio::Stream;
use serde_json::{Value, json};
use sidekicks_client::daemon_connection::DaemonEndpoint;
use sidekicks_client::daemon_ending::{
    DaemonEnd, DaemonEndingError, DaemonEndingTerms, DaemonEndingVerb, end_daemon,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_platforms::{ChildEnd, DaemonRunFolder, PinnedProcess};
use sidekicks_std::mutex_lock::lock;
use tokio::task::JoinHandle;

use crate::helpers::{PATIENCE, ScriptedDaemon, accept, listen, run_folder};

/// The token the stand-in daemon wrote.
const TOKEN: &str = "ending-token";

/// The stand-in daemon's drain bound, short so the test runs on the real clock.
const DRAIN_BOUND: Duration = Duration::from_millis(600);

/// The grace before the kill.
const KILL_GRACE: Duration = Duration::from_millis(300);

/// How long the stop may take to cross the socket after the client noted its send.
const TRANSIT_SLACK: Duration = Duration::from_millis(50);

/// The process the stand-in daemon runs as: this test program, run again on the ignored test
/// below, which only waits. Killed and reaped when dropped, whether the test passed or not.
struct StandInProcess {
    child: Child,
}

impl StandInProcess {
    fn start() -> Self {
        let program = std::env::current_exe().expect("the test program's path");
        let child = Command::new(program)
            .args([
                "--exact",
                "daemon_ending::a_daemon_process_that_never_exits",
                "--ignored",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the stand-in process starts");
        Self { child }
    }

    /// The process's identity as the daemon would report it.
    fn identity(&self) -> Value {
        let identity = sidekicks_platforms::process_identity(self.child.id())
            .expect("the stand-in's identity reads")
            .expect("the stand-in runs");
        serde_json::to_value(identity).expect("an identity writes as JSON")
    }

    fn is_running(&mut self) -> bool {
        self.child
            .try_wait()
            .expect("the stand-in's state reads")
            .is_none()
    }
}

impl Drop for StandInProcess {
    fn drop(&mut self) {
        // A stand-in the ending already ended cannot be killed again, and needs nothing more.
        match self.child.kill().and_then(|()| self.child.wait()) {
            Ok(_) | Err(_) => {}
        }
    }
}

#[test]
#[ignore = "the process a stand-in daemon runs as, which the ending tests start"]
fn a_daemon_process_that_never_exits() {
    std::thread::sleep(Duration::from_secs(60));
}

/// One call of the ending: when, which process and with which grace.
struct EndCall {
    at: Instant,
    process_id: u32,
    grace: Duration,
}

/// The test's bounds, and the real ending of the daemon's process with each call recorded.
fn recording_terms() -> (DaemonEndingTerms, Arc<Mutex<Vec<EndCall>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&calls);
    let terms = DaemonEndingTerms {
        flush_wait: PATIENCE,
        drain_bound: DRAIN_BOUND,
        kill_grace: KILL_GRACE,
        end_process: Arc::new(move |process: &PinnedProcess, grace| {
            lock(&recorded).push(EndCall {
                at: Instant::now(),
                process_id: process.id(),
                grace,
            });
            process.stop_sparing_lasting_sessions(grace)
        }),
    };
    (terms, calls)
}

/// A private run folder in a temporary folder, its token written.
fn stand_in_run_folder(folder: &tempfile::TempDir) -> DaemonRunFolder {
    let private = folder.path().join("run");
    sidekicks_platforms::create_private_folder(&private).expect("the run folder is made private");
    let run_folder = run_folder(&private, &private);
    std::fs::write(&run_folder.token_path, TOKEN).expect("the token is written");
    run_folder
}

fn start_stop(
    run_folder: &DaemonRunFolder,
    terms: &DaemonEndingTerms,
) -> JoinHandle<Result<DaemonEnd, DaemonEndingError>> {
    let endpoint = DaemonEndpoint::new(run_folder.clone());
    let terms = terms.clone();
    tokio::spawn(async move { end_daemon(endpoint, DaemonEndingVerb::Stop, &terms).await })
}

async fn ended(ending: JoinHandle<Result<DaemonEnd, DaemonEndingError>>) -> DaemonEnd {
    tokio::time::timeout(PATIENCE, ending)
        .await
        .expect("the ending ends")
        .expect("the ending task runs")
        .expect("the ending succeeds")
}

/// Answers the status read with `status`, after checking it is the next call.
async fn answer_status(daemon: &mut ScriptedDaemon<Stream>, status: Value) {
    let request = daemon.next_message().await;
    assert_eq!(request["method"], "daemon.status.read");
    daemon.answer(&request["id"], status).await;
}

/// Serves a compatible daemon that names `identity`, flushes and takes the stop, never exiting;
/// answers when the stop arrived.
async fn take_stop(daemon: &mut ScriptedDaemon<Stream>, identity: Value) -> Instant {
    daemon.answer_initialize_with_token(TOKEN).await;
    answer_status(daemon, json!({ "processIdentity": identity })).await;
    let flush = daemon.next_message().await;
    assert_eq!(flush["method"], "daemon.flush");
    daemon
        .answer(&flush["id"], json!({ "flushed": true }))
        .await;
    let stop = daemon.next_message().await;
    let stop_at = Instant::now();
    assert_eq!(stop["method"], "daemon.stop");
    daemon
        .answer(&stop["id"], json!({ "accepted": true }))
        .await;
    stop_at
}

fn take_calls(calls: &Mutex<Vec<EndCall>>) -> Vec<EndCall> {
    std::mem::take(&mut *lock(calls))
}

#[tokio::test]
async fn a_daemon_that_takes_the_stop_and_stays_is_ended_after_the_drain_and_only_by_identity() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let run_folder = stand_in_run_folder(&folder);
    let listener = listen(&run_folder);
    let mut process = StandInProcess::start();
    let identity = process.identity();
    let (terms, calls) = recording_terms();

    // The daemon names a process that holds the stand-in's id but started at another time.
    let mut other_identity = identity.clone();
    let start = other_identity["processStartTime"]
        .as_str()
        .expect("the start is text")
        .to_owned();
    other_identity["processStartTime"] = Value::String(format!("{start}0"));
    let ending = start_stop(&run_folder, &terms);
    let mut daemon = accept(&listener).await;
    take_stop(&mut daemon, other_identity).await;
    assert_eq!(ended(ending).await, DaemonEnd::ProcessNotFound);
    assert!(
        take_calls(&calls).is_empty(),
        "a process the identity does not name was ended"
    );
    assert!(
        process.is_running(),
        "a process the identity does not name ended"
    );

    let ending = start_stop(&run_folder, &terms);
    let mut daemon = accept(&listener).await;
    let stop_at = take_stop(&mut daemon, identity).await;
    assert_eq!(ended(ending).await, DaemonEnd::Ended(ChildEnd::Stop));
    let calls = take_calls(&calls);
    let [call] = calls.as_slice() else {
        panic!("the process was ended {} times", calls.len());
    };
    assert_eq!(call.process_id, process.child.id());
    assert!(
        call.at.duration_since(stop_at) + TRANSIT_SLACK >= DRAIN_BOUND,
        "the process was signaled {:?} after the stop, within the drain bound",
        call.at.duration_since(stop_at)
    );
    assert_eq!(call.grace, KILL_GRACE);
    assert!(!process.is_running(), "the ended process still runs");
}

#[tokio::test]
async fn a_daemon_on_another_protocol_is_ended_at_once_from_its_identity_read_raw() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let run_folder = stand_in_run_folder(&folder);
    let listener = listen(&run_folder);
    let mut process = StandInProcess::start();
    let (terms, calls) = recording_terms();

    let ending = start_stop(&run_folder, &terms);
    let mut daemon = accept(&listener).await;
    daemon.answer_initialize_incompatibly(TOKEN).await;
    // A newer daemon's status, which this client's status type does not read.
    let status = json!({
        "processIdentity": process.identity(),
        "processState": "aStateOfANewerService",
        "addedLater": { "count": 1 },
    });
    answer_status(&mut daemon, status).await;
    let answered_at = Instant::now();
    let mut mutating_calls = Vec::new();
    while let Some(request) = daemon.next_message_or_close().await {
        mutating_calls.push(request["method"].clone());
        daemon
            .refuse(&request["id"], RefusalCode::ConnectionVersionMismatch)
            .await;
    }
    assert_eq!(ended(ending).await, DaemonEnd::Ended(ChildEnd::Stop));
    assert!(
        mutating_calls.is_empty(),
        "calls the daemon refuses were sent: {mutating_calls:?}"
    );
    let calls = take_calls(&calls);
    let [call] = calls.as_slice() else {
        panic!("the process was ended {} times", calls.len());
    };
    assert_eq!(call.process_id, process.child.id());
    assert!(
        call.at.duration_since(answered_at) < DRAIN_BOUND,
        "the process was ended {:?} after its status, not at once",
        call.at.duration_since(answered_at)
    );
    assert_eq!(call.grace, DRAIN_BOUND + KILL_GRACE);
    assert!(!process.is_running(), "the ended process still runs");
}

// Fails when the ending of a repairing daemon answers once the daemon took the stop, before the
// daemon closed its link or while its socket still answers, so the start that follows meets it.
#[tokio::test]
async fn a_repairing_daemon_s_stop_ends_only_once_its_socket_stops_answering() {
    const LINGER: Duration = Duration::from_millis(300);
    let folder = tempfile::tempdir().expect("a temporary folder");
    let run_folder = stand_in_run_folder(&folder);
    let listener = listen(&run_folder);
    let (terms, _calls) = recording_terms();
    let terms = DaemonEndingTerms {
        drain_bound: PATIENCE,
        ..terms
    };

    let mut ending = start_stop(&run_folder, &terms);
    let mut daemon = accept(&listener).await;
    let initialize = daemon.next_message().await;
    daemon
        .refuse_with_fields(
            &initialize["id"],
            RefusalCode::DaemonRepairing,
            json!({ "progress": { "done": 1, "total": 2 } }),
        )
        .await;
    let stop = daemon.next_message().await;
    assert_eq!(stop["method"], "daemon.stop");
    daemon
        .answer(&stop["id"], json!({ "accepted": true }))
        .await;
    let is_ended_with_link_open = tokio::time::timeout(LINGER, &mut ending).await.is_ok();
    drop(daemon);
    let is_ended_while_listening = tokio::time::timeout(LINGER, &mut ending).await.is_ok();
    drop(listener);
    let end = ended(ending).await;

    assert!(
        !is_ended_with_link_open,
        "the ending answered before the daemon closed its link"
    );
    assert!(
        !is_ended_while_listening,
        "the ending answered while the socket still answered"
    );
    assert_eq!(end, DaemonEnd::StoppedWhileRepairing);
}

/// A `stopping` record naming `identity`, begun long before now.
fn stopping_record(identity: &Value) -> String {
    json!({
        "stopping": {
            "step": "searchIndex",
            "stopStarted": "2026-11-03T23:00:00.000Z",
            "process": identity,
        }
    })
    .to_string()
}

// Fails when a `stopping` record outlives the process it names, which a reader would show as a
// stop under way forever, or when the record of a process still running is removed.
#[tokio::test]
async fn the_ending_removes_a_stopping_record_only_once_its_process_has_ended() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let run_folder = stand_in_run_folder(&folder);
    let (terms, _calls) = recording_terms();
    let mut ended_process = StandInProcess::start();
    let ended_identity = ended_process.identity();
    ended_process.child.kill().expect("the stand-in is killed");
    ended_process.child.wait().expect("the stand-in is reaped");
    let running_process = StandInProcess::start();
    let running_identity = running_process.identity();

    std::fs::write(&run_folder.status_path, stopping_record(&running_identity))
        .expect("the status file is written");
    assert_eq!(
        ended(start_stop(&run_folder, &terms)).await,
        DaemonEnd::NotRunning
    );
    let kept = std::fs::read_to_string(&run_folder.status_path);
    std::fs::write(&run_folder.status_path, stopping_record(&ended_identity))
        .expect("the status file is written");
    assert_eq!(
        ended(start_stop(&run_folder, &terms)).await,
        DaemonEnd::NotRunning
    );

    assert_eq!(
        kept.ok(),
        Some(stopping_record(&running_identity)),
        "the record of a process still running was removed"
    );
    assert!(
        !run_folder.status_path.exists(),
        "the record of a process that has ended was kept"
    );
}
