//! The seam between a Claude session and the process that runs it: the control requests the daemon
//! sends and their answers, the requests the process sends and the daemon's answers, the user
//! messages it reads, the reads of a short control-only process, and the channel that carries them.

use std::time::Duration;

pub(crate) mod channel;
pub(crate) mod control;
pub(crate) mod inbound;
pub(crate) mod readings;
pub(crate) mod user_message;

/// How long a request to the Claude Code process, a control request or an input write, waits for
/// its answer before it is withdrawn.
pub(crate) const CLAUDE_REQUEST_DEADLINE: Duration = Duration::from_secs(60);
