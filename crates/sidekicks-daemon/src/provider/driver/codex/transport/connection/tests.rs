use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::poll;
use rstest::rstest;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use tokio::sync::Notify;

use super::scripted_service::{ScriptedService, connect_scripted_service};
use super::{
    CODEX_REQUEST_TIMEOUT, CodexAppServerConnection, CodexConnectionEvents,
    CodexConnectionHandlers, CodexForgottenRequest,
};
use crate::provider::driver::codex::server_requests::{
    CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON, CodexAskKind, CodexInboundServerRequest,
    CodexRoutedMethod, CodexServerRequestAnswer, CodexServerRequestDecision,
    CodexServerRequestResponder, compose_unrouted_request_error,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::error_causes::RequestUnanswered;

#[derive(Default)]
struct RecordedEvents {
    dropped: Mutex<Vec<String>>,
    held_requests_dropped: Mutex<Vec<CodexForgottenRequest>>,
}

impl CodexConnectionEvents for RecordedEvents {
    fn notification(&self, _method: &str, _params: Box<RawValue>) {}

    fn dropped(&self, reason: &str) {
        self.dropped
            .lock()
            .expect("no test thread panicked")
            .push(reason.to_owned());
    }

    fn held_requests_dropped(&self, dropped: Vec<CodexForgottenRequest>) {
        self.held_requests_dropped
            .lock()
            .expect("no test thread panicked")
            .extend(dropped);
    }

    fn service_draining(&self, _message: &str) {}
}

enum TestResponder {
    // Holds every ask, notifying once it is held.
    Hold(Arc<Notify>),
    // Allows every tool call with one text item.
    AllowToolCall(String),
    // Fails every ask.
    Fail,
}

impl CodexServerRequestResponder for TestResponder {
    fn answer(
        &self,
        _request: CodexInboundServerRequest,
    ) -> BoxFuture<'static, Result<CodexServerRequestDecision, DriverError>> {
        let decision = match self {
            Self::Hold(held) => {
                let held = Arc::clone(held);
                Ok(CodexServerRequestDecision::Held {
                    on_held: Some(Box::new(move || held.notify_one())),
                })
            }
            Self::AllowToolCall(text) => {
                let payload: Map<String, Value> = serde_json::from_value(
                    json!({ "contentItems": [{ "type": "inputText", "text": text }] }),
                )
                .expect("the payload is an object");
                Ok(CodexServerRequestDecision::Answer(
                    CodexServerRequestAnswer::Allow {
                        is_for_session: false,
                        payload: Some(payload),
                    },
                ))
            }
            Self::Fail => Err(DriverError::Internal("the responder failed".into())),
        };
        Box::pin(async move { decision })
    }
}

fn connect(
    limit: usize,
    responder: Option<Arc<dyn CodexServerRequestResponder>>,
) -> (
    CodexAppServerConnection,
    ScriptedService,
    Arc<RecordedEvents>,
) {
    let events = Arc::new(RecordedEvents::default());
    let (connection, service) = connect_scripted_service(
        limit,
        CodexConnectionHandlers {
            events: Arc::clone(&events) as Arc<dyn CodexConnectionEvents>,
            responder,
        },
    );
    (connection, service, events)
}

// Where a request's end falls, against the write.
#[derive(Clone, Copy, Debug)]
enum RequestEnd {
    DeadlinePassed,
    ClosedAfterSending,
    ClosedBeforeSending,
}

