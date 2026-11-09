use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use rstest::rstest;
use sidekicks_contracts::event::usage::UsageContainment;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use super::{CodexCompletedResponse, read_codex_completed_responses};
use crate::driver::diagnostics::RecordedEvents;
use crate::usage_delta_accountant::UsageAxisCounts;

const REFUSED_COUNTER: &str = "driver.telemetry.recordRefused";

/// The thread this file's records are on.
const THREAD: &str = "thread-r";

/// The counts this file's completed response carries.
const COUNTS: UsageAxisCounts = UsageAxisCounts {
    input: Some(1000),
    cached_input: Some(200),
    cache_write_input: Some(50),
    output: Some(100),
    reasoning_output: Some(30),
    total: Some(1100),
};

fn attribute(key: &str, value: Value) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue { value: Some(value) }),
        ..Default::default()
    }
}

fn text(key: &str, value: &str) -> KeyValue {
    attribute(key, Value::StringValue(value.to_owned()))
}

/// A record as Codex's log bridge sends it: tracing's call-site name in `event_name`, the event's
/// own name among the attributes.
pub(crate) fn codex_record(attributes: Vec<KeyValue>) -> LogRecord {
    LogRecord {
        event_name: "event core/src/client.rs:2753".to_owned(),
        attributes,
        ..Default::default()
    }
}

// The attributes every record of Codex's on `thread_id` carries, the person's identity among them.
fn shared_attributes(thread_id: &str) -> Vec<KeyValue> {
    vec![
        text("conversation.id", thread_id),
        text("model", "gpt-5.6-luna"),
        text("user.email", "person-email-value"),
        text("user.account_id", "account-id-value"),
        text("auth_mode", "Chatgpt"),
        text("originator", "codex_cli_rs"),
        text("event.timestamp", "2026-11-05T12:00:00.000Z"),
    ]
}

/// The attributes of a completed response on `thread_id` carrying `counts`, as Codex logs them:
/// input, output and total as digit strings, the rest as integers, an absent count left out.
pub(crate) fn completed_response_attributes(
    thread_id: &str,
    counts: &UsageAxisCounts,
) -> Vec<KeyValue> {
    let mut attributes = vec![
        text("event.name", "codex.sse_event"),
        text("event.kind", "response.completed"),
        text("service_tier", "priority"),
    ];
    let digits = [
        ("input_token_count", counts.input),
        ("output_token_count", counts.output),
        ("tool_token_count", counts.total),
    ];
    for (key, count) in digits {
        if let Some(count) = count {
            attributes.push(text(key, &count.to_string()));
        }
    }
    let integers = [
        ("cached_token_count", counts.cached_input),
        ("cache_write_token_count", counts.cache_write_input),
        ("reasoning_token_count", counts.reasoning_output),
    ];
    for (key, count) in integers {
        if let Some(count) = count {
            let count = i64::try_from(count).expect("a test's count fits");
            attributes.push(attribute(key, Value::IntValue(count)));
        }
    }
    attributes.extend(shared_attributes(thread_id));
    attributes
}

fn sse_record(kind: &str, extra: Vec<KeyValue>) -> LogRecord {
    let mut attributes = vec![
        text("event.name", "codex.sse_event"),
        text("event.kind", kind),
    ];
    attributes.extend(extra);
    attributes.extend(shared_attributes(THREAD));
    codex_record(attributes)
}

