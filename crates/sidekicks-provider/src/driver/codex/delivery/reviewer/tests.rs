use rstest::rstest;
use serde_json::{Map, Value, json};

use super::complete_codex_review;
use crate::driver::codex::delivery::memory::CodexDeliveryMemory;
use crate::driver::codex::delivery::rows::test_row_run;

// A review's end as Codex sends it on `thread-1` in `turn-1`.
fn review_end(
    review_id: &str,
    target_item_id: &Value,
    review: &Value,
    action: &Value,
) -> Map<String, Value> {
    let Value::Object(params) = json!({
        "threadId": "thread-1",
        "turnId": "turn-1",
        "startedAtMs": 10,
        "completedAtMs": 20,
        "reviewId": review_id,
        "targetItemId": target_item_id,
        "decisionSource": "agent",
        "review": review,
        "action": action,
    }) else {
        unreachable!("the frame is an object")
    };
    params
}

fn command_action() -> Value {
    json!({"type": "command", "source": "unifiedExec", "command": "rm -rf build", "cwd": "/work"})
}

// Fails when a block reaches the approval service with the wrong item, reason or override, when a
// network access is not its own block naming where it reached, when anything but a denial may be
// allowed once, or when a review that did not block is handed over.
#[rstest]
#[case::a_denied_command(
    json!("item-1"),
    json!({"status": "denied", "rationale": "deletes the build"}),
    command_action(),
    Some((Some("item-1"), Some("deletes the build"), true)),
)]
#[case::a_timed_out_command(
    json!("item-1"),
    json!({"status": "timedOut"}),
    command_action(),
    Some((Some("item-1"), None, false)),
)]
#[case::a_denied_network_access(
    Value::Null,
    json!({"status": "denied", "rationale": "an unknown host"}),
    json!({"type": "networkAccess", "target": "https://x.example/a", "host": "x.example",
        "protocol": "https", "port": 443}),
    Some((None, Some("network access to https://x.example/a · an unknown host"), true)),
)]
#[case::a_network_access_with_no_target(
    Value::Null,
    json!({"status": "timedOut"}),
    json!({"type": "networkAccess", "target": "", "host": "x.example", "protocol": "http",
        "port": 80}),
    Some((None, Some("network access to x.example"), false)),
)]
#[case::an_approved_command(json!("item-1"), json!({"status": "approved"}), command_action(), None)]
#[case::an_aborted_command(json!("item-1"), json!({"status": "aborted"}), command_action(), None)]
fn a_codex_reviewer_block_reaches_the_approval_service_as_codex_sent_it(
    #[case] target_item_id: Value,
    #[case] review: Value,
    #[case] action: Value,
    #[case] expected: Option<(Option<&str>, Option<&str>, bool)>,
) {
    let mut memory = CodexDeliveryMemory::new();
    let run = test_row_run();

    let completion = complete_codex_review(
        &mut memory,
        &review_end("review-1", &target_item_id, &review, &action),
        Some(&run),
    );

    let denial = completion
        .denial
        .map(|denial| denial.expect("the review's record reads"));
    assert_eq!(
        denial.as_ref().map(|denial| (
            denial.tool_call_id.as_deref(),
            denial.reason.as_deref(),
            denial.is_overridable
        )),
        expected
    );
    if let Some(denial) = denial {
        assert_eq!(
            (denial.session_id, denial.run_id),
            (run.session_id, run.run_id)
        );
    }
}

// Fails when the event Codex takes back is not written in Codex's own snake_case members, field by
// field, or a written-input folder is not the `file:` address Codex's event holds.
#[test]
fn a_denied_review_hands_codex_the_assessment_event_it_accepts() {
    let mut memory = CodexDeliveryMemory::new();
    let params = review_end(
        "review-1",
        &json!("item-1"),
        &json!({"status": "denied", "riskLevel": "high", "userAuthorization": "low",
            "rationale": "writes to a shell"}),
        &json!({"type": "writeStdin", "approvalId": "approval-1", "processId": "7",
            "stdin": "y\n", "cwd": "/work/app"}),
    );

    let denial = complete_codex_review(&mut memory, &params, Some(&test_row_run()))
        .denial
        .expect("the denial is a block")
        .expect("the review's record reads");

    let record: Value =
        serde_json::from_str(denial.provider_denial.get()).expect("the record is JSON");
    assert_eq!(
        record,
        json!({
            "threadId": "thread-1",
            "event": {
                "id": "review-1",
                "turn_id": "turn-1",
                "started_at_ms": 10,
                "completed_at_ms": 20,
                "status": "denied",
                "risk_level": "high",
                "user_authorization": "low",
                "rationale": "writes to a shell",
                "decision_source": "agent",
                "action": {
                    "type": "write_stdin",
                    "approval_id": "approval-1",
                    "process_id": "7",
                    "stdin": "y\n",
                    "cwd": "file:///work/app",
                },
            },
        })
    );
}

// Fails when a review Codex sends again is handed over twice, or a block goes on the frame's run
// when the reviewed item's rows carry another, which for a command outlives its turn.
#[test]
fn a_codex_reviewer_block_goes_once_on_the_reviewed_item_s_run() {
    let mut memory = CodexDeliveryMemory::new();
    let item_run = test_row_run();
    memory
        .tool_row_run_by_item_id
        .insert("item-1".to_owned(), item_run.clone());
    let params = review_end(
        "review-1",
        &json!("item-1"),
        &json!({"status": "denied"}),
        &command_action(),
    );

    let first = complete_codex_review(&mut memory, &params, Some(&test_row_run())).denial;
    let again = complete_codex_review(&mut memory, &params, Some(&test_row_run())).denial;

    let first = first
        .expect("the first end is a block")
        .expect("the review's record reads");
    assert_eq!(first.run_id, item_run.run_id);
    assert!(again.is_none());
}

// Fails when a reviewer warning is not flagged on a review that fell back to the person, or is
// flagged on one that approved or blocked, whose words stand on its action's row.
#[rstest]
#[case::a_review_that_fell_back("aborted", true)]
#[case::a_review_that_runs("inProgress", true)]
#[case::an_approval("approved", false)]
#[case::a_block("denied", false)]
fn a_codex_reviewer_warning_is_flagged_only_on_a_review_that_fell_back(
    #[case] status: &str,
    #[case] is_flagged: bool,
) {
    let mut memory = CodexDeliveryMemory::new();
    let Value::Object(warning) = json!({"threadId": "thread-1", "message": "Risky command"}) else {
        unreachable!("the frame is an object")
    };
    super::hold_guardian_warning(&mut memory, &warning);

    let flag = complete_codex_review(
        &mut memory,
        &review_end(
            "review-1",
            &json!("item-1"),
            &json!({"status": status}),
            &command_action(),
        ),
        Some(&test_row_run()),
    )
    .flag;

    assert_eq!(
        flag.map(|flag| flag.text.as_str().to_owned()),
        is_flagged.then(|| "Risky command".to_owned())
    );
    assert!(memory.guardian_warning_by_thread_id.is_empty());
}
