//! The attention entries a rebuild writes from the log against the entries the live writes kept,
//! and what a rebuild leaves of each entry's delivery.

use std::sync::Arc;

use jiff::Timestamp;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_session::attention::projection::notify_entry_statements;
use sidekicks_session::attention::rebuild::AttentionEntriesProjection;
use sidekicks_session::attention::retention::advance_retention_statements;
use sidekicks_session::attention::test_log::AttentionTestLog;
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::{rebuild_whole, table_rows};

const ENTRY_ROWS_SQL: &str = "SELECT * FROM attention_entries ORDER BY id";
const DELIVERY_ROWS_SQL: &str = "SELECT * FROM attention_deliveries ORDER BY entry_id";

const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
const NODE: &str = "tell";

/// Appends `event` at `occurred_at`, years before any clock a test runs under.
async fn append_at(log: &AttentionTestLog, event: Value, occurred_at: &str) {
    log.append_with(
        event,
        SessionEventLinkage {
            occurred_at: Some(
                WireInstant::try_from(occurred_at.to_owned()).expect("the test's instant reads"),
            ),
            ..SessionEventLinkage::default()
        },
    )
    .await;
}

async fn rebuild(log: &AttentionTestLog) {
    rebuild_whole(
        &log.database,
        Arc::clone(&log.writer),
        Box::new(AttentionEntriesProjection),
        log.session_id,
    )
    .await;
}

// The entries a rebuild writes are the entries the live writes kept: a resolved wait and a lead
// run's end, both years old, the end seen, under no cut, and a Notify step's entry, which no event
// raises. Each delivery stands as it was. Killed by a clear that takes deliveries or Notify entries,
// and by a fold that reads the clock, which would date the rows or cut the old seen end.
#[tokio::test]
async fn a_rebuild_writes_the_entries_the_live_writes_kept_and_keeps_their_deliveries() {
    let log = AttentionTestLog::new().await;
    let run_id = log.run(None);
    append_at(
        &log,
        log.run_state(run_id, "waitingForApproval", 2, json!({})),
        "2020-01-01T09:00:00.000Z",
    )
    .await;
    let wait = log.entry_of(run_id);
    append_at(
        &log,
        log.run_state(run_id, "running", 3, json!({})),
        "2020-01-01T09:01:00.000Z",
    )
    .await;
    append_at(
        &log,
        log.run_state(run_id, "completed", 4, json!({})),
        "2020-01-01T09:02:00.000Z",
    )
    .await;
    let (entries, _) = log.entries_of(run_id);
    let end = entries
        .into_iter()
        .find(|entry| *entry != wait)
        .expect("the lead run's end raised its entry");
    let notify = notify_entry_statements(
        log.session_id,
        WorkflowRunId::new(WORKFLOW_RUN).expect("a test workflow run id"),
        &WorkflowNodeId::new(NODE.to_owned()).expect("a test node id"),
        SafeInt::ZERO,
        "018f0000-0000-7000-8000-0000000000aa",
        &NonEmptyText::new("Deployed".to_owned()).expect("a test notice"),
        "2020-01-01T09:03:00.000Z",
    );
    log.append_with(
        json!({"type": "workflow.step.completed", "payload": {
            "sessionId": log.session_id, "workflowRunId": WORKFLOW_RUN, "nodeId": NODE,
            "attempt": 1, "executionIndex": 0,
            "outputRef": {"kind": "inline", "items": []},
            "logRef": {"kind": "inline", "items": []},
        }}),
        SessionEventLinkage {
            transactional_prelude: notify,
            ..SessionEventLinkage::default()
        },
    )
    .await;
    log.decide(&wait, Some("withdrawn"), None);
    log.decide(&end, Some("posted"), None);
    let reader = log.database.reader();
    reader
        .execute(
            "INSERT INTO attention_seen (session_id, seen_through_sequence) VALUES (?1, ?2)",
            params![log.session_id.to_string(), i64::MAX],
        )
        .expect("the test marks the session seen");
    let live_entries = table_rows(&reader, ENTRY_ROWS_SQL);
    let live_deliveries = table_rows(&reader, DELIVERY_ROWS_SQL);
    assert_eq!(
        (live_entries.len(), live_deliveries.len()),
        (3, 2),
        "the wait, the end and the notice, two of them decided"
    );

    rebuild(&log).await;

    assert_eq!(table_rows(&reader, ENTRY_ROWS_SQL), live_entries);
    assert_eq!(table_rows(&reader, DELIVERY_ROWS_SQL), live_deliveries);
}

