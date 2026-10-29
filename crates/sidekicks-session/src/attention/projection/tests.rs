use std::sync::Arc;

use rusqlite::{OptionalExtension as _, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::statement::WriteStatement;
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

use super::{attention_projection_statements, notify_entry_statements};
use crate::attention::schema::schema_parts;
use crate::run::engine::test_fixture::insert_running_run;

const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
const NODE: &str = "tell";

/// A log whose appends carry the attention statements, over a fresh database, and the one session
/// the test appends to.
struct Harness {
    database: TestDatabase,
    appender: SessionEventAppender,
    session_id: SessionId,
}

impl Harness {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::new(writer),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: Some(Box::new(attention_projection_statements)),
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        Self {
            database,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            session_id: test_session_id(),
        }
    }

    /// Appends `event`, a session event's `type` and `payload` as JSON, with `prelude` in its write.
    async fn append_with(&self, event: Value, prelude: Vec<WriteStatement>) {
        let event: SessionEvent = serde_json::from_value(event).expect("the test event reads");
        self.appender
            .append(
                SessionEventDraft::of_session(self.session_id, &event)
                    .expect("the test event passes its checks"),
                SessionEventLinkage {
                    transactional_prelude: prelude,
                    ..SessionEventLinkage::default()
                },
            )
            .await
            .expect("the test event is appended");
    }

    async fn append(&self, event: Value) {
        self.append_with(event, Vec::new()).await;
    }

    /// A running run of the session, under `parent` when it has one.
    fn run(&self, parent: Option<RunId>) -> RunId {
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
    fn run_state(&self, run_id: RunId, state: &str, run_version: u64, extra: Value) -> Value {
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
    fn entries_of(&self, run_id: RunId) -> (Vec<String>, usize) {
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
    fn entry_of(&self, run_id: RunId) -> String {
        let (ids, _) = self.entries_of(run_id);
        assert_eq!(ids.len(), 1, "one entry for the run");
        ids.into_iter().next().expect("one entry for the run")
    }

    /// Stores `entry_id`'s delivery as the gate would have decided it.
    fn decide(&self, entry_id: &str, banner_state: Option<&str>, merged_into: Option<&str>) {
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
    fn delivery(&self, entry_id: &str) -> (Option<String>, Option<String>) {
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

fn posted() -> Option<String> {
    Some("posted".to_owned())
}

/// Mutation: drop the trigger filter from the mute's statements.
#[tokio::test]
async fn muting_withdraws_raised_end_banners_and_keeps_waits_and_notices() {
    let harness = Harness::new().await;
    let finished_run = harness.run(None);
    let waiting_run = harness.run(None);
    harness
        .append(harness.run_state(finished_run, "completed", 2, json!({})))
        .await;
    harness
        .append(harness.run_state(waiting_run, "waitingForApproval", 2, json!({})))
        .await;
    let notify = notify_entry_statements(
        harness.session_id,
        WorkflowRunId::new(WORKFLOW_RUN).expect("a test workflow run id"),
        &WorkflowNodeId::new(NODE.to_owned()).expect("a test node id"),
        SafeInt::ZERO,
        "018f0000-0000-7000-8000-0000000000aa",
        &NonEmptyText::new("Deployed".to_owned()).expect("a test notice"),
        "2026-10-28T09:00:00.000Z",
    );
    harness
        .append_with(
            json!({"type": "workflow.step.completed", "payload": {
                "sessionId": harness.session_id, "workflowRunId": WORKFLOW_RUN, "nodeId": NODE,
                "attempt": 1, "executionIndex": 0,
                "outputRef": {"kind": "inline", "items": []},
                "logRef": {"kind": "inline", "items": []},
            }}),
            notify,
        )
        .await;
    let finished = harness.entry_of(finished_run);
    let waiting = harness.entry_of(waiting_run);
    let notice: String = harness
        .database
        .reader()
        .query_row(
            "SELECT id FROM attention_entries WHERE trigger = 'workflowNotify'",
            [],
            |row| row.get(0),
        )
        .expect("the Notify step raised its entry");
    for entry in [&finished, &waiting, &notice] {
        harness.decide(entry, Some("posted"), None);
    }

    harness
        .append(json!({"type": "session.muted", "payload": {
            "sessionId": harness.session_id, "at": "2026-10-28T09:01:00.000Z",
        }}))
        .await;

    assert_eq!(
        harness.delivery(&finished),
        (Some("withdrawn".to_owned()), None)
    );
    assert_eq!(harness.delivery(&waiting), (posted(), None));
    assert_eq!(harness.delivery(&notice), (posted(), None));
}

/// Mutations: drop the banner-state guard from the withdraw; drop the `merged_into` clause from
/// the hand-back.
#[tokio::test]
async fn a_resolve_withdraws_raised_banners_and_hands_merged_waits_back() {
    let harness = Harness::new().await;
    let [
        posted_run,
        pending_run,
        withheld_run,
        merged_run,
        resolved_merged_run,
    ] = [(); 5].map(|()| harness.run(None));
    for run_id in [
        posted_run,
        pending_run,
        withheld_run,
        merged_run,
        resolved_merged_run,
    ] {
        harness
            .append(harness.run_state(run_id, "waitingForApproval", 2, json!({})))
            .await;
    }
    harness
        .append(harness.run_state(resolved_merged_run, "running", 3, json!({})))
        .await;
    let picked = harness.entry_of(posted_run);
    let pending = harness.entry_of(pending_run);
    let withheld = harness.entry_of(withheld_run);
    let merged = harness.entry_of(merged_run);
    let resolved_merged = harness.entry_of(resolved_merged_run);
    harness.decide(&picked, Some("posted"), None);
    harness.decide(&pending, Some("pending"), None);
    harness.decide(&withheld, Some("withheld"), None);
    harness.decide(&merged, None, Some(&picked));
    harness.decide(&resolved_merged, None, Some(&picked));

    for run_id in [posted_run, pending_run, withheld_run] {
        harness
            .append(harness.run_state(run_id, "running", 3, json!({})))
            .await;
    }

    let withdrawn = (Some("withdrawn".to_owned()), None);
    assert_eq!(harness.delivery(&picked), withdrawn);
    assert_eq!(harness.delivery(&pending), withdrawn);
    assert_eq!(
        harness.delivery(&withheld),
        (Some("withheld".to_owned()), None)
    );
    assert_eq!(harness.delivery(&merged), (None, None));
    assert_eq!(harness.delivery(&resolved_merged), (None, Some(picked)));
    assert_eq!(harness.entries_of(posted_run).1, 0);
}

/// Mutation: drop `parent_run_id IS NULL` from the run end's insert.
#[tokio::test]
async fn a_child_runs_end_raises_nothing_and_its_wait_raises_one_entry() {
    let harness = Harness::new().await;
    let lead_run = harness.run(None);
    let child_run = harness.run(Some(lead_run));

    harness
        .append(harness.run_state(child_run, "waitingForInput", 2, json!({})))
        .await;
    harness
        .append(harness.run_state(child_run, "completed", 3, json!({})))
        .await;
    harness
        .append(harness.run_state(lead_run, "completed", 2, json!({})))
        .await;

    let (child_entries, child_open) = harness.entries_of(child_run);
    assert_eq!((child_entries.len(), child_open), (1, 0));
    assert_eq!(harness.entries_of(lead_run).0.len(), 1);
}

/// Mutation: resolve only a run's waits, so a limit's failed end stays open.
#[tokio::test]
async fn running_after_a_step_limit_interrupt_resolves_its_failed_end() {
    let harness = Harness::new().await;
    let run_id = harness.run(None);
    harness
        .append(harness.run_state(run_id, "interrupted", 2, json!({"trigger": "stepLimit"})))
        .await;
    let failed = harness.entry_of(run_id);
    let trigger: String = harness
        .database
        .reader()
        .query_row(
            "SELECT trigger FROM attention_entries WHERE id = ?1",
            [&failed],
            |row| row.get(0),
        )
        .expect("the failed end reads");
    assert_eq!(
        (trigger.as_str(), harness.entries_of(run_id).1),
        ("runFailed", 1)
    );

    harness
        .append(harness.run_state(run_id, "running", 3, json!({})))
        .await;

    assert_eq!(harness.entries_of(run_id), (vec![failed], 0));
}
