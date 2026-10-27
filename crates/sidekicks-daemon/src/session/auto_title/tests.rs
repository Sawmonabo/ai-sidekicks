use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use mockall::Sequence;
use rstest::rstest;
use rusqlite::params;
use serde_json::Value;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionRenameRequest;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::runtime::Handle;
use tokio::sync::Notify;

use super::{SESSION_AUTO_TITLE_STATEMENT_CAPACITY, SessionAutoTitle, first_words_of};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::schema::session_directory::insert_session_row;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::appender::UnsequencedEventEnvelope;
use crate::events::session::followers::SessionEventFollowers;
use crate::provider::driver::contract::{MockProviderDriver, ProviderDriver};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::test_registry::bind_run_to_first_provider;
use crate::provider::driver::test_registry::test_driver_services;
use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};
use crate::questions::schema::schema_parts;
use crate::session::changes::{SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges};
use crate::session::directory::row::{DirectoryEvent, directory_statements_for};
use crate::session::run::engine::tests::insert_running_run;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// Bounds every wait a test expects to end, so one that never does fails the test.
const WAIT: Duration = Duration::from_secs(10);

/// The session's stored renames, oldest first: each name and who gave it.
const STORED_RENAMES_SQL: &str = "SELECT payload FROM session_events
  WHERE session_id = ?1 AND type = ?2 ORDER BY sequence";

/// The self-naming, the changes a test renames through, and the followers of the log they share.
struct Harness {
    database: TestDatabase,
    followers: Arc<SessionEventFollowers>,
    changes: Arc<SessionChanges>,
    auto_title: Arc<SessionAutoTitle>,
}

/// The self-naming on a fresh database whose one provider's driver `build` makes.
async fn harness(build: fn(&DriverServices) -> Arc<dyn ProviderDriver>) -> Harness {
    let database = TestDatabase::new(schema_parts());
    // Opening the writer creates the file with the daemon's schema.
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let followers = Arc::new(SessionEventFollowers::default());
    // Each event changes the session's directory row, so a rename or a clear lands on its name.
    let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer: Arc::new(writer),
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY,
        )),
        followers: Arc::clone(&followers),
        projection_statements: Some(Box::new(|envelope: &UnsequencedEventEnvelope| {
            Ok(directory_statements_for(&DirectoryEvent::from(envelope))?)
        })),
        refuse_session_write: None,
        read_damaged_from_sequence: None,
    }));
    let services = test_driver_services();
    let providers = Arc::new(ProviderRegistry::register_from(
        &[ProviderRegistration {
            descriptor: PROVIDERS[0],
            build,
        }],
        &services,
    ));
    let changes = Arc::new(SessionChanges::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_CHANGES_STATEMENT_CAPACITY,
        )),
        event_log,
        Arc::clone(&providers),
    ));
    let auto_title = Arc::new(SessionAutoTitle::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_AUTO_TITLE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&changes),
        providers,
    ));
    Harness {
        database,
        followers,
        changes,
        auto_title,
    }
}

/// Stores an unnamed session whose first message was `first_message` and whose lead run,
/// bound to the table's first provider, completed while nothing followed the log, after a
/// subagent run beneath it, bound to no provider, completed first.
fn insert_completed_session(database: &TestDatabase, session_id: SessionId, first_message: &str) {
    let connection = database.reader();
    let session = session_id.text();
    insert_session_row(&connection, session.as_str(), None, None);
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let run = run_id.text();
    let subagent_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let subagent_run = subagent_run_id.text();
    insert_running_run(database, session_id, run_id);
    insert_running_run(database, session_id, subagent_run_id);
    connection
        .execute(
            "UPDATE runs SET parent_run_id = ?1 WHERE run_id = ?2",
            params![run.as_str(), subagent_run.as_str()],
        )
        .expect("the test makes the subagent's run a child of the lead's");
    let completed = SessionEventType::AgentRunCompleted;
    connection
        .execute(
            "UPDATE sessions SET first_message_preview = ?2 WHERE id = ?1",
            params![session.as_str(), first_message],
        )
        .expect("the test stores the first message");
    for (sequence, completed_run) in [(1, subagent_run.as_str()), (2, run.as_str())] {
        connection
            .execute(
                "INSERT INTO session_events (id, session_id, sequence, occurred_at,
                   monotonic_ns, category, type, payload, run_id, run_version)
                 VALUES (?1, ?2, ?3, '2026-10-19T09:00:00.000Z', 0, ?4, ?5, '{}', ?1, 1)",
                params![
                    completed_run,
                    session.as_str(),
                    sequence,
                    completed.category().as_str(),
                    completed.as_str(),
                ],
            )
            .expect("the test stores the completion");
    }
    bind_run_to_first_provider(database, run_id);
}

