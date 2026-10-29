//! The event log a test of the attention entries appends to: every append carries the attention
//! statements in its write, and every commit raises the attention change counts, as the daemon's
//! do, over a fresh database holding the runs', the provider drivers' and the attention tables.

use std::sync::Arc;

use rusqlite::{OptionalExtension as _, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::attention::changes::{AttentionChanges, attention_changes_after_commits};
use crate::attention::projection::attention_projection_statements;
use crate::attention::read::ATTENTION_STATEMENT_CAPACITY;
use crate::attention::schema::schema_parts;
use crate::attention::service::ATTENTION_SERVICE_STATEMENT_CAPACITY;
use crate::run::engine::test_fixture::insert_running_run;

/// A log whose appends carry the attention statements, over a fresh database, and the one session
/// the test appends to.
pub struct AttentionTestLog {
    /// The test's database.
    pub database: TestDatabase,
    /// The writer every append goes through, which a test's own writes share.
    pub writer: Arc<DatabaseWriter>,
    /// The read pool over the test's database.
    pub pool: Arc<DatabaseReadPool>,
    /// The change counts the writer raises after each commit.
    pub changes: AttentionChanges,
    /// The session every append is of unless the test names another.
    pub session_id: SessionId,
    appender: SessionEventAppender,
}

impl AttentionTestLog {
    /// The log over a fresh database.
    pub async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let (after_commit, changes) = attention_changes_after_commits();
        let writer = Arc::new(
            DatabaseWriter::open(
                database.opener(),
                DatabaseWriterOptions {
                    after_commits: vec![after_commit],
                    ..DatabaseWriterOptions::default()
                },
            )
            .await
            .expect("the writer opens its database"),
        );
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY
                + ATTENTION_STATEMENT_CAPACITY
                + ATTENTION_SERVICE_STATEMENT_CAPACITY,
        ));
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::clone(&pool),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: Some(Box::new(attention_projection_statements)),
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        Self {
            database,
            writer,
            pool,
            changes,
            session_id: test_session_id(),
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        }
    }

    /// Appends `event`, a session event's `type` and `payload` as JSON, with `linkage`.
    pub async fn append_with(&self, event: Value, linkage: SessionEventLinkage) {
        self.append_to(self.session_id, event, linkage).await;
    }

    /// Appends `event` to the log of `session_id`, with `linkage`.
    pub async fn append_to(
        &self,
        session_id: SessionId,
        event: Value,
        linkage: SessionEventLinkage,
    ) {
        let event: SessionEvent = serde_json::from_value(event).expect("the test event reads");
        self.appender
            .append(
                SessionEventDraft::of_session(session_id, &event)
                    .expect("the test event passes its checks"),
                linkage,
            )
            .await
            .expect("the test event is appended");
    }

    /// Appends `event` with no linkage.
    pub async fn append(&self, event: Value) {
        self.append_with(event, SessionEventLinkage::default())
            .await;
    }

    /// A running run of the session, under `parent` when it has one.
    pub fn run(&self, parent: Option<RunId>) -> RunId {
        let run_id = test_run_id();
        insert_running_run(&self.database, self.session_id, run_id);
        if let Some(parent) = parent {
            self.database
                .reader()
                .execute(
                    "UPDATE runs SET parent_run_id = ?1 WHERE run_id = ?2",
                    params![parent.to_string(), run_id.to_string()],
                )
                .expect("the test makes the run a child");
        }
        run_id
    }

    /// An `agent.run.<state>` event of `run_id` at `run_version`, with `extra` payload members.
    pub fn run_state(&self, run_id: RunId, state: &str, run_version: u64, extra: Value) -> Value {
        let mut payload = json!({
            "sessionId": self.session_id, "runId": run_id, "runVersion": run_version,
            "previousState": "running", "newState": state,
        });
        if let (Some(payload), Value::Object(extra)) = (payload.as_object_mut(), extra) {
            payload.extend(extra);
        }
        json!({"type": format!("agent.run.{state}"), "payload": payload})
    }

    /// The ids of `run_id`'s entries, and how many of them are open.
    pub fn entries_of(&self, run_id: RunId) -> (Vec<String>, usize) {
        let connection = self.database.reader();
        let mut statement = connection
            .prepare("SELECT id, resolved_at IS NULL FROM attention_entries WHERE run_id = ?1")
            .expect("the entry read prepares");
        let rows: Vec<(String, bool)> = statement
            .query_map([run_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("the entry read runs")
            .collect::<rusqlite::Result<_>>()
            .expect("each entry reads");
        let open = rows.iter().filter(|(_, is_open)| *is_open).count();
        (rows.into_iter().map(|(id, _)| id).collect(), open)
    }

    /// The one entry `run_id` raised.
    pub fn entry_of(&self, run_id: RunId) -> String {
        let (ids, _) = self.entries_of(run_id);
        assert_eq!(ids.len(), 1, "one entry for the run");
        ids.into_iter().next().expect("one entry for the run")
    }

    /// Stores `entry_id`'s delivery as the gate would have decided it.
    pub fn decide(&self, entry_id: &str, banner_state: Option<&str>, merged_into: Option<&str>) {
        self.database
            .reader()
            .execute(
                "INSERT INTO attention_deliveries (entry_id, banner_state, merged_into)
                 VALUES (?1, ?2, ?3)",
                params![entry_id, banner_state, merged_into],
            )
            .expect("the test decides the entry");
    }

    /// `entry_id`'s banner state and the entry it merged into.
    pub fn delivery(&self, entry_id: &str) -> (Option<String>, Option<String>) {
        self.database
            .reader()
            .query_row(
                "SELECT banner_state, merged_into FROM attention_deliveries WHERE entry_id = ?1",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("the delivery read runs")
            .expect("the entry has a delivery")
    }
}
