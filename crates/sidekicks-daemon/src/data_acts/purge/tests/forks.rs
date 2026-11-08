//! A purged session's forks: each stays whole and names no parent, and a rebuild of a fork's row
//! never writes the purged parent back.

use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::event_cursor::{START_OF_LOG_POSITION, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_session::directory::projection::SessionDirectoryProjection;
use sidekicks_session::directory::row::{DirectoryEvent, directory_statements_for};
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::writer::test_file::test_envelope;
use sidekicks_store::events::log_service::EventLogAppendOptions;
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_store::events::session::read::{SessionEventFilter, SessionEventReads};

use super::{PurgeFixture, only_outcome, purge_fixture, state_of, store_session};
use crate::data_acts::purge::SessionPurgeOutcome;
use crate::data_acts::purge::rows::PurgeCaller;

// `fork`'s `session.created`, naming `parent`, appended with the directory row its write makes.
async fn append_fork_created(fixture: &PurgeFixture, fork: SessionId, parent: SessionId) {
    let event: SessionEvent = serde_json::from_value(json!({
        "type": "session.created",
        "payload": {
            "sessionId": fork,
            "shape": "chat",
            "mainAgent": {
                "agentId": mint_uuid_v7().to_string(),
                "name": "lead",
                "binding": {
                    "providerName": "test-provider",
                    "modelId": "test-model",
                    "providerAccountId": null,
                    "effort": null,
                },
                "ancestry": [],
                "createdAt": "2026-11-08T09:00:00.000Z",
            },
            "parent": {
                "sessionId": parent,
                "anchorCursor": encode_event_cursor(0).expect("the first position is a cursor"),
            },
        },
    }))
    .expect("the test writes a fork's session.created");
    let envelope = test_envelope(fork, &event);
    let directory_row = directory_statements_for(&DirectoryEvent::from(&envelope))
        .expect("the fork's row is drafted");
    fixture
        .log
        .service
        .append(
            envelope,
            EventLogAppendOptions {
                transactional_prelude: directory_row,
                ..EventLogAppendOptions::default()
            },
        )
        .await
        .expect("the fork is created");
}

// Folds `session_id`'s log into its directory row and writes the row over it, as a rebuild does.
async fn rebuild_directory_row(fixture: &PurgeFixture, session_id: SessionId) {
    let reader = fixture.database.reader();
    let envelopes = SessionEventReads::new(&reader, |_: &SessionId| None)
        .read_after(
            &session_id,
            START_OF_LOG_POSITION,
            -1,
            SessionEventFilter::default(),
        )
        .expect("the log reads");
    let mut fold = SessionDirectoryProjection.fold(&session_id);
    let mut statements = Vec::new();
    for envelope in &envelopes {
        let event = SessionEvent::from_envelope(envelope).expect("a stored event reads");
        fold.apply(envelope, &event, &mut statements)
            .expect("the log folds");
    }
    fixture
        .log
        .writer
        .write(statements)
        .await
        .expect("the rebuilt row is written");
}

fn parent_of(connection: &Connection, session_id: SessionId) -> Option<String> {
    connection
        .query_row(
            "SELECT parent_session_id FROM sessions WHERE id = ?1",
            [session_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the fork's row reads")
}

// A fork names its parent while the parent stands, a rebuild included, and once the parent is
// purged the fork stays whole and names no parent, a rebuild of its row writing none back and a
// create naming the purged parent writing none either. Killed by the purge's write leaving the
// fork's parent column, by the rebuild's row write naming a parent that has no row, and by the
// create's row write doing so.
#[tokio::test]
async fn a_purged_parents_forks_stay_whole_and_name_no_parent() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let parent = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    let fork = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    let parent_text = Some(parent.text().as_str().to_owned());
    store_session(&reader, parent, SessionState::Archived);
    append_fork_created(&fixture, fork, parent).await;
    assert_eq!(parent_of(&reader, fork), parent_text, "the create names it");
    rebuild_directory_row(&fixture, fork).await;
    assert_eq!(parent_of(&reader, fork), parent_text, "a rebuild keeps it");

    let outcome = only_outcome(
        fixture
            .purge
            .purge(
                &[parent],
                PurgeCaller::Retention,
                &ProcessorMeter::default(),
            )
            .await,
    );

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the parent is purged, got {outcome:?}"
    );
    assert_eq!(state_of(&reader, parent), None);
    assert_eq!(
        state_of(&reader, fork).as_deref(),
        Some(<&'static str>::from(SessionState::Provisioning)),
        "the fork stays whole"
    );
    assert_eq!(parent_of(&reader, fork), None, "the purge clears it");
    rebuild_directory_row(&fixture, fork).await;
    assert_eq!(
        parent_of(&reader, fork),
        None,
        "a rebuild writes no dead parent"
    );
    let late_fork = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    append_fork_created(&fixture, late_fork, parent).await;
    assert_eq!(
        parent_of(&reader, late_fork),
        None,
        "a create writes no dead parent"
    );
}