// Kills: a post-write close mapped back to `Transport`, which a caller would send again blind, and
// a pre-write failure read as `Unanswered`, which would keep a request nothing received.
#[rstest]
#[case::deadline(RequestEnd::DeadlinePassed, Some(RefusalCode::ProviderTimeout))]
#[case::closed_after(RequestEnd::ClosedAfterSending, Some(RefusalCode::ProviderUnavailable))]
#[case::closed_before(RequestEnd::ClosedBeforeSending, None)]
#[tokio::test(start_paused = true)]
async fn a_request_whose_link_closes_after_the_write_is_unanswered(
    #[case] end: RequestEnd,
    #[case] unanswered_code: Option<RefusalCode>,
) {
    let (connection, mut service, _events) = connect(usize::MAX, None);
    let params = json!({});
    if matches!(end, RequestEnd::ClosedBeforeSending) {
        connection.close().await.expect("the close is sent");
    }

    let request = connection.request("thread/read", &params);
    tokio::pin!(request);
    let first_poll = poll!(request.as_mut());
    let is_pending = first_poll.is_pending();
    match end {
        RequestEnd::DeadlinePassed => {
            tokio::time::advance(CODEX_REQUEST_TIMEOUT.saturating_sub(Duration::from_millis(1)))
                .await;
            assert!(poll!(request.as_mut()).is_pending());
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        RequestEnd::ClosedAfterSending => {
            service.next_sent().await;
            service.close("the service ended");
        }
        RequestEnd::ClosedBeforeSending => {}
    }
    let outcome = match first_poll {
        Poll::Ready(outcome) => outcome,
        Poll::Pending => request.await,
    };
    let error = outcome.expect_err("no answer came");

    assert_eq!(is_pending, !matches!(end, RequestEnd::ClosedBeforeSending));
    match (unanswered_code, &error) {
        (Some(_), CodexError::Unanswered { method, .. }) => assert_eq!(method, "thread/read"),
        (None, CodexError::Transport { .. }) => {}
        (_, other) => panic!("the request ended as {other:?}"),
    }
    match (unanswered_code, DriverError::from(error)) {
        (Some(code), DriverError::Unanswered(RequestUnanswered { refusal })) => {
            assert_eq!(refusal.code, code);
        }
        (None, DriverError::Refused(refusal)) => {
            assert_eq!(refusal.code, RefusalCode::ProviderUnavailable);
        }
        (_, other) => panic!("the driver error is {other:?}"),
    }
}

// Kills: the overloaded or draining answer left on the `Internal` arm, or the connection closed on
// either, which would cut the session's running turns.
#[rstest]
#[case::overloaded(
    json!({ "code": -32001, "message": "Server overloaded; retry later." }),
    Some("Server overloaded; retry later.")
)]
#[case::draining(
    json!({
        "code": -32600,
        "message": "Server is draining; retry after reconnecting",
        "data": { "reason": "serverShuttingDown" },
    }),
    Some("Server is draining; retry after reconnecting")
)]
#[case::refused(json!({ "code": -32600, "message": "missing field `threadId`" }), None)]
#[tokio::test]
async fn overloaded_and_draining_answers_refuse_the_request_and_keep_the_connection(
    #[case] answer: Value,
    #[case] unavailable_words: Option<&str>,
) {
    let (connection, mut service, events) = connect(usize::MAX, None);
    let params = json!({});

    let refused = connection.request("turn/start", &params);
    tokio::pin!(refused);
    assert!(poll!(refused.as_mut()).is_pending());
    let request = service.next_sent().await;
    service.send(&json!({ "jsonrpc": "2.0", "id": request["id"], "error": answer }));
    let error = refused.await.expect_err("the service refused the request");
    let is_draining = error.is_service_draining();
    let driver_error = DriverError::from(error);

    let answered = connection.request("thread/read", &params);
    tokio::pin!(answered);
    assert!(poll!(answered.as_mut()).is_pending());
    let request = service.next_sent().await;
    service.answer(&request, &json!({ "thread": "t" }));
    let reply = answered.await.expect("the same connection still answers");

    assert_eq!(reply.get(), r#"{"thread":"t"}"#);
    assert!(
        events
            .dropped
            .lock()
            .expect("no test thread panicked")
            .is_empty()
    );
    assert_eq!(
        is_draining,
        answer["data"]["reason"] == "serverShuttingDown"
    );
    match (unavailable_words, driver_error) {
        (Some(words), DriverError::Refused(refusal)) => {
            assert_eq!(refusal.code, RefusalCode::ProviderUnavailable);
            let detail = refusal.detail.expect("the refusal carries its detail");
            let carried = detail["providerFailureDetail"]
                .as_str()
                .expect("the detail is text");
            assert!(carried.contains(words), "{carried}");
        }
        (None, DriverError::Internal(_)) => {}
        (_, other) => panic!("the driver error is {other:?}"),
    }
}

// On a paused clock a request the close did not fail would end at its deadline instead.
#[tokio::test(start_paused = true)]
async fn a_dropped_socket_fails_every_pending_request_and_withdraws_the_held_asks() {
    let held = Arc::new(Notify::new());
    let (connection, service, events) = connect(
        usize::MAX,
        Some(Arc::new(TestResponder::Hold(Arc::clone(&held)))),
    );
    service.send(&json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "item/commandExecution/requestApproval",
        "params": { "threadId": "thread-1", "turnId": "turn-1" },
    }));
    held.notified().await;

    let params = json!({});
    let first = connection.request("thread/read", &params);
    let second = connection.request("turn/start", &params);
    tokio::pin!(first, second);
    assert!(poll!(first.as_mut()).is_pending());
    assert!(poll!(second.as_mut()).is_pending());
    service.close("the service ended");

    for outcome in [first.await, second.await] {
        assert!(
            matches!(outcome, Err(CodexError::Unanswered { .. })),
            "{outcome:?}"
        );
    }
    assert_eq!(
        *events.dropped.lock().expect("no test thread panicked"),
        ["the service ended"]
    );
    assert_eq!(
        *events
            .held_requests_dropped
            .lock()
            .expect("no test thread panicked"),
        [CodexForgottenRequest {
            request_id: "7".to_owned(),
            ask_kind: CodexAskKind::Approval,
            thread_id: Some("thread-1".to_owned()),
        }]
    );
}

