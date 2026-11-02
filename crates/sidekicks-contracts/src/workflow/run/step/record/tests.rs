use serde_json::json;

use super::WorkflowStep;

#[test]
fn a_step_record_requires_its_pool_wait_total_and_keeps_a_decline_reason() {
    let wire = json!({
        "status": "failed",
        "workflowRunId": "018f0000-0000-7000-8000-000000000004",
        "nodeId": "ask",
        "attempt": 1,
        "executionIndex": 0,
        "source": [],
        "startedAt": "2020-01-01T09:00:00.000Z",
        "finishedAt": "2020-01-01T09:05:00.000Z",
        "inputRef": {"kind": "inline", "items": []},
        "outputRef": {"kind": "inline", "items": []},
        "logRef": {"kind": "inline", "items": []},
        "totalPoolWaitMs": 1500,
        "error": {"message": "declined"},
        "resolution": {
            "kind": "declined",
            "at": "2020-01-01T09:05:00.000Z",
            "declineReason": "use the test database",
        },
    });
    let read: WorkflowStep = serde_json::from_value(wire.clone()).expect("the record reads");
    assert_eq!(serde_json::to_value(read).expect("the record writes"), wire);

    let mut without_total = wire;
    if let Some(members) = without_total.as_object_mut() {
        members.remove("totalPoolWaitMs");
    }
    assert!(
        serde_json::from_value::<WorkflowStep>(without_total).is_err(),
        "a record without its pool-wait total is refused"
    );
}
