//! The run holds over a test database: a run in a given state, its open asks written as rows, and
//! a reconcile run against the engine.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::ApprovalCategory;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::service::test_fixture::SETTLE_WAIT;
use crate::service::tests::{ApprovalFixture, from_json};
use crate::store::{InsertedApprovalRequest, insert_request_statement};

impl ApprovalFixture {
    /// Writes one pending ask on the run, with no event, as a row alone changes the run's open
    /// asks.
    async fn open_ask(&self) {
        let ask = InsertedApprovalRequest {
            approval_request_id: from_json(json!(mint_uuid_v7())),
            session_id: self.session_id,
            run_id: self.run_id,
            requested_by: from_json(json!("agent")),
            category: ApprovalCategory::ToolExecution,
            scope: from_json(json!("Bash")),
            resource_descriptor: from_json(json!({
                "subject": "git push",
                "standingAllowOffered": true,
                "projectScopeOffered": false,
                "editable": true,
            })),
            ask_id: None,
            tool_call_id: None,
            created_at: WireInstant::now(),
        };
        self.writer
            .write(vec![insert_request_statement(&ask)])
            .await
            .expect("the test writes the ask");
    }
}

// The run ends in the state its open asks call for, whatever state it was in: held from
// `running`, released from `waitingForApproval`, and left alone where its state allows no move.
// Killed by a release with no expected state (it would move `waitingForInput`) and by treating a
// refused move as a failure.
#[rstest]
#[case::running_held("running", true, "waitingForApproval")]
#[case::running_free("running", false, "running")]
#[case::waiting_held("waitingForApproval", true, "waitingForApproval")]
#[case::waiting_released("waitingForApproval", false, "running")]
#[case::input_held("waitingForInput", true, "waitingForInput")]
#[case::input_free("waitingForInput", false, "waitingForInput")]
#[tokio::test]
async fn a_reconcile_moves_the_run_to_match_its_open_asks(
    #[case] state: &str,
    #[case] is_ask_open: bool,
    #[case] expected: &str,
) {
    let fixture = ApprovalFixture::new().await;
    fixture.execute(&format!("UPDATE runs SET state = '{state}'"));
    if is_ask_open {
        fixture.open_ask().await;
    }
    fixture
        .run_holds
        .reconcile(fixture.run_id)
        .await
        .expect("the reconcile settles");
    assert_eq!(fixture.run_state(fixture.run_id), expected);
}

// A reconcile reads the open asks when it holds the run, not when it was spawned: one waiting on
// the run's lock while an ask opens holds the run once it takes the lock. Killed by a reconcile
// that decides its move before it takes the run's lock.
#[tokio::test]
async fn a_reconcile_reads_the_asks_open_when_it_holds_the_run() {
    let fixture = ApprovalFixture::new().await;
    let run_locks = &fixture.run_holds.run_locks;
    let run_hold = run_locks.acquire(fixture.run_id).await;
    let held_alone = run_locks.queue_handle_count(fixture.run_id);
    let holds = Arc::clone(&fixture.run_holds);
    let run_id = fixture.run_id;
    let reconcile = tokio::spawn(async move { holds.reconcile(run_id).await });
    tokio::time::timeout(
        SETTLE_WAIT,
        run_locks.wait_for_queue_past(run_id, held_alone),
    )
    .await
    .expect("the reconcile waits on the run's lock");
    fixture.open_ask().await;
    drop(run_hold);
    tokio::time::timeout(SETTLE_WAIT, reconcile)
        .await
        .expect("the reconcile settles")
        .expect("the reconcile's task ends")
        .expect("the reconcile moves the run");
    assert_eq!(fixture.run_state(fixture.run_id), "waitingForApproval");
}
