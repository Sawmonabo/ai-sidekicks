//! A purge that cannot finish: a failed file step keeping every row for a retry, the range read
//! again once for an append that raced it, the second such refusal a fault, and a session moved
//! off its mark keeping every row.

use rusqlite::params;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_session::conversation_purge::ConversationPurgeError;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::writer::test_file::session_event_row;

use super::{
    append_event, event_count, only_outcome, purge_fixture, receipts, state_of, store_session,
};
use crate::data_acts::purge::rows::PurgeCaller;
use crate::data_acts::purge::{SessionPurgeError, SessionPurgeOutcome};

// Kills: the rows deleted before the files, and a retention purge that will not take up a session
// a failed purge left marked.
#[tokio::test]
async fn a_failed_file_step_keeps_every_row_and_purging_again_finishes() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Closed);
    append_event(&fixture.log, session_id, "Read").await;
    let run_id = mint_uuid_v7().to_string();
    reader
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'completed', 1)",
            params![run_id, session_id.text().as_str()],
        )
        .expect("the test writes the run");
    // A conversation on a provider no driver answers refuses the provider's step.
    reader
        .execute(
            "INSERT INTO runtime_bindings
               (id, run_id, provider_name, contract_version, cli_version_raw, resume_handle,
                spawn_config, created_at, updated_at)
             VALUES (?1, ?2, ?3, '1.0.0', '2.1.0', 'conversation',
                     '{\"providerAccountId\":\"account-1\",
                       \"resolvedExecutablePath\":\"/bin/provider\"}',
                     '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z')",
            params![mint_uuid_v7().to_string(), run_id, test_provider().as_str()],
        )
        .expect("the test writes the binding");

    let refused = only_outcome(
        fixture
            .purge
            .purge(
                &[session_id],
                PurgeCaller::Retention,
                &ProcessorMeter::default(),
            )
            .await,
    );

    assert!(
        matches!(
            refused,
            SessionPurgeOutcome::Refused(SessionPurgeError::Conversations(
                ConversationPurgeError::ProviderNotFound(_)
            ))
        ),
        "the provider's step refuses the purge, got {refused:?}"
    );
    assert_eq!(
        state_of(&reader, session_id).as_deref(),
        Some(<&'static str>::from(SessionState::PurgeRequested))
    );
    assert_eq!(event_count(&reader, session_id), 1);
    assert_eq!(receipts(&reader), []);

    reader
        .execute("DELETE FROM runtime_bindings WHERE run_id = ?1", [&run_id])
        .expect("the test lets the provider's step pass");
    let retried = only_outcome(
        fixture
            .purge
            .purge(
                &[session_id],
                PurgeCaller::Retention,
                &ProcessorMeter::default(),
            )
            .await,
    );

    assert!(
        matches!(retried, SessionPurgeOutcome::Removed { .. }),
        "purging again finishes, got {retried:?}"
    );
    assert_eq!(state_of(&reader, session_id), None);
    assert_eq!(receipts(&reader), vec![(session_id.to_string(), 0, 0)]);
}

// Kills: the upper-bound guard dropped (the receipt misses the raced event) and the range not read
// again after its refusal (the purge refused instead).
#[tokio::test]
async fn an_append_queued_before_the_range_read_is_taken_into_the_receipt() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    append_event(&fixture.log, session_id, "Read").await;
    let before_lock = fixture.purge.rows_lock_pause.arm();
    let before_write = fixture.purge.rows_write_pause.arm();

    let meter = ProcessorMeter::default();
    let session_ids = [session_id];
    let (outcome, ()) = tokio::join!(
        fixture
            .purge
            .purge(&session_ids, PurgeCaller::Retention, &meter),
        async {
            before_lock
                .reached
                .await
                .expect("the purge reaches the append lock");
            #[expect(
                clippy::async_yields_async,
                reason = "the raced append is awaited once the writer's hold lets go"
            )]
            let raced = fixture
                .log
                .writer
                .hold_while(|| async {
                    // Queued under the append lock before the purge takes it, committed after the
                    // purge's range read.
                    let mut raced = Box::pin(append_event(&fixture.log, session_id, "Write"));
                    assert!(futures::poll!(raced.as_mut()).is_pending());
                    before_lock.release.send(()).expect("the purge waits");
                    before_write
                        .reached
                        .await
                        .expect("the purge read its range");
                    raced
                })
                .await;
            raced.await;
            before_write.release.send(()).expect("the purge waits");
        }
    );

    let outcome = only_outcome(outcome);
    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the purge reads the range again and removes the session, got {outcome:?}"
    );
    assert_eq!(event_count(&reader, session_id), 0);
    assert_eq!(receipts(&reader), vec![(session_id.to_string(), 0, 1)]);
}

// Kills: a range read again without end, and a refused write that deletes anything.
#[tokio::test]
async fn a_second_refusal_of_the_range_is_a_fault_that_keeps_every_row() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    append_event(&fixture.log, session_id, "Read").await;
    let first = fixture.purge.rows_write_pause.arm();
    let second = fixture.purge.rows_write_pause.arm();

    let meter = ProcessorMeter::default();
    let session_ids = [session_id];
    let (outcome, ()) = tokio::join!(
        fixture
            .purge
            .purge(&session_ids, PurgeCaller::Retention, &meter),
        async {
            // A row past the range at each write: only a fault past the append lock can write one.
            for pause in [first, second] {
                pause.reached.await.expect("the purge read its range");
                fixture
                    .log
                    .writer
                    .append_events(vec![session_event_row(&session_id)], Vec::new())
                    .await
                    .expect("the row is written");
                pause.release.send(()).expect("the purge waits");
            }
        }
    );

    let outcome = only_outcome(outcome);
    assert!(
        matches!(
            outcome,
            SessionPurgeOutcome::Refused(SessionPurgeError::RangeMoved)
        ),
        "the second refusal is a fault, got {outcome:?}"
    );
    assert_eq!(event_count(&reader, session_id), 3);
    assert_eq!(
        state_of(&reader, session_id).as_deref(),
        Some(<&'static str>::from(SessionState::PurgeRequested))
    );
    assert_eq!(receipts(&reader), []);
}

// Kills: the marked guard dropped (the rows go though the session left `purge_requested`), and its
// refusal read as the range's (the purge writes again).
#[tokio::test]
async fn a_session_moved_after_its_mark_keeps_every_row() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    append_event(&fixture.log, session_id, "Read").await;
    let before_write = fixture.purge.rows_write_pause.arm();

    let meter = ProcessorMeter::default();
    let session_ids = [session_id];
    let (outcome, ()) = tokio::join!(
        fixture
            .purge
            .purge(&session_ids, PurgeCaller::Retention, &meter),
        async {
            before_write
                .reached
                .await
                .expect("the purge read its range");
            reader
                .execute(
                    "UPDATE sessions SET state = ?2 WHERE id = ?1",
                    params![
                        session_id.text().as_str(),
                        <&'static str>::from(SessionState::Archived)
                    ],
                )
                .expect("the test moves the session off its mark");
            before_write.release.send(()).expect("the purge waits");
        }
    );

    let outcome = only_outcome(outcome);
    assert!(
        matches!(
            outcome,
            SessionPurgeOutcome::Refused(SessionPurgeError::MarkLost)
        ),
        "a session moved off its mark is refused, got {outcome:?}"
    );
    assert_eq!(event_count(&reader, session_id), 1);
    assert_eq!(
        state_of(&reader, session_id).as_deref(),
        Some(<&'static str>::from(SessionState::Archived))
    );
    assert_eq!(receipts(&reader), []);
}
