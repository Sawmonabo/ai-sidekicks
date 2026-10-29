//! What a run's end does with the lead's messages still waiting for it: rest with them and
//! continue, move them to the run before it, to the live run or to a next run; rest until a send
//! when a limit ended it; a start that failed; a process gone for good after its restart; and the
//! queue's stop waiting for a start a run's end made meanwhile and the hand that start's drain made
//! after it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_provider::driver::contract::SessionProcessState;
use sidekicks_provider::driver::session_control::{DriverResumeResult, answer_every_run_gone};
use sidekicks_provider::driver::test_registry::bind_run_to_first_provider;
use sidekicks_provider::process_identity::TEST_PROVIDER_PROCESS;
use sidekicks_provider::runtime_binding::test_store::spawned_build;
use sidekicks_session::queue_store::RecordedQueueItemState;
use sidekicks_std::mutex_lock::lock;
use tokio::time::{sleep, timeout};

use super::{DriverCalls, Fixture, HELD_WATCH, WAIT, fixture, recording_driver};

/// How the session's lead runs stand when one of them ends with a message waiting.
#[derive(Clone, Copy, Debug)]
enum EndedRun {
    /// A person interrupted the session's current lead run.
    Interrupted,
    /// A newer lead run failed before it ran, so the interrupted run before it is current again.
    FailedAfterInterrupted,
    /// A run ended while a newer lead run runs.
    CompletedBeforeLiveRun,
    /// The session's only run completed.
    Completed,
}

/// Where the ended run's message goes.
enum Expected {
    /// It continues this run, which the driver starts with it.
    Continues(RunId),
    /// It is steered into this live run.
    Steered(RunId),
    /// A next run, which the driver starts with it.
    NextRun,
}

impl Fixture {
    /// Ends `run_id` as the lifecycle settles a run's end, then waits for what that end started.
    pub(super) async fn settle_end(&self, run_id: RunId) {
        self.queue
            .lifecycle
            .settle_ended_run(self.session_id, run_id);
        timeout(WAIT, self.queue.stop())
            .await
            .expect("the run's end settles");
    }
}

// A run's end with a message waiting: the session's current run a person interrupted rests and
// is continued with it; a newer run that failed before it ran gives it to the interrupted run
// before it, which is continued with it; a run ended under a live run steers it into that run;
// and the session's last run ended queues a next run that starts with it. Killed by removing any
// of these branches, the move back to an interrupted run and the move into the live run among
// them.
#[rstest]
#[case::interrupted(EndedRun::Interrupted)]
#[case::failed_after_interrupted(EndedRun::FailedAfterInterrupted)]
#[case::completed_before_live_run(EndedRun::CompletedBeforeLiveRun)]
#[case::completed(EndedRun::Completed)]
#[tokio::test]
async fn a_runs_end_moves_its_waiting_message_on(#[case] ended: EndedRun) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let (ended_run_id, expected) = match ended {
        EndedRun::Interrupted => {
            let run_id = fixture.insert_run("interrupted");
            fixture.insert_interrupted_end(run_id, None);
            (run_id, Expected::Continues(run_id))
        }
        EndedRun::FailedAfterInterrupted => {
            let interrupted_run_id = fixture.insert_run("interrupted");
            fixture.insert_interrupted_end(interrupted_run_id, None);
            (
                fixture.insert_run("failed"),
                Expected::Continues(interrupted_run_id),
            )
        }
        EndedRun::CompletedBeforeLiveRun => {
            let ended_run_id = fixture.insert_run("completed");
            let live_run_id = fixture.insert_run("running");
            bind_run_to_first_provider(&fixture.database, live_run_id);
            (ended_run_id, Expected::Steered(live_run_id))
        }
        EndedRun::Completed => (fixture.insert_run("completed"), Expected::NextRun),
    };
    let item_id = fixture.queue_message(ended_run_id).await;

    fixture.settle_end(ended_run_id).await;

    let target = fixture
        .stored_item(item_id)
        .target_run_id
        .expect("the message waits for a run");
    match expected {
        Expected::Continues(run_id) => {
            assert_eq!(calls.starts(), [(run_id, item_id)]);
            assert_eq!(target, run_id);
            assert_eq!(fixture.run_state(run_id), "running");
        }
        Expected::Steered(run_id) => {
            assert!(calls.starts().is_empty(), "{:?}", calls.starts());
            assert_eq!(calls.steers(), [(item_id, false)]);
            assert_eq!(target, run_id);
        }
        Expected::NextRun => {
            assert_ne!(target, ended_run_id);
            assert_eq!(calls.starts(), [(target, item_id)]);
        }
    }
}