// A resolved wait past the cut goes, with its delivery, in the write that moves the cut, and a
// rebuild under that cut writes it no more; an open wait past the cut stays through both, and so
// does a resolved wait whose web-address message is still to send, below the one that goes. The cut
// stands at the aged event and never moves down, a send decided after it moved included. Killed by
// a rule that drops a resolved entry, keeps an open one or retires one with a send pending, by a
// cut held below the first pending send, and by a rebuild that writes back what the cut retired.
#[tokio::test]
async fn an_entry_past_the_cut_goes_live_and_stays_gone_after_a_rebuild() {
    let log = AttentionTestLog::new().await;
    let pending_run = log.run(None);
    let resolved_run = log.run(None);
    let open_run = log.run(None);
    append_at(
        &log,
        log.run_state(pending_run, "waitingForApproval", 2, json!({})),
        "2020-01-01T09:00:00.000Z",
    )
    .await;
    let pending = log.entry_of(pending_run);
    append_at(
        &log,
        log.run_state(resolved_run, "waitingForApproval", 2, json!({})),
        "2020-01-01T09:01:00.000Z",
    )
    .await;
    let resolved = log.entry_of(resolved_run);
    append_at(
        &log,
        log.run_state(open_run, "waitingForInput", 2, json!({})),
        "2020-01-01T09:02:00.000Z",
    )
    .await;
    let open = log.entry_of(open_run);
    for (run_id, occurred_at) in [
        (pending_run, "2020-01-01T09:03:00.000Z"),
        (resolved_run, "2020-01-01T09:04:00.000Z"),
    ] {
        append_at(
            &log,
            log.run_state(run_id, "running", 3, json!({})),
            occurred_at,
        )
        .await;
    }
    log.decide(&resolved, Some("withdrawn"), None);
    let reader = log.database.reader();
    let send_pending = |entry_id: &str| {
        reader
            .execute(
                "INSERT INTO attention_deliveries
                   (entry_id, banner_state, web_address_state, web_address_attempt_count)
                 VALUES (?1, 'withdrawn', 'pending', 0)
                 ON CONFLICT (entry_id) DO UPDATE SET
                   web_address_state = 'pending', web_address_attempt_count = 0",
                [entry_id],
            )
            .expect("the test leaves the entry's send pending");
    };
    send_pending(&pending);
    assert_eq!(log.entries_of(pending_run), (vec![pending.clone()], 0));
    assert_eq!(log.entries_of(resolved_run), (vec![resolved.clone()], 0));
    let newest_sequence: i64 = reader
        .query_row(
            "SELECT MAX(sequence) FROM session_events WHERE session_id = ?1",
            [log.session_id.to_string()],
            |row| row.get(0),
        )
        .expect("the newest sequence reads");
    let advance = || async {
        log.writer
            .write(advance_retention_statements(
                log.session_id,
                Timestamp::now(),
            ))
            .await
            .expect("the cut moves");
    };
    let cut = || -> Option<i64> {
        reader
            .query_row(
                "SELECT retained_through_sequence FROM attention_versions WHERE scope_key = ?1",
                [log.session_id.to_string()],
                |row| row.get(0),
            )
            .expect("the cut reads")
    };
    let delivery_count = |entry_id: &str| -> i64 {
        reader
            .query_row(
                "SELECT COUNT(*) FROM attention_deliveries WHERE entry_id = ?1",
                [entry_id],
                |row| row.get(0),
            )
            .expect("the delivery count reads")
    };
    let assert_kept = || {
        assert_eq!(log.entries_of(resolved_run).0, Vec::<String>::new());
        assert_eq!(delivery_count(&resolved), 0);
        assert_eq!(log.entries_of(pending_run), (vec![pending.clone()], 0));
        assert_eq!(delivery_count(&pending), 1);
        assert_eq!(log.entries_of(open_run), (vec![open.clone()], 1));
        assert_eq!(cut(), Some(newest_sequence));
    };

    advance().await;
    assert_kept();

    send_pending(&open);
    advance().await;
    assert_kept();

    rebuild(&log).await;
    assert_kept();
}
