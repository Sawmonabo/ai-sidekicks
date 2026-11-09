//! A purged session's forks: each stays whole and names no parent, and a rebuild of a fork's row
//! never writes the purged parent back.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_recovery::projection_rebuild::{
    PROJECTION_REBUILD_STATEMENT_CAPACITY, ProjectionRebuildService,
};
use sidekicks_session::directory::projection::SessionDirectoryProjection;
use sidekicks_session::directory::row::{DirectoryEvent, directory_statements_for};
use sidekicks_session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::damage::DatabaseDamageWatch;
use sidekicks_store::database::writer::test_file::test_envelope;
use sidekicks_store::events::log_service::EventLogAppendOptions;

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

// Rebuilds `session_id`'s directory row from its log through the projection rebuild.
async fn rebuild_directory_row(fixture: &PurgeFixture, session_id: SessionId) {
    let reads = Arc::new(DatabaseReadPool::new(
        fixture.database.path(),
        SESSION_SERVICE_STATEMENT_CAPACITY + PROJECTION_REBUILD_STATEMENT_CAPACITY,
    ));
    let session_events = Arc::new(SessionService::new(
        Arc::clone(&reads),
        Arc::new(|_: &SessionId| None),
        Arc::new(|_: &ProviderId| None),
    ));
    ProjectionRebuildService::new(
        reads,
        Arc::clone(&fixture.log.writer),
        session_events,
        Arc::new(DatabaseDamageWatch::new()),
        vec![Box::new(SessionDirectoryProjection)],
    )
    .rebuild_session(session_id)
    .await
    .expect("the row is rebuilt");
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

    let outcome = only_outcome(fixture.purge.purge(&[parent], PurgeCaller::Retention).await);

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed),
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
