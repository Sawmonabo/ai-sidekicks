//! What reaches a service's supervisor: a caller's ask, or the outcome of something its runner
//! did, each carrying the instants the transition reads.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::daemon_stop::DaemonStopIntent;

/// What reaches the supervisor: a caller's ask, or the outcome of something its runner did.
#[derive(Debug)]
pub(crate) enum SupervisorEvent {
    /// A caller needs the service up.
    Start,
    /// A start brought the service up, its process and connection parked under `launch`.
    Started {
        /// The start's ticket.
        launch: u64,
        /// When the connection came up.
        at: Instant,
        /// What the start found the service to be.
        kind: CodexServiceKind,
    },
    /// A start failed; anything it launched is parked under `launch`.
    StartFailed {
        /// The start's ticket.
        launch: u64,
        /// When it failed, on the wall clock.
        at: SystemTime,
        /// Why.
        failure: Arc<CodexError>,
    },
    /// The connection `dial` closed with no close of the daemon's.
    Dropped {
        /// The connection's ticket.
        dial: u64,
        /// When it closed.
        at: Instant,
        /// When it closed, on the wall clock.
        wall_at: SystemTime,
        /// Whether the runner found gone a process the daemon cannot wait on, whose end it reads
        /// from no exit.
        is_unwaited_process_gone: bool,
    },
    /// The process the start `launch` launched ended.
    ProcessExited {
        /// The start's ticket.
        launch: u64,
        /// When, on the wall clock.
        at: SystemTime,
    },
    /// A redial opened a connection, parked under `dial`.
    Reconnected {
        /// The redial's ticket.
        dial: u64,
        /// When it came up.
        at: Instant,
    },
    /// A redial failed.
    ReconnectFailed {
        /// The redial's ticket.
        dial: u64,
        /// Whether anything answered on the socket.
        is_listening: bool,
        /// Whether the runner found gone a process the daemon cannot wait on, whose end it reads
        /// from no exit.
        is_unwaited_process_gone: bool,
    },
    /// A crash restart's wait ended.
    WaitElapsed {
        /// The wait's ticket.
        wait: u64,
    },
    /// The stop or teardown of what the ticket named ended.
    StopDone {
        /// The ticket.
        ticket: u64,
    },
    /// Codex answered on connection `dial` that it drains toward its exit.
    Draining {
        /// The connection's ticket.
        dial: u64,
        /// Codex's words.
        message: String,
    },
    /// A request on the open connection `dial` went unanswered past its deadline.
    RequestTimedOut {
        /// The connection's ticket.
        dial: u64,
        /// How long since the oldest request still unanswered on it was sent or the service last
        /// sent a frame, whichever came later.
        silent_for: Duration,
    },
    /// The service sent something on connection `dial` after a request on it went unanswered.
    Answered {
        /// The connection's ticket.
        dial: u64,
    },
    /// The silence watch `ticket` ran its whole limit with nothing from the service.
    SilenceElapsed {
        /// The watch's ticket.
        ticket: u64,
        /// When it ran out, on the wall clock.
        at: SystemTime,
        /// How long the service had answered nothing then.
        silent_for: Duration,
    },
    /// Codex's own managed daemon this supervisor joined is free, and the runner stopped it.
    JoinedServiceFreed {
        /// The ticket of the connection it was joined on.
        dial: u64,
    },
    /// The daemon's last conversation on a joined service closed, so it may be free.
    LastConversationClosed,
    /// The person or the switch stops the service.
    Stop,
    /// The daemon stops or restarts.
    Shutdown {
        /// Which.
        intent: DaemonStopIntent,
    },
    /// The person's restart of a service left down, which forgets the crash window.
    Restart,
    /// A start on a new program: a Codex update, the daemon's own program moved, or hooks that
    /// do not match.
    PlannedRestart,
    /// A planned restart's second service took this one's place on its home, so it is never
    /// started again: once its process ends, its conversations move to the second.
    Replaced,
}
