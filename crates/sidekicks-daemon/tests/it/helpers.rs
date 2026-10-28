//! What several of the integration tests' behaviors share: the daemon's own program, the spawner
//! its modes start on, and its service run on a home of the test's.

use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;

/// The path of the daemon's own program, whose modes the tests run.
pub(crate) const DAEMON_PROGRAM: &str = env!("CARGO_BIN_EXE_sidekicks-daemon");

/// The longest a service the tests run may take to end, so one that starts in full fails the test.
const SERVICE_RUN_BOUND: Duration = Duration::from_secs(60);

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

/// Runs the daemon's program as the service on `home`, its data and run folders there, and
/// answers how it ended. Panics when it runs past its bound, the process killed.
pub(crate) async fn run_service(home: &Path) -> Output {
    let service = tokio::process::Command::new(DAEMON_PROGRAM)
        .env("HOME", home)
        .env_remove("XDG_RUNTIME_DIR")
        .kill_on_drop(true)
        .output();
    tokio::time::timeout(SERVICE_RUN_BOUND, service)
        .await
        .expect("the service ends within its bound")
        .expect("the service's program runs")
}
