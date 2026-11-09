use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use rusqlite::params;
use rusqlite::types::Value as SqlValue;
use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{ComposedText, NonEmptyText};
use sidekicks_contracts::workflow::definition::document::{WorkflowDefinitionId, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowCost, WorkflowPayloadRef, WorkflowStepKey,
};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use crate::definitions::kept_values::{
    WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY, WorkflowKeptValueStore,
};
use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::ports::scripted_agent_runs::ScriptedAgentRunner;
use crate::engine::tick::commit::tests::{
    DEFINITION_ID, TurnHarness, instant, report, run_id, sequence, step_key, test_node,
};
use crate::engine::tick::commit::{ReportedStep, SettlementAnswer};
use crate::engine::tick::walk::WalkReady;
use crate::engine::tick::{StepReportKind, StepSettlement};
use crate::kinds::step_context::{StepRecords, StepRunVariable};
use crate::kinds::{PersonAsk, PersonWait, StepFailure, uncoded_step_error};
use crate::test_rows::{TEST_NODE_ID, TestStep, insert_step};

const AT: &str = "2026-10-02T00:05:00.000Z";

/// A stored column of the step at `execution_index` as JSON: an integer as a number, text as the
/// JSON it holds or else as a string, and NULL as `Null`.
fn step_json(harness: &TurnHarness, column: &str, execution_index: u32) -> Value {
    let stored = harness
        .rows
        .query_row(
            &format!("SELECT {column} FROM workflow_steps WHERE execution_index = ?1"),
            params![execution_index],
            |row| row.get::<_, SqlValue>(0),
        )
        .expect("the step's column reads");
    match stored {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(number) => json!(number),
        SqlValue::Text(text) => serde_json::from_str(&text).unwrap_or(Value::String(text)),
        SqlValue::Real(_) | SqlValue::Blob(_) => {
            panic!("no step column the tests read is {column}")
        }
    }
}

/// The stored events' types, in order.
fn event_types(harness: &TurnHarness) -> Vec<String> {
    harness
        .events()
        .into_iter()
        .map(|(_, event_type, _, _)| event_type)
        .collect()
}

/// The test node with `retry` as `[maxTries, waitMs]` and `on_error`.
fn node(retry: [u64; 2], on_error: &str) -> WorkflowNode {
    let mut node = serde_json::to_value(test_node()).expect("the test's node writes");
    node["retry"] = json!({ "maxTries": retry[0], "waitMs": retry[1] });
    node["onError"] = json!(on_error);
    serde_json::from_value(node).expect("the test's node reads")
}

/// An item holding `json`.
fn item(json: Value) -> WorkflowItem {
    WorkflowItem {
        json: AnyValue(json),
        binary: None,
        paired_item: None,
        error: None,
    }
}

fn account() -> ProviderAccountId {
    serde_json::from_value(json!("account-1")).expect("the test's account id")
}