// No answer can be read as consent: an unknown method gets `-32601`, and a routed ask with no
// responder or a failing one its own refusal.
#[rstest]
#[case::outside_the_table(
    "currentTime/read",
    None,
    json!({ "jsonrpc": "2.0", "id": "ask-1", "error": compose_unrouted_request_error() })
)]
#[case::routed_without_a_responder(
    "item/fileChange/requestApproval",
    None,
    json!({ "jsonrpc": "2.0", "id": "ask-1", "result": { "decision": "decline" } })
)]
#[case::routed_to_a_failing_responder(
    "item/fileChange/requestApproval",
    Some(TestResponder::Fail),
    json!({ "jsonrpc": "2.0", "id": "ask-1", "result": { "decision": "decline" } })
)]
#[tokio::test]
async fn a_server_request_nothing_decides_is_refused(
    #[case] method: &str,
    #[case] responder: Option<TestResponder>,
    #[case] expected: Value,
) {
    let responder =
        responder.map(|responder| Arc::new(responder) as Arc<dyn CodexServerRequestResponder>);
    let (_connection, mut service, _events) = connect(usize::MAX, responder);

    service.send(&json!({
        "jsonrpc": "2.0",
        "id": "ask-1",
        "method": method,
        "params": { "threadId": "thread-1", "turnId": "turn-1" },
    }));

    assert_eq!(service.next_sent().await, expected);
}

#[tokio::test]
async fn an_answer_past_the_limit_is_refused_and_a_refusal_past_it_sends_nothing() {
    let responder = TestResponder::AllowToolCall("x".repeat(400));
    let (_connection, mut service, _events) = connect(300, Some(Arc::new(responder)));

    service.send(&json!({ "jsonrpc": "2.0", "id": 1, "method": "item/tool/call", "params": {} }));
    assert_eq!(
        service.next_sent().await,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": CodexRoutedMethod::ToolCall
                .compose_refused_result(CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON),
        })
    );

    let long_id = "i".repeat(300);
    service.send(&json!({ "jsonrpc": "2.0", "id": long_id, "method": "item/tool/call" }));
    service.send(&json!({ "jsonrpc": "2.0", "id": 2, "method": "currentTime/read" }));
    assert_eq!(service.next_sent().await["id"], json!(2));
    assert!(service.sent.try_recv().is_err(), "nothing else was sent");
}
