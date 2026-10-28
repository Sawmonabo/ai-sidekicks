use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use rstest::rstest;

use super::{Supervision, SupervisorEvent, SupervisorState};
use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::daemon_stop::DaemonStopIntent;

fn wall(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}

fn started(launch: u64, kind: CodexServiceKind) -> impl Fn(Instant) -> SupervisorEvent {
    move |start| SupervisorEvent::Started {
        launch,
        at: start,
        kind,
    }
}

fn dropped(dial: u64, after: u64, is_process_gone: bool) -> impl Fn(Instant) -> SupervisorEvent {
    move |start| SupervisorEvent::Dropped {
        dial,
        at: start + Duration::from_secs(after),
        wall_at: wall(after),
        is_unwaited_process_gone: is_process_gone,
    }
}

fn reconnected(dial: u64, after: u64) -> impl Fn(Instant) -> SupervisorEvent {
    move |start| SupervisorEvent::Reconnected {
        dial,
        at: start + Duration::from_secs(after),
    }
}

fn start_failed(launch: u64) -> SupervisorEvent {
    SupervisorEvent::StartFailed {
        launch,
        at: wall(0),
        failure: Arc::new(CodexError::Transport {
            detail: "refused".to_owned(),
            cause: None,
        }),
    }
}

// Runs `steps` from a stopped service of `kind`, answering the state and the last step's actions,
// each as its debug text, an `Up` state's instant read as how long after the run's start.
fn drive(
    kind: CodexServiceKind,
    steps: Vec<Box<dyn Fn(Instant) -> SupervisorEvent>>,
) -> (String, Vec<String>) {
    let start = Instant::now();
    let mut supervision = Supervision::new(kind);
    let mut actions = Vec::new();
    for step in steps {
        actions = supervision.transition(step(start));
    }
    let state = if let SupervisorState::Up {
        launch,
        dial,
        attempt,
        since,
        draining,
    } = supervision.state()
    {
        format!(
            "Up {{ launch: {launch}, dial: {dial}, attempt: {attempt}, up for: {:?}, draining: \
             {draining:?} }}",
            since.saturating_duration_since(start)
        )
    } else {
        format!("{:?}", supervision.state())
    };
    let actions = actions.iter().map(|action| format!("{action:?}")).collect();
    (state, actions)
}

// Five crashes inside the crash window from a stopped terminal service, then `last`.
fn crash_loop_then(
    last: fn(Instant) -> SupervisorEvent,
) -> Vec<Box<dyn Fn(Instant) -> SupervisorEvent>> {
    let mut steps = vec![at_once(|_| SupervisorEvent::Start)];
    for crash in 0..5_u64 {
        let launch = 1 + crash * 2;
        steps.push(boxed(started(launch, CodexServiceKind::Terminal)));
        steps.push(boxed(move |_| SupervisorEvent::ProcessExited {
            launch,
            at: wall(crash * 10),
        }));
        if crash < 4 {
            steps.push(boxed(move |_| SupervisorEvent::WaitElapsed {
                wait: launch + 1,
            }));
        }
    }
    steps.push(at_once(last));
    steps
}

fn boxed(
    step: impl Fn(Instant) -> SupervisorEvent + 'static,
) -> Box<dyn Fn(Instant) -> SupervisorEvent> {
    Box::new(step)
}

fn at_once(event: fn(Instant) -> SupervisorEvent) -> Box<dyn Fn(Instant) -> SupervisorEvent> {
    Box::new(event)
}

