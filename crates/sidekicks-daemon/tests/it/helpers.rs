//! What several of the integration tests' behaviors share: the daemon's own program, the spawner
//! its modes start on, a terminal's output kept whole with no screen listener, and its service run
//! on a home of the test's.

use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use alacritty_terminal::event::EventListener;
use sidekicks_contracts::daemon::lifecycle::DAEMON_READY_LINE;
use sidekicks_daemon::program::ISOLATED_SERVICE_MODE;
use sidekicks_platforms::{DaemonRunFolder, PathRules, Spawner};
use sidekicks_store::data_folder::data_folder;
use sidekicks_terminal::{OutputFilter, ScreenListener};
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::Child;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

/// The path of the daemon's own program, whose modes the tests run.
pub(crate) const DAEMON_PROGRAM: &str = env!("CARGO_BIN_EXE_sidekicks-daemon");

/// The longest a service the tests run may take to start or to end.
pub(crate) const SERVICE_RUN_BOUND: Duration = Duration::from_secs(60);

/// The daemon's own program, as the path a mode's start takes.
pub(crate) fn daemon_program() -> PathBuf {
    PathBuf::from(DAEMON_PROGRAM)
}

/// A spawner on the test's runtime. Panics when its thread does not start.
pub(crate) fn spawner() -> Spawner {
    Spawner::new(Handle::current()).expect("the spawner thread starts")
}

/// A terminal output filter that keeps every byte of the output.
pub(crate) struct KeepAllOutput;

impl OutputFilter for KeepAllOutput {
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
        kept.extend_from_slice(chunk);
    }

    fn finish(&mut self, _kept: &mut Vec<u8>) {}
}

/// A screen-copy listener that hears nothing and answers nothing.
#[derive(Clone)]
pub(crate) struct NoListener;

impl EventListener for NoListener {}

impl ScreenListener for NoListener {
    fn find_questions(&mut self, _output: &[u8], _ends: &mut Vec<usize>) {}

    fn answer_question(&mut self) {}
}

/// A temporary home under `/tmp`, short enough that the run folder's sockets in it fit the
/// system's bound on a socket's path.
pub(crate) fn short_home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("home")
        .tempdir_in("/tmp")
        .expect("a temporary home")
}

/// Starts the daemon's program as the service on `home`, its data and run folders there, apart
/// from the account: it runs no login shell and keeps its secrets in the plain items file there,
/// never the account's keychain. Its standard output and standard error are piped; the process is
/// killed when the child is dropped. Panics when the program does not start.
pub(crate) fn start_service(home: &Path) -> Child {
    tokio::process::Command::new(DAEMON_PROGRAM)
        .arg(ISOLATED_SERVICE_MODE)
        .env(PathRules::NATIVE.home_environment_name(), home)
        .env_remove("XDG_RUNTIME_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("the service's program runs")
}

/// Runs the daemon's program as the service on `home`, as [`start_service`] starts it, and answers
/// how it ended. Panics when it runs past its bound, the process killed.
pub(crate) async fn run_service(home: &Path) -> Output {
    tokio::time::timeout(SERVICE_RUN_BOUND, start_service(home).wait_with_output())
        .await
        .expect("the service ends within its bound")
        .expect("the service's output reads")
}

/// The run folder of the service run on `home`: its socket, token and status file, in the data
/// folder there.
pub(crate) fn service_run_folder(home: &Path) -> DaemonRunFolder {
    let folder_path = data_folder(home).join("run");
    DaemonRunFolder {
        socket_path: folder_path.join("daemon.sock"),
        token_path: folder_path.join("daemon.token"),
        status_path: folder_path.join("service-status.json"),
        folder_path,
    }
}

/// Starts the service on `home` as [`start_service`] does and waits for its ready line; answers
/// the service with its whole standard error, read to its end on a task of its own so no write of
/// it blocks. Panics when the service ends before it is ready or is not ready within its bound.
pub(crate) async fn start_ready_service(home: &Path) -> (Child, JoinHandle<String>) {
    let mut service = start_service(home);
    let mut lines = BufReader::new(service.stderr.take().expect("standard error is piped")).lines();
    let mut start_lines = String::new();
    let is_ready = tokio::time::timeout(SERVICE_RUN_BOUND, async {
        while let Some(line) = lines.next_line().await.expect("standard error reads") {
            start_lines.push_str(&line);
            start_lines.push('\n');
            if line.contains(DAEMON_READY_LINE) {
                return true;
            }
        }
        false
    })
    .await
    .expect("the service is ready within its bound");
    assert!(
        is_ready,
        "the service ended before it was ready: {start_lines}"
    );
    let standard_error = tokio::spawn(async move {
        let mut whole = start_lines;
        while let Some(line) = lines.next_line().await.expect("standard error reads") {
            whole.push_str(&line);
            whole.push('\n');
        }
        whole
    });
    (service, standard_error)
}
