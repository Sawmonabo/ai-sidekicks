use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::poll;
use rstest::rstest;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::tungstenite::Bytes;

use super::{
    CODEX_REQUEST_TIMEOUT, CodexAppServerConnection, CodexConnectionEvents,
    CodexConnectionHandlers, CodexForgottenRequest, ServiceMessageReader, ServiceMessageWriter,
};
use crate::provider::driver::codex::server_requests::{
    CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON, CodexAskKind, CodexInboundServerRequest,
    CodexRoutedMethod, CodexServerRequestAnswer, CodexServerRequestDecision,
    CodexServerRequestResponder, compose_unrouted_request_error,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::socket::CodexSocketEvent;
use crate::provider::driver::contract::DriverError;

// The connection's socket as the test drives it: what the connection sent arrives on `sent`, and
// what the service sends goes in through `inbound`.
struct ScriptedService {
    sent: mpsc::UnboundedReceiver<String>,
    inbound: mpsc::UnboundedSender<CodexSocketEvent>,
}

impl ScriptedService {
    async fn next_sent(&mut self) -> Value {
        let text = self
            .sent
            .recv()
            .await
            .expect("the connection sent a message");
        serde_json::from_str(&text).expect("the connection sends JSON")
    }

    fn send(&self, message: &Value) {
        self.inbound
            .send(CodexSocketEvent::Message(Bytes::from(message.to_string())))
            .expect("the connection reads");
    }

    fn close(&self, reason: &str) {
        self.inbound
            .send(CodexSocketEvent::Closed {
                reason: reason.to_owned(),
            })
            .expect("the connection reads");
    }
}

struct ScriptedWriter {
    sent: mpsc::UnboundedSender<String>,
    limit: Option<usize>,
}

impl ServiceMessageWriter for ScriptedWriter {
    fn sent_message_byte_limit(&self) -> Option<usize> {
        self.limit
    }

    fn send_text<'call>(
        &'call mut self,
        _method: &'call str,
        text: String,
    ) -> BoxFuture<'call, Result<(), CodexError>> {
        Box::pin(async move {
            self.sent.send(text).map_err(|error| CodexError::Transport {
                detail: "the test's service stopped reading".to_owned(),
                cause: Some(Box::new(error)),
            })
        })
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), CodexError>> {
        Box::pin(async { Ok(()) })
    }
}

struct ScriptedReader {
    inbound: mpsc::UnboundedReceiver<CodexSocketEvent>,
}

impl ServiceMessageReader for ScriptedReader {
    fn receive(&mut self) -> BoxFuture<'_, Result<CodexSocketEvent, CodexError>> {
        Box::pin(async move {
            Ok(self
                .inbound
                .recv()
                .await
                .unwrap_or_else(|| CodexSocketEvent::Closed {
                    reason: "the test ended".to_owned(),
                }))
        })
    }
}

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
    ) -> BoxFuture<'_, Result<CodexServerRequestDecision, DriverError>> {
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
    limit: Option<usize>,
    responder: Option<Arc<dyn CodexServerRequestResponder>>,
) -> (
    CodexAppServerConnection,
    ScriptedService,
    Arc<RecordedEvents>,
) {
    let (sent_sender, sent) = mpsc::unbounded_channel();
    let (inbound, inbound_receiver) = mpsc::unbounded_channel();
    let events = Arc::new(RecordedEvents::default());
    let connection = CodexAppServerConnection::start(
        Box::new(ScriptedWriter {
            sent: sent_sender,
            limit,
        }),
        Box::new(ScriptedReader {
            inbound: inbound_receiver,
        }),
        CodexConnectionHandlers {
            events: Arc::clone(&events) as Arc<dyn CodexConnectionEvents>,
            responder,
        },
    );
    (connection, ScriptedService { sent, inbound }, events)
}

#[tokio::test(start_paused = true)]
async fn a_request_fails_at_its_deadline_and_an_answer_before_it_settles_it() {
    let (connection, mut service, _events) = connect(None, None);
    let params = json!({});

    let unanswered = connection.request("thread/read", &params);
    tokio::pin!(unanswered);
    assert!(poll!(unanswered.as_mut()).is_pending());
    tokio::time::advance(CODEX_REQUEST_TIMEOUT - Duration::from_millis(1)).await;
    assert!(poll!(unanswered.as_mut()).is_pending());
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(matches!(
        unanswered.await,
        Err(CodexError::RequestTimeout { timeout, .. }) if timeout == CODEX_REQUEST_TIMEOUT
    ));
    // The unanswered request's message.
    service.next_sent().await;

    let answered = connection.request("thread/read", &params);
    tokio::pin!(answered);
    assert!(poll!(answered.as_mut()).is_pending());
    let request = service.next_sent().await;
    service.send(&json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "thread": "t" } }));
    let reply = answered.await.expect("the answer settles the request");
    assert_eq!(reply.get(), r#"{"thread":"t"}"#);

    let refused = connection.request("thread/fork", &params);
    tokio::pin!(refused);
    assert!(poll!(refused.as_mut()).is_pending());
    let request = service.next_sent().await;
    service.send(&json!({
        "jsonrpc": "2.0",
        "id": request["id"],
        "error": { "code": -32600, "message": "missing field `threadId`" },
    }));
    assert!(matches!(
        refused.await,
        Err(CodexError::ProviderRequest { method, code: -32600, message })
            if method == "thread/fork" && message == "missing field `threadId`"
    ));
}

// On a paused clock a request the close did not fail would end at its deadline instead.
#[tokio::test(start_paused = true)]
async fn a_dropped_socket_fails_every_pending_request_and_withdraws_the_held_asks() {
    let held = Arc::new(Notify::new());
    let (connection, service, events) =
        connect(None, Some(Arc::new(TestResponder::Hold(Arc::clone(&held)))));
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
            matches!(outcome, Err(CodexError::Transport { .. })),
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
    let (_connection, mut service, _events) = connect(None, responder);

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
    let (_connection, mut service, _events) = connect(Some(300), Some(Arc::new(responder)));

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