// Each cell of the supervisor's table that moves its state or tears something down, from a
// stopped service of the daemon's own kind unless the case names another. Fails on any arm
// changed: a drop while the process runs read as a crash, a stale start's outcome dropped with
// no teardown (a leaked lasting service), a stop that forgets what follows it, a first redial
// that waits past the first wait, a reconnect count that starts again after a short uptime, one
// that keeps growing after a long one, a replaced service started again onto its home, a replaced
// service's crash restart left to come up, its stop or launch stopped rather than drained, a
// daemon stop held on a drain, or a replaced service's record kept once it ended.
#[rstest]
#[case::a_start(
    CodexServiceKind::Account,
    vec![at_once(|_| SupervisorEvent::Start)],
    "Starting { launch: 1, recovery: None }",
    &["Launch { launch: 1 }", "Publish(Starting)"],
)]
#[case::a_start_comes_up(
    CodexServiceKind::Account,
    vec![at_once(|_| SupervisorEvent::Start), boxed(started(1, CodexServiceKind::Account))],
    "Up { launch: 1, dial: 1, attempt: 0, up for: 0ns, draining: None }",
    &["AdoptStart { launch: 1 }", "Publish(Up)"],
)]
#[case::a_start_fails(
    CodexServiceKind::Account,
    vec![at_once(|_| SupervisorEvent::Start), at_once(|_| start_failed(1))],
    "Stopped",
    &["TearDown { ticket: 1, end: Stop }",
        "Publish(StartFailed(Transport { detail: \"refused\", cause: None }))"],
)]
#[case::a_drop_after_a_short_uptime_keeps_the_grown_count(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        boxed(dropped(1, 10, false)),
        boxed(reconnected(2, 20)),
        boxed(dropped(2, 30, false)),
    ],
    "Reconnecting { launch: 1, dial: 3, attempt: 1 }",
    &["Disconnect { is_process_gone: false }", "ReportDropped", "Dial { dial: 3, attempt: 1 }",
        "Publish(Reconnecting)"],
)]
#[case::a_fresh_service_s_first_redial_waits_from_the_first_wait(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        boxed(dropped(1, 10, false)),
    ],
    "Reconnecting { launch: 1, dial: 2, attempt: 0 }",
    &["Disconnect { is_process_gone: false }", "ReportDropped", "Dial { dial: 2, attempt: 0 }",
        "Publish(Reconnecting)"],
)]
#[case::a_drop_after_a_long_uptime_starts_the_count_again(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        boxed(dropped(1, 10, false)),
        boxed(reconnected(2, 20)),
        boxed(dropped(2, 140, false)),
    ],
    "Reconnecting { launch: 1, dial: 3, attempt: 0 }",
    &["Disconnect { is_process_gone: false }", "ReportDropped", "Dial { dial: 3, attempt: 0 }",
        "Publish(Reconnecting)"],
)]
// Killed by counting the end in the crash window, which leaves a crash loop no exit to name.
#[case::a_drop_whose_unread_process_ended_restarts_it_with_no_crash_counted(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        boxed(dropped(1, 10, true)),
    ],
    "Starting { launch: 2, recovery: Some(Crash) }",
    &["Disconnect { is_process_gone: true }", "ReportProcessExited", "Launch { launch: 2 }",
        "Publish(Starting)"],
)]
#[case::a_joined_service_whose_process_ended_is_redialed(
    CodexServiceKind::Joined,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Joined)),
        boxed(dropped(1, 10, true)),
    ],
    "Reconnecting { launch: 1, dial: 2, attempt: 0 }",
    &["Disconnect { is_process_gone: false }", "ReportDropped", "Dial { dial: 2, attempt: 0 }",
        "Publish(Reconnecting)"],
)]
#[case::a_reconnect_where_nothing_listens_starts_the_daemon_s_own(
    CodexServiceKind::Joined,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Joined)),
        boxed(dropped(1, 10, false)),
        at_once(|_| SupervisorEvent::ReconnectFailed {
            dial: 2,
            is_listening: false,
            is_unwaited_process_gone: false,
        }),
    ],
    "Starting { launch: 3, recovery: Some(Crash) }",
    &["Disconnect { is_process_gone: true }", "Launch { launch: 3 }", "Publish(Starting)"],
)]
#[case::a_stop(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        at_once(|_| SupervisorEvent::Stop),
    ],
    "Stopping { launch: 1, then: Stopped, end: Stop }",
    &["StopService { launch: 1, end: Stop }", "Publish(Stopping)"],
)]
#[case::a_daemon_restart_leaves_the_terminal_service(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::Shutdown { intent: DaemonStopIntent::Restart }),
    ],
    "Stopping { launch: 1, then: ShutDown, end: Keep }",
    &["StopService { launch: 1, end: Keep }", "Publish(Stopping)"],
)]
#[case::a_start_during_a_stop_follows_it(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        at_once(|_| SupervisorEvent::Stop),
        at_once(|_| SupervisorEvent::Start),
        at_once(|_| SupervisorEvent::StopDone { ticket: 1 }),
    ],
    "Starting { launch: 2, recovery: None }",
    &["Launch { launch: 2 }", "Publish(Starting)"],
)]
#[case::an_account_service_s_planned_restart_stops_then_starts(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        at_once(|_| SupervisorEvent::PlannedRestart),
    ],
    "Stopping { launch: 1, then: Starting, end: Stop }",
    &["StopService { launch: 1, end: Stop }", "Publish(Stopping)"],
)]
#[case::a_terminal_service_s_planned_restart_goes_to_the_recovery(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::PlannedRestart),
    ],
    "Up { launch: 1, dial: 1, attempt: 0, up for: 0ns, draining: None }",
    &["BeginPlannedRestart"],
)]
#[case::a_stale_start_is_torn_down(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        at_once(|_| SupervisorEvent::Stop),
        at_once(|_| SupervisorEvent::StopDone { ticket: 1 }),
        boxed(started(1, CodexServiceKind::Account)),
    ],
    "Stopped",
    &["TearDown { ticket: 1, end: Stop }"],
)]
#[case::a_stale_redial_is_torn_down(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        boxed(dropped(1, 10, false)),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(11) }),
        boxed(reconnected(2, 12)),
    ],
    "Restarting { wait: 3 }",
    &["TearDown { ticket: 2, end: Stop }"],
)]
#[case::a_crash_wait_ends_in_a_start_that_resumes(
    CodexServiceKind::Account,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Account)),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(10) }),
        at_once(|_| SupervisorEvent::WaitElapsed { wait: 2 }),
    ],
    "Starting { launch: 3, recovery: Some(Crash) }",
    &["Launch { launch: 3 }", "Publish(Starting)"],
)]
#[case::a_replaced_service_s_crash_ends_it_stopped(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::Replaced),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(10) }),
    ],
    "Stopped",
    &["Disconnect { is_process_gone: true }", "ReportProcessExited", "RetireRecord",
        "Publish(Stopped)"],
)]
#[case::a_replaced_service_is_never_started_again(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::Replaced),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(10) }),
        at_once(|_| SupervisorEvent::Start),
    ],
    "Stopped",
    &["Publish(Stopped)"],
)]
#[case::a_replaced_service_s_stop_never_starts_it_again(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::Replaced),
        at_once(|_| SupervisorEvent::Stop),
        at_once(|_| SupervisorEvent::Start),
        at_once(|_| SupervisorEvent::StopDone { ticket: 1 }),
    ],
    "Stopped",
    &["RetireRecord", "Publish(Stopped)"],
)]
#[case::a_replaced_service_s_stop_drains_it(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::Replaced),
        at_once(|_| SupervisorEvent::Stop),
    ],
    "Stopping { launch: 1, then: Stopped, end: Drain }",
    &["StopService { launch: 1, end: Drain }", "Publish(Stopping)"],
)]
#[case::a_daemon_stop_shuts_a_replaced_service_down_once_its_drain_is_called_off(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::Replaced),
        at_once(|_| SupervisorEvent::Stop),
        at_once(|_| SupervisorEvent::Shutdown { intent: DaemonStopIntent::Stop }),
        at_once(|_| SupervisorEvent::StopDone { ticket: 1 }),
    ],
    "ShutDown",
    &["Publish(ShutDown)"],
)]
#[case::a_replaced_service_asks_no_third_service(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::Replaced),
        at_once(|_| SupervisorEvent::PlannedRestart),
    ],
    "Up { launch: 1, dial: 1, attempt: 0, up for: 0ns, draining: None }",
    &[],
)]
#[case::a_replaced_crash_restart_under_way_is_stood_down_to_drain(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(10) }),
        at_once(|_| SupervisorEvent::WaitElapsed { wait: 2 }),
        at_once(|_| SupervisorEvent::Replaced),
    ],
    "Stopping { launch: 3, then: Stopped, end: Drain }",
    &["CancelPending", "Publish(Stopping)"],
)]
#[case::a_replaced_crash_restart_s_launch_drains(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(10) }),
        at_once(|_| SupervisorEvent::WaitElapsed { wait: 2 }),
        at_once(|_| SupervisorEvent::Replaced),
        boxed(started(3, CodexServiceKind::Terminal)),
    ],
    "Stopping { launch: 3, then: Stopped, end: Drain }",
    &["TearDown { ticket: 3, end: Drain }"],
)]
#[case::a_replaced_crash_restart_s_stop_retires_its_record(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(10) }),
        at_once(|_| SupervisorEvent::WaitElapsed { wait: 2 }),
        at_once(|_| SupervisorEvent::Replaced),
        at_once(|_| start_failed(3)),
        at_once(|_| SupervisorEvent::StopDone { ticket: 3 }),
    ],
    "Stopped",
    &["RetireRecord", "Publish(Stopped)"],
)]
#[case::a_replaced_crash_restart_still_waiting_is_called_off(
    CodexServiceKind::Terminal,
    vec![
        at_once(|_| SupervisorEvent::Start),
        boxed(started(1, CodexServiceKind::Terminal)),
        at_once(|_| SupervisorEvent::ProcessExited { launch: 1, at: wall(10) }),
        at_once(|_| SupervisorEvent::Replaced),
    ],
    "Stopped",
    &["CancelPending", "RetireRecord", "Publish(Stopped)"],
)]
#[case::a_replaced_service_down_after_a_crash_loop_retires_its_record(
    CodexServiceKind::Terminal,
    crash_loop_then(|_| SupervisorEvent::Replaced),
    "Stopped",
    &["RetireRecord", "Publish(Stopped)"],
)]
fn the_supervisor_table(
    #[case] kind: CodexServiceKind,
    #[case] steps: Vec<Box<dyn Fn(Instant) -> SupervisorEvent>>,
    #[case] state: &str,
    #[case] actions: &[&str],
) {
    let (driven_state, driven_actions) = drive(kind, steps);

    assert_eq!(driven_state, state);
    assert_eq!(driven_actions, actions);
}