// A message the provider's live process keeps past its run's end stays with that run through the
// end, and once a driver tells the queue the process is gone it moves on as at the end, to a next
// run, which starts with it. Killed by a process-gone listener that tells the run lifecycle
// nothing, which leaves it with the ended run.
#[tokio::test]
async fn a_message_a_gone_process_kept_moves_on_once_a_driver_tells_of_it() {
    let calls = Arc::new(DriverCalls::default());
    calls.is_kept_by_process.store(true, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    fixture.process.set(Some(TEST_PROVIDER_PROCESS));
    let run_id = fixture.insert_run("running");
    bind_run_to_first_provider(&fixture.database, run_id);
    let item_id = fixture.queue_message(run_id).await;
    timeout(WAIT, fixture.queue.lifecycle.reconcile(fixture.session_id))
        .await
        .expect("the reconcile answers")
        .expect("the reconcile is heard")
        .expect("the reconcile hands the running run its message");
    fixture.set_run_state(run_id, "completed");
    fixture.settle_end(run_id).await;
    let target_at_end = fixture.stored_item(item_id).target_run_id;

    fixture.process.set(None);
    fixture
        .queue
        .process_gone_listener()
        .process_gone(fixture.session_id);
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the gone process's runs settle");

    assert_eq!(calls.steers(), [(item_id, false)]);
    assert_eq!(target_at_end, Some(run_id));
    let next_run_id = fixture
        .stored_item(item_id)
        .target_run_id
        .expect("the message waits for a run");
    assert_ne!(next_run_id, run_id);
    assert_eq!(calls.starts(), [(next_run_id, item_id)]);
}

// A process whose driver brings it back keeps the session open through the notice of its end,
// and once the restart gives up, the driver's second notice, read as down, forgets it, so the next
// send opens the session again by resuming its conversation. Killed by a process-gone notice that
// does not forget a down process, which leaves the next run on the gone process's opening.
#[tokio::test]
async fn a_restart_that_ends_down_leaves_the_next_send_to_resume_the_session() {
    let calls = Arc::new(DriverCalls::default());
    let mut driver = recording_driver(&calls);
    let state = Arc::new(Mutex::new(SessionProcessState::Live));
    let reading = Arc::clone(&state);
    driver
        .expect_session_process_state()
        .returning(move |_session_id| *lock(&reading));
    let resumes = Arc::new(AtomicUsize::new(0));
    let resuming = Arc::clone(&resumes);
    driver.expect_resume_session().returning(move |params| {
        resuming.fetch_add(1, Ordering::SeqCst);
        let runs = answer_every_run_gone(&params.live_runs);
        async move {
            Ok(DriverResumeResult::Resumed {
                binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
                    .expect("a UUID is a binding id"),
                session_position: SafeInt::new(1).expect("a position"),
                resume_handle: NonEmptyText::new("conversation-1".to_owned())
                    .expect("a resume handle"),
                spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
                runs,
            })
        }
        .boxed()
    });
    let fixture = fixture(driver).await;
    timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is saved");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the send's run starts");
    let [(first_run_id, _)] = calls.starts()[..] else {
        panic!("one run started: {:?}", calls.starts());
    };
    fixture.set_run_state(first_run_id, "completed");

    for gone_as in [SessionProcessState::Restarting, SessionProcessState::Down] {
        *lock(&state) = gone_as;
        fixture
            .queue
            .process_gone_listener()
            .process_gone(fixture.session_id);
        timeout(WAIT, fixture.queue.stop())
            .await
            .expect("the gone process settles");
    }
    timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is saved");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the send's run starts");

    assert_eq!(resumes.load(Ordering::SeqCst), 1);
    assert_eq!(calls.starts().len(), 2, "{:?}", calls.starts());
}

