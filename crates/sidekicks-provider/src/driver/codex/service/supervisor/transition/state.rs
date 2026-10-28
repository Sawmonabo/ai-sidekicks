//! Where one service's supervisor stands, and what follows a stop under way.

use std::time::{Instant, SystemTime};

use crate::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::driver::codex::service::supervisor::transition::action::LastingServiceEnd;

/// Where one service stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SupervisorState {
    /// Nothing runs and nothing is starting.
    Stopped,
    /// A start is under way.
    Starting {
        /// The start's ticket.
        launch: u64,
        /// Why the conversations on the service need resuming once it is up, when they do.
        recovery: Option<CodexServiceRecoveryCause>,
    },
    /// The service runs and the daemon's connection is open.
    Up {
        /// The ticket of the start whose process runs.
        launch: u64,
        /// The ticket of the open connection.
        dial: u64,
        /// How many redials the drops since the last stable connection made, 0 for a start; the
        /// next drop's wait grows from it.
        attempt: u32,
        /// When the connection came up.
        since: Instant,
        /// Codex's words once it answered that it drains toward its exit: new work is refused,
        /// reads and interrupts go on.
        draining: Option<String>,
        /// The ticket of the silence watch running since a request on the connection went
        /// unanswered, until the service sends anything.
        silence: Option<u64>,
    },
    /// The connection dropped while the service runs; a redial is waiting or under way, and it
    /// never gives up.
    Reconnecting {
        /// The ticket of the start whose process runs.
        launch: u64,
        /// The ticket of the redial under way.
        dial: u64,
        /// How many redials came before this one since the last stable connection, which its wait
        /// grows from.
        attempt: u32,
        /// The ticket of the silence watch running since the service last answered, `None` for a
        /// service the daemon joined, which is never ended.
        silence: Option<u64>,
    },
    /// The process ended on its own and the crash window's wait runs before the next start.
    Restarting {
        /// The wait's ticket.
        wait: u64,
    },
    /// The process ended too many times in the crash window; it stays down until the person's
    /// restart.
    CrashLoop,
    /// A stop is under way.
    Stopping {
        /// The ticket of the start whose process is stopping.
        launch: u64,
        /// What follows once it has stopped.
        then: StoppingThen,
        /// What becomes of a terminal service's lasting process.
        end: LastingServiceEnd,
    },
    /// Shut down with the daemon; nothing starts it again.
    ShutDown,
}

/// What follows a stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoppingThen {
    /// Nothing.
    Stopped,
    /// A fresh start.
    Starting,
    /// The service is shut down for good.
    ShutDown,
    /// The crash of a service the daemon ended for answering nothing.
    SilentEnd {
        /// When the silence ran out, on the wall clock.
        at: SystemTime,
    },
}

impl SupervisorState {
    /// The ticket of the silence watch the state runs, where it runs one.
    pub(crate) fn silence_ticket(&self) -> Option<u64> {
        match self {
            Self::Up { silence, .. } | Self::Reconnecting { silence, .. } => *silence,
            Self::Stopped
            | Self::Starting { .. }
            | Self::Restarting { .. }
            | Self::CrashLoop
            | Self::Stopping { .. }
            | Self::ShutDown => None,
        }
    }
}
