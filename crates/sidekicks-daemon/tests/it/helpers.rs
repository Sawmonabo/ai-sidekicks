//! What several of the integration tests' behaviors share: the daemon's own program, the spawner
//! its modes start on, and its service run on a home of the test's.

use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use sidekicks_platforms::{PathRules, Spawner};
use tokio::process::Child;
use tokio::runtime::Handle;

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

/// A temporary home under `/tmp`, short enough that the run folder's sockets in it fit the
/// system's bound on a socket's path.
pub(crate) fn short_home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("home")
        .tempdir_in("/tmp")
        .expect("a temporary home")
}

/// Starts the daemon's program as the service on `home`, its data and run folders there, its
/// standard output and standard error piped; the process is killed when the child is dropped.
/// Panics when the program does not start.
pub(crate) fn start_service(home: &Path) -> Child {
    tokio::process::Command::new(DAEMON_PROGRAM)
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
