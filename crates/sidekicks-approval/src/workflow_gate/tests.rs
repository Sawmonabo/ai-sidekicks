//! A workflow gate's card over the approval and workflow tables: raised once per wait, refused for
//! an ended workflow run, a chain whose question no longer waits or another session, answered
//! through the registered waits, left standing by its session's close and canceled at a restart
//! once no step holds its wait or its chain's question stopped waiting.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::{
    ApprovalDecision, ApprovalRequestId, ApprovalResolveRequest, ApprovalState,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::test_session_id;
use sidekicks_workflow::test_rows::{TestStep, insert_run, insert_step, insert_workflow_version};

use super::{ApprovalWaitAnswer, ApprovalWaitOutcome, ApprovalWaits, WorkflowGateCardAsk};
use crate::service::tests::{ApprovalFixture, from_json, held_by_a_live_call, refusal};
use crate::store::ApprovalRequestReader;

const VERSION_ID: &str = "00000000-0000-7000-8000-0000000000a1";
const RUN_ID: &str = "00000000-0000-7000-8000-0000000000b1";
const ENDED_RUN_ID: &str = "00000000-0000-7000-8000-0000000000b2";
const CHAIN_RUN_ID: &str = "00000000-0000-7000-8000-0000000000b3";

/// The waits a test registers: each answer it took, answered settled while `is_waiting` holds and
/// not waiting after.
#[derive(Default)]
struct RecordingWaits {
    /// Whether a step still waits.
    is_waiting: AtomicBool,
    /// The answers taken, oldest first.
    answers: Mutex<Vec<ApprovalWaitAnswer>>,
}

impl ApprovalWaits for RecordingWaits {
    fn answer_wait(
        &self,
        answer: ApprovalWaitAnswer,
    ) -> BoxFuture<'_, Result<ApprovalWaitOutcome, Box<dyn std::error::Error + Send + Sync>>> {
        let outcome = if self.is_waiting.load(Ordering::SeqCst) {
            ApprovalWaitOutcome::Settled
        } else {
            ApprovalWaitOutcome::NotWaiting
        };
        self.answers
            .lock()
            .expect("the test's answers are never poisoned")
            .push(answer);
        async move { Ok(outcome) }.boxed()
    }
}

/// The fixture over the workflow tables too, all in the fixture's session: a going workflow run
/// whose step at execution index 1 waits on an approval, and an ended one, the first run of a
/// chain whose later run's step at execution index 4 is held by the chain's question.
async fn gate_fixture() -> ApprovalFixture {
    let fixture = ApprovalFixture::with_workflow_tables().await;
    let reader = fixture.database.reader();
    insert_workflow_version(
        &reader,
        "00000000-0000-7000-8000-0000000000c1",
        VERSION_ID,
        "Notes",
    );
    insert_run(
        &reader,
        RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Waiting,
        "2026-10-02T00:00:00Z",
        None,
    );
    insert_step(
        &reader,
        RUN_ID,
        &TestStep {
            execution_index: 1,
            status: WorkflowStepStatus::Waiting,
            wait_cause: Some(WorkflowWaitCause::Approval),
            wait_account_id: None,
            resume_at: None,
        },
    );
    insert_run(
        &reader,
        ENDED_RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Succeeded,
        "2026-10-02T00:00:00Z",
        Some("2026-10-02T00:01:00Z"),
    );
    insert_run(
        &reader,
        CHAIN_RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Waiting,
        "2026-10-02T00:02:00Z",
        None,
    );
    insert_step(
        &reader,
        CHAIN_RUN_ID,
        &TestStep {
            execution_index: 4,
            status: WorkflowStepStatus::Waiting,
            wait_cause: Some(WorkflowWaitCause::Chain),
            wait_account_id: None,
            resume_at: None,
        },
    );
    reader
        .execute(
            "UPDATE workflow_runs SET chain_root_run_id = ?1, chain_run_count = NULL,
               chain_kept_going = NULL WHERE id = ?2",
            [ENDED_RUN_ID, CHAIN_RUN_ID],
        )
        .expect("the test joins the later run to the chain");
    reader
        .execute(
            "UPDATE workflow_runs SET session_id = ?1",
            [fixture.session_id.text().as_str()],
        )
        .expect("the test puts the runs in the fixture's session");
    fixture
}

