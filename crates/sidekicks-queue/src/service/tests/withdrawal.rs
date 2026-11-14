//! A plan message's withdrawal once what it carried out ended, on a hand-off's seed: found by its
//! plan whatever key a retry sent it under, canceled while it waits or reads not delivered, and
//! answered as taken once a run took it or starts with it; a late admission of one canceled leaves
//! it canceled, and the session's other messages stay as they were.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::queue::{MessageText, PlanMessageKind, QueueItemNotDeliveredReason};
use sidekicks_provider::driver::ports::MessageTakenListener as _;
use sidekicks_session::queue_store::RecordedQueueItemState;
use tokio::time::timeout;

use super::sends::{PLAN_MESSAGE_TEXT, new_plan_id, queue_item_id_of};
use super::{DriverCalls, Fixture, WAIT, client_key, fixture, recording_driver};
use crate::service::withdrawal::CancelOutcome;

/// The reason a seed whose run failed to start reads not delivered.
const START_FAILED: RecordedQueueItemState = RecordedQueueItemState::NotDelivered {
    reason: QueueItemNotDeliveredReason::Failed {},
};

impl Fixture {
    /// Withdraws the session's hand-off seed of `plan_id` as the hand-off's end does.
    async fn withdraw_seed(&self, plan_id: PlanId) -> Option<CancelOutcome> {
        timeout(
            WAIT,
            self.queue
                .withdraw_plan_message(self.session_id, plan_id, PlanMessageKind::Seed),
        )
        .await
        .expect("the withdrawal answers")
        .expect("the withdrawal reads and writes")
    }
}

// A seed waiting behind a running turn is taken back and reads canceled, its cancel recorded,
// while a person's message waiting beside it stays queued. Killed by a waiting seed left for a
// run to open with, and by the withdrawal taking the person's message with it.
#[tokio::test]
async fn a_waiting_seed_is_canceled_and_the_message_beside_it_stays() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("running").await;
    let plan_id = new_plan_id();
    let seed_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Seed, client_key())
        .await;
    let message_id = fixture.queue_message(run_id).await;

    let withdrawn = fixture.withdraw_seed(plan_id).await;
    fixture.queue.stop().await;

    assert_eq!(withdrawn, Some(CancelOutcome::Canceled));
    assert_eq!(
        fixture.stored_state(seed_id),
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        fixture.count_events(Some("agent.queueItem.canceled"), Some(seed_id)),
        1
    );
    assert_eq!(
        fixture.stored_state(message_id),
        RecordedQueueItemState::Queued
    );
}

// A seed whose run failed to start reads not delivered and is canceled outright, so no retry sends
// it again; the provider then reporting it taken leaves it canceled, with no admission recorded.
// Killed by a not-delivered seed left for its retry, and by a late admission over the cancel.
#[tokio::test]
async fn a_seed_not_delivered_is_canceled_and_stays_so_when_taken_late() {
    let calls = Arc::new(DriverCalls::default());
    calls.start_failures_left.store(1, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let plan_id = new_plan_id();
    let seed_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Seed, client_key())
        .await;
    fixture.queue.stop().await;
    assert_eq!(fixture.stored_state(seed_id), START_FAILED);

    let withdrawn = fixture.withdraw_seed(plan_id).await;
    let run_id = fixture
        .stored_item(seed_id)
        .target_run_id
        .expect("the seed waited for its run");
    fixture
        .queue
        .delivery
        .message_taken(fixture.session_id, seed_id.text().as_str(), run_id);
    timeout(WAIT, fixture.queue.delivery.settle(fixture.session_id))
        .await
        .expect("the late admission settles");
    fixture.queue.stop().await;

    assert_eq!(withdrawn, Some(CancelOutcome::Canceled));
    assert_eq!(
        fixture.stored_state(seed_id),
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        fixture.count_events(Some("agent.queueItem.canceled"), Some(seed_id)),
        1
    );
    assert_eq!(
        fixture.count_events(Some("agent.queueItem.admitted"), Some(seed_id)),
        0
    );
}

