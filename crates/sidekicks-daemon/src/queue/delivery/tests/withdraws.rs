//! Take-backs: a handed message the chain does not reach in time reads not delivered with no
//! driver call, one never handed is the queue's at once, and one a resume of its run read is
//! taken at once.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::run::control::AgentRunResumeRequest;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::{Notify, oneshot};
use tokio::time::Instant;

use super::{
    HANDS_AT_ONCE, count_steers, count_withdraws, driver_handing, fixture, hand, hold_chain,
    insert_item, release_chain, set_run_state, settle, stored_item,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::provider::driver::contract::{DriverError, MockProviderDriver};
use crate::provider::driver::test_registry::registry_of_first_provider;
use crate::queue::delivery::{QueueWithdrawal, WITHDRAW_DEADLINE};
use crate::queue::refusals::UnreturnedReason;
use crate::queue::store::{QueueItemOutcome, RecordedQueueItemState};
use crate::session::run::engine::tests::test_engine;
use crate::session::run::pause::{RUN_PAUSE_STATEMENT_CAPACITY, RunPauseControl, RunPauseError};

/// How long the test gives a call that does not wait for the session's hold to act.
const HOLD_WATCH: Duration = Duration::from_millis(200);

// A withdraw the chain does not reach within the deadline answers not delivered, the message
// reads not delivered and stays handed, and once the chain reaches it the withdraw makes no
// driver call. Killed by dropping the deadline check at the withdraw's start.
#[tokio::test(start_paused = true)]
async fn a_withdraw_past_its_deadline_reads_not_delivered_and_reaches_no_driver() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = count_steers(&mut driver);
    let withdraws = count_withdraws(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;
    let (release, holder) = hold_chain(&fixture).await;

    let started = Instant::now();
    let withdrawals = {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        fixture
            .delivery
            .take_back(&hold, std::slice::from_ref(&item))
            .await
            .expect("the take-back answers")
    };
    let waited = started.elapsed();
    let is_handed = fixture.delivery.is_handed(&item.id);
    release_chain(release, holder).await;
    settle(&fixture).await;

    assert_eq!(steers.load(Ordering::SeqCst), 1);
    assert!(waited >= WITHDRAW_DEADLINE);
    assert!(matches!(
        withdrawals.get(&item.id),
        Some(QueueWithdrawal::Unreturned(UnreturnedReason::NotDelivered))
    ));
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {}
        }
    );
    assert!(is_handed, "a message not given back stays handed");
    assert_eq!(withdraws.load(Ordering::SeqCst), 0);
}

// A message never handed is given back at once while the chain is busy, and still waits. Killed
// by withdrawing it on the chain, where it waits out the deadline and reads not delivered.
#[tokio::test(start_paused = true)]
async fn a_message_never_handed_is_returned_at_once_behind_a_busy_chain() {
    let fixture = fixture(driver_handing(HANDS_AT_ONCE)).await;
    let item = insert_item(&fixture).await;
    let (release, holder) = hold_chain(&fixture).await;

    let started = Instant::now();
    let withdrawals = {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        fixture
            .delivery
            .take_back(&hold, std::slice::from_ref(&item))
            .await
            .expect("the take-back answers")
    };
    let waited = started.elapsed();
    release_chain(release, holder).await;
    settle(&fixture).await;

    assert!(waited < WITHDRAW_DEADLINE);
    assert_eq!(withdrawals.get(&item.id), Some(&QueueWithdrawal::Returned));
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::Queued
    );
}

/// When a take-back meets a resume of the message's run.
#[derive(Clone, Copy, Debug)]
enum TakeBackMoment {
    /// The person's change holds the session first and removes the message before letting go.
    BeforeTheResume,
    /// The change comes while the driver takes the resume, which the provider then refuses.
    DuringARefusedResume,
}