/// A completed step stores its 70 KiB outputs, two lists joined, as an artifact and its ten-line
/// log inline, its row `succeeded` with the cost and each list's item count, which
/// `step.completed` repeats after `phase.completed`, and hands the outputs back; its one kept
/// variable, itself above the cap, is kept as an artifact the store reads back
/// in the step's own write, and its unkept one is not; a deleted workflow keeps none and still
/// commits the turn. Mutations: a payload above the cap kept inline; the lists' counts dropped
/// from the row or the event; an unkept variable kept;
/// kept values written outside the step's write; a deleted workflow's value kept or its turn
/// refused; the kept artifact not resolved on the read.
#[rstest]
#[case::live(false)]
#[case::deleted(true)]
#[tokio::test]
async fn a_completed_step_stores_its_outputs_and_keeps_its_kept_values(#[case] is_deleted: bool) {
    let harness = TurnHarness::new().await;
    let step = harness.store_step(1, WorkflowStepStatus::Running);
    if is_deleted {
        harness
            .rows
            .execute(
                "UPDATE workflow_definitions SET deleted_at = ?1 WHERE id = ?2",
                params![AT, DEFINITION_ID],
            )
            .expect("the test deletes the workflow");
    }
    let outputs = vec![
        (0..10)
            .map(|index| item(json!({ "index": index, "text": "x".repeat(7 * 1024) })))
            .collect::<Vec<_>>(),
        (0..3)
            .map(|index| item(json!({ "index": index })))
            .collect(),
    ];
    let log_lines: Vec<String> = (0..10).map(|index| format!("line {index}")).collect();
    let cost: WorkflowCost =
        serde_json::from_value(json!({ "usdMicros": 1500, "providerAccountId": "account-1" }))
            .expect("the test's cost reads");
    let kept_value = json!("y".repeat(70 * 1024));
    let run_variables = BTreeMap::from([
        (
            "kept".to_owned(),
            StepRunVariable {
                value: kept_value.clone(),
                is_kept: true,
            },
        ),
        (
            "unkept".to_owned(),
            StepRunVariable {
                value: json!(2),
                is_kept: false,
            },
        ),
    ]);
    let completed = StepReportKind::Settled(StepSettlement::Completed {
        outputs: outputs.clone(),
        cost: Some(cost),
        log_lines,
        run_variables,
    });

    let mut commit = harness.commit();
    let answer = commit
        .report(
            report(&step, AT, completed),
            harness.reported(sequence(0), None),
        )
        .await
        .expect("the payloads write");
    let kept_rows = || -> i64 {
        harness
            .rows
            .query_row("SELECT count(*) FROM workflow_node_state", [], |row| {
                row.get(0)
            })
            .expect("the test counts the kept values")
    };
    assert_eq!(
        kept_rows(),
        0,
        "a kept value is written before the turn's write"
    );
    harness.append(commit).await;

    let Some(SettlementAnswer::Completed {
        readying_event,
        outputs: answered,
        run_variables,
    }) = answer
    else {
        panic!("a completed step answers its outputs");
    };
    assert_eq!((readying_event, answered), (1, outputs));
    assert_eq!(run_variables.len(), 2);
    let writes = harness.payloads.writes();
    assert_eq!(
        writes.len(),
        2,
        "the outputs and the kept value are artifacts"
    );
    assert_eq!(
        step_json(&harness, "output_ref", 1)["artifactId"],
        json!(writes[0].artifact_id)
    );
    let log_ref = step_json(&harness, "log_ref", 1);
    assert_eq!(log_ref["kind"], json!("inline"));
    assert_eq!(log_ref["items"][9], json!({ "json": { "line": "line 9" } }));
    assert_eq!(harness.step_row(1).0, "succeeded");
    assert_eq!(
        step_json(&harness, "output_item_counts_json", 1),
        json!([10, 3])
    );
    assert_eq!(harness.events()[1].3["outputItemCounts"], json!([10, 3]));
    assert_eq!(step_json(&harness, "cost_usd_micros", 1), json!(1500));
    assert_eq!(
        step_json(&harness, "cost_account_id", 1),
        json!("account-1")
    );
    assert_eq!(
        event_types(&harness),
        ["workflow.phase.completed", "workflow.step.completed"]
    );
    if is_deleted {
        assert_eq!(kept_rows(), 0);
        return;
    }
    let kept: (String, String) = harness
        .rows
        .query_row(
            "SELECT key, kept_by_run_id FROM workflow_node_state",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the one kept value reads");
    assert_eq!(
        kept,
        (
            "kept".to_owned(),
            step.workflow_run_id.text().as_str().to_owned()
        )
    );
    let store = WorkflowKeptValueStore::new(
        Arc::new(DatabaseReadPool::new(
            harness.database.path(),
            WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&harness.writer),
        Arc::clone(&harness.payloads) as Arc<dyn StepPayloadArtifacts>,
    );
    let read = store
        .read(WorkflowDefinitionId::new(DEFINITION_ID).expect("the test's definition id"))
        .await
        .expect("the kept values read");
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].value, kept_value);
}

