//! The supervisor's states and the one function that moves them: given the state and an event, it
//! answers the next state and the actions the supervisor's runner carries out whole before it reads
//! the next event. It reads no clock and draws no random number: each event carries the instants it
//! needs, and the runner draws the reconnect's jitter. Every launch, dial and wait takes a ticket of
//! its own; an outcome whose ticket the state no longer names is stale, and one that carries a
//! connection or a process is torn down, never dropped.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use crate::crash_window::{CrashOutcome, CrashWindow};
use crate::provider::driver::codex::service::home::CodexServiceKind;
use crate::provider::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::provider::driver::codex::service::supervisor::reconnect::RECONNECT_STABLE_UPTIME;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::contract::DaemonStopIntent;

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
        /// The redial the connection came up at, 0 for a start.
        attempt: u32,
        /// When the connection came up.
        since: Instant,
        /// Codex's words once it answered that it drains toward its exit: new work is refused,
        /// reads and interrupts go on.
        draining: Option<String>,
    },
    /// The connection dropped while the service runs; a redial is waiting or under way, and it
    /// never gives up.
    Reconnecting {
        /// The ticket of the start whose process runs.
        launch: u64,
        /// The ticket of the redial under way.
        dial: u64,
        /// Which redial it is, 0 for the first.
        attempt: u32,
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
        /// Whether the stop ends a terminal service that outlives the daemon.
        ends_lasting_service: bool,
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
}

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
        /// For a process the daemon cannot wait on, when the runner found it gone.
        process_gone_at: Option<SystemTime>,
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
        /// For a process the daemon cannot wait on, when the runner found it gone.
        process_gone_at: Option<SystemTime>,
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
        /// Whether a terminal service it launched is ended rather than left in its record.
        ends_lasting_service: bool,
    },
    /// Closes the service's connection; the process stays, or is let go of when it has ended.
    Disconnect {
        /// Whether the process ended, so its handle is let go of too.
        is_process_gone: bool,
    },
    /// Waits redial `attempt`'s wait, then dials under `dial`, reporting `Reconnected` or
    /// `ReconnectFailed`.
    Dial {
        /// The redial's ticket.
        dial: u64,
        /// Which redial it is.
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
    /// Stops the service's own process and connection by its kind, reporting `StopDone`.
    StopService {
        /// The start's ticket.
        launch: u64,
        /// Whether a terminal service is ended rather than only disconnected.
        ends_lasting_service: bool,
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
    /// Reports the connection's drop.
    ReportDropped,
    /// Reports a start that failed after a crash.
    ReportStartFailed(Arc<CodexError>),
    /// Publishes how the service stands to the callers waiting on it.
    Publish(CodexServiceAvailability),
}

/// How a service stands, as the callers waiting on it read it.
#[derive(Clone, Debug)]
pub(crate) enum CodexServiceAvailability {
    /// Nothing runs.
    Stopped,
    /// A start is under way.
    Starting,
    /// It runs and its connection is open.
    Up,
    /// Its connection is coming back.
    Reconnecting,
    /// A crash restart waits.
    Restarting,
    /// The last start failed.
    StartFailed(Arc<CodexError>),
    /// It ended too many times and stays down.
    CrashLoop,
    /// A stop is under way.
    Stopping,
    /// It was shut down with the daemon.
    ShutDown,
}

/// One supervisor's state, its kind and its crash window.
#[derive(Debug)]
pub(crate) struct Supervision {
    state: SupervisorState,
    kind: CodexServiceKind,
    crash_window: CrashWindow,
    next_ticket: u64,
}

impl Supervision {
    /// A stopped service of `kind` with an empty crash window, which starts empty at each daemon
    /// start.
    pub(crate) fn new(kind: CodexServiceKind) -> Self {
        Self {
            state: SupervisorState::Stopped,
            kind,
            crash_window: CrashWindow::provider(),
            next_ticket: 1,
        }
    }

    /// Where the service stands.
    pub(crate) fn state(&self) -> &SupervisorState {
        &self.state
    }

    /// The kind of service it is, as the last start found it.
    pub(crate) fn kind(&self) -> CodexServiceKind {
        self.kind
    }

    /// Moves the state by `event` and answers what the runner carries out, in order.
    pub(crate) fn transition(&mut self, event: SupervisorEvent) -> Vec<SupervisorAction> {
        let state = std::mem::replace(&mut self.state, SupervisorState::Stopped);
        let (next, actions) = self.step(state, event);
        self.state = next;
        actions
    }

    fn mint_ticket(&mut self) -> u64 {
        let ticket = self.next_ticket;
        self.next_ticket += 1;
        ticket
    }

    // A fresh start, after `recovery` when the conversations need resuming.
    fn start(
        &mut self,
        recovery: Option<CodexServiceRecoveryCause>,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        let launch = self.mint_ticket();
        actions.push(SupervisorAction::Launch { launch });
        actions.push(SupervisorAction::Publish(
            CodexServiceAvailability::Starting,
        ));
        (SupervisorState::Starting { launch, recovery }, actions)
    }

    // The process ended on its own at `at`: a restart after the crash window's wait, or the
    // crash loop that leaves it down.
    fn crash(
        &mut self,
        at: SystemTime,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        actions.push(SupervisorAction::ReportProcessExited);
        match self.crash_window.record_crash(at) {
            CrashOutcome::RestartAfter(wait) => {
                let ticket = self.mint_ticket();
                actions.push(SupervisorAction::WaitToRestart { ticket, wait });
                actions.push(SupervisorAction::Publish(
                    CodexServiceAvailability::Restarting,
                ));
                (SupervisorState::Restarting { wait: ticket }, actions)
            }
            CrashOutcome::CrashLoop => {
                actions.push(SupervisorAction::ReportCrashLoop);
                actions.push(SupervisorAction::Publish(
                    CodexServiceAvailability::CrashLoop,
                ));
                (SupervisorState::CrashLoop, actions)
            }
        }
    }

    // A start that failed at `at`: one after a crash counts as another crash, any other leaves
    // the service stopped with the failure for its callers.
    fn fail_start(
        &mut self,
        recovery: Option<CodexServiceRecoveryCause>,
        at: SystemTime,
        failure: Arc<CodexError>,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        if recovery == Some(CodexServiceRecoveryCause::Crash) {
            actions.push(SupervisorAction::ReportStartFailed(failure));
            return self.crash(at, actions);
        }
        actions.push(SupervisorAction::Publish(
            CodexServiceAvailability::StartFailed(failure),
        ));
        (SupervisorState::Stopped, actions)
    }

    // A stop of the running process, then `then`.
    fn stop(
        launch: u64,
        then: StoppingThen,
        ends_lasting_service: bool,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        actions.push(SupervisorAction::StopService {
            launch,
            ends_lasting_service,
        });
        actions.push(SupervisorAction::Publish(
            CodexServiceAvailability::Stopping,
        ));
        (
            SupervisorState::Stopping {
                launch,
                then,
                ends_lasting_service,
            },
            actions,
        )
    }

    // The next redial after `attempt`.
    fn redial(
        &mut self,
        launch: u64,
        attempt: u32,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        let dial = self.mint_ticket();
        actions.push(SupervisorAction::Dial { dial, attempt });
        actions.push(SupervisorAction::Publish(
            CodexServiceAvailability::Reconnecting,
        ));
        (
            SupervisorState::Reconnecting {
                launch,
                dial,
                attempt,
            },
            actions,
        )
    }

    #[expect(
        clippy::too_many_lines,
        reason = "one match over every state and event is the table, read whole"
    )]
    fn step(
        &mut self,
        state: SupervisorState,
        event: SupervisorEvent,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        use SupervisorAction as Action;
        use SupervisorEvent as Event;
        use SupervisorState as State;

        match (state, event) {
            // A stale outcome that carries a connection or a process is torn down in every state
            // whose tickets do not name it.
            (
                state,
                Event::Started { launch: ticket, .. }
                | Event::StartFailed { launch: ticket, .. }
                | Event::Reconnected { dial: ticket, .. },
            ) if !state_names_outcome(&state, ticket) => {
                let ends_lasting_service = match &state {
                    State::Stopping {
                        ends_lasting_service,
                        ..
                    } => *ends_lasting_service,
                    State::Stopped
                    | State::Starting { .. }
                    | State::Up { .. }
                    | State::Reconnecting { .. }
                    | State::Restarting { .. }
                    | State::CrashLoop
                    | State::ShutDown => true,
                };
                (
                    state,
                    vec![Action::TearDown {
                        ticket,
                        ends_lasting_service,
                    }],
                )
            }

            (State::Stopped, Event::Start) => self.start(None, Vec::new()),
            (State::Stopped, Event::Restart) => {
                self.crash_window.clear();
                self.start(None, Vec::new())
            }
            (State::Stopped | State::CrashLoop, Event::Stop) => (
                State::Stopped,
                vec![Action::Publish(CodexServiceAvailability::Stopped)],
            ),
            (
                State::Stopped | State::Restarting { .. } | State::CrashLoop,
                Event::Shutdown { .. },
            ) => (
                State::ShutDown,
                vec![
                    Action::CancelPending,
                    Action::Publish(CodexServiceAvailability::ShutDown),
                ],
            ),

            (
                state @ (State::Starting { .. } | State::Up { .. } | State::Reconnecting { .. }),
                Event::Restart,
            ) => {
                self.crash_window.clear();
                (state, Vec::new())
            }
            (State::Starting { launch, recovery }, Event::Started { at, kind, .. }) => {
                self.kind = kind;
                let mut actions = vec![Action::AdoptStart { launch }];
                if let Some(cause) = recovery {
                    actions.push(Action::ReportRecovered(cause));
                }
                actions.push(Action::Publish(CodexServiceAvailability::Up));
                (
                    State::Up {
                        launch,
                        dial: launch,
                        attempt: 0,
                        since: at,
                        draining: None,
                    },
                    actions,
                )
            }
            (State::Starting { launch, recovery }, Event::StartFailed { at, failure, .. }) => self
                .fail_start(
                    recovery,
                    at,
                    failure,
                    vec![Action::TearDown {
                        ticket: launch,
                        ends_lasting_service: true,
                    }],
                ),
            // The start's own connection or process ended before it was up: the start fails, and
            // its outcome, stale once it arrives, is torn down.
            (State::Starting { launch, recovery }, Event::Dropped { dial, wall_at, .. })
                if dial == launch =>
            {
                let failure = Arc::new(CodexError::Transport {
                    detail: "The Codex service's connection closed while it was starting."
                        .to_owned(),
                    cause: None,
                });
                self.fail_start(recovery, wall_at, failure, vec![Action::CancelPending])
            }
            (State::Starting { launch, recovery }, Event::ProcessExited { launch: ended, at })
                if ended == launch =>
            {
                let failure = Arc::new(CodexError::Transport {
                    detail: "The Codex service ended before it answered.".to_owned(),
                    cause: None,
                });
                self.fail_start(recovery, at, failure, vec![Action::CancelPending])
            }
            (State::Starting { launch, .. }, Event::Stop) => (
                State::Stopping {
                    launch,
                    then: StoppingThen::Stopped,
                    ends_lasting_service: true,
                },
                vec![
                    Action::CancelPending,
                    Action::Publish(CodexServiceAvailability::Stopping),
                ],
            ),
            (State::Starting { launch, .. }, Event::Shutdown { intent }) => (
                State::Stopping {
                    launch,
                    then: StoppingThen::ShutDown,
                    ends_lasting_service: intent == DaemonStopIntent::Stop,
                },
                vec![
                    Action::CancelPending,
                    Action::Publish(CodexServiceAvailability::Stopping),
                ],
            ),

            (
                State::Up {
                    launch,
                    dial,
                    attempt,
                    since,
                    ..
                },
                Event::Dropped {
                    dial: dropped,
                    at,
                    process_gone_at,
                    ..
                },
            ) if dropped == dial => match process_gone_at {
                Some(gone_at) if self.kind.is_daemons_own() => self.crash(
                    gone_at,
                    vec![Action::Disconnect {
                        is_process_gone: true,
                    }],
                ),
                Some(_) | None => {
                    let is_stable = at.saturating_duration_since(since) >= RECONNECT_STABLE_UPTIME;
                    let next_attempt = if is_stable {
                        0
                    } else {
                        attempt.saturating_add(1)
                    };
                    self.redial(
                        launch,
                        next_attempt,
                        vec![
                            Action::Disconnect {
                                is_process_gone: false,
                            },
                            Action::ReportDropped,
                        ],
                    )
                }
            },
            (State::Up { launch, .. }, Event::ProcessExited { launch: ended, at })
                if ended == launch =>
            {
                self.crash(
                    at,
                    vec![Action::Disconnect {
                        is_process_gone: true,
                    }],
                )
            }
            (
                State::Up {
                    launch,
                    dial,
                    attempt,
                    since,
                    ..
                },
                Event::Draining {
                    dial: draining,
                    message,
                },
            ) if draining == dial => (
                State::Up {
                    launch,
                    dial,
                    attempt,
                    since,
                    draining: Some(message),
                },
                Vec::new(),
            ),
            (State::Up { launch, .. }, Event::Stop) => {
                Self::stop(launch, StoppingThen::Stopped, true, Vec::new())
            }
            (State::Up { launch, .. }, Event::Shutdown { intent }) => Self::stop(
                launch,
                StoppingThen::ShutDown,
                intent == DaemonStopIntent::Stop,
                Vec::new(),
            ),
            (state @ State::Up { launch, .. }, Event::PlannedRestart) => match self.kind {
                CodexServiceKind::Account => {
                    Self::stop(launch, StoppingThen::Starting, true, Vec::new())
                }
                CodexServiceKind::Terminal => (state, vec![Action::BeginPlannedRestart]),
                CodexServiceKind::Joined => self.redial(
                    launch,
                    0,
                    vec![Action::Disconnect {
                        is_process_gone: false,
                    }],
                ),
            },
            (state @ State::Up { dial, .. }, Event::LastConversationClosed) => {
                if self.kind == CodexServiceKind::Joined {
                    (state, vec![Action::CheckJoinedServiceFree { dial }])
                } else {
                    (state, Vec::new())
                }
            }
            (State::Up { dial, .. }, Event::JoinedServiceFreed { dial: freed })
                if freed == dial && self.kind == CodexServiceKind::Joined =>
            {
                self.start(
                    None,
                    vec![Action::Disconnect {
                        is_process_gone: true,
                    }],
                )
            }

            (
                State::Reconnecting {
                    launch,
                    dial,
                    attempt,
                },
                Event::Reconnected { at, .. },
            ) => (
                State::Up {
                    launch,
                    dial,
                    attempt,
                    since: at,
                    draining: None,
                },
                vec![
                    Action::AdoptDial { dial },
                    Action::ReportRecovered(CodexServiceRecoveryCause::Reconnect),
                    Action::Publish(CodexServiceAvailability::Up),
                ],
            ),
            (
                State::Reconnecting {
                    launch,
                    dial,
                    attempt,
                },
                Event::ReconnectFailed {
                    dial: failed,
                    is_listening,
                    process_gone_at,
                },
            ) if failed == dial => match (self.kind, process_gone_at) {
                (CodexServiceKind::Account | CodexServiceKind::Terminal, Some(gone_at)) => self
                    .crash(
                        gone_at,
                        vec![Action::Disconnect {
                            is_process_gone: true,
                        }],
                    ),
                // Nothing answers where Codex's own service was: the folder is free to start the
                // daemon's own, and that service's end is the conversations' crash.
                (CodexServiceKind::Joined, _) if !is_listening => self.start(
                    Some(CodexServiceRecoveryCause::Crash),
                    vec![Action::Disconnect {
                        is_process_gone: true,
                    }],
                ),
                (
                    CodexServiceKind::Account
                    | CodexServiceKind::Terminal
                    | CodexServiceKind::Joined,
                    _,
                ) => self.redial(launch, attempt.saturating_add(1), Vec::new()),
            },
            (State::Reconnecting { launch, .. }, Event::ProcessExited { launch: ended, at })
                if ended == launch =>
            {
                self.crash(
                    at,
                    vec![
                        Action::CancelPending,
                        Action::Disconnect {
                            is_process_gone: true,
                        },
                    ],
                )
            }
            (State::Reconnecting { launch, .. }, Event::Stop) => Self::stop(
                launch,
                StoppingThen::Stopped,
                true,
                vec![Action::CancelPending],
            ),
            (State::Reconnecting { launch, .. }, Event::Shutdown { intent }) => Self::stop(
                launch,
                StoppingThen::ShutDown,
                intent == DaemonStopIntent::Stop,
                vec![Action::CancelPending],
            ),

            (State::Restarting { wait }, Event::WaitElapsed { wait: elapsed })
                if elapsed == wait =>
            {
                self.start(Some(CodexServiceRecoveryCause::Crash), Vec::new())
            }
            (State::Restarting { .. }, Event::Stop) => (
                State::Stopped,
                vec![
                    Action::CancelPending,
                    Action::Publish(CodexServiceAvailability::Stopped),
                ],
            ),
            (State::Restarting { .. }, Event::Restart) => {
                self.crash_window.clear();
                self.start(
                    Some(CodexServiceRecoveryCause::Crash),
                    vec![Action::CancelPending],
                )
            }

            (State::CrashLoop, Event::Start) => (
                State::CrashLoop,
                vec![Action::Publish(CodexServiceAvailability::CrashLoop)],
            ),
            (State::CrashLoop, Event::Restart) => {
                self.crash_window.clear();
                self.start(Some(CodexServiceRecoveryCause::Crash), Vec::new())
            }

            (State::Stopping { launch, then, .. }, Event::StopDone { ticket })
                if ticket == launch =>
            {
                match then {
                    StoppingThen::Stopped => (
                        State::Stopped,
                        vec![Action::Publish(CodexServiceAvailability::Stopped)],
                    ),
                    StoppingThen::Starting => self.start(None, Vec::new()),
                    StoppingThen::ShutDown => (
                        State::ShutDown,
                        vec![Action::Publish(CodexServiceAvailability::ShutDown)],
                    ),
                }
            }
            // The outcome of a start a stop stood down: torn down, which ends the stop.
            (
                state @ State::Stopping {
                    ends_lasting_service,
                    ..
                },
                Event::Started { launch: ticket, .. } | Event::StartFailed { launch: ticket, .. },
            ) => (
                state,
                vec![Action::TearDown {
                    ticket,
                    ends_lasting_service,
                }],
            ),
            (
                State::Stopping {
                    launch,
                    then,
                    ends_lasting_service,
                },
                event @ (Event::Start | Event::Restart | Event::Stop | Event::Shutdown { .. }),
            ) => {
                let then = match (then, &event) {
                    (StoppingThen::ShutDown, _) | (_, Event::Shutdown { .. }) => {
                        StoppingThen::ShutDown
                    }
                    (_, Event::Stop) => StoppingThen::Stopped,
                    (_, _) => StoppingThen::Starting,
                };
                if matches!(event, Event::Restart) {
                    self.crash_window.clear();
                }
                let actions = if then == StoppingThen::ShutDown && matches!(event, Event::Start) {
                    vec![Action::Publish(CodexServiceAvailability::Stopping)]
                } else {
                    Vec::new()
                };
                (
                    State::Stopping {
                        launch,
                        then,
                        ends_lasting_service,
                    },
                    actions,
                )
            }

            (State::ShutDown, Event::Start) => (
                State::ShutDown,
                vec![Action::Publish(CodexServiceAvailability::ShutDown)],
            ),

            // Anything else changes nothing: an empty stale outcome, an end a stop awaits, an ask.
            (state, _) => (state, Vec::new()),
        }
    }
}

// Whether `state` names the outcome under `ticket` as its own.
fn state_names_outcome(state: &SupervisorState, ticket: u64) -> bool {
    match state {
        SupervisorState::Starting { launch, .. } | SupervisorState::Stopping { launch, .. } => {
            *launch == ticket
        }
        SupervisorState::Reconnecting { dial, .. } => *dial == ticket,
        SupervisorState::Stopped
        | SupervisorState::Up { .. }
        | SupervisorState::Restarting { .. }
        | SupervisorState::CrashLoop
        | SupervisorState::ShutDown => false,
    }
}

#[cfg(test)]
mod tests;
