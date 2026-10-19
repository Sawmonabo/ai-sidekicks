//! Take-backs: a handed message the chain does not reach in time reads not delivered with no
//! driver call, and one never handed is the queue's at once.

use std::sync::atomic::Ordering;

use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use tokio::time::Instant;

use super::{
    HANDS_AT_ONCE, count_steers, count_withdraws, driver_handing, fixture, hand, hold_chain,
    insert_item, release_chain, settle, stored_item,
};
use crate::queue::delivery::{QueueWithdrawal, WITHDRAW_DEADLINE};
use crate::queue::refusals::UnreturnedReason;
use crate::queue::store::RecordedQueueItemState;

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
        let hold = fixture.session_lock.acquire(fixture.session_id).await;
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
            reason: QueueItemNotDeliveredReason::Failed
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
        let hold = fixture.session_lock.acquire(fixture.session_id).await;
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
