//! The daemon's stop of Claude Code's sessions: every slot closing before any process ends, the
//! surviving background tasks stopped under a person's Stop, a bring-up waited out, each run left
//! for the stop's own settle, and the whole stop ended by its deadline.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use tokio::time::Instant;

use super::held_calls::{holding_session, keep_record, stopped_tasks};
use super::start_params;
use crate::bounded_poll::poll_until;
use crate::driver::claude::session::scripted::channel::{ScriptedChannel, ScriptedWrite};
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, create_params};
use crate::driver::claude::session::scripted::held_calls::closes;
use crate::driver::claude::session::scripted::settle;
use crate::driver::contract::ProviderDriver;
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::run::state_entry::RunStateEntry;

/// What meets a session at the daemon's stop.
#[derive(Clone, Copy, Debug)]
enum AtTheStop {
    /// Under `Restart`, the process writes its turn's `result` and exits while its slot is closing.
    RestartProcessExits,
    /// Under `Restart`, the turn's `result` arrives while the close is held.
    RestartResultArrives,
    /// Under `Restart`, nothing arrives during the close.
    RestartNothingArrives,
    /// Under `Stop`, the process holds a tool server's background task that survives it.
    StopWithASurvivingTask,
    /// Under `Stop`, the session's process is still coming up.
    StopWhileEstablishing,
}

// Fails when the stop ends a run itself, or a slot closes after its process could end. Mutations:
// `end_turn_on_close` run under the daemon's stop (an `EndTurnOnClose` in every case);
// `signal_intended_close` sent under the daemon's stop (the `result` reads `intended_close`); the
// survivors' stop dropped (no `stop_task`), or sent after the processes' stop or the channel's
// close; the slot wait skipped, or the processes stopped before a bring-up's slot settles (a stop
// marked while the bring-up is held); `begin_close` run after the processes' stop (the slot reads
// live at the stop); each close finished before the processes' stop (`Terminate` first); the
// deadline not handed to the processes' stop.
#[rstest]
#[case::restart_process_exits(AtTheStop::RestartProcessExits)]
#[case::restart_result_arrives(AtTheStop::RestartResultArrives)]
#[case::restart_nothing_arrives(AtTheStop::RestartNothingArrives)]
#[case::stop_with_a_surviving_task(AtTheStop::StopWithASurvivingTask)]
#[case::stop_while_establishing(AtTheStop::StopWhileEstablishing)]
#[tokio::test(start_paused = true)]
async fn a_daemon_stop_leaves_each_claude_run_to_the_stops_own_settle(
    #[case] at_the_stop: AtTheStop,
) {
    match at_the_stop {
        AtTheStop::RestartProcessExits
        | AtTheStop::RestartResultArrives
        | AtTheStop::RestartNothingArrives => restart_with_a_live_run(at_the_stop).await,
        AtTheStop::StopWithASurvivingTask => stop_with_a_surviving_task().await,
        AtTheStop::StopWhileEstablishing => stop_while_establishing().await,
    }
}

// A restart of the daemon meeting a live run, with `at_the_stop` arriving while its close is held:
// the run is never ended by the close, and a `result` read meanwhile ends it as Claude Code's own.
async fn restart_with_a_live_run(at_the_stop: AtTheStop) {
    let fixture = ScriptedDriver::new();
    let driver: Arc<dyn ProviderDriver> = fixture.driver.clone();
    let channel = Arc::new(ScriptedChannel::default());
    let session_id = fixture.create(&channel).await;
    let start = fixture.next_start().await;
    let run_id = new_run_id();
    driver
        .start_run(start_params(session_id, run_id))
        .await
        .expect("the run starts");
    settle().await;
    let before = fixture.engine.moves_of_run(run_id);
    let release_close = channel.hold_next_close();
    let release_stop = fixture.starts.hold_stop();
    let deadline = daemon_stop_deadline();

    let shutdown = tokio::spawn({
        let driver = Arc::clone(&driver);
        async move { driver.shutdown(DaemonStopIntent::Restart, deadline).await }
    });
    poll_until(|| channel.processes_stopped_at(), Option::is_some).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    assert!(
        parts.slots().holds_slot(session_id) && parts.slots().live_session(session_id).is_none(),
        "the session's slot reads closing before its process stops"
    );
    release_stop.send(()).expect("the stop is held");
    poll_until(
        || channel.writes(),
        |writes| writes.contains(&ScriptedWrite::Terminate),
    )
    .await;
    match at_the_stop {
        AtTheStop::RestartProcessExits => {
            fixture.end_turn(&start, session_id);
            ScriptedDriver::exit(&start);
        }
        AtTheStop::RestartResultArrives => fixture.end_turn(&start, session_id),
        AtTheStop::RestartNothingArrives
        | AtTheStop::StopWithASurvivingTask
        | AtTheStop::StopWhileEstablishing => {}
    }
    settle().await;
    release_close.send(()).expect("the close is held");
    shutdown.await.expect("the stop's task ends");
    settle().await;

    assert_eq!(fixture.starts.take_stop_deadlines(), [deadline]);
    let closed = channel
        .writes()
        .iter()
        .position(|write| *write == ScriptedWrite::Terminate);
    assert!(
        matches!(
            (channel.processes_stopped_at(), closed),
            (Some(stopped), Some(close)) if stopped <= close
        ),
        "the process stops before its channel closes: {:?}",
        channel.writes()
    );
    assert_eq!(fixture.engine.turn_ends(), []);
    let mut expected = before;
    if !matches!(at_the_stop, AtTheStop::RestartNothingArrives) {
        expected.push(RunStateEntry::Completed {
            intended_close: None,
        });
    }
    assert_eq!(fixture.engine.moves_of_run(run_id), expected);
}

