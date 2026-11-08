use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{ProgramStart, Spawner};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

use super::{
    ClaudeCodeProcess, ClaudeOutputReader, ClaudeProcessAccount, ClaudeProcessEnd,
    ClaudeProcessLaunch, ClaudeProcessListener, ClaudeStreamFrame, wait_out_startup_deadline,
};
use crate::driver::child_records::{DaemonChildRecords, SPAWN_NONCE_ENVIRONMENT_NAME};
use crate::driver::claude::session::control_requests::ClaudeControlRequests;
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::ports::DriverPorts;
use crate::process_registry::ProviderProcessRegistry;

/// The nonce the recording records hand every child.
const NONCE: &str = "claude-child-nonce";

/// One call the daemon's child records took, in order.
#[derive(Debug, PartialEq, Eq)]
enum ChildRecordCall {
    Prepared,
    Completed(String, u32),
    Retired(String),
}

/// Child records that keep every call they take.
#[derive(Default)]
struct RecordingChildren(Mutex<Vec<ChildRecordCall>>);

impl RecordingChildren {
    fn push(&self, call: ChildRecordCall) {
        self.0.lock().expect("the calls are writable").push(call);
    }
}

impl DaemonChildRecords for RecordingChildren {
    fn prepare_spawn(&self) -> BoxFuture<'_, Result<String, Box<dyn Error + Send + Sync>>> {
        self.push(ChildRecordCall::Prepared);
        Box::pin(async { Ok(NONCE.to_owned()) })
    }

    fn complete_spawn<'call>(
        &'call self,
        nonce: &'call str,
        process_id: u32,
    ) -> BoxFuture<'call, Result<(), Box<dyn Error + Send + Sync>>> {
        self.push(ChildRecordCall::Completed(nonce.to_owned(), process_id));
        Box::pin(async { Ok(()) })
    }

    fn retire<'call>(&'call self, nonce: &'call str) -> BoxFuture<'call, ()> {
        self.push(ChildRecordCall::Retired(nonce.to_owned()));
        Box::pin(async {})
    }
}

// Killed by a Claude Code process started with no record, which the next start's sweep would
// never end after a daemon crash, and by a record never retired at its reap.
#[tokio::test(flavor = "multi_thread")]
async fn a_claude_code_process_is_recorded_from_its_start_to_its_reap() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let nonce_file = folder.path().join("nonce");
    let records = Arc::new(RecordingChildren::default());
    let child_records: Arc<dyn DaemonChildRecords> = records.clone();
    let spawner =
        Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts");
    let launch = ClaudeProcessLaunch {
        start: ProgramStart {
            program: PathBuf::from("/bin/sh"),
            leading_arguments: Vec::new(),
        },
        arguments: vec![
            "-c".to_owned(),
            format!(
                "printf '%s' \"${SPAWN_NONCE_ENVIRONMENT_NAME}\" > '{}'",
                nonce_file.display()
            ),
        ],
        environment: Vec::new(),
        working_folder: folder.path().to_owned(),
        provider_session_id: "conversation".to_owned(),
        account: ClaudeProcessAccount::default(),
        token: None,
    };

    let process = ClaudeCodeProcess::start(
        &spawner,
        &child_records,
        &ProviderProcessRegistry::default(),
        launch,
        Arc::new(NoSession::default()),
        None,
        DriverPorts::new().raw_provider_messages,
    )
    .await
    .expect("the process starts");
    let ended = tokio::time::timeout(Duration::from_secs(10), process.exited())
        .await
        .expect("the process ends in time");

    assert!(ended.is_ok(), "{ended:?}");
    assert_eq!(
        *records.0.lock().expect("the calls are readable"),
        [
            ChildRecordCall::Prepared,
            ChildRecordCall::Completed(NONCE.to_owned(), process.identity().process_id),
            ChildRecordCall::Retired(NONCE.to_owned()),
        ]
    );
    assert_eq!(
        std::fs::read_to_string(&nonce_file).expect("the child wrote its nonce"),
        NONCE
    );
}

