use rstest::rstest;
use serde_json::{Value, json};

use super::{WorkflowPhaseSuspendedPayload, WorkflowStepFailedPayload, WorkflowStepStartedPayload};

const SESSION: &str = "018f0000-0000-7000-8000-000000000001";
const WORKFLOW_RUN: &str = "018f0000-0000-7000-8000-000000000004";
const ACCOUNT: &str = "018f0000-0000-7000-8000-00000000000c";
const DEADLINE: &str = "2020-01-01T10:00:00.000Z";

/// A step event's payload: the step it names, then `members`.
fn step_payload(members: Value) -> Value {
    let mut payload = json!({
        "sessionId": SESSION, "workflowRunId": WORKFLOW_RUN, "nodeId": "ask",
        "attempt": 1, "executionIndex": 0,
    });
    if let (Some(payload), Value::Object(members)) = (payload.as_object_mut(), members) {
        payload.extend(members);
    }
    payload
}

#[rstest]
#[case::approval(json!({"waitCause": "approval"}), true)]
#[case::form(json!({"waitCause": "form"}), true)]
#[case::reply(json!({"waitCause": "reply"}), true)]
#[case::account(json!({"waitCause": "account", "providerAccountId": ACCOUNT}), false)]
#[case::chain(json!({"waitCause": "chain"}), false)]
fn phase_suspended_carries_a_deadline_only_on_a_wait_on_a_person(
    #[case] wait: Value,
    #[case] is_carried: bool,
) {
    let without_deadline = step_payload(wait.clone());
    assert!(
        serde_json::from_value::<WorkflowPhaseSuspendedPayload>(without_deadline).is_ok(),
        "the wait reads without a deadline"
    );
    let mut with_deadline = wait;
    if let Some(members) = with_deadline.as_object_mut() {
        members.insert("waitDeadlineAt".into(), json!(DEADLINE));
    }
    let wire = step_payload(with_deadline);
    let written = serde_json::from_value::<WorkflowPhaseSuspendedPayload>(wire.clone())
        .ok()
        .map(|read| serde_json::to_value(read).expect("a read payload writes"));
    assert_eq!(written, is_carried.then_some(wire));
}

#[rstest]
#[case::with_level(json!({"inputRef": {"kind": "inline", "items": []}, "permissionLevel": "ask"}))]
#[case::without_level(json!({"inputRef": {"kind": "inline", "items": []}}))]
fn step_started_keeps_its_level_only_where_one_was_written(#[case] members: Value) {
    let wire = step_payload(members);
    let read: WorkflowStepStartedPayload =
        serde_json::from_value(wire.clone()).expect("the payload reads");
    assert_eq!(
        serde_json::to_value(read).expect("the payload writes"),
        wire
    );
}

#[rstest]
#[case::with_reason(json!({
    "error": {"message": "declined"}, "declineReason": "use the test database",
}))]
#[case::without_reason(json!({"error": {"message": "declined"}}))]
fn step_failed_keeps_its_decline_reason_only_where_one_was_written(#[case] members: Value) {
    let wire = step_payload(members);
    let read: WorkflowStepFailedPayload =
        serde_json::from_value(wire.clone()).expect("the payload reads");
    assert_eq!(
        serde_json::to_value(read).expect("the payload writes"),
        wire
    );
}
