//! The gates a request meets before its dispatch, the order calls are admitted in, and
//! `$/cancelRequest`.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;

use super::{SESSION_TOKEN, assert_refusal, call, cancel_request, harness, lock, settle};

#[tokio::test(start_paused = true)]
async fn an_id_past_its_bound_is_refused_unechoed_and_the_connection_reads_on() {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);
    // A string id is written with its two quotes: 255 characters are 257 bytes, 254 are 256.
    let past_the_bound = "i".repeat(255);
    let at_the_bound = "i".repeat(254);

    connection
        .client
        .send(&call(past_the_bound.as_str(), "test.read", &json!({})))
        .await;
    let refusal = connection.client.answer().await;
    assert_refusal(
        &refusal,
        &Value::Null,
        -32600,
        "request.envelopeInvalid",
        "invalidArgument",
        None,
    );

    connection
        .client
        .send(&call(at_the_bound.as_str(), "test.read", &json!({})))
        .await;
    let answer = connection.client.answer().await;
    assert_eq!(answer["id"], json!(at_the_bound));
    assert_eq!(answer["result"], json!({ "method": "test.read" }));
}

#[rstest]
#[case::missing("test.read", None, Some(json!({ "reason": "missing" })))]
#[case::null(
    "test.read",
    Some(Value::Null),
    Some(json!({ "reason": "wrongType", "observedType": "null" }))
)]
#[case::array(
    "test.read",
    Some(json!([])),
    Some(json!({ "reason": "wrongType", "observedType": "object" }))
)]
#[case::not_a_date(
    "test.read",
    Some(json!("2026-5-1")),
    Some(json!({ "reason": "invalidFormat" }))
)]
#[case::exempt_handshake("connection.initialize", None, None)]
#[tokio::test(start_paused = true)]
async fn a_request_without_a_dated_protocol_version_is_refused_under_its_own_id(
    #[case] method: &str,
    #[case] protocol_version: Option<Value>,
    #[case] refused_with: Option<Value>,
) {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);
    let params = json!({
        "protocolVersion": CURRENT_PROTOCOL_VERSION,
        "sessionToken": SESSION_TOKEN,
    });
    let mut request = call(7, method, &params);
    match protocol_version {
        Some(value) => request["protocolVersion"] = value,
        None => {
            request
                .as_object_mut()
                .expect("a request is an object")
                .remove("protocolVersion");
        }
    }

    connection.client.send(&request).await;
    let answer = connection.client.answer().await;
    match refused_with {
        Some(fields) => {
            assert_refusal(
                &answer,
                &json!(7),
                -32600,
                "request.protocolVersion.invalid",
                "invalidArgument",
                Some(&fields),
            );
            assert!(!answer.to_string().contains("2026-5-1"), "{answer}");
        }
        None => assert_ne!(
            answer["error"]["data"]["type"],
            json!("request.protocolVersion.invalid"),
            "{answer}"
        ),
    }
}

#[tokio::test(start_paused = true)]
async fn a_canceled_call_answers_once_and_a_cancel_after_its_answer_is_ignored() {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);

    connection
        .client
        .send(&call(1, "test.wait", &json!({})))
        .await;
    settle().await;
    connection.client.send(&cancel_request(1)).await;
    let canceled = connection.client.answer().await;
    assert_refusal(
        &canceled,
        &json!(1),
        -32800,
        "request.canceled",
        "canceled",
        None,
    );

    // Each later answer is the next call's: a cancel of an answered id sends nothing.
    connection
        .client
        .send_all(&[cancel_request(1), call(2, "test.read", &json!({}))])
        .await;
    assert_eq!(connection.client.answer().await["id"], json!(2));
    connection
        .client
        .send_all(&[cancel_request(2), call(3, "test.read", &json!({}))])
        .await;
    assert_eq!(connection.client.answer().await["id"], json!(3));
}

#[tokio::test(start_paused = true)]
async fn an_ordered_call_is_admitted_before_the_next_message_is_read() {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);

    // Both arrive in one read: the cancel finds the write admitted already, so the mutation runs to
    // its answer; admitted later, it would find its call canceled and never admit it.
    connection
        .client
        .send_all(&[call(1, "test.write", &json!({})), cancel_request(1)])
        .await;
    let answer = connection.client.answer().await;
    assert_eq!(answer["result"], json!({}), "{answer}");
    assert_eq!(*lock(&harness.admitted), ["test.write"]);
}