/// The wait the test step at `execution_index` holds, as the test rows make its id; a higher
/// index names a wait no step holds.
fn wait_id(execution_index: u32) -> UuidTextForm {
    UuidTextForm::new(&format!("00000000-0000-7000-8000-{execution_index:012x}"))
        .expect("the test's wait id is a UUID")
}

/// The card a step of `run_id` asks at `wait_id`.
fn step_card(
    fixture: &ApprovalFixture,
    run_id: &str,
    wait_id: UuidTextForm,
) -> WorkflowGateCardAsk {
    WorkflowGateCardAsk {
        session_id: fixture.session_id,
        workflow_run_id: WorkflowRunId::new(run_id).expect("the test's run id"),
        wait_id,
        node_id: Some(WorkflowNodeId::new("approve".to_owned()).expect("the test's node id")),
        workflow_name: from_json(json!("Release notes")),
        prompt: from_json(json!("Publish the release notes?")),
    }
}

/// The card the question of the chain whose first run is `root` asks, which names no node.
fn chain_card(fixture: &ApprovalFixture, root: &str) -> WorkflowGateCardAsk {
    WorkflowGateCardAsk {
        session_id: fixture.session_id,
        workflow_run_id: WorkflowRunId::new(root).expect("the test's run id"),
        wait_id: UuidTextForm::new(root).expect("a run id is a UUID"),
        node_id: None,
        workflow_name: from_json(json!("Release notes")),
        prompt: from_json(json!("Keep going?")),
    }
}

/// The stored state of the card `approval_request_id`.
fn card_state(fixture: &ApprovalFixture, approval_request_id: ApprovalRequestId) -> String {
    fixture
        .database
        .reader()
        .query_row(
            "SELECT state FROM approval_requests WHERE id = ?1",
            [approval_request_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the test reads the card's state")
}

/// The count `sql` reads from the test database.
fn count(fixture: &ApprovalFixture, sql: &str) -> i64 {
    fixture
        .database
        .reader()
        .query_row(sql, [], |row| row.get(0))
        .expect("the test counts its rows")
}

/// An approval of the card `approval_request_id`.
fn approval(approval_request_id: ApprovalRequestId) -> ApprovalResolveRequest {
    from_json(json!({
        "decision": ApprovalDecision::Approved,
        "approvalRequestId": approval_request_id,
        "clientResolutionId": mint_uuid_v7().to_string(),
    }))
}

// A raise for a wait whose card is open answers that card and writes nothing, one after the other
// or both at once. Killed by dropping the unique index on the open wait, which lets the two raises
// at once write two cards, and by dropping both the open-card read and that index, which lets the
// second raise write another. The read dropped alone leaves the index to refuse the second
// raise's write, which reads the card back: the same rows and answer, one more write attempted.
#[tokio::test]
async fn a_wait_raises_one_card() {
    let fixture = gate_fixture().await;
    let service = &fixture.service;

    let first = service
        .raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(1)))
        .await
        .expect("the card is raised");
    let again = service
        .raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(1)))
        .await
        .expect("the raise answers the open card");
    let (left, right) = tokio::join!(
        service.raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(2))),
        service.raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(2))),
    );

    assert_eq!(first, again);
    assert_eq!(
        left.expect("the card is raised"),
        right.expect("the raise answers the open card")
    );
    assert_eq!(count(&fixture, "SELECT count(*) FROM approval_requests"), 2);
    assert_eq!(
        count(
            &fixture,
            "SELECT count(*) FROM session_events WHERE type = 'approval.requested'"
        ),
        2
    );
}