// A person's Stop meeting a process that holds a surviving task: its `stop_task` goes out before
// the processes stop, which is before the process's channel closes, and the run is left to the
// stop's settle.
async fn stop_with_a_surviving_task() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let (session_id, ..) = holding_session(
        &fixture,
        &channel,
        &[("call-A", "task-A"), ("call-B", "task-B")],
    )
    .await;
    keep_record(&fixture, session_id, "call-A", "task-A");

    fixture
        .driver
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
    settle().await;

    assert_eq!(stopped_tasks(&channel), ["task-A"]);
    let writes = channel.writes();
    let stop_sent = writes.iter().position(|write| {
        matches!(write, ScriptedWrite::Control(request) if request["subtype"] == "stop_task")
    });
    let closed = writes
        .iter()
        .position(|write| *write == ScriptedWrite::Terminate);
    assert!(
        matches!(
            (stop_sent, channel.processes_stopped_at(), closed),
            (Some(stop), Some(stopped), Some(close)) if stop < stopped && stopped <= close
        ),
        "the survivor's stop goes out before the processes stop, and they before the process's \
         channel closes: {writes:?}"
    );
    assert_eq!(fixture.engine.turn_ends(), []);
}

// A person's Stop meeting a session whose process is still coming up: the stop waits the bring-up
// out, then closes it, writing nothing for it.
async fn stop_while_establishing() {
    let fixture = ScriptedDriver::new();
    let driver: Arc<dyn ProviderDriver> = fixture.driver.clone();
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let release_start = fixture.starts.hold_next_session_start();
    let session_id = new_session_id();
    let create = tokio::spawn({
        let driver = Arc::clone(&driver);
        async move { driver.create_session(create_params(session_id)).await }
    });
    // Held at its start before the stop's deadline is armed: the paused clock jumps to the next
    // timer whenever every task waits, and the work before the start waits on more than timers.
    fixture.starts.wait_for_starts(1).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    assert!(
        parts.slots().establishing_settled(session_id).is_some(),
        "the session is coming up"
    );

    let shutdown = tokio::spawn({
        let driver = Arc::clone(&driver);
        let deadline = daemon_stop_deadline();
        async move { driver.shutdown(DaemonStopIntent::Stop, deadline).await }
    });
    settle().await;
    assert!(!shutdown.is_finished(), "the stop waits out the bring-up");
    assert_eq!(
        channel.processes_stopped_at(),
        None,
        "no process stops while the bring-up's slot is unsettled"
    );
    // The bring-up's sandbox check answers from the spawner's own thread, which the paused clock
    // never waits on, so a blocking wait alive keeps the clock off the stop's deadline until the
    // create is answered.
    let (end_hold, hold_ended) = std::sync::mpsc::channel::<()>();
    let hold = tokio::task::spawn_blocking(move || hold_ended.recv());
    release_start.send(()).expect("the start is held");
    let _create_answer = create.await.expect("the create's task ends");
    end_hold.send(()).expect("the clock's hold waits");
    hold.await
        .expect("the hold finishes")
        .expect("the hold is ended");
    shutdown.await.expect("the stop's task ends");
    settle().await;

    assert!(!parts.slots().holds_slot(session_id));
    assert!(
        channel.processes_stopped_at().is_some(),
        "the brought-up process is stopped"
    );
    assert_eq!(fixture.engine.turn_ends(), []);
    assert_eq!(closes(fixture.engine.deliveries()), []);
}

// Fails when a survivor's stop that Claude Code never answers holds the daemon's stop past its
// deadline. Mutation: the survivors' stop given the person's close deadline, 2 s from now, in
// place of the stop's own, which ends the stop past the second this allows.
#[tokio::test]
async fn a_daemon_stop_with_an_unanswered_task_stop_ends_by_its_deadline() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let (session_id, ..) = holding_session(&fixture, &channel, &[("call-A", "task-A")]).await;
    keep_record(&fixture, session_id, "call-A", "task-A");
    // Held for the whole test, so the stop is never answered.
    let _unanswered = channel.hold_next_control("stop_task");
    let deadline = Instant::now() + Duration::from_millis(300);

    fixture
        .driver
        .shutdown(DaemonStopIntent::Stop, deadline)
        .await;

    assert!(
        Instant::now() <= deadline + Duration::from_secs(1),
        "the stop ends by its deadline"
    );
    assert_eq!(stopped_tasks(&channel), ["task-A"]);
}