// A seed its retry sent again in its own words, under the retry's key, is found by its plan: the
// retry, not delivered either, reads canceled and the first stays superseded. Killed by the seed
// matched by the key the hand-off sent it under.
#[tokio::test]
async fn a_seed_sent_again_by_its_retry_is_found_by_its_plan() {
    let calls = Arc::new(DriverCalls::default());
    calls.start_failures_left.store(2, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let plan_id = new_plan_id();
    let first_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Seed, client_key())
        .await;
    fixture.queue.stop().await;
    let retried = fixture
        .replace_item_carrying(first_id, |request| {
            request.content =
                MessageText::new(PLAN_MESSAGE_TEXT.to_owned()).expect("a test message");
        })
        .await
        .expect("the retry is queued");
    fixture.queue.stop().await;
    let retried_id = queue_item_id_of(&retried);
    assert_eq!(fixture.stored_state(retried_id), START_FAILED);

    let withdrawn = fixture.withdraw_seed(plan_id).await;
    fixture.queue.stop().await;

    assert_eq!(withdrawn, Some(CancelOutcome::Canceled));
    assert_eq!(
        fixture.stored_state(retried_id),
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        fixture.stored_state(first_id),
        RecordedQueueItemState::Superseded
    );
}

// A seed a run took is answered as taken and stays admitted, nothing written. Killed by an
// admitted seed canceled.
#[tokio::test]
async fn a_seed_a_run_took_is_answered_taken() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let plan_id = new_plan_id();
    let seed_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Seed, client_key())
        .await;
    fixture.queue.stop().await;
    let events = fixture.count_events(None, None);

    let withdrawn = fixture.withdraw_seed(plan_id).await;

    assert_eq!(withdrawn, Some(CancelOutcome::Taken));
    assert_eq!(
        fixture.stored_state(seed_id),
        RecordedQueueItemState::Admitted
    );
    assert_eq!(fixture.count_events(None, None), events);
}

// A seed its run is starting with is answered as taken while it still reads queued, and the run
// then takes it. Killed by an opening seed canceled under its starting run.
#[tokio::test]
async fn a_seed_a_starting_run_opens_with_is_answered_taken() {
    let calls = Arc::new(DriverCalls::default());
    let start = calls.start_pause.arm();
    let fixture = fixture(recording_driver(&calls)).await;
    let plan_id = new_plan_id();
    let seed_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Seed, client_key())
        .await;
    timeout(WAIT, start.reached)
        .await
        .expect("the seed's run starts")
        .expect("the start reaches the driver");

    let withdrawn = fixture.withdraw_seed(plan_id).await;
    let state_during_start = fixture.stored_state(seed_id);
    start.release.send(()).expect("the start waits");
    fixture.queue.stop().await;

    assert_eq!(withdrawn, Some(CancelOutcome::Taken));
    assert_eq!(state_during_start, RecordedQueueItemState::Queued);
    assert_eq!(
        fixture.stored_state(seed_id),
        RecordedQueueItemState::Admitted
    );
}

// With no seed of the plan, the withdrawal answers none and writes nothing: the plan's build
// message and another plan's seed keep waiting. Killed by a seed matched without its plan, and by
// a plan message of the other kind withdrawn.
#[tokio::test]
async fn with_no_seed_of_the_plan_the_withdrawal_answers_none() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    fixture.insert_run("running").await;
    let plan_id = new_plan_id();
    let build_id = fixture
        .send_plan_message(plan_id, PlanMessageKind::Build, client_key())
        .await;
    let other_seed_id = fixture
        .send_plan_message(new_plan_id(), PlanMessageKind::Seed, client_key())
        .await;
    let events = fixture.count_events(None, None);

    let withdrawn = fixture.withdraw_seed(plan_id).await;
    fixture.queue.stop().await;

    assert_eq!(withdrawn, None);
    assert_eq!(fixture.count_events(None, None), events);
    assert_eq!(
        fixture.stored_state(build_id),
        RecordedQueueItemState::Queued
    );
    assert_eq!(
        fixture.stored_state(other_seed_id),
        RecordedQueueItemState::Queued
    );
}