/// Which raise a refusal case makes.
enum RefusedRaise {
    /// A step's card on a workflow run that has ended.
    EndedRun,
    /// A chain's card on a chain no step of which waits on its question.
    ChainNotWaiting,
    /// A step's card on a going run, named in another session.
    OtherSession,
}

// A raise whose holder no longer stands raises no card and names the run's end: a step's card on
// an ended run, a chain's card whose question no longer waits, and a card naming another session
// than its run's. Killed by dropping the holder's guard, guarding a chain's card on its first
// run's status, dropping the guard's session, or reading its refusal as the session's.
#[rstest]
#[case::ended_run(RefusedRaise::EndedRun)]
#[case::chain_not_waiting(RefusedRaise::ChainNotWaiting)]
#[case::other_session(RefusedRaise::OtherSession)]
#[tokio::test]
async fn a_raise_whose_holder_no_longer_stands_is_refused(#[case] raise: RefusedRaise) {
    let fixture = gate_fixture().await;
    let ask = match raise {
        RefusedRaise::EndedRun => step_card(&fixture, ENDED_RUN_ID, wait_id(3)),
        RefusedRaise::ChainNotWaiting => chain_card(&fixture, RUN_ID),
        RefusedRaise::OtherSession => {
            let other = test_session_id();
            insert_session_row(
                &fixture.database.reader(),
                other.text().as_str(),
                None,
                None,
            );
            WorkflowGateCardAsk {
                session_id: other,
                ..step_card(&fixture, RUN_ID, wait_id(1))
            }
        }
    };

    let refused = refusal(
        fixture
            .service
            .raise_workflow_gate(ask)
            .await
            .expect_err("the raise is refused"),
    );

    assert_eq!(refused.code, RefusalCode::ApprovalRequestCanceled);
    assert_eq!(
        refused
            .detail
            .and_then(|detail| detail.get("reason").cloned()),
        Some(json!("runEnded"))
    );
    assert_eq!(count(&fixture, "SELECT count(*) FROM approval_requests"), 0);
}

// An answer to a wait's card is handed to the registered waits with the write that settles it, and
// writes no row itself; once no step waits, the answer cancels the card and is refused. Killed by
// the wait's answer writing its own rows, which settles the card here, and by dropping the cancel,
// which leaves the card pending.
#[tokio::test]
async fn a_wait_s_card_is_answered_through_its_wait() {
    let fixture = gate_fixture().await;
    let waits = Arc::new(RecordingWaits::default());
    waits.is_waiting.store(true, Ordering::SeqCst);
    fixture
        .service
        .waits()
        .register(Arc::clone(&waits) as Arc<dyn ApprovalWaits>)
        .unwrap_or_else(|_| panic!("the test registers the waits once"));
    let card = fixture
        .service
        .raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(1)))
        .await
        .expect("the card is raised");

    let answered = fixture
        .service
        .resolve(
            &approval(card),
            from_json(json!("device-1")),
            held_by_a_live_call,
        )
        .await
        .expect("the wait takes the answer");

    assert_eq!(answered.response.state, ApprovalState::Approved);
    assert_eq!(card_state(&fixture, card), "pending");
    assert_eq!(
        count(&fixture, "SELECT count(*) FROM approval_resolutions"),
        0
    );
    {
        let answers = waits
            .answers
            .lock()
            .expect("the test's answers are never poisoned");
        let [taken] = answers.as_slice() else {
            panic!("the wait took one answer");
        };
        assert_eq!(taken.approval_request_id, card);
        assert_eq!(taken.wait_id, wait_id(1));
        assert_eq!(taken.statements.len(), 2);
        assert!(matches!(taken.event, SessionEvent::ApprovalApproved(_)));
    }

    waits.is_waiting.store(false, Ordering::SeqCst);
    let refused = refusal(
        fixture
            .service
            .resolve(
                &approval(card),
                from_json(json!("device-1")),
                held_by_a_live_call,
            )
            .await
            .expect_err("an answer no step waits on is refused"),
    );

    assert_eq!(refused.code, RefusalCode::ApprovalRequestCanceled);
    assert_eq!(card_state(&fixture, card), "canceled");
}

