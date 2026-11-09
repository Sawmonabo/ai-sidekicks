use std::collections::BTreeMap;
use std::sync::Arc;

use rstest::rstest;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::instant;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowNode, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use tokio::sync::oneshot;

use super::RunLiveStep;
use crate::engine::chain::{
    KEEP_GOING_STATEMENT_INDEX, KeepGoingAnswer, keep_going_write, read_chain_held_steps,
};
use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::tick::commit::tests::{
    DEFINITION_ID, TurnHarness, VERSION_ID, report, run_id, sequence, step_key, test_node,
};
use crate::engine::tick::commit::{ReportedStep, RunTurnCommit, RunTurnCommitted};
use crate::engine::tick::run_status::{RunPersonWait, RunStepCounts};
use crate::engine::tick::{StepReportKind, StepSettlement};
use crate::engine::waits::answers::{PersonWaitIntake, answered_step};
use crate::engine::waits::{PersonWaitAnswer, PersonWaitRefusal, WaitingPersonStep};
use crate::kinds::{StepFailure, uncoded_step_error};
use crate::runs::gate_resolution::RunEventKeys;
use crate::runs::gate_resolution::tests::gate_answer;
use crate::test_rows::{TEST_NODE_ID, TEST_SESSION_ID, TestStep, insert_chain_run, insert_step};

const T0: &str = "2026-10-02T00:10:00.000Z";
const T90: &str = "2026-10-02T00:11:30.000Z";
const RUN_ID_TEXT: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";
const OTHER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e90";
const OTHER_SESSION_ID: &str = "00000000-0000-7000-8000-0000000000aa";

/// The wait columns of the step at `execution_index` in `run`, each as stored text or NULL.
fn wait_columns(harness: &TurnHarness, run: &str, execution_index: u32) -> Vec<Option<String>> {
    harness
        .rows
        .query_row(
            "SELECT wait_cause, wait_started_at, wait_deadline_at, wait_account_id, resume_at, \
             wait_id FROM workflow_steps WHERE workflow_run_id = ?1 AND execution_index = ?2",
            params![run, execution_index],
            |row| (0..6).map(|column| row.get(column)).collect(),
        )
        .expect("the step's wait columns read")
}

