//! The one function that moves a supervisor's state: given the state and an event, it answers the
//! next state and the actions the supervisor's runner carries out whole before it reads the next
//! event. It reads no clock and draws no random number: each event carries the instants it needs,
//! and the runner draws the reconnect's jitter and runs the silence watch. Every launch, dial,
//! wait and watch takes a ticket of its own; an outcome whose ticket the state no longer names is
//! stale, and one that carries a connection or a process is torn down, never dropped.

pub(crate) mod action;
pub(crate) mod event;
pub(crate) mod state;

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::crash_window::{CrashOutcome, CrashWindow};
use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::driver::codex::service::supervisor::reconnect::RECONNECT_STABLE_UPTIME;
use crate::driver::codex::service::supervisor::transition::action::{
    LastingServiceEnd, SupervisorAction,
};
use crate::driver::codex::service::supervisor::transition::event::SupervisorEvent;
use crate::driver::codex::service::supervisor::transition::state::{StoppingThen, SupervisorState};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::daemon_stop::DaemonStopIntent;

/// How long a service the daemon started may answer nothing, since its connection dropped or a
/// request on its open connection went unanswered, before the daemon ends it as a crash.
pub(crate) const SERVICE_SILENCE_LIMIT: Duration = Duration::from_mins(2);

// The span over which silent ends are counted apart from the crash window, which two-minute
// silences can never fill.
const SILENT_END_WINDOW: Duration = Duration::from_mins(30);

// One entry per silent end the window lets pass, so the fifth leaves the service down; only the
// count is read, since the crash window gives the wait before each restart.
const SILENT_ENDS_PASSED: &[Duration] = &[Duration::ZERO; 4];

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
    // The silent ends over the last half hour.
    silent_ends: CrashWindow,
    next_ticket: u64,
    // Whether another service took this one's place on its home.
    is_replaced: bool,
}

