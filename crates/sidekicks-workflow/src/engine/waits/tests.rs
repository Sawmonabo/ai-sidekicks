use std::time::Duration;

use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{ComposedText, NonEmptyText};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use super::{
    PersonWaitAnswer, PersonWaitRefusal, WaitingPersonStep, open_person_wait, settle_person_wait,
};
use crate::engine::tick::StepSettlement;
use crate::kinds::PersonAsk;
use crate::test_rows::TEST_NODE_ID;

const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52";
const OPENED_AT: &str = "2026-10-02T00:00:00.000Z";
const ANSWERED_AT: &str = "2026-10-02T00:00:05.000Z";

fn instant(text: &str) -> WireInstant {
    WireInstant::try_from(text.to_owned()).expect("the test's instant")
}

fn prompt() -> ComposedText {
    ComposedText::new("Ship it?".to_owned()).expect("the test's prompt")
}

fn person(name: &str) -> WorkflowItem {
    WorkflowItem {
        json: AnyValue(json!({ "name": name })),
        binary: None,
        paired_item: None,
        error: None,
    }
}

// The test node's first attempt at `execution_index` in the test run.
fn test_step(execution_index: u32) -> WorkflowStepKey {
    serde_json::from_value(json!({
        "workflowRunId": RUN_ID, "nodeId": TEST_NODE_ID, "attempt": 1,
        "executionIndex": execution_index,
    }))
    .expect("the test's step key")
}

/// The answer settles its wait only when of its own kind, strictly before the deadline the wait
/// opened with. Kills: the approval's handles swapped, `>` in place of `>=` on the deadline, a late
/// answer taken, the kind unchecked.
#[rstest]
#[case::approved(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    ANSWERED_AT,
    Ok(json!([
        [
            {"json": {"name": "Ada"}, "pairedItem": {"item": 0}},
            {"json": {"name": "Bob"}, "pairedItem": {"item": 1}},
        ],
        [],
    ])),
)]
#[case::rejected(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Rejected),
    ANSWERED_AT,
    Ok(json!([
        [],
        [
            {"json": {"name": "Ada"}, "pairedItem": {"item": 0}},
            {"json": {"name": "Bob"}, "pairedItem": {"item": 1}},
        ],
    ])),
)]
#[case::form(
    PersonAsk::Form { prompt: prompt(), input_schema: Map::new() },
    PersonWaitAnswer::Form(Map::from_iter([("email".to_owned(), json!("ada@example.com"))])),
    ANSWERED_AT,
    Ok(json!([[{"json": {"email": "ada@example.com"}, "pairedItem": {"item": 0}}]])),
)]
#[case::reply(
    PersonAsk::Reply { prompt: prompt() },
    PersonWaitAnswer::Reply(NonEmptyText::new("Ship it".to_owned()).expect("a reply")),
    ANSWERED_AT,
    Ok(json!([[{"json": {"reply": "Ship it"}, "pairedItem": {"item": 0}}]])),
)]
#[case::an_approval_for_a_form_wait(
    PersonAsk::Form { prompt: prompt(), input_schema: Map::new() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    ANSWERED_AT,
    Err(PersonWaitRefusal::NotWaiting),
)]
#[case::at_the_deadline(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    "2026-10-02T00:00:10.000Z",
    Err(PersonWaitRefusal::NotWaiting),
)]
#[case::a_millisecond_before_the_deadline(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    "2026-10-02T00:00:09.999Z",
    Ok(json!([
        [
            {"json": {"name": "Ada"}, "pairedItem": {"item": 0}},
            {"json": {"name": "Bob"}, "pairedItem": {"item": 1}},
        ],
        [],
    ])),
)]
fn an_answer_of_the_waits_kind_settles_the_wait_before_its_deadline(
    #[case] ask: PersonAsk,
    #[case] answer: PersonWaitAnswer,
    #[case] answered_at: &str,
    #[case] expected: Result<Value, PersonWaitRefusal>,
) {
    let opened = open_person_wait(&ask, Some(Duration::from_secs(10)), instant(OPENED_AT))
        .expect("the wait opens");
    let waiting = WaitingPersonStep {
        step: test_step(0),
        wait_id: opened.wait_id,
        cause: opened.cause,
        deadline_at: opened.deadline_at,
    };
    let settled = settle_person_wait(
        &waiting,
        answer,
        &instant(answered_at),
        vec![person("Ada"), person("Bob")],
    )
    .map(|settlement| match settlement {
        StepSettlement::Completed { outputs, .. } => {
            serde_json::to_value(outputs).expect("the outputs write")
        }
        StepSettlement::Failed { .. }
        | StepSettlement::PersonWait { .. }
        | StepSettlement::AccountSpent { .. }
        | StepSettlement::Canceled { .. } => Value::Null,
    });

    assert_eq!(settled, expected);
}
