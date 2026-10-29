//! The typed daemon client: the command line's, and the desktop's through its Node-API addon in a
//! helper process.

pub mod daemon_connection;
pub mod error;
pub mod terminal_write;
pub mod transport;
pub mod untyped_call;

use std::time::Duration;

/// How long a quit, a stop or a restart waits for the daemon's answer to `daemon.flush` before it
/// goes ahead without it, so a daemon that never answers cannot hold the caller.
pub const DAEMON_FLUSH_WAIT: Duration = Duration::from_secs(10);

/// How long a daemon still running after the terminate signal has before it is killed.
pub const DAEMON_KILL_GRACE: Duration = Duration::from_secs(2);
