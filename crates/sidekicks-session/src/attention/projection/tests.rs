use serde_json::json;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::notify_entry_statements;
use crate::attention::test_log::AttentionTestLog;

const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
const NODE: &str = "tell";

/// Mutation: drop the trigger filter from the mute's statements.
#[tokio::test]
async fn muting_withdraws_raised_end_banners_and_keeps_waits_and_notices() {
    let harness = AttentionTestLog::new().await;
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
            SessionEventLinkage {
                transactional_prelude: notify,
                ..SessionEventLinkage::default()
            },
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
    assert_eq!(
        harness.delivery(&waiting),
        (Some("posted".to_owned()), None)
    );
    assert_eq!(harness.delivery(&notice), (Some("posted".to_owned()), None));
}

/// Mutations: drop the banner-state guard from the withdraw; drop the `merged_into` clause from
/// the hand-back.
#[tokio::test]
async fn a_resolve_withdraws_raised_banners_and_hands_merged_waits_back() {
    let harness = AttentionTestLog::new().await;
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
    let harness = AttentionTestLog::new().await;
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
    let harness = AttentionTestLog::new().await;
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