// A take-back and a resume of one run take the session's hold in turn: a resume never sends a
// message the person removed under their hold, and a change that comes while the driver takes a
// resume finds the message taken at once, without waiting for the driver, and the refused resume
// gives it back to the queue. Killed by reading the waiting messages without the session's hold,
// or by withdrawing a message the resume read.
#[rstest]
#[case::before_the_resume(TakeBackMoment::BeforeTheResume)]
#[case::during_a_refused_resume(TakeBackMoment::DuringARefusedResume)]
#[tokio::test]
async fn a_take_back_and_a_resume_of_one_run_take_the_session_in_turn(
    #[case] moment: TakeBackMoment,
) {
    let fixture = fixture(driver_handing(HANDS_AT_ONCE)).await;
    let item = insert_item(&fixture).await;
    set_run_state(&fixture, RunState::Paused);
    let sent: Arc<Mutex<Vec<Vec<QueueItemId>>>> = Arc::default();
    let driver_started = Arc::new(Notify::new());
    let (answer_driver, driver_answer) = oneshot::channel::<Result<(), DriverError>>();
    let mut resume_driver = MockProviderDriver::new();
    resume_driver
        .expect_message_handing()
        .return_const(HANDS_AT_ONCE);
    {
        let sent = Arc::clone(&sent);
        let started = Arc::clone(&driver_started);
        let answer = Mutex::new(Some(driver_answer));
        resume_driver
            .expect_resume_run()
            .times(1)
            .returning(move |params| {
                sent.lock()
                    .expect("the sent messages read")
                    .push(params.messages.iter().map(|message| message.id).collect());
                started.notify_one();
                let answer = answer
                    .lock()
                    .expect("the driver's answer reads")
                    .take()
                    .expect("the driver is resumed once");
                async move { answer.await.expect("the test answers the driver") }.boxed()
            });
    }
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let control = RunPauseControl::new(
        Arc::new(DatabaseReadPool::new(
            fixture.database.path(),
            RUN_PAUSE_STATEMENT_CAPACITY,
        )),
        test_engine(
            &fixture.database,
            Arc::clone(&fixture.log.service),
            home.path(),
        ),
        Arc::new(registry_of_first_provider(Arc::new(resume_driver))),
    );
    let request = AgentRunResumeRequest {
        target_run_id: fixture.run_id,
        expected_run_version: SafeInt::new(1).expect("the run's version is a safe integer"),
    };

    let (resumed, withdrawals) = match moment {
        TakeBackMoment::BeforeTheResume => {
            answer_driver
                .send(Ok(()))
                .expect("the driver waits for its answer");
            let hold = fixture.session_lock.hold_session(fixture.session_id).await;
            let withdrawals = fixture
                .delivery
                .take_back(&hold, std::slice::from_ref(&item))
                .await
                .expect("the take-back answers");
            let removed = async {
                tokio::time::sleep(HOLD_WATCH).await;
                fixture
                    .delivery
                    .shared
                    .deps
                    .recorder
                    .record_outcome(&item, QueueItemOutcome::Canceled, &WireInstant::now())
                    .await
                    .expect("the person's removal is written");
                drop(hold);
            };
            let (resumed, ()) = tokio::join!(control.resume(&request, &fixture.delivery), removed);
            (resumed, withdrawals)
        }
        TakeBackMoment::DuringARefusedResume => {
            let taken_back = async {
                driver_started.notified().await;
                let take_back = async {
                    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
                    fixture
                        .delivery
                        .take_back(&hold, std::slice::from_ref(&item))
                        .await
                        .expect("the take-back answers")
                };
                let refuse = async {
                    tokio::time::sleep(HOLD_WATCH).await;
                    answer_driver
                        .send(Err(DriverError::Internal(
                            "the provider would not resume".into(),
                        )))
                        .expect("the driver waits for its answer");
                };
                tokio::join!(take_back, refuse).0
            };
            tokio::join!(control.resume(&request, &fixture.delivery), taken_back)
        }
    };

    match moment {
        TakeBackMoment::BeforeTheResume => {
            assert_eq!(withdrawals.get(&item.id), Some(&QueueWithdrawal::Returned));
            assert!(resumed.is_ok(), "{resumed:?}");
            assert_eq!(*sent.lock().expect("the sent messages read"), vec![vec![]]);
            assert_eq!(
                stored_item(&fixture, item.id).state,
                RecordedQueueItemState::Canceled
            );
        }
        TakeBackMoment::DuringARefusedResume => {
            assert_eq!(
                withdrawals.get(&item.id),
                Some(&QueueWithdrawal::Unreturned(UnreturnedReason::Taken))
            );
            assert!(
                matches!(
                    resumed,
                    Err(RunPauseError::Driver(DriverError::Internal(_)))
                ),
                "{resumed:?}"
            );
            assert_eq!(
                *sent.lock().expect("the sent messages read"),
                vec![vec![item.id]]
            );
            assert_eq!(
                stored_item(&fixture, item.id).state,
                RecordedQueueItemState::Queued
            );
        }
    }
}