/// The status, person-wait start and person-wait milliseconds of the run `run`.
fn run_row(harness: &TurnHarness, run: &str) -> (String, Option<String>, i64, Option<String>) {
    harness
        .rows
        .query_row(
            "SELECT status, person_wait_since, person_wait_ms, finished_at FROM workflow_runs \
             WHERE id = ?1",
            params![run],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("the run's row reads")
}

/// The stored events of `session`, each its sequence, type and payload, in sequence order.
fn session_events(harness: &TurnHarness, session: &str) -> Vec<(i64, String, Value)> {
    harness
        .events()
        .into_iter()
        .filter(|(_, _, _, payload)| payload["sessionId"] == json!(session))
        .map(|(sequence, event_type, _, payload)| (sequence, event_type, payload))
        .collect()
}

/// The step of the test node at `execution_index`, waiting on `cause`, stored in `run`.
fn store_waiting(harness: &TurnHarness, run: &str, execution_index: u32, cause: WorkflowWaitCause) {
    insert_step(
        &harness.rows,
        run,
        &TestStep {
            execution_index,
            status: WorkflowStepStatus::Waiting,
            wait_cause: Some(cause),
            wait_account_id: (cause == WorkflowWaitCause::Account).then_some("account-1"),
            resume_at: None,
        },
    );
}

/// The wait id the test rows give the person wait of the step at `execution_index`.
fn stored_wait_id(execution_index: u32) -> UuidTextForm {
    UuidTextForm::new(&format!("00000000-0000-7000-8000-{execution_index:012x}"))
        .expect("the test's wait id")
}

fn item(json: Value) -> WorkflowItem {
    WorkflowItem {
        json: AnyValue(json),
        binary: None,
        paired_item: None,
        error: None,
    }
}

/// How the running sibling ends in the turn that leaves the run waiting.
#[derive(Clone, Copy, Debug)]
enum SiblingEnding {
    Completed,
    Canceled,
}

/// A running A settles at `t` beside B, waiting: the run's `workflow.run.waiting` is the write's
/// last event and its row reads `waiting`, its person wait open at `t` unless B waits on an
/// account. B's resume at `t + 90 s` writes `gate.resolved` for an approval, `phase.resumed`, then
/// `workflow.run.resumed` naming B; B's row is `running` with no wait column and the run's 90 s on
/// people are counted. Mutations: the run event before its cause; an account wait counted; a
/// resume that leaves `since` or B's wait columns set; a completion or a cancel that moves no
/// count.
#[rstest]
#[case::completed_beside_an_approval(SiblingEnding::Completed, WorkflowWaitCause::Approval)]
#[case::canceled_beside_an_approval(SiblingEnding::Canceled, WorkflowWaitCause::Approval)]
#[case::completed_beside_an_account(SiblingEnding::Completed, WorkflowWaitCause::Account)]
#[tokio::test]
async fn a_run_waits_resumes_and_counts_only_time_waiting_on_people(
    #[case] ending: SiblingEnding,
    #[case] cause: WorkflowWaitCause,
) {
    let harness = TurnHarness::new().await;
    let sibling = harness.store_step(1, WorkflowStepStatus::Running);
    store_waiting(&harness, RUN_ID_TEXT, 2, cause);
    let waiting = step_key(TEST_NODE_ID, 2);
    let is_account = cause == WorkflowWaitCause::Account;
    let counts = RunStepCounts {
        has_admitted_step: true,
        running: 1,
        waiting: 1,
        account_waits: usize::from(is_account),
        ..RunStepCounts::default()
    };
    let settlement = match ending {
        SiblingEnding::Completed => StepSettlement::Completed {
            outputs: vec![Vec::new()],
            cost: None,
            log_lines: Vec::new(),
            run_variables: BTreeMap::new(),
        },
        SiblingEnding::Canceled => StepSettlement::Canceled {
            hold_started_at: None,
            cancellation_reason: None,
        },
    };

    let mut settles = harness.commit_with(counts, RunPersonWait::default());
    settles
        .report(
            report(&sibling, T0, StepReportKind::Settled(settlement)),
            harness.reported(sequence(0), None),
        )
        .await
        .expect("the settlement writes its payloads");
    let left_waiting = RunLiveStep {
        step: &waiting,
        status: WorkflowStepStatus::Waiting,
        wait_cause: Some(cause),
    };
    let committed = settles
        .append(&harness.appender, &harness.record, [left_waiting])
        .await
        .expect("the turn's write commits");
    let events = harness.events();
    let last = events.last().expect("the turn wrote events");
    assert_eq!(
        (last.1.as_str(), last.2.as_str()),
        ("workflow.run.waiting", T0)
    );
    let opened_at = (!is_account).then(|| T0.to_owned());
    assert_eq!(
        run_row(&harness, RUN_ID_TEXT),
        ("waiting".to_owned(), opened_at, 0, None)
    );
    let event_count = events.len();

    let RunTurnCommitted {
        counts,
        person_wait,
        ..
    } = committed;
    let mut resumes = harness.commit_with(counts, person_wait);
    let wait_id = stored_wait_id(2);
    if is_account {
        resumes.resume_step(&waiting, None, cause, &instant(T90));
    } else {
        let answer = gate_answer(
            RUN_ID_TEXT,
            1,
            WorkflowGateKind::HumanApproval,
            ApprovalDecision::Approved,
        );
        let row = crate::runs::gate_resolution::gate_resolution_statement(&answer);
        resumes.answer_gate(&answer, vec![row], &instant(T90));
        resumes.resume_step(&waiting, Some(&wait_id), cause, &instant(T90));
    }
    let running = RunLiveStep {
        status: WorkflowStepStatus::Running,
        wait_cause: None,
        ..left_waiting
    };
    resumes
        .append(&harness.appender, &harness.record, [running])
        .await
        .expect("the resume's write commits");

    let events = harness.events();
    let written: Vec<&str> = events[event_count..]
        .iter()
        .map(|(_, event_type, _, _)| event_type.as_str())
        .collect();
    let expected: &[&str] = if is_account {
        &["workflow.phase.resumed", "workflow.run.resumed"]
    } else {
        &[
            "workflow.gate.resolved",
            "workflow.phase.resumed",
            "workflow.run.resumed",
        ]
    };
    assert_eq!(written, expected);
    let resumed = &events.last().expect("the resume wrote events").3;
    assert_eq!(
        resumed["resumptionPoint"],
        json!({
            "activeSteps": [{ "nodeId": TEST_NODE_ID, "attempt": 1, "executionIndex": 2 }],
            "pendingGates": [],
        })
    );
    assert_eq!(harness.step_row(2).0, "running");
    assert_eq!(wait_columns(&harness, RUN_ID_TEXT, 2), vec![None; 6]);
    let waited_ms = if is_account { 0 } else { 90_000 };
    assert_eq!(
        run_row(&harness, RUN_ID_TEXT),
        ("running".to_owned(), None, waited_ms, None)
    );
}

/// What an answer case answers, and when.
#[derive(Clone, Copy, Debug)]
enum AnswerCase {
    /// An approval with its own gate answer, before the deadline.
    ApprovalOnTime,
    /// A form with no gate answer, to a form wait with no deadline.
    FormOnTime,
    /// An approval at its wait's deadline.
    AtDeadline,
    /// A form's answer to an approval wait.
    OtherKind,
    /// An approval with no gate answer.
    MissingGate,
    /// An approval whose gate answer rejects what it approves.
    DifferentGate,
    /// A form's answer that carries a gate answer.
    FormWithGate,
    /// An approval on time to a step whose row already failed and left the wait.
    LeftTheWait,
}

/// An answer resumes its step in its turn, in the order an answer writes: an approval's
/// `gate.resolved` and its row, then `phase.resumed`, then the settlement's events, its input on
/// the `approved` handle; a form's writes no `gate.resolved`. An answer at its deadline, of another
/// kind, an approval whose gate answer is missing or differs, and a form carrying one are refused
/// `NotWaiting` with nothing written; one whose row left the wait refuses the write at the resume
/// statement, nothing stored. Mutations: an answer at its deadline written; a resume not keyed on
/// the wait id; `gate.resolved` on a form; the gate answer not checked.
#[rstest]
#[case::approval_on_time(AnswerCase::ApprovalOnTime)]
#[case::form_on_time(AnswerCase::FormOnTime)]
#[case::at_deadline(AnswerCase::AtDeadline)]
#[case::other_kind(AnswerCase::OtherKind)]
#[case::missing_gate(AnswerCase::MissingGate)]
#[case::different_gate(AnswerCase::DifferentGate)]
#[case::form_with_gate(AnswerCase::FormWithGate)]
#[case::left_the_wait(AnswerCase::LeftTheWait)]
#[tokio::test]
async fn an_answer_resumes_its_step_only_while_its_wait_holds(#[case] case: AnswerCase) {
    let harness = TurnHarness::new().await;
    let cause = match case {
        AnswerCase::FormOnTime | AnswerCase::FormWithGate => WorkflowWaitCause::Form,
        AnswerCase::ApprovalOnTime
        | AnswerCase::AtDeadline
        | AnswerCase::OtherKind
        | AnswerCase::MissingGate
        | AnswerCase::DifferentGate
        | AnswerCase::LeftTheWait => WorkflowWaitCause::Approval,
    };
    if matches!(case, AnswerCase::LeftTheWait) {
        harness.store_step(2, WorkflowStepStatus::Failed);
    } else {
        store_waiting(&harness, RUN_ID_TEXT, 2, cause);
    }
    let waiting = WaitingPersonStep {
        step: step_key(TEST_NODE_ID, 2),
        wait_id: stored_wait_id(2),
        cause,
        deadline_at: (cause == WorkflowWaitCause::Approval).then(|| instant(T90)),
    };
    let gate = |outcome| {
        Some(gate_answer(
            RUN_ID_TEXT,
            1,
            WorkflowGateKind::HumanApproval,
            outcome,
        ))
    };
    let form = || PersonWaitAnswer::Form(serde_json::Map::from_iter([("ok".to_owned(), json!(1))]));
    let approved = PersonWaitAnswer::Approval(ApprovalDecision::Approved);
    let (answer, gate, at) = match case {
        AnswerCase::ApprovalOnTime | AnswerCase::LeftTheWait => {
            (approved, gate(ApprovalDecision::Approved), T0)
        }
        AnswerCase::FormOnTime | AnswerCase::OtherKind => (form(), None, T0),
        AnswerCase::AtDeadline => (approved, gate(ApprovalDecision::Approved), T90),
        AnswerCase::MissingGate => (approved, None, T0),
        AnswerCase::DifferentGate => (approved, gate(ApprovalDecision::Rejected), T0),
        AnswerCase::FormWithGate => (form(), gate(ApprovalDecision::Approved), T0),
    };
    let intake = PersonWaitIntake {
        wait_id: waiting.wait_id,
        answer,
        gate,
        at: instant(at),
        reply: oneshot::channel().0,
    };
    let input = vec![item(json!({ "a": 1 })), item(json!({ "b": 2 }))];

    let answered = answered_step(&waiting, &intake, input);
    let answered = match case {
        AnswerCase::ApprovalOnTime | AnswerCase::FormOnTime | AnswerCase::LeftTheWait => {
            answered.expect("an answer to the wait it names, on time, settles it")
        }
        AnswerCase::AtDeadline
        | AnswerCase::OtherKind
        | AnswerCase::MissingGate
        | AnswerCase::DifferentGate
        | AnswerCase::FormWithGate => {
            assert_eq!(answered.err(), Some(PersonWaitRefusal::NotWaiting));
            return;
        }
    };
    let counts = RunStepCounts {
        has_admitted_step: true,
        running: 1,
        waiting: 1,
        ..RunStepCounts::default()
    };
    let mut commit = harness.commit_with(counts, RunPersonWait::default());
    let settled = answered.resume(&mut commit);
    if let StepReportKind::Settled(StepSettlement::Completed { outputs, .. }) = &settled.kind
        && matches!(case, AnswerCase::ApprovalOnTime)
    {
        assert_eq!(outputs[0].len(), 2, "the input is on the approved handle");
        assert_eq!(outputs[1].len(), 0);
    }
    commit
        .report(settled, harness.reported(sequence(0), None))
        .await
        .expect("the answer's settlement writes its payloads");
    let appended = commit.append(&harness.appender, &harness.record, []).await;

    let gate_rows = || -> i64 {
        harness
            .rows
            .query_row(
                "SELECT count(*) FROM workflow_gate_resolutions",
                [],
                |row| row.get(0),
            )
            .expect("the test counts the gate rows")
    };
    if matches!(case, AnswerCase::LeftTheWait) {
        let failure = appended.expect_err("a row that left the wait refuses the resume");
        assert_eq!(failure.error.refused_statement_index(), Some(1));
        assert_eq!(harness.events().len(), 0);
        assert_eq!(gate_rows(), 0);
        assert_eq!(harness.step_row(2).0, "failed");
        return;
    }
    appended.expect("the answer's write commits");
    let events = harness.events();
    let types: Vec<&str> = events
        .iter()
        .map(|(_, event_type, _, _)| event_type.as_str())
        .collect();
    let mut expected = vec![
        "workflow.phase.resumed",
        "workflow.phase.completed",
        "workflow.step.completed",
    ];
    if matches!(case, AnswerCase::ApprovalOnTime) {
        expected.insert(0, "workflow.gate.resolved");
        assert_eq!(events[3].3["outputItemCounts"], json!([2, 0]));
    }
    assert_eq!(types, expected);
    assert_eq!(
        gate_rows(),
        i64::from(matches!(case, AnswerCase::ApprovalOnTime))
    );
    assert_eq!(harness.step_row(2).0, "succeeded");
}

/// Keep going over two runs of one chain, the first run's held step in its session and the
/// other's in another, is one write: the kept-going update and the answer's row first,
/// `gate.resolved` with no node, each held step's `phase.resumed` and each run's
/// `workflow.run.resumed`, each session's events at its own consecutive sequences; both rows
/// `running` with no wait column. A second Keep going is refused at the kept-going update and
/// writes nothing in either session. Mutations: a held step left `waiting`; the answer's row
/// written without the moves; the kept-going update not the write's first statement.
#[tokio::test]
async fn keep_going_moves_every_held_step_in_one_write() {
    let harness = TurnHarness::new().await;
    harness
        .rows
        .execute(
            "UPDATE workflow_runs SET status = 'waiting' WHERE id = ?1",
            params![RUN_ID_TEXT],
        )
        .expect("the test sets the first run waiting");
    insert_chain_run(
        &harness.rows,
        OTHER_RUN_ID,
        VERSION_ID,
        OTHER_SESSION_ID,
        "2026-10-02T00:00:01.000Z",
        Some(RUN_ID_TEXT),
    );
    store_waiting(&harness, RUN_ID_TEXT, 1, WorkflowWaitCause::Chain);
    store_waiting(&harness, OTHER_RUN_ID, 1, WorkflowWaitCause::Chain);
    let root = run_id();
    let other = WorkflowRunId::new(OTHER_RUN_ID).expect("the test's run id");
    let held = read_chain_held_steps(&harness.rows, &root).expect("the held steps read");
    assert_eq!(held.len(), 2);
    let waiting_counts = RunStepCounts {
        has_admitted_step: true,
        waiting: 1,
        ..RunStepCounts::default()
    };
    let other_keys = RunEventKeys {
        session_id: SessionId::new(OTHER_SESSION_ID).expect("the test's session id"),
        definition_id: WorkflowDefinitionId::new(DEFINITION_ID).expect("the test's definition"),
        workflow_version_id: WorkflowVersionId::new(VERSION_ID).expect("the test's version"),
    };
    let fresh_turns = || {
        // The other run's turn comes first, so the write must put the first run's ahead.
        vec![
            RunTurnCommit::new(
                other_keys,
                other,
                waiting_counts,
                RunPersonWait::default(),
                Arc::clone(&harness.payloads) as Arc<dyn StepPayloadArtifacts>,
            ),
            harness.commit_with(waiting_counts, RunPersonWait::default()),
        ]
    };
    let writes = |turns: Vec<RunTurnCommit>| {
        turns
            .into_iter()
            .map(|turn| {
                let live_steps: Vec<RunLiveStep<'_>> = held
                    .iter()
                    .filter(|held_step| held_step.step.workflow_run_id == turn.run_id())
                    .map(|held_step| RunLiveStep {
                        step: &held_step.step,
                        status: WorkflowStepStatus::Running,
                        wait_cause: None,
                    })
                    .collect();
                (turn, live_steps, Some(&harness.record))
            })
            .collect::<Vec<_>>()
    };
    let keep_going = |id_suffix| {
        KeepGoingAnswer::new(
            &root,
            gate_answer(
                RUN_ID_TEXT,
                id_suffix,
                WorkflowGateKind::Chain,
                ApprovalDecision::Approved,
            ),
        )
        .expect("an approval of the first run's question keeps it going")
    };
    let at = instant(T0);

    let turns = keep_going_write(&keep_going(1), fresh_turns(), &held, &at);
    RunTurnCommit::append_together(writes(turns), &harness.appender)
        .await
        .expect("Keep going's write commits");

    let first_session: Vec<(i64, String)> = session_events(&harness, TEST_SESSION_ID)
        .into_iter()
        .map(|(sequence, event_type, _)| (sequence, event_type))
        .collect();
    assert_eq!(
        first_session,
        [
            (0, "workflow.gate.resolved".to_owned()),
            (1, "workflow.phase.resumed".to_owned()),
            (2, "workflow.run.resumed".to_owned()),
        ]
    );
    assert_eq!(
        session_events(&harness, TEST_SESSION_ID)[0].2.get("nodeId"),
        None
    );
    let other_session: Vec<(i64, String)> = session_events(&harness, OTHER_SESSION_ID)
        .into_iter()
        .map(|(sequence, event_type, _)| (sequence, event_type))
        .collect();
    assert_eq!(
        other_session,
        [
            (0, "workflow.phase.resumed".to_owned()),
            (1, "workflow.run.resumed".to_owned()),
        ]
    );
    for run in [RUN_ID_TEXT, OTHER_RUN_ID] {
        assert_eq!(wait_columns(&harness, run, 1), vec![None; 6], "{run}");
        assert_eq!(run_row(&harness, run).0, "running", "{run}");
    }
    let kept_going: i64 = harness
        .rows
        .query_row(
            "SELECT chain_kept_going FROM workflow_runs WHERE id = ?1",
            params![RUN_ID_TEXT],
            |row| row.get(0),
        )
        .expect("the first run's mark reads");
    assert_eq!(kept_going, 1);

    let again = keep_going_write(&keep_going(2), fresh_turns(), &held, &at);
    let failure = RunTurnCommit::append_together(writes(again), &harness.appender)
        .await
        .expect_err("a chain answered once refuses a second Keep going");
    assert_eq!(
        failure.error.refused_statement_index(),
        Some(KEEP_GOING_STATEMENT_INDEX)
    );
    assert_eq!(session_events(&harness, TEST_SESSION_ID).len(), 3);
    assert_eq!(session_events(&harness, OTHER_SESSION_ID).len(), 2);
}

/// A running A fails under `onError: stop` while B, waiting on an approval, is canceled in the
/// same turn: the run parks, `workflow.run.failed` with `outcome: parked` the write's last, its
/// row `failed` with no end instant, and B's row `canceled` with no wait column. Mutations: the
/// park written `ended` or with an end instant; a cancel that leaves the wait columns, which the
/// step's CHECK refuses.
#[tokio::test]
async fn a_park_fails_the_run_and_cancels_its_waiting_step() {
    let harness = TurnHarness::new().await;
    let failing = harness.store_step(1, WorkflowStepStatus::Running);
    store_waiting(&harness, RUN_ID_TEXT, 2, WorkflowWaitCause::Approval);
    let waiting = step_key(TEST_NODE_ID, 2);
    let mut stopping = serde_json::to_value(test_node()).expect("the test's node writes");
    stopping["onError"] = json!("stop");
    let stopping: WorkflowNode = serde_json::from_value(stopping).expect("the test's node reads");
    let counts = RunStepCounts {
        has_admitted_step: true,
        running: 1,
        waiting: 1,
        ..RunStepCounts::default()
    };
    let mut commit = harness.commit_with(counts, RunPersonWait::default());
    let failed = StepSettlement::Failed {
        failure: StepFailure::Failed(Box::new(uncoded_step_error("disk full".to_owned()))),
        log_lines: Vec::new(),
    };
    commit
        .report(
            report(&failing, T0, StepReportKind::Settled(failed)),
            ReportedStep {
                node: &stopping,
                ..harness.reported(sequence(0), None)
            },
        )
        .await
        .expect("the failure writes its log");
    let canceled = StepSettlement::Canceled {
        hold_started_at: None,
        cancellation_reason: Some(WorkflowPhaseCancellationReason::SiblingFailure),
    };
    commit
        .report(
            report(&waiting, T0, StepReportKind::Settled(canceled)),
            harness.reported_waiting(WorkflowWaitCause::Approval),
        )
        .await
        .expect("a cancel writes no payload");
    harness.append(commit).await;

    let events = harness.events();
    let (_, last_type, _, last) = events.last().expect("the turn wrote events");
    assert_eq!(last_type, "workflow.run.failed");
    assert_eq!(last["outcome"], json!("parked"));
    assert_eq!(
        run_row(&harness, RUN_ID_TEXT),
        ("failed".to_owned(), None, 0, None)
    );
    assert_eq!(harness.step_row(2).0, "canceled");
    assert_eq!(wait_columns(&harness, RUN_ID_TEXT, 2), vec![None; 6]);
}