// The restart's settle cancels a step's card whose wait no step holds and leaves the one a waiting
// step holds. Killed by dropping the wait arm of the settle's read, which leaves both standing.
#[tokio::test]
async fn the_restart_settle_cancels_a_card_no_step_holds() {
    let fixture = gate_fixture().await;
    let held = fixture
        .service
        .raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(1)))
        .await
        .expect("the held card is raised");
    let unheld = fixture
        .service
        .raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(9)))
        .await
        .expect("the unheld card is raised");

    fixture
        .service
        .cancel_unheld_wait_asks(fixture.session_id)
        .await
        .expect("the settle's cancels are kept");

    assert_eq!(card_state(&fixture, held), "pending");
    assert_eq!(card_state(&fixture, unheld), "canceled");
}

// A chain's card is raised while its question waits though its first run has ended, and the
// restart's settle leaves it until no step of the chain waits on the question, then cancels it;
// the restart's list names the card's session once while any unheld card stands. Killed by
// guarding a chain's card on its first run's status, which refuses the raise and cancels the
// card at once, and by dropping the chain arm of the unheld read, which leaves it standing.
#[tokio::test]
async fn a_chain_s_card_stands_while_its_question_waits() {
    let fixture = gate_fixture().await;
    let chain = fixture
        .service
        .raise_workflow_gate(chain_card(&fixture, ENDED_RUN_ID))
        .await
        .expect("the chain's card is raised");
    let unheld = fixture
        .service
        .raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(9)))
        .await
        .expect("the unheld card is raised");
    let unheld_sessions = || {
        ApprovalRequestReader::new(&fixture.database.reader())
            .list_sessions_with_unheld_wait_requests()
            .expect("the restart's list reads")
    };

    assert_eq!(unheld_sessions(), [fixture.session_id]);
    fixture
        .service
        .cancel_unheld_wait_asks(fixture.session_id)
        .await
        .expect("the settle's cancels are kept");
    assert_eq!(card_state(&fixture, chain), "pending");
    assert_eq!(card_state(&fixture, unheld), "canceled");
    assert_eq!(unheld_sessions(), []);

    fixture
        .database
        .reader()
        .execute(
            "UPDATE workflow_steps SET status = 'succeeded', wait_cause = NULL,
               wait_started_at = NULL
               WHERE workflow_run_id = ?1",
            [CHAIN_RUN_ID],
        )
        .expect("the test settles the held start");
    assert_eq!(unheld_sessions(), [fixture.session_id]);
    fixture
        .service
        .cancel_unheld_wait_asks(fixture.session_id)
        .await
        .expect("the settle's cancels are kept");

    assert_eq!(card_state(&fixture, chain), "canceled");
}

// A closed session's cancel of its pending asks cancels a run's card and leaves a wait's card to
// its wait. Killed by dropping the run-held filter from the session's pending read.
#[tokio::test]
async fn a_session_s_close_leaves_a_wait_s_card() {
    let fixture = gate_fixture().await;
    let run_card = fixture
        .raise("git push")
        .await
        .expect("the run's card is raised")
        .approval_request_id;
    let wait_card = fixture
        .service
        .raise_workflow_gate(step_card(&fixture, RUN_ID, wait_id(1)))
        .await
        .expect("the wait's card is raised");

    fixture
        .service
        .cancel_pending_for_session(fixture.session_id)
        .await
        .expect("the session's cancels are kept");

    assert_eq!(card_state(&fixture, run_card), "canceled");
    assert_eq!(card_state(&fixture, wait_card), "pending");
}
