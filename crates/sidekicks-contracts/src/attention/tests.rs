//! The rules a garde check and the schema hold alike: the subscribe request's narrowing and the
//! delivery outcome's `cause`.

use garde::Validate as _;
use rstest::rstest;

use crate::attention::{AttentionDeliveryOutcome, AttentionSubscribeRequest};
use crate::schema::closed_schema_for;

const SESSION: &str = "0190d2b4-7c3a-7e21-9a4b-5f6c7d8e9f01";

// The garde check and the schema both hold every narrowing rule, so the daemon and a client
// refuse the same request. Killed by dropping either garde check or the `dependentRequired`.
#[rstest]
#[case::whole_projection("{}", true)]
#[case::one_session(&format!(r#"{{"sessionId":"{SESSION}"}}"#), true)]
#[case::session_aggregate(&format!(r#"{{"sessionId":"{SESSION}","scope":"session"}}"#), true)]
#[case::one_run(
    &format!(r#"{{"sessionId":"{SESSION}","scope":"run","runId":"run-1"}}"#),
    true
)]
#[case::run_scope_without_run(&format!(r#"{{"sessionId":"{SESSION}","scope":"run"}}"#), false)]
#[case::run_with_session_scope(
    &format!(r#"{{"sessionId":"{SESSION}","scope":"session","runId":"run-1"}}"#),
    false
)]
#[case::run_without_scope(&format!(r#"{{"sessionId":"{SESSION}","runId":"run-1"}}"#), false)]
#[case::session_scope_without_session(r#"{"scope":"session"}"#, false)]
#[case::run_scope_without_session(r#"{"scope":"run","runId":"run-1"}"#, false)]
fn a_subscribe_request_narrows_only_as_its_session_and_scope_allow(
    #[case] request: &str,
    #[case] is_taken: bool,
) {
    let parsed: AttentionSubscribeRequest =
        serde_json::from_str(request).expect("the case reads as a subscribe request");
    assert_eq!(parsed.validate().is_ok(), is_taken, "garde: {request}");

    let schema = closed_schema_for::<AttentionSubscribeRequest>().expect("the schema writes");
    let check = jsonschema::validator_for(&schema).expect("the schema builds a check");
    let json: serde_json::Value = serde_json::from_str(request).expect("the case is JSON");
    assert_eq!(check.is_valid(&json), is_taken, "schema: {request}");
}

// `cause` is present exactly on a `storeUnavailable` attempt, in the garde check and the schema
// alike. Killed by dropping the garde check or either branch of the schema's `if`.
#[rstest]
#[case::store_unavailable_with_its_cause("storeUnavailable", Some("locked"), true)]
#[case::store_unavailable_without_a_cause("storeUnavailable", None, false)]
#[case::refused_without_a_cause("refused", None, true)]
#[case::refused_with_a_cause("refused", Some("secretMissing"), false)]
fn a_delivery_outcome_carries_a_cause_exactly_on_a_store_unavailable_attempt(
    #[case] result: &str,
    #[case] cause: Option<&str>,
    #[case] is_taken: bool,
) {
    let mut json = serde_json::json!({
        "at": "2026-10-30T12:00:00.000Z",
        "result": result,
        "httpStatus": null,
        "undelivered": 0,
    });
    if let Some(cause) = cause {
        json["cause"] = serde_json::Value::from(cause);
    }
    let parsed: AttentionDeliveryOutcome =
        serde_json::from_value(json.clone()).expect("the case reads as an outcome");
    assert_eq!(parsed.validate().is_ok(), is_taken, "garde: {json}");

    let schema = closed_schema_for::<AttentionDeliveryOutcome>().expect("the schema writes");
    let check = jsonschema::validator_for(&schema).expect("the schema builds a check");
    assert_eq!(check.is_valid(&json), is_taken, "schema: {json}");
}