impl Supervision {
    /// A stopped service of `kind` with an empty crash window, which starts empty at each daemon
    /// start.
    pub(crate) fn new(kind: CodexServiceKind) -> Self {
        Self {
            state: SupervisorState::Stopped,
            kind,
            crash_window: CrashWindow::provider(),
            silent_ends: CrashWindow::new(SILENT_END_WINDOW, SILENT_ENDS_PASSED),
            next_ticket: 1,
            is_replaced: false,
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

    /// Moves the state by `event` and answers what the runner carries out, in order; a silence
    /// watch the new state no longer names is ended first.
    pub(crate) fn transition(&mut self, event: SupervisorEvent) -> Vec<SupervisorAction> {
        let state = std::mem::replace(&mut self.state, SupervisorState::Stopped);
        let watched = state.silence_ticket();
        let (next, mut actions) = self.step(state, event);
        if watched.is_some() && next.silence_ticket() != watched {
            actions.insert(0, SupervisorAction::ClearSilence);
        }
        self.state = next;
        actions
    }

    // Forgets every crash and silent end; the person's restart does this.
    fn forget_crashes(&mut self) {
        self.crash_window.clear();
        self.silent_ends.clear();
    }

    // A silence watch, `silent_for` into its limit already, for a service the daemon started; one
    // it joined is never ended.
    fn watch_silence(
        &mut self,
        actions: &mut Vec<SupervisorAction>,
        silent_for: Duration,
    ) -> Option<u64> {
        if !self.kind.is_daemons_own() {
            return None;
        }
        let ticket = self.mint_ticket();
        actions.push(SupervisorAction::WatchSilence { ticket, silent_for });
        Some(ticket)
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

    // The process ended on its own at `at`, or the daemon ended it for its silence: a restart
    // after the crash window's wait, or the crash loop that leaves it down, reported with
    // `start_failure` where the crash was a restart that failed; a silent end also counts toward
    // the half hour's limit. A replaced service is never restarted and its record goes. With no
    // `at`, a lasting service a former daemon started whose end the daemon could not read, it
    // starts again at once and no crash is counted, since a crash loop names its end.
    fn crash(
        &mut self,
        at: Option<SystemTime>,
        start_failure: Option<Arc<CodexError>>,
        silent_for: Option<Duration>,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        actions.push(match silent_for {
            Some(silent_for) => SupervisorAction::ReportSilentEnd { silent_for },
            None => SupervisorAction::ReportProcessExited,
        });
        if self.is_replaced {
            actions.push(SupervisorAction::RetireRecord);
            actions.push(SupervisorAction::Publish(CodexServiceAvailability::Stopped));
            return (SupervisorState::Stopped, actions);
        }
        let Some(at) = at else {
            return self.start(Some(CodexServiceRecoveryCause::Crash), actions);
        };
        let mut outcome = self.crash_window.record_crash(at);
        if silent_for.is_some() && self.silent_ends.record_crash(at) == CrashOutcome::CrashLoop {
            outcome = CrashOutcome::CrashLoop;
        }
        match outcome {
            CrashOutcome::RestartAfter(wait) => {
                let ticket = self.mint_ticket();
                actions.push(SupervisorAction::WaitToRestart { ticket, wait });
                actions.push(SupervisorAction::Publish(
                    CodexServiceAvailability::Restarting,
                ));
                (SupervisorState::Restarting { wait: ticket }, actions)
            }
            CrashOutcome::CrashLoop => {
                actions.push(SupervisorAction::ReportCrashLoop(start_failure));
                actions.push(SupervisorAction::Publish(
                    CodexServiceAvailability::CrashLoop,
                ));
                (SupervisorState::CrashLoop, actions)
            }
        }
    }

    // A start that failed at `at`: one after a crash or the person's restart of a crash loop
    // counts as another crash, any other leaves the service stopped with the failure for its
    // callers.
    fn fail_start(
        &mut self,
        recovery: Option<CodexServiceRecoveryCause>,
        at: SystemTime,
        failure: Arc<CodexError>,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        if matches!(
            recovery,
            Some(CodexServiceRecoveryCause::Crash | CodexServiceRecoveryCause::PersonRestart)
        ) {
            actions.push(SupervisorAction::ReportStartFailed(Arc::clone(&failure)));
            return self.crash(Some(at), Some(failure), None, actions);
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
        end: LastingServiceEnd,
        mut actions: Vec<SupervisorAction>,
    ) -> (SupervisorState, Vec<SupervisorAction>) {
        actions.push(SupervisorAction::StopService { launch, end });
        actions.push(SupervisorAction::Publish(
            CodexServiceAvailability::Stopping,
        ));
        (SupervisorState::Stopping { launch, then, end }, actions)
    }

    // What a stop under `intent`, `None` for a stop of the person's or the switch's, does with a
    // terminal service's lasting process: a daemon restart keeps it running, a service another
    // took the home's link from drains, and any other is stopped.
    fn lasting_end(&self, intent: Option<DaemonStopIntent>) -> LastingServiceEnd {
        match intent {
            Some(DaemonStopIntent::Restart) => LastingServiceEnd::Keep,
            Some(DaemonStopIntent::Stop) | None if self.is_replaced => LastingServiceEnd::Drain,
            Some(DaemonStopIntent::Stop) | None => LastingServiceEnd::Stop,
        }
    }

    // A redial after `attempt` earlier ones, waiting the wait grown from that count, under the
    // silence watch `silence`.
    fn redial(
        &mut self,
        launch: u64,
        attempt: u32,
        silence: Option<u64>,
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
                silence,
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
                let end = match &state {
                    State::Stopping { end, .. } => *end,
                    State::Stopped
                    | State::Starting { .. }
                    | State::Up { .. }
                    | State::Reconnecting { .. }
                    | State::Restarting { .. }
                    | State::CrashLoop
                    | State::ShutDown => self.lasting_end(None),
                };
                (state, vec![Action::TearDown { ticket, end }])
            }

            // A crash restart still waiting is called off: the second takes its conversations.
            (State::Restarting { .. }, Event::Replaced) => {
                self.is_replaced = true;
                (
                    State::Stopped,
                    vec![
                        Action::CancelPending,
                        Action::RetireRecord,
                        Action::Publish(CodexServiceAvailability::Stopped),
                    ],
                )
            }
            // A crash restart under way is called off and what it launched drains, so it never
            // comes up on the home the second holds.
            (State::Starting { launch, .. }, Event::Replaced) => {
                self.is_replaced = true;
                (
                    State::Stopping {
                        launch,
                        then: StoppingThen::Stopped,
                        end: LastingServiceEnd::Drain,
                    },
                    vec![
                        Action::CancelPending,
                        Action::Publish(CodexServiceAvailability::Stopping),
                    ],
                )
            }
            // A service down after a crash loop waits for no restart: its record goes.
            (State::CrashLoop, Event::Replaced) => {
                self.is_replaced = true;
                (
                    State::Stopped,
                    vec![
                        Action::RetireRecord,
                        Action::Publish(CodexServiceAvailability::Stopped),
                    ],
                )
            }
            (state, Event::Replaced) => {
                self.is_replaced = true;
                (state, Vec::new())
            }
            // A replaced service is never started again: its home's socket is the second's now.
            (state @ (State::Stopped | State::CrashLoop), Event::Start | Event::Restart)
                if self.is_replaced =>
            {
                let availability = if state == State::CrashLoop {
                    CodexServiceAvailability::CrashLoop
                } else {
                    CodexServiceAvailability::Stopped
                };
                (state, vec![Action::Publish(availability)])
            }
            (State::Stopped, Event::Start) => self.start(None, Vec::new()),
            (State::Stopped, Event::Restart) => {
                self.forget_crashes();
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
                self.forget_crashes();
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
                        silence: None,
                    },
                    actions,
                )
            }
            (State::Starting { launch, recovery }, Event::StartFailed { at, failure, .. }) => {
                let end = self.lasting_end(None);
                self.fail_start(
                    recovery,
                    at,
                    failure,
                    vec![Action::TearDown {
                        ticket: launch,
                        end,
                    }],
                )
            }
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
                    end: self.lasting_end(None),
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
                    end: self.lasting_end(Some(intent)),
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
                    silence,
                    ..
                },
                Event::Dropped {
                    dial: dropped,
                    at,
                    is_unwaited_process_gone,
                    ..
                },
            ) if dropped == dial => {
                if is_unwaited_process_gone && self.kind.is_daemons_own() {
                    return self.crash(
                        None,
                        None,
                        None,
                        vec![Action::Disconnect {
                            is_process_gone: true,
                        }],
                    );
                }
                let is_stable = at.saturating_duration_since(since) >= RECONNECT_STABLE_UPTIME;
                let mut actions = vec![
                    Action::Disconnect {
                        is_process_gone: false,
                    },
                    Action::ReportDropped,
                ];
                // A watch already running since an unanswered request goes on: the silence began
                // then.
                let silence = match silence {
                    Some(ticket) => Some(ticket),
                    None => self.watch_silence(&mut actions, Duration::ZERO),
                };
                self.redial(
                    launch,
                    if is_stable { 0 } else { attempt },
                    silence,
                    actions,
                )
            }
            (State::Up { launch, .. }, Event::ProcessExited { launch: ended, at })
                if ended == launch =>
            {
                self.crash(
                    Some(at),
                    None,
                    None,
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
                    silence,
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
                    silence,
                },
                Vec::new(),
            ),
            // A request went unanswered on the open connection: the silence watch starts from the
            // send of the oldest request still unanswered, unless one already runs, so a later
            // request's timeout never pushes its end out.
            (
                State::Up {
                    launch,
                    dial,
                    attempt,
                    since,
                    draining,
                    silence: None,
                },
                Event::RequestTimedOut {
                    dial: timed_out,
                    silent_for,
                },
            ) if timed_out == dial => {
                let mut actions = Vec::new();
                let silence = self.watch_silence(&mut actions, silent_for);
                (
                    State::Up {
                        launch,
                        dial,
                        attempt,
                        since,
                        draining,
                        silence,
                    },
                    actions,
                )
            }
            // The service sent something on the connection: its silence is over.
            (
                State::Up {
                    launch,
                    dial,
                    attempt,
                    since,
                    draining,
                    silence: Some(_),
                },
                Event::Answered { dial: answered },
            ) if answered == dial => (
                State::Up {
                    launch,
                    dial,
                    attempt,
                    since,
                    draining,
                    silence: None,
                },
                Vec::new(),
            ),
            // The service answered nothing for the whole limit: the daemon ends it, and its end
            // is a crash once the stop is done.
            (
                State::Up {
                    launch,
                    silence: Some(watched),
                    ..
                }
                | State::Reconnecting {
                    launch,
                    silence: Some(watched),
                    ..
                },
                Event::SilenceElapsed {
                    ticket,
                    at,
                    silent_for,
                },
            ) if ticket == watched => Self::stop(
                launch,
                StoppingThen::SilentEnd { at, silent_for },
                LastingServiceEnd::Stop,
                vec![Action::CancelPending],
            ),
            (State::Up { launch, .. }, Event::Stop) => Self::stop(
                launch,
                StoppingThen::Stopped,
                self.lasting_end(None),
                Vec::new(),
            ),
            (State::Up { launch, .. }, Event::Shutdown { intent }) => Self::stop(
                launch,
                StoppingThen::ShutDown,
                self.lasting_end(Some(intent)),
                Vec::new(),
            ),
            // A replaced service serves only until it is retired: no third service follows it.
            (state @ State::Up { .. }, Event::PlannedRestart) if self.is_replaced => {
                (state, Vec::new())
            }
            (state @ State::Up { launch, .. }, Event::PlannedRestart) => match self.kind {
                CodexServiceKind::Account => Self::stop(
                    launch,
                    StoppingThen::Starting,
                    LastingServiceEnd::Stop,
                    Vec::new(),
                ),
                CodexServiceKind::Terminal => (state, vec![Action::BeginPlannedRestart]),
                CodexServiceKind::Joined => self.redial(
                    launch,
                    0,
                    None,
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
                    ..
                },
                Event::Reconnected { at, .. },
            ) => (
                State::Up {
                    launch,
                    dial,
                    attempt: attempt.saturating_add(1),
                    since: at,
                    draining: None,
                    silence: None,
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
                    silence,
                },
                Event::ReconnectFailed {
                    dial: failed,
                    is_listening,
                    is_unwaited_process_gone,
                },
            ) if failed == dial => match (self.kind, is_unwaited_process_gone) {
                (CodexServiceKind::Account | CodexServiceKind::Terminal, true) => self.crash(
                    None,
                    None,
                    None,
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
                ) => self.redial(launch, attempt.saturating_add(1), silence, Vec::new()),
            },
            (State::Reconnecting { launch, .. }, Event::ProcessExited { launch: ended, at })
                if ended == launch =>
            {
                self.crash(
                    Some(at),
                    None,
                    None,
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
                self.lasting_end(None),
                vec![Action::CancelPending],
            ),
            (State::Reconnecting { launch, .. }, Event::Shutdown { intent }) => Self::stop(
                launch,
                StoppingThen::ShutDown,
                self.lasting_end(Some(intent)),
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
                self.forget_crashes();
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
                self.forget_crashes();
                self.start(Some(CodexServiceRecoveryCause::PersonRestart), Vec::new())
            }

            (State::Stopping { launch, then, .. }, Event::StopDone { ticket })
                if ticket == launch =>
            {
                match then {
                    // A replaced service's stop ends it, its home's socket the second's, and its
                    // record goes with what its last start left.
                    StoppingThen::Stopped | StoppingThen::Starting if self.is_replaced => (
                        State::Stopped,
                        vec![
                            Action::RetireRecord,
                            Action::Publish(CodexServiceAvailability::Stopped),
                        ],
                    ),
                    StoppingThen::Stopped => (
                        State::Stopped,
                        vec![Action::Publish(CodexServiceAvailability::Stopped)],
                    ),
                    StoppingThen::Starting => self.start(None, Vec::new()),
                    StoppingThen::SilentEnd { at, silent_for } => {
                        self.crash(Some(at), None, Some(silent_for), Vec::new())
                    }
                    StoppingThen::ShutDown => (
                        State::ShutDown,
                        vec![Action::Publish(CodexServiceAvailability::ShutDown)],
                    ),
                }
            }
            // The outcome of a start a stop stood down: torn down, which ends the stop.
            (
                state @ State::Stopping { end, .. },
                Event::Started { launch: ticket, .. } | Event::StartFailed { launch: ticket, .. },
            ) => (state, vec![Action::TearDown { ticket, end }]),
            (
                State::Stopping { launch, then, end },
                event @ (Event::Start | Event::Restart | Event::Stop | Event::Shutdown { .. }),
            ) => {
                let then = match (then, &event) {
                    (StoppingThen::ShutDown, _) | (_, Event::Shutdown { .. }) => {
                        StoppingThen::ShutDown
                    }
                    (_, Event::Stop) => StoppingThen::Stopped,
                    // A caller's start waits for the restart the silent end leads to.
                    (silent @ StoppingThen::SilentEnd { .. }, _) => silent,
                    (_, _) => StoppingThen::Starting,
                };
                if matches!(event, Event::Restart) {
                    self.forget_crashes();
                }
                let actions = if matches!(event, Event::Start) && then == StoppingThen::ShutDown {
                    vec![Action::Publish(CodexServiceAvailability::Stopping)]
                } else {
                    Vec::new()
                };
                (State::Stopping { launch, then, end }, actions)
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