/// The session's stored renames, oldest first: each name and its origin.
fn stored_renames(database: &TestDatabase, session_id: SessionId) -> Vec<(Value, Value)> {
    database
        .reader()
        .prepare(STORED_RENAMES_SQL)
        .expect("the test reads the log")
        .query_map(
            params![
                session_id.text().as_str(),
                SessionEventType::SessionRenamed.as_str()
            ],
            |row| row.get::<_, String>(0),
        )
        .expect("the test reads the log")
        .map(|payload| {
            let payload: Value = serde_json::from_str(&payload.expect("a payload reads"))
                .expect("a stored payload is JSON");
            (payload["name"].clone(), payload["origin"].clone())
        })
        .collect()
}

// Killed by the fallback not being written after a pass that returned nothing, by the naming
// writing over a name the person gave while the pass ran, and by a subagent's completion
// naming the session, which runs no pass on the lead run's driver.
#[tokio::test]
async fn auto_title_writes_the_first_words_after_an_empty_pass_and_never_over_a_rename() {
    static PASS_STARTED: Notify = Notify::const_new();
    static PASS_RELEASED: Notify = Notify::const_new();
    fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        let mut sequence = Sequence::new();
        driver
            .expect_name_session()
            .times(1)
            .in_sequence(&mut sequence)
            .returning(|_| {
                async {
                    PASS_STARTED.notify_one();
                    PASS_RELEASED.notified().await;
                    Ok(None)
                }
                .boxed()
            });
        driver
            .expect_name_session()
            .times(1)
            .in_sequence(&mut sequence)
            .returning(|_| async { Ok(None) }.boxed());
        driver
            .expect_tell_session_name()
            .returning(|_, _| async { Ok(()) }.boxed());
        Arc::new(driver)
    }
    let harness = harness(build).await;
    // The start names the sessions in id order, so the first is renamed during its pass.
    let mut session_ids = [test_session_id(), test_session_id()];
    session_ids.sort_by_key(|session_id| session_id.text().as_str().to_owned());
    let [renamed_first, unnamed] = session_ids;
    insert_completed_session(&harness.database, renamed_first, "rename this one please");
    insert_completed_session(
        &harness.database,
        unnamed,
        "  tidy up\u{FEFF}the settings page spacing before lunch",
    );
    let mut unnamed_changes = harness.followers.change_count(&unnamed);

    let titling = harness.auto_title.start(&harness.followers);
    tokio::time::timeout(WAIT, PASS_STARTED.notified())
        .await
        .expect("the first session's pass starts");
    harness
        .database
        .reader()
        .execute(
            "UPDATE sessions SET name = 'Mine' WHERE id = ?1",
            [renamed_first.text().as_str()],
        )
        .expect("the person's name lands");
    PASS_RELEASED.notify_one();
    tokio::time::timeout(WAIT, unnamed_changes.changed())
        .await
        .expect("the second session is named in time")
        .expect("the log is still followed");
    titling.stop().await;

    assert_eq!(stored_renames(&harness.database, renamed_first), []);
    assert_eq!(
        stored_renames(&harness.database, unnamed),
        [(
            Value::from("tidy up the settings page spacing before"),
            Value::from("auto")
        )]
    );
}

