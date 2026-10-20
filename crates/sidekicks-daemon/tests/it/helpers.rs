//! What several of the integration tests' behaviors share: the daemon's own program and the
//! spawner its modes start on.

use std::path::PathBuf;

use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;

/// The path of the daemon's own program, whose modes the tests run.
pub(crate) const DAEMON_PROGRAM: &str = env!("CARGO_BIN_EXE_sidekicks-daemon");

/// The daemon's own program, as the path a mode's start takes.
pub(crate) fn daemon_program() -> PathBuf {
    PathBuf::from(DAEMON_PROGRAM)
}

/// A spawner on the test's runtime. Panics when its thread does not start.
pub(crate) fn spawner() -> Spawner {
    Spawner::new(Handle::current()).expect("the spawner thread starts")
}
