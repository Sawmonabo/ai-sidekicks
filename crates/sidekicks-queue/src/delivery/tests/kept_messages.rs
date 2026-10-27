//! Messages kept past their hand: by the provider process they went to, only while that very
//! process is the session's, and by a resume whose outcome is unknown, never read again until it
//! is settled, its provider's record read only once no live process holds it.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::run::control::AgentRunResumeRequest;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::run_control::TakenMessages;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::port::run_pause::ContinuedMessages;
use sidekicks_provider::process_identity::{ProviderProcessIdentity, TEST_PROVIDER_PROCESS};
use sidekicks_session::queue_store::RecordedQueueItemState;
use sidekicks_session::run::engine::test_fixture::test_engine;
use sidekicks_session::run::pause::{RUN_PAUSE_STATEMENT_CAPACITY, RunPauseControl};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use super::{
    HANDS_AT_ONCE, continued_ids, count_steers, driver_handing, fixture, hand, insert_item,
    set_run_state, settle, stored_item,
};

/// A provider whose process keeps a message past its run's end, for a turn it starts with it.
const KEPT_BY_PROCESS: MessageHanding = MessageHanding {
    hands_at: HandMoment::AtOnce,
    can_withdraw: true,
    kept_by_process: true,
    reads_priority_message: false,
};

// A message handed to a provider whose process keeps it past the run's end stays handed through
// the end while that process is the session's; once the session's process is gone, or is a new
// one the system gave the old id, the message is forgotten, its run answered, and it waits
// without being handed again. Killed by forgetting kept messages at the run's end, by keeping them
// once their process is gone, or by matching the process by its id alone.
#[rstest]
#[case::no_process_runs(None)]
#[case::a_new_process_reuses_the_id(Some(ProviderProcessIdentity {
    process_id: TEST_PROVIDER_PROCESS.process_id,
    spawn_sequence: TEST_PROVIDER_PROCESS.spawn_sequence + 1,
}))]
#[tokio::test]
async fn a_message_kept_by_a_process_no_longer_the_sessions_waits_unhanded(
    #[case] next_process: Option<ProviderProcessIdentity>,
) {
    let mut driver = driver_handing(KEPT_BY_PROCESS);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;

    set_run_state(&fixture, RunState::Completed);
    fixture.delivery.end_run(fixture.session_id, fixture.run_id);
    let is_kept_through_the_end = fixture.delivery.is_handed(&item.id);
    fixture.process.set(next_process);
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

// A message a resume read and kept, its outcome unknown, is read by no later continue, and a
// later resume's release and the run's end both leave it kept, until its settle gives it back.
// Killed by reading a kept message again, or by forgetting it at the run's end.
#[tokio::test]
async fn a_message_a_resume_keeps_is_never_read_again_until_settled() {
    let fixture = fixture(driver_handing(HANDS_AT_ONCE)).await;
    let item = insert_item(&fixture).await;
    set_run_state(&fixture, RunState::Paused);

    let first_read = continued_ids(&fixture).await;
    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        ContinuedMessages::keep(&fixture.delivery, &hold, fixture.run_id);
    }
    let second_read = continued_ids(&fixture).await;
    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        ContinuedMessages::release(&fixture.delivery, &hold, fixture.run_id)
            .await
            .expect("the release answers");
    }
    let read_after_a_release = continued_ids(&fixture).await;
    set_run_state(&fixture, RunState::Stopped);
    fixture.delivery.end_run(fixture.session_id, fixture.run_id);
    let is_kept_through_the_end = fixture.delivery.is_handed(&item.id);
    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        ContinuedMessages::settle_kept(&fixture.delivery, &hold, fixture.run_id, &[item.id], &[])
            .await
            .expect("the kept message is settled");
    }
    let read_after_the_settle = continued_ids(&fixture).await;

    assert_eq!(first_read, vec![item.id]);
    assert_eq!(second_read, []);
    assert_eq!(read_after_a_release, []);
    assert!(is_kept_through_the_end);
    assert_eq!(read_after_the_settle, vec![item.id]);
}

// A message a resume sent with no answer back, on a provider whose process keeps messages past a
// run's end, stays kept through the run's end with its provider's record unread while that
// process is the session's, since the process may still start a turn with it; once the process
// is gone, the record says what became of it. Killed by reading the record at the run's end or
// forgetting the message there.
#[tokio::test]
async fn a_resume_kept_message_a_live_process_holds_waits_for_the_process_end() {
    let fixture = fixture(driver_handing(KEPT_BY_PROCESS)).await;
    let item = insert_item(&fixture).await;
    set_run_state(&fixture, RunState::Paused);
    let record_reads = Arc::new(AtomicUsize::new(0));
    let mut resume_driver = driver_handing(KEPT_BY_PROCESS);
    resume_driver
        .expect_resume_run()
        .times(1)
        .returning(|_| async { Err(unanswered()) }.boxed());
    {
        let record_reads = Arc::clone(&record_reads);
        resume_driver
            .expect_find_taken_messages()
            .returning(move |_| {
                record_reads.fetch_add(1, Ordering::SeqCst);
                async { Ok(TakenMessages { taken: Vec::new() }) }.boxed()
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
    let resumed = control
        .resume(
            &AgentRunResumeRequest {
                target_run_id: fixture.run_id,
                expected_run_version: SafeInt::new(1).expect("a test version"),
            },
            &fixture.delivery,
        )
        .await;

    set_run_state(&fixture, RunState::Stopped);
    fixture.delivery.end_run(fixture.session_id, fixture.run_id);
    let at_the_runs_end = control
        .settle_kept_by_record(fixture.session_id, fixture.run_id, &fixture.delivery)
        .await;
    let reads_at_the_runs_end = record_reads.load(Ordering::SeqCst);
    let is_kept_through_the_end = fixture.delivery.is_handed(&item.id);
    fixture.process.set(None);
    let at_the_process_end = control
        .settle_kept_by_record(fixture.session_id, fixture.run_id, &fixture.delivery)
        .await;

    assert!(resumed.is_err(), "{resumed:?}");
    assert!(at_the_runs_end.is_ok(), "{at_the_runs_end:?}");
    assert_eq!(reads_at_the_runs_end, 0);
    assert!(is_kept_through_the_end);
    assert!(at_the_process_end.is_ok(), "{at_the_process_end:?}");
    assert_eq!(record_reads.load(Ordering::SeqCst), 1);
    assert!(!fixture.delivery.is_handed(&item.id));
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::Queued
    );
}