// Killed by a rename that leaves the pass under way, by a cancelled pass still writing, and by
// the rename's answer waiting on the push of the name to the provider.
#[tokio::test]
async fn auto_title_cancels_a_pending_pass_when_the_session_is_renamed() {
    static PASS_STARTED: Notify = Notify::const_new();
    static PASS_ENDED: Notify = Notify::const_new();
    static PUSH_RELEASED: Notify = Notify::const_new();
    /// Raises `PASS_ENDED` when the pass's future ends or is dropped.
    struct EndsPass;
    impl Drop for EndsPass {
        fn drop(&mut self) {
            PASS_ENDED.notify_one();
        }
    }
    fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        driver.expect_name_session().times(1).returning(|params| {
            async move {
                let _ends_pass = EndsPass;
                PASS_STARTED.notify_one();
                params.cancel.cancelled().await;
                Ok(Some("Late name".to_owned()))
            }
            .boxed()
        });
        driver
            .expect_tell_session_name()
            .times(1)
            .returning(|_, _| {
                async {
                    PUSH_RELEASED.notified().await;
                    Ok(())
                }
                .boxed()
            });
        Arc::new(driver)
    }
    let harness = harness(build).await;
    let session_id = test_session_id();
    insert_completed_session(&harness.database, session_id, "fix the login bug");

    let titling = harness.auto_title.start(&harness.followers);
    tokio::time::timeout(WAIT, PASS_STARTED.notified())
        .await
        .expect("the pass starts");
    tokio::time::timeout(
        WAIT,
        harness.changes.rename(SessionRenameRequest {
            session_id,
            name: Some(FreeFormText::new("Mine".to_owned()).expect("a name")),
        }),
    )
    .await
    .expect("the rename answers while the provider still holds the push")
    .expect("the person's rename is kept");
    tokio::time::timeout(WAIT, PASS_ENDED.notified())
        .await
        .expect("the rename ends the pass before the stop");
    titling.stop().await;
    PUSH_RELEASED.notify_one();
    tokio::time::timeout(WAIT, harness.changes.stop())
        .await
        .expect("the push of the name ends once the provider takes it");

    assert_eq!(
        stored_renames(&harness.database, session_id),
        [(Value::from("Mine"), Value::from("user"))]
    );
}

// Killed by a clear leaving the session unnamed, by the clear's pass skipped for a session that
// was named before, and by the fresh name not told to the provider.
#[tokio::test]
async fn auto_title_names_a_cleared_session_again_and_tells_the_provider() {
    static PUSHED: Notify = Notify::const_new();
    fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        driver
            .expect_name_session()
            .times(1)
            .returning(|_| async { Ok(Some("Fix the login bug".to_owned())) }.boxed());
        driver
            .expect_tell_session_name()
            .times(1)
            .withf(|_, name| name == "Fix the login bug")
            .returning(|_, _| {
                PUSHED.notify_one();
                async { Ok(()) }.boxed()
            });
        Arc::new(driver)
    }
    let harness = harness(build).await;
    let session_id = test_session_id();
    insert_completed_session(&harness.database, session_id, "the login page throws");
    harness
        .database
        .reader()
        .execute(
            "UPDATE sessions SET name = 'Mine' WHERE id = ?1",
            [session_id.text().as_str()],
        )
        .expect("the person's name is stored");

    let titling = harness.auto_title.start(&harness.followers);
    harness
        .changes
        .rename(SessionRenameRequest {
            session_id,
            name: None,
        })
        .await
        .expect("the person's clear is kept");
    tokio::time::timeout(WAIT, PUSHED.notified())
        .await
        .expect("the fresh name is told to the provider");
    titling.stop().await;

    assert_eq!(
        stored_renames(&harness.database, session_id),
        [
            (Value::Null, Value::from("user")),
            (Value::from("Fix the login bug"), Value::from("auto")),
        ]
    );
}

// Killed by a push carrying the name its rename captured, and by pushes that take no lock: either
// way the first rename's push tells the provider the older name.
#[tokio::test]
async fn auto_title_leaves_the_provider_on_the_later_of_two_close_renames() {
    static TOLD_NAMES: Mutex<Vec<String>> = Mutex::new(Vec::new());
    fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        driver.expect_tell_session_name().returning(|_, name| {
            TOLD_NAMES.lock().expect("the names lock").push(name);
            async { Ok(()) }.boxed()
        });
        Arc::new(driver)
    }
    let harness = harness(build).await;
    let session_id = test_session_id();
    insert_completed_session(&harness.database, session_id, "fix the login bug");
    let rename_to = |name: &str| SessionRenameRequest {
        session_id,
        name: Some(FreeFormText::new(name.to_owned()).expect("a name")),
    };

    // Both renames land while their pushes wait for the lock.
    let held_pushes = harness.changes.name_push_lock().acquire(session_id).await;
    for name in ["First", "Second"] {
        harness
            .changes
            .rename(rename_to(name))
            .await
            .expect("the rename is kept");
    }
    drop(held_pushes);
    tokio::time::timeout(WAIT, harness.changes.stop())
        .await
        .expect("both pushes end");

    assert_eq!(
        *TOLD_NAMES.lock().expect("the names lock"),
        ["Second", "Second"]
    );
}