// Killed by a `stop` that asks no kill at `kill_at`: the process then ends only once the owner's
// grace after the stop ask passes, 5 s on, past the deadline's margin.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_with_a_deadline_kills_a_process_that_ignores_its_input_and_its_stop() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let child_records: Arc<dyn DaemonChildRecords> = Arc::new(RecordingChildren::default());
    let spawner =
        Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts");
    let launch = ClaudeProcessLaunch {
        start: ProgramStart {
            program: PathBuf::from("/bin/sh"),
            leading_arguments: Vec::new(),
        },
        // Ignores the stop ask, then says so in one frame, and never reads its input; each short
        // sleep keeps the error output held open at most briefly once the shell is killed.
        arguments: vec![
            "-c".to_owned(),
            r#"trap '' TERM; echo '{"type":"system"}'; while :; do sleep 0.1; done"#.to_owned(),
        ],
        environment: vec![("PATH".to_owned(), "/bin:/usr/bin".to_owned())],
        working_folder: folder.path().to_owned(),
        provider_session_id: "conversation".to_owned(),
        account: ClaudeProcessAccount::default(),
        token: None,
    };
    let listener = Arc::new(NoSession::default());
    let process = ClaudeCodeProcess::start(
        &spawner,
        &child_records,
        &ProviderProcessRegistry::default(),
        launch,
        Arc::clone(&listener) as Arc<dyn ClaudeProcessListener>,
        None,
        DriverPorts::new().raw_provider_messages,
    )
    .await
    .expect("the process starts");
    // Its first frame says the stop's signal is ignored, so the signal cannot win the race.
    tokio::time::timeout(Duration::from_secs(10), listener.frame_printed.notified())
        .await
        .expect("the process ignores the stop's signal");
    let deadline = Instant::now() + Duration::from_millis(500);
    let margin = Duration::from_secs(1);

    process
        .stop(
            deadline.saturating_duration_since(Instant::now()) / 2,
            Some(deadline),
        )
        .await;
    assert!(
        Instant::now() <= deadline + margin,
        "the stop returns by its deadline"
    );
    let ended = tokio::time::timeout_at(deadline + margin, process.exited())
        .await
        .expect("the process ends by its deadline");

    assert!(
        matches!(&ended, Ok(ProcessExit::Signal(exit)) if exit.signal.as_str() == "SIGKILL"),
        "{ended:?}"
    );
}

/// A listener with no session behind it, which only tells when the process printed a frame.
#[derive(Default)]
struct NoSession {
    frame_printed: Notify,
}

impl ClaudeProcessListener for NoSession {
    fn take_frame(&self, _frame: ClaudeStreamFrame) {
        self.frame_printed.notify_one();
    }

    fn take_request(&self, _event: ClaudeInboundRequestEvent) {}

    fn take_exit(&self, _end: ClaudeProcessEnd) {}

    fn is_turn_ending(&self, _frame: &ClaudeStreamFrame) -> bool {
        true
    }
}

async fn settle_tasks() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

// Killed by counting the time a `SessionStart` hook runs against `initialize`'s deadline, and
// by a reader that does not count the hook from its frames.
#[tokio::test(start_paused = true)]
async fn initialize_waits_its_deadline_only_outside_the_startup_hooks() {
    let (startup_hooks, running_hooks) = watch::channel(0);
    let (mut provider, output) = tokio::io::duplex(4096);
    let reader = ClaudeOutputReader::new(
        ClaudeControlRequests::new(Arc::new(|_request_id: &str| {})),
        Arc::new(NoSession::default()),
        None,
        startup_hooks,
        Weak::new(),
        "conversation".to_owned(),
        ClaudeProcessAccount::default(),
    );
    let reading = tokio::spawn(reader.read(output, DriverPorts::new().raw_provider_messages));
    let deadline = tokio::spawn(wait_out_startup_deadline(running_hooks.clone()));
    settle_tasks().await;

    provider
        .write_all(
            b"{\"type\":\"system\",\"subtype\":\"hook_started\",\"hook_id\":\"h1\",\
              \"hook_name\":\"SessionStart:startup\",\"hook_event\":\"SessionStart\"}\n",
        )
        .await
        .expect("the pipe takes the line");
    settle_tasks().await;
    assert_eq!(*running_hooks.borrow(), 1);
    tokio::time::advance(Duration::from_secs(50)).await;
    settle_tasks().await;
    assert!(!deadline.is_finished(), "the hook's time is not counted");

    provider
        .write_all(
            b"{\"type\":\"system\",\"subtype\":\"hook_response\",\"hook_id\":\"h1\",\
              \"hook_event\":\"SessionStart\"}\n",
        )
        .await
        .expect("the pipe takes the line");
    settle_tasks().await;
    assert_eq!(*running_hooks.borrow(), 0);
    tokio::time::advance(Duration::from_secs(50)).await;
    settle_tasks().await;
    assert!(
        !deadline.is_finished(),
        "50 s outside the hook is within the deadline"
    );

    tokio::time::advance(Duration::from_secs(11)).await;
    settle_tasks().await;
    assert!(
        deadline.is_finished(),
        "61 s outside the hook passes the deadline"
    );
    drop(provider);
    reading.await.expect("the reader ends with its output");
}