/// How a failure case is set up and what it answers.
#[derive(Clone, Copy, Debug)]
enum FailureCase {
    /// Its own failure on attempt 1 of 3, then the walk's retry.
    RetryLeft,
    /// A Decline with words on attempt 1 of 3 under `continue`.
    DeclinedContinue,
    /// Its own failure while the memory gate held it, its hold last reported 5 s before, under
    /// `stop`.
    HeldStop,
    /// A deadline's failure of a waiting approval under `stop`.
    DeadlineStop,
}

/// A failure writes the row `failed` from wherever the step stood, with every wait column empty
/// and the cut hold added, then `phase.failed` and `step.failed` carrying the row's log, and
/// answers as its node routes it: a retry writes the next attempt's `pending` row and
/// `phase.retried` in the same write; a decline is never retried and passes its input on with its
/// words, its output and its counts on event and row; a stop parks, its run `failed` with no end
/// instant and `workflow.run.failed` parked the write's last. Mutations: a decline retried; the
/// cut hold dropped; a waiting step's failure refused by the CHECK; the retry's row outside the
/// failure's write; a park that moves no count; the passed-on output left off the event.
#[rstest]
#[case::retry_left(FailureCase::RetryLeft)]
#[case::declined_continue(FailureCase::DeclinedContinue)]
#[case::held_stop(FailureCase::HeldStop)]
#[case::deadline_stop(FailureCase::DeadlineStop)]
#[tokio::test]
async fn a_failure_routes_as_its_node_says(#[case] case: FailureCase) {
    let harness = TurnHarness::new().await;
    let (status, wait_cause) = match case {
        FailureCase::RetryLeft | FailureCase::DeclinedContinue => {
            (WorkflowStepStatus::Running, None)
        }
        FailureCase::HeldStop => (WorkflowStepStatus::WaitingMemory, None),
        FailureCase::DeadlineStop => (
            WorkflowStepStatus::Waiting,
            Some(WorkflowWaitCause::Approval),
        ),
    };
    insert_step(
        &harness.rows,
        run_id().text().as_str(),
        &TestStep {
            execution_index: 1,
            status,
            wait_cause,
            wait_account_id: None,
            resume_at: None,
        },
    );
    let step = step_key(TEST_NODE_ID, 1);
    let node = match case {
        FailureCase::RetryLeft | FailureCase::DeclinedContinue => node([3, 0], "continue"),
        FailureCase::HeldStop | FailureCase::DeadlineStop => node([1, 0], "stop"),
    };
    let failure = match case {
        FailureCase::DeclinedContinue => StepFailure::Declined {
            words: Some(NonEmptyText::new("not now".to_owned()).expect("the words are not empty")),
            at: instant(AT),
        },
        FailureCase::RetryLeft | FailureCase::HeldStop | FailureCase::DeadlineStop => {
            StepFailure::Failed(Box::new(uncoded_step_error("disk full".to_owned())))
        }
    };
    let inputs = vec![vec![item(json!({ "name": "Ada" }))]];
    let last_hold = instant("2026-10-02T00:04:55.000Z");
    let reported = ReportedStep {
        readying_sequence: sequence(0),
        last_hold_report_at: matches!(case, FailureCase::HeldStop).then_some(&last_hold),
        node: &node,
        spec: &harness.spec,
        inputs: &inputs,
        status: WorkflowStepStatus::Running,
        wait_cause: None,
    };
    let failed = StepReportKind::Settled(StepSettlement::Failed {
        failure,
        log_lines: Vec::new(),
    });

    let mut commit = harness.commit();
    let answer = commit
        .report(report(&step, AT, failed), reported)
        .await
        .expect("the payloads write")
        .expect("a settlement answers");
    let retry = WalkReady {
        step: WorkflowStepKey {
            attempt: SafeInt::new(2).expect("a second attempt"),
            ..step_key(TEST_NODE_ID, 2)
        },
        run_index: 0,
        sources: Vec::new(),
    };
    match (case, answer) {
        (FailureCase::RetryLeft, SettlementAnswer::Retry { wait }) => {
            assert_eq!(wait, Duration::ZERO);
            commit.retried(&retry, WorkflowPayloadRef::Inline { items: Vec::new() });
        }
        (
            FailureCase::DeclinedContinue,
            SettlementAnswer::PassOn {
                readying_event,
                outputs,
            },
        ) => {
            assert_eq!(readying_event, 1);
            assert_eq!(outputs[0].len(), 1);
        }
        (FailureCase::HeldStop | FailureCase::DeadlineStop, SettlementAnswer::Park) => {}
        (case, _) => panic!("{case:?} answered another route"),
    }
    harness.append(commit).await;

    assert_eq!(harness.step_row(1).0, "failed");
    for column in [
        "wait_cause",
        "wait_started_at",
        "wait_deadline_at",
        "wait_id",
    ] {
        assert_eq!(step_json(&harness, column, 1), Value::Null, "{column} kept");
    }
    let events = harness.events();
    let types: Vec<&str> = events
        .iter()
        .map(|(_, event_type, _, _)| event_type.as_str())
        .collect();
    assert_eq!(
        types[..2],
        ["workflow.phase.failed", "workflow.step.failed"]
    );
    assert_eq!(events[0].3["cancellationReason"], Value::Null);
    assert_eq!(events[1].3["logRef"], step_json(&harness, "log_ref", 1));
    match case {
        FailureCase::RetryLeft => {
            assert_eq!(events[1].3.get("passedOn"), None);
            assert_eq!(types[2..], ["workflow.phase.retried"]);
            assert_eq!(events[2].3["attempt"], json!(2));
            assert_eq!(events[2].3["readied"][0]["attempt"], json!(2));
            assert_eq!(harness.step_row(2).0, "pending");
        }
        FailureCase::DeclinedContinue => {
            assert_eq!(types.len(), 2, "a decline is retried");
            assert_eq!(events[1].3["declineReason"], json!("not now"));
            assert_eq!(step_json(&harness, "decline_reason", 1), json!("not now"));
            let output_ref = step_json(&harness, "output_ref", 1);
            assert_eq!(output_ref["items"][0]["json"], json!({ "name": "Ada" }));
            assert_eq!(
                output_ref["items"][0]["error"]["message"],
                json!("The step was declined: not now")
            );
            let passed_on = &events[1].3["passedOn"];
            assert_eq!(passed_on["outputRef"], output_ref);
            assert_eq!(
                passed_on["outputItemCounts"],
                step_json(&harness, "output_item_counts_json", 1)
            );
        }
        FailureCase::HeldStop | FailureCase::DeadlineStop => {
            assert_eq!(events[1].3.get("passedOn"), None);
            assert_eq!(types[2..], ["workflow.run.failed"]);
            assert_eq!(events[2].3["outcome"], json!("parked"));
            let run_row: (String, Option<String>) = harness
                .rows
                .query_row(
                    "SELECT status, finished_at FROM workflow_runs WHERE id = ?1",
                    params![run_id().text().as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("the run's row reads");
            assert_eq!(run_row, ("failed".to_owned(), None));
            let pool_wait_ms = if matches!(case, FailureCase::HeldStop) {
                5_000
            } else {
                0
            };
            assert_eq!(harness.step_row(1).1, pool_wait_ms);
        }
    }
}

/// What a wait case waits on.
#[derive(Clone, Copy, Debug)]
enum WaitCase {
    /// An approval with a 10-minute timeout.
    Approval,
    /// A form with no timeout.
    Form,
    /// A spent account.
    Account,
}

/// A wait is stored in the step's write before anyone is asked: an approval's row takes the
/// four wait columns with `phase.suspended` naming its wait id, deadline and the row's log and
/// `gate.reached`, and the answer names the opened wait; a form writes no `gate.reached`; an
/// account wait stores its account with no resume instant or log and hands the run back.
/// Mutations: the wait id missing from the row; `gate.reached` on a form; a deadline not
/// reported; the account's run dropped; the log left off the suspension.
#[rstest]
#[case::approval(WaitCase::Approval)]
#[case::form(WaitCase::Form)]
#[case::account(WaitCase::Account)]
#[tokio::test]
async fn a_wait_is_stored_before_anyone_is_asked(#[case] case: WaitCase) {
    let harness = TurnHarness::new().await;
    let step = harness.store_step(1, WorkflowStepStatus::Running);
    let prompt = || ComposedText::new("Ship it?".to_owned()).expect("the prompt is not empty");
    let runner = ScriptedAgentRunner::new(None, false);
    let settlement = match case {
        WaitCase::Approval => StepSettlement::PersonWait {
            wait: PersonWait {
                ask: PersonAsk::Approval { prompt: prompt() },
                timeout: Some(Duration::from_secs(600)),
            },
            admission: None,
            log_lines: vec!["asked for approval".to_owned()],
        },
        WaitCase::Form => StepSettlement::PersonWait {
            wait: PersonWait {
                ask: PersonAsk::Form {
                    prompt: prompt(),
                    input_schema: Map::new(),
                },
                timeout: None,
            },
            admission: None,
            log_lines: Vec::new(),
        },
        WaitCase::Account => StepSettlement::AccountSpent {
            provider_account_id: account(),
            resets_at: None,
            run: runner.made_run(),
            records: StepRecords {
                log_lines: vec!["asked".to_owned()],
                ..StepRecords::default()
            },
        },
    };

    let mut commit = harness.commit();
    let answer = commit
        .report(
            report(&step, AT, StepReportKind::Settled(settlement)),
            harness.reported(sequence(0), None),
        )
        .await
        .expect("the payloads write")
        .expect("a settlement answers");
    harness.append(commit).await;

    assert_eq!(harness.step_row(1).0, "waiting");
    let events = harness.events();
    let types: Vec<&str> = events
        .iter()
        .map(|(_, event_type, _, _)| event_type.as_str())
        .collect();
    let suspended = &events[0].3;
    assert_eq!(step_json(&harness, "wait_started_at", 1), json!(AT));
    match (case, answer) {
        (WaitCase::Approval | WaitCase::Form, SettlementAnswer::PersonWait { opened, .. }) => {
            let deadline =
                matches!(case, WaitCase::Approval).then(|| instant("2026-10-02T00:15:00.000Z"));
            assert_eq!(opened.deadline_at, deadline);
            let wait_id = json!(opened.wait_id);
            assert_eq!(step_json(&harness, "wait_id", 1), wait_id);
            assert_eq!(suspended["waitId"], wait_id);
            assert_eq!(suspended["logRef"], step_json(&harness, "log_ref", 1));
            let deadline_json = deadline.as_ref().map_or(Value::Null, |at| json!(at));
            assert_eq!(step_json(&harness, "wait_deadline_at", 1), deadline_json);
            if matches!(case, WaitCase::Approval) {
                assert_eq!(suspended["waitDeadlineAt"], deadline_json);
                assert_eq!(step_json(&harness, "wait_cause", 1), json!("approval"));
                assert_eq!(types, ["workflow.phase.suspended", "workflow.gate.reached"]);
            } else {
                assert_eq!(step_json(&harness, "wait_cause", 1), json!("form"));
                assert_eq!(types, ["workflow.phase.suspended"]);
            }
        }
        (WaitCase::Account, SettlementAnswer::AccountSpent { parked, resume_at }) => {
            assert_eq!(resume_at, None);
            assert_eq!(
                parked.records.log_lines,
                ["asked"],
                "the park keeps the params' lines"
            );
            let run = parked.run;
            assert_eq!(step_json(&harness, "wait_cause", 1), json!("account"));
            assert_eq!(
                step_json(&harness, "wait_account_id", 1),
                json!("account-1")
            );
            assert_eq!(step_json(&harness, "resume_at", 1), Value::Null);
            assert_eq!(suspended["waitCause"], json!("account"));
            assert_eq!(suspended.get("logRef"), None);
            assert_eq!(types, ["workflow.phase.suspended"]);
            let progressed = run.progressed();
            runner.progress();
            assert_eq!(
                *progressed.borrow(),
                1,
                "the answered run is not the step's"
            );
        }
        (case, _) => panic!("{case:?} answered another settlement"),
    }
}