// Killed by a completion refused while another pass of its session ran being dropped: the
// session's lead completion lands during a subagent completion's pass, which names nothing.
#[tokio::test]
async fn auto_title_names_a_session_whose_lead_completion_landed_during_another_pass() {
    fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        driver
            .expect_name_session()
            .times(1)
            .returning(|_| async { Ok(Some("Fix the login bug".to_owned())) }.boxed());
        driver
            .expect_tell_session_name()
            .returning(|_, _| async { Ok(()) }.boxed());
        Arc::new(driver)
    }
    let harness = harness(build).await;
    let session_id = test_session_id();
    // The subagent's completion is the first event, the lead's the second.
    insert_completed_session(&harness.database, session_id, "the login page throws");
    let subagent_completion = SafeInt::new(1).expect("a sequence");
    let lead_completion = SafeInt::new(2).expect("a sequence");

    let (generation, cancel) = harness
        .auto_title
        .register_pass(session_id)
        .expect("the subagent completion's pass is the first");
    harness
        .auto_title
        .spawn_pass(session_id, Some(lead_completion), &Handle::current());
    tokio::time::timeout(
        WAIT,
        harness.auto_title.name_and_release(
            session_id,
            Some(subagent_completion),
            generation,
            &cancel,
        ),
    )
    .await
    .expect("the pass and its rerun end");

    assert_eq!(
        stored_renames(&harness.database, session_id),
        [(Value::from("Fix the login bug"), Value::from("auto"))]
    );
    assert!(
        harness.auto_title.register_pass(session_id).is_some(),
        "the pass is forgotten once it ran again"
    );
}

// Killed by a clear that lands during a pass under way marking nothing: the pass, a subagent
// completion's, names nothing by itself, and only the rerun the clear marked names the session.
// The writer runs its followers before a write answers, so the mark lands before the pass runs.
#[tokio::test]
async fn auto_title_names_a_cleared_session_through_the_pass_under_way() {
    static PUSHED: Notify = Notify::const_new();
    fn build(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        driver
            .expect_name_session()
            .times(1)
            .returning(|_| async { Ok(Some("Fix the login bug".to_owned())) }.boxed());
        driver
            .expect_tell_session_name()
            .times(1)
            .withf(|_, name| name == "Fix the login bug")
            .returning(|_, _| {
                PUSHED.notify_one();
                async { Ok(()) }.boxed()
            });
        Arc::new(driver)
    }
    let harness = harness(build).await;
    let session_id = test_session_id();
    insert_completed_session(&harness.database, session_id, "the login page throws");
    harness
        .database
        .reader()
        .execute(
            "UPDATE sessions SET name = 'Mine' WHERE id = ?1",
            [session_id.text().as_str()],
        )
        .expect("the person's name is stored");
    let subagent_completion = SafeInt::new(1).expect("a sequence");
    let (generation, cancel) = harness
        .auto_title
        .register_pass(session_id)
        .expect("the subagent completion's pass is the first");

    let titling = harness.auto_title.start(&harness.followers);
    harness
        .changes
        .rename(SessionRenameRequest {
            session_id,
            name: None,
        })
        .await
        .expect("the person's clear is kept");
    tokio::time::timeout(
        WAIT,
        harness.auto_title.name_and_release(
            session_id,
            Some(subagent_completion),
            generation,
            &cancel,
        ),
    )
    .await
    .expect("the pass and the clear's rerun end");
    tokio::time::timeout(WAIT, PUSHED.notified())
        .await
        .expect("the fresh name is told to the provider");
    titling.stop().await;

    assert_eq!(
        stored_renames(&harness.database, session_id),
        [
            (Value::Null, Value::from("user")),
            (Value::from("Fix the login bug"), Value::from("auto")),
        ]
    );
}

// Killed by splitting at Unicode whitespace instead of ECMAScript's, by counting bytes instead
// of code points, by passing the bound, and by dropping a first word longer than it.
#[rstest]
#[case::no_words(" \t\n", "")]
#[case::words_joined_by_one_space("  fix   the\tlogin\nbug  ", "fix the login bug")]
#[case::ecmascript_whitespace_splits("fix\u{FEFF}bug", "fix bug")]
#[case::whole_words_up_to_the_bound(
    "tidy up the settings page spacing before lunch",
    "tidy up the settings page spacing before"
)]
#[case::code_points_not_bytes(
    "é é é é é é é é é é é é é é é é é é é é é",
    "é é é é é é é é é é é é é é é é é é é é"
)]
#[case::a_long_first_word_is_cut(
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz rest",
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmn"
)]
fn first_words_of_takes_whole_words_up_to_forty_code_points(
    #[case] message: &str,
    #[case] expected: &str,
) {
    assert_eq!(first_words_of(message), expected);
}