// A run a limit interrupted rests with its message waiting: its end continues nothing, and a send
// continues it, opening with the message that waited first. Killed by continuing a limit's end as
// a person's interrupt is continued, at once.
#[tokio::test]
async fn a_run_a_limit_interrupted_rests_until_a_send() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("interrupted");
    fixture.insert_interrupted_end(run_id, Some("stepLimit"));
    let waited = fixture.queue_message(run_id).await;

    fixture.settle_end(run_id).await;
    let starts_at_end = calls.starts();
    let state_at_end = fixture.run_state(run_id);
    timeout(WAIT, fixture.send())
        .await
        .expect("the send answers")
        .expect("the send is saved");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the continue settles");

    assert!(starts_at_end.is_empty(), "{starts_at_end:?}");
    assert_eq!(state_at_end, "interrupted");
    assert_eq!(calls.starts(), [(run_id, waited)]);
    assert_eq!(fixture.run_state(run_id), "running");
}

// A queued run whose start failed leaves its opening not delivered and its other message waiting
// for a next run, which starts with it. Killed by dropping the opening's not-delivered write, so
// the next run opens with the failed message again.
#[tokio::test]
async fn a_failed_start_leaves_its_opening_not_delivered_and_the_rest_to_a_next_run() {
    let calls = Arc::new(DriverCalls::default());
    calls.start_failures_left.store(1, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("queued");
    let opening = fixture.queue_message(run_id).await;
    let rest = fixture.queue_message(run_id).await;

    timeout(WAIT, fixture.queue.lifecycle.reconcile(fixture.session_id))
        .await
        .expect("the reconcile answers")
        .expect("the reconcile is heard")
        .expect("the reconcile starts the queued run");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the failed start settles");

    assert_eq!(
        fixture.stored_state(opening),
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {}
        }
    );
    let rest_item = fixture.stored_item(rest);
    assert_eq!(rest_item.state, RecordedQueueItemState::Admitted);
    let next_run_id = rest_item.target_run_id.expect("the rest went to a run");
    assert_ne!(next_run_id, run_id);
    assert_eq!(calls.starts(), [(run_id, opening), (next_run_id, rest)]);
}

// The queue's stop waits for a start that a run's end, settled during the stop, made after the
// starts were first waited for, and then for the hand that the drain of that start's `running`
// change makes after the start ended. Killed by waiting each kind of work once, in turn, so the
// stop answers while the start is with the driver, or before the drain's hand reaches it.
#[tokio::test]
async fn stop_waits_for_the_work_a_runs_end_starts_during_the_stop() {
    let calls = Arc::new(DriverCalls::default());
    let start = calls.start_pause.arm();
    let steer = calls.steer_pause.arm();
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("completed");
    let opening = fixture.queue_message(run_id).await;
    let rest = fixture.queue_message(run_id).await;

    let hold = fixture
        .queue
        .session_lock
        .hold_session(fixture.session_id)
        .await;
    fixture
        .queue
        .lifecycle
        .settle_ended_run(fixture.session_id, run_id);
    let queue = Arc::clone(&fixture.queue);
    let stopping = tokio::spawn(async move { queue.stop().await });
    // The stop has waited for the starts before the run's end can take the session.
    sleep(HELD_WATCH).await;
    drop(hold);
    timeout(WAIT, start.reached)
        .await
        .expect("the run's end starts a next run")
        .expect("the start reaches the driver");
    sleep(HELD_WATCH).await;
    let is_stopped_during_start = stopping.is_finished();
    start.release.send(()).expect("the start waits");
    timeout(WAIT, steer.reached)
        .await
        .expect("the next run's `running` change hands it the rest")
        .expect("the hand reaches the driver");
    sleep(HELD_WATCH).await;
    let is_stopped_during_hand = stopping.is_finished();
    steer.release.send(()).expect("the hand waits");
    timeout(WAIT, stopping)
        .await
        .expect("the stop answers once the hand does")
        .expect("the stop's task ends");

    assert!(!is_stopped_during_start, "the stop waits for the start");
    assert!(
        !is_stopped_during_hand,
        "the stop waits for the drain's hand"
    );
    let next_run_id = fixture
        .stored_item(opening)
        .target_run_id
        .expect("the opening went to a run");
    assert_eq!(calls.starts(), [(next_run_id, opening)]);
    assert_eq!(calls.steers(), [(rest, false)]);
}
