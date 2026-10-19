//! Messages kept past their hand: by the provider process they went to, only while that very
//! process is the session's, and by a resume whose outcome is unknown, never read again until it
//! is settled.

use std::sync::atomic::Ordering;

use rstest::rstest;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;

use super::{
    FIRST_PROCESS, Fixture, HANDS_AT_ONCE, count_steers, driver_handing, fixture, hand,
    insert_item, set_run_state, settle, stored_item,
};
use crate::provider::driver::message_handing::{HandMoment, MessageHanding};
use crate::queue::delivery::ProviderProcessIdentity;
use crate::queue::store::RecordedQueueItemState;
use crate::session::run::pause::ContinuedMessages;

// A message handed to a provider whose process keeps it past the run's end stays handed through
// the end while that process is the session's; once the session's process is gone, or is a new
// one the system gave the old id, the message is forgotten, its run answered, and it waits
// without being handed again. Killed by forgetting kept messages at the run's end, by keeping them
// once their process is gone, or by matching the process by its id alone.
#[rstest]
#[case::no_process_runs(None)]
#[case::a_new_process_reuses_the_id(Some(ProviderProcessIdentity {
    process_id: FIRST_PROCESS.process_id,
    spawn_sequence: FIRST_PROCESS.spawn_sequence + 1,
}))]
#[tokio::test]
async fn a_message_kept_by_a_process_no_longer_the_sessions_waits_unhanded(
    #[case] next_process: Option<ProviderProcessIdentity>,
) {
    let mut driver = driver_handing(MessageHanding {
        hands_at: HandMoment::AtOnce,
        can_withdraw: true,
        kept_by_process: true,
    });
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;

    set_run_state(&fixture, RunState::Completed);
    fixture.delivery.end_run(fixture.session_id, fixture.run_id);
    let is_kept_through_the_end = fixture.delivery.is_handed(&item.id);
    *fixture
        .process
        .0
        .lock()
        .expect("the test's process is writable") = next_process;
    let ended_runs = fixture
        .delivery
        .forget_kept_by_gone_process(fixture.session_id)
        .await
        .expect("the kept messages are read");
    settle(&fixture).await;

    assert!(is_kept_through_the_end);
    assert_eq!(ended_runs, vec![fixture.run_id]);
    assert!(!fixture.delivery.is_handed(&item.id));
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::Queued
    );
    assert_eq!(steers.load(Ordering::SeqCst), 1);
}

async fn continued_ids(fixture: &Fixture) -> Vec<QueueItemId> {
    ContinuedMessages::read(&fixture.delivery, fixture.run_id)
        .await
        .expect("the continue reads the waiting messages")
        .iter()
        .map(|message| message.id)
        .collect()
}

// A message a resume read and kept, its outcome unknown, is read by no later continue, and a
// later resume's release leaves it kept, until its settle gives it back. Killed by reading a kept
// message again.
#[tokio::test]
async fn a_message_a_resume_keeps_is_never_read_again_until_settled() {
    let fixture = fixture(driver_handing(HANDS_AT_ONCE)).await;
    let item = insert_item(&fixture).await;
    set_run_state(&fixture, RunState::Paused);

    let first_read = continued_ids(&fixture).await;
    fixture.delivery.keep_continued(fixture.run_id);
    let second_read = continued_ids(&fixture).await;
    ContinuedMessages::release(&fixture.delivery, fixture.session_id, fixture.run_id)
        .await
        .expect("the release answers");
    let read_after_a_release = continued_ids(&fixture).await;
    fixture
        .delivery
        .settle_kept_continue(fixture.run_id, false)
        .await
        .expect("the kept message is settled");
    let read_after_the_settle = continued_ids(&fixture).await;

    assert_eq!(first_read, vec![item.id]);
    assert!(second_read.is_empty());
    assert!(read_after_a_release.is_empty());
    assert_eq!(read_after_the_settle, vec![item.id]);
}
