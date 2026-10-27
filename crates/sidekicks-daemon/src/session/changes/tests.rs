use std::sync::{Arc, Mutex};
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionRenameRequest;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::schema::session_directory::insert_session_row;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
    SessionAppendRefusal,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::test_registry::test_driver_services;

/// Bounds a change the test expects to answer, so one that waits forever fails the test.
const CHANGE_WAIT: Duration = Duration::from_secs(10);

/// A person's rename landing between the change's read and its append.
const RACED_RENAME_SQL: &str = "UPDATE sessions SET name = 'Theirs' WHERE id = ?1";

/// The session's stored events, oldest first.
const STORED_EVENTS_SQL: &str =
    "SELECT type, payload FROM session_events WHERE session_id = ?1 ORDER BY sequence";

/// A pin landing between the change's read and its append.
const RACED_PIN_SQL: &str =
    "UPDATE sessions SET pinned_at = '2026-10-19T09:00:00.000Z' WHERE id = ?1";

/// The change a case makes.
#[derive(Clone, Copy, Debug)]
enum Change {
    Rename(&'static str),
    NameUnnamed(&'static str),
    Pin,
}

// Killed by a change appending with no guard on the facts it read (a raced case stores an
// event decided on stale facts), by one failing instead of deciding again when its guard is
// refused, by the naming pass writing over a name, and by it never writing one.
#[rstest]
#[case::the_naming_pass_names_an_unnamed_session(
    None,
    None,
    Change::NameUnnamed("  Fix the login bug\n"),
    Some(true),
    &[(Some("Fix the login bug"), None, "auto")],
)]
#[case::the_naming_pass_keeps_a_persons_name(
    Some("Mine"),
    None,
    Change::NameUnnamed("Auto"),
    Some(false),
    &[],
)]
#[case::the_naming_pass_yields_to_a_rename_that_landed_first(
    None,
    Some(RACED_RENAME_SQL),
    Change::NameUnnamed("Auto"),
    Some(false),
    &[],
)]
#[case::a_rename_is_decided_again_on_a_rename_that_landed_first(
    None,
    Some(RACED_RENAME_SQL),
    Change::Rename("Mine"),
    None,
    &[(Some("Mine"), Some("Theirs"), "user")],
)]
#[case::a_pin_is_decided_again_on_a_pin_that_landed_first(
    None,
    Some(RACED_PIN_SQL),
    Change::Pin,
    None,
    &[],
)]
#[tokio::test]
async fn a_change_is_decided_on_the_facts_that_landed(
    #[case] stored_name: Option<&str>,
    #[case] raced_write: Option<&'static str>,
    #[case] change: Change,
    #[case] expected_named: Option<bool>,
    #[case] expected_renames: &[(Option<&str>, Option<&str>, &str)],
) {
    let database = TestDatabase::new(crate::questions::schema::schema_parts());
    // Opening the writer creates the file with the daemon's schema.
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database"),
    );
    let session_id = test_session_id();
    insert_session_row(
        &database.reader(),
        session_id.text().as_str(),
        stored_name,
        None,
    );
    // The log's check runs after the change read its facts and before its write is queued,
    // so the raced write lands between the two.
    let raced = Mutex::new(raced_write.map(|sql| (database.reader(), sql)));
    let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer,
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY,
        )),
        followers: Arc::new(SessionEventFollowers::default()),
        projection_statements: None,
        refuse_session_write: Some(Box::new(
            move |session_id: &SessionId, _event_type: &str| {
                let raced = raced.lock().expect("no raced write panicked").take();
                if let Some((connection, sql)) = raced {
                    connection
                        .execute(sql, [session_id.text().as_str()])
                        .expect("the raced write lands");
                }
                Ok::<(), SessionAppendRefusal>(())
            },
        )),
        read_damaged_from_sequence: None,
    }));
    // The session ran nothing, so no driver is told its name.
    let services = test_driver_services();
    let changes = SessionChanges::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_CHANGES_STATEMENT_CAPACITY,
        )),
        event_log,
        Arc::new(ProviderRegistry::register_from(&[], &services)),
    );

    let named = tokio::time::timeout(CHANGE_WAIT, async {
        match change {
            Change::Rename(name) => changes
                .rename(SessionRenameRequest {
                    session_id,
                    name: Some(FreeFormText::new(name.to_owned()).expect("a name")),
                })
                .await
                .map(|_response| None),
            Change::NameUnnamed(name) => changes.name_unnamed(session_id, name).await.map(Some),
            Change::Pin => changes.pin(session_id).await.map(|()| None),
        }
    })
    .await
    .expect("the change answers in time")
    .expect("the change is kept");

    assert_eq!(named, expected_named);
    let stored: Vec<(String, Value)> = database
        .reader()
        .prepare(STORED_EVENTS_SQL)
        .expect("the test reads the log")
        .query_map([session_id.text().as_str()], |row| {
            let payload: String = row.get(1)?;
            Ok((
                row.get(0)?,
                serde_json::from_str(&payload).expect("a stored payload is JSON"),
            ))
        })
        .expect("the test reads the log")
        .collect::<rusqlite::Result<_>>()
        .expect("the test reads the log");
    let expected: Vec<(String, Value)> = expected_renames
        .iter()
        .map(|(name, previous_name, origin)| {
            let mut payload = json!({ "sessionId": session_id, "name": name, "origin": origin });
            if let Some(previous_name) = previous_name {
                payload["previousName"] = json!(previous_name);
            }
            (
                SessionEventType::SessionRenamed.as_str().to_owned(),
                payload,
            )
        })
        .collect();
    assert_eq!(stored, expected);
}