// Fails when the crash path stops counting on the crash window, which restarts a dying service
// without bound, or a start is taken while the service is down for it, or the person's restart
// does not start it again under its own cause, which tells the sessions it brings back, or a
// failed start after that restart leaves the service stopped rather than counting a crash.
#[test]
fn a_fifth_crash_within_three_minutes_leaves_the_service_down() {
    let start = Instant::now();
    let mut supervision = Supervision::new(CodexServiceKind::Account);
    supervision.transition(SupervisorEvent::Start);
    let mut launch = 1;
    for crash in 0..5 {
        supervision.transition(SupervisorEvent::Started {
            launch,
            at: start,
            kind: CodexServiceKind::Account,
        });
        supervision.transition(SupervisorEvent::ProcessExited {
            launch,
            at: wall(crash * 10),
        });
        if let SupervisorState::Restarting { wait } = *supervision.state() {
            supervision.transition(SupervisorEvent::WaitElapsed { wait });
            let SupervisorState::Starting { launch: next, .. } = *supervision.state() else {
                panic!("a crash wait ends in a start: {:?}", supervision.state());
            };
            launch = next;
        }
    }
    let refused = supervision.transition(SupervisorEvent::Start);
    let state_after_start = supervision.state().clone();
    supervision.transition(SupervisorEvent::Restart);

    assert_eq!(state_after_start, SupervisorState::CrashLoop);
    assert_eq!(format!("{refused:?}"), "[Publish(CrashLoop)]");
    let SupervisorState::Starting {
        launch: restarted,
        recovery: Some(CodexServiceRecoveryCause::PersonRestart),
    } = *supervision.state()
    else {
        panic!(
            "the person's restart starts the service under its own cause: {:?}",
            supervision.state()
        );
    };
    supervision.transition(start_failed(restarted));
    assert!(
        matches!(supervision.state(), SupervisorState::Restarting { .. }),
        "a failed start after the person's restart counts as a crash: {:?}",
        supervision.state()
    );
}
