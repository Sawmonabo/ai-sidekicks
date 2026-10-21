//! What the runner carries out for one transition of a service's state, in order.

use std::sync::Arc;
use std::time::Duration;

use crate::provider::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::provider::driver::codex::service::supervisor::transition::CodexServiceAvailability;
use crate::provider::driver::codex::session::errors::CodexError;

/// What a stop does with the lasting process of a terminal service, which outlives the daemon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LastingServiceEnd {
    /// It is only disconnected and keeps running in its record, as under a daemon restart.
    Keep,
    /// It is asked to drain, Codex's own graceful end, and ends by itself once its running
    /// replies finish: a service another took the home's link from.
    Drain,
    /// It is asked to stop and killed once the grace runs out.
    Stop,
}

/// What the runner carries out for a transition, in order.
#[derive(Debug)]
pub(crate) enum SupervisorAction {
    /// Starts the service under `launch`, reporting `Started` or `StartFailed`.
    Launch {
        /// The start's ticket.
        launch: u64,
    },
    /// Makes what the start `launch` parked the service's own.
    AdoptStart {
        /// The start's ticket.
        launch: u64,
    },
    /// Makes the connection the redial `dial` parked the service's own.
    AdoptDial {
        /// The redial's ticket.
        dial: u64,
    },
    /// Ends what an outcome under `ticket` parked: its connection closed and its process stopped,
    /// reporting `StopDone`.
    TearDown {
        /// The outcome's ticket.
        ticket: u64,
        /// What becomes of a terminal service it launched.
        end: LastingServiceEnd,
    },
    /// Closes the service's connection; the process stays, or is let go of when it has ended.
    Disconnect {
        /// Whether the process ended, so its handle is let go of too.
        is_process_gone: bool,
    },
    /// Waits the wait grown from `attempt` earlier redials, then dials under `dial`, reporting
    /// `Reconnected` or `ReconnectFailed`.
    Dial {
        /// The redial's ticket.
        dial: u64,
        /// How many redials came before it.
        attempt: u32,
    },
    /// Waits `wait` before a crash restart, reporting `WaitElapsed`.
    WaitToRestart {
        /// The wait's ticket.
        ticket: u64,
        /// How long.
        wait: Duration,
    },
    /// Ends the start, redial or wait under way.
    CancelPending,
    /// Calls off the wait of every drain the service asked: each drain finishes by itself, and
    /// its record stays for the next start.
    CancelDrains,
    /// Stops the service's own process and connection by its kind, reporting `StopDone`.
    StopService {
        /// The start's ticket.
        launch: u64,
        /// What becomes of a terminal service.
        end: LastingServiceEnd,
    },
    /// Checks whether Codex's managed daemon this supervisor joined is free, and stops it when it
    /// is, reporting `JoinedServiceFreed`.
    CheckJoinedServiceFree {
        /// The ticket of the connection it is joined on.
        dial: u64,
    },
    /// Hands the planned restart of a terminal service to the session's recovery, which starts
    /// the second service and moves the conversations.
    BeginPlannedRestart,
    /// Tells the session's recovery the service is back and its conversations need resuming.
    ReportRecovered(CodexServiceRecoveryCause),
    /// Tells the session's recovery the process ended on its own.
    ReportProcessExited,
    /// Reports the crash loop, which leaves the service down.
    ReportCrashLoop,
    /// Retires the record of a service another took the place of once its process ended: what
    /// that process left is ended and the record removed, since nothing restarts it.
    RetireRecord,
    /// Reports the connection's drop.
    ReportDropped,
    /// Reports a start that failed after a crash.
    ReportStartFailed(Arc<CodexError>),
    /// Publishes how the service stands to the callers waiting on it.
    Publish(CodexServiceAvailability),
}