fn one_resource(scopes: Vec<Vec<LogRecord>>) -> ResourceLogs {
    ResourceLogs {
        scope_logs: scopes
            .into_iter()
            .map(|log_records| ScopeLogs {
                log_records,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

fn first_completed_response() -> CodexCompletedResponse {
    let resource = one_resource(vec![vec![codex_record(completed_response_attributes(
        THREAD, &COUNTS,
    ))]]);
    let mut responses = read_codex_completed_responses(&resource, None);
    assert_eq!(responses.len(), 1);
    responses.remove(0)
}

// Killed by matching on the record's `event_name`, by reading integer counts only, by reading
// every `response.completed` record, by reading the observed time in another unit, and by logging
// the record's own attributes.
#[test]
fn a_mixed_export_yields_its_one_completed_response_and_logs_it_without_identity() {
    let resource = one_resource(vec![
        vec![
            LogRecord {
                observed_time_unix_nano: 1_762_600_000_123_456_789,
                ..codex_record(completed_response_attributes(THREAD, &COUNTS))
            },
            sse_record("response.completed", vec![text("duration_ms", "12")]),
            sse_record(
                "response.completed",
                vec![
                    text("duration_ms", "9"),
                    text("error.message", "stream closed"),
                ],
            ),
        ],
        vec![
            sse_record("response.output_text.delta", vec![text("duration_ms", "1")]),
            codex_record(
                [
                    vec![text("event.name", "codex.tool_result")],
                    shared_attributes(THREAD),
                ]
                .concat(),
            ),
            codex_record(
                [
                    vec![
                        text("event.name", "codex.turn_cost"),
                        attribute("usage.estimated_usd", Value::DoubleValue(0.25)),
                    ],
                    shared_attributes(THREAD),
                ]
                .concat(),
            ),
        ],
    ]);
    let recorded = RecordedEvents::default();
    let mut responses = Vec::new();
    recorded.record_during(|| responses = read_codex_completed_responses(&resource, None));

    assert_eq!(
        responses,
        [CodexCompletedResponse {
            conversation_id: THREAD.to_owned(),
            model_id: FreeFormText::new("gpt-5.6-luna".to_owned()).expect("the model fits"),
            service_tier: BoundedText::new("priority".to_owned()),
            counts: COUNTS,
            observed_at_ms: 1_762_600_000_123,
            provider_account_id: None,
        }]
    );
    assert!(recorded.counters().is_empty(), "{:?}", recorded.texts());

    let logged = RecordedEvents::default();
    logged.record_during(|| responses[0].log_read_for_price());
    let texts = logged.texts();
    assert!(texts.iter().any(|text| text == THREAD), "{texts:?}");
    assert!(texts.iter().any(|text| text == "gpt-5.6-luna"), "{texts:?}");
    assert!(
        texts
            .iter()
            .all(|text| !text.contains("person-email-value") && !text.contains("account-id-value")),
        "{texts:?}"
    );
}

// Killed by taking a string count through a whole `parse::<u64>`, which reads `+12`, by casting a
// negative integer, by a refusal that logs its value and by keeping the record with its bad count
// dropped.
#[rstest]
#[case::input_absent_beside_output("input_token_count", None, None)]
#[case::a_negative_output(
    "output_token_count",
    Some(Value::StringValue("-5".to_owned())),
    Some("-5")
)]
#[case::a_signed_input(
    "input_token_count",
    Some(Value::StringValue("+12".to_owned())),
    Some("+12")
)]
#[case::a_fractional_total(
    "tool_token_count",
    Some(Value::StringValue("1.5".to_owned())),
    Some("1.5")
)]
#[case::a_negative_integer_cached("cached_token_count", Some(Value::IntValue(-1)), Some("-1"))]
#[case::a_word_for_reasoning(
    "reasoning_token_count",
    Some(Value::StringValue("abc".to_owned())),
    Some("abc")
)]
#[case::model_absent("model", None, None)]
#[case::conversation_absent("conversation.id", None, None)]
fn a_malformed_record_is_refused_whole_its_field_named_and_its_value_never(
    #[case] field: &str,
    #[case] replacement: Option<Value>,
    #[case] bad_value: Option<&str>,
) {
    let mut attributes: Vec<KeyValue> = completed_response_attributes(THREAD, &COUNTS)
        .into_iter()
        .filter(|attribute| attribute.key != field)
        .collect();
    if let Some(value) = replacement {
        attributes.push(attribute(field, value));
    }
    let resource = one_resource(vec![vec![codex_record(attributes)]]);
    let recorded = RecordedEvents::default();
    let mut responses = Vec::new();
    recorded.record_during(|| responses = read_codex_completed_responses(&resource, None));

    assert!(responses.is_empty(), "{responses:?}");
    assert_eq!(recorded.counters(), [REFUSED_COUNTER]);
    assert_eq!(
        recorded.field_on(REFUSED_COUNTER, "details"),
        [format!("{{\"field\":\"{field}\"}}")]
    );
    if let Some(bad_value) = bad_value {
        let texts = recorded.texts();
        assert!(
            texts.iter().all(|text| !text.contains(bad_value)),
            "{texts:?}"
        );
    }
}

// Killed by leaving the total unread, which leaves input whole and unconfirmed, and by not passing
// the tier, which leaves the speed unset.
#[test]
fn a_response_meters_as_one_request_with_its_cached_share_taken_out_of_input() {
    let metered = first_completed_response().meter();

    assert_eq!(metered.normalized_input_tokens, 750);
    assert_eq!(metered.normalized_output_tokens, 100);
    assert_eq!(metered.containment, UsageContainment::ConfirmedSubtracted);
    assert_eq!(
        metered.request.model_id.as_ref().map(FreeFormText::as_str),
        Some("gpt-5.6-luna")
    );
    assert_eq!(
        metered.request.speed.as_ref().map(BoundedText::as_str),
        Some("priority")
    );
    assert_eq!(
        metered
            .request
            .thread_speed
            .as_ref()
            .map(BoundedText::as_str),
        Some("priority")
    );
    assert_eq!(metered.request.request_key, None);
}
