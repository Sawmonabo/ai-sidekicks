//! An in-process tool server for the client's tests: hand-written JSON lines over a pipe, so it can
//! answer in the 2025-11-25 shapes rmcp's own server no longer writes, stay silent, write a line
//! `serde_json` would not, or send a request of its own before it replies; each message it
//! receives is kept with the instant it arrived.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::port::question::QuestionPort;
use sidekicks_provider::port::question::test_card::QuestionCard;
use sidekicks_provider::port::registration::PortRegistration;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::client::McpClient;
use crate::client::connection::{McpConnectionScope, McpServerConnection};
use crate::client::raw_copy::{RawLineTee, RawReplyCopy};
use crate::client::stdio::StdioProcess;
use crate::client::tasks::{
    McpTaskContact, McpTaskDispatchIdentity, McpTaskHandleObservation, McpTaskHandleSink,
    McpToolCall,
};

/// What the server does with one request.
pub(super) enum Reply {
    /// Answers with this `result` or `error` member.
    Answer(Value),
    /// Never answers.
    Silent,
    /// Writes this line as it stands, `{id}` replaced by the request's id.
    Raw(String),
    /// Sends `request` of its own first, and answers with `then` once the client answered it.
    AskFirst {
        /// The server's request, its `id` set by the server.
        request: Value,
        /// The reply's `result` or `error` member.
        then: Value,
    },
    /// Sends `request` of its own and never answers, the client's answer to it included.
    AskThenSilent {
        /// The server's request, its `id` set by the server.
        request: Value,
    },
}

/// What the server does with a request, by method and params.
pub(super) type Responder = Box<dyn FnMut(&str, &Value) -> Reply + Send>;

/// The server's side: each message it received, and a sender of lines it writes unasked.
pub(super) struct TestServer {
    pub(super) received: Arc<Mutex<Vec<(Instant, Value)>>>,
    pub(super) unasked: mpsc::UnboundedSender<String>,
    pub(super) session_id: SessionId,
}

impl TestServer {
    /// Each request of `method` received, in order, with its instant.
    pub(super) fn requests(&self, method: &str) -> Vec<(Instant, Value)> {
        self.received
            .lock()
            .expect("the test's record is never poisoned")
            .iter()
            .filter(|(_, message)| message["method"] == method)
            .cloned()
            .collect()
    }

    /// The client's answer to the server's request `id`, once it arrived.
    pub(super) fn answer_to(&self, id: &str) -> Option<Value> {
        self.received
            .lock()
            .expect("the test's record is never poisoned")
            .iter()
            .find(|(_, message)| message["id"] == id && message.get("method").is_none())
            .map(|(_, message)| message.clone())
    }
}

/// A 2025-11-25 server's `initialize` result, declaring tasks on `tools/call`.
pub(super) fn v1_initialize_result() -> Value {
    json!({
        "protocolVersion": "2025-11-25",
        "capabilities": {
            "tools": {},
            "prompts": { "listChanged": true },
            "tasks": { "requests": { "tools": { "call": {} } } },
        },
        "serverInfo": { "name": "tracker", "version": "1.0.0" },
    })
}

/// The refusal of a method the server does not serve, `server/discover` on a 2025-11-25 server.
pub(super) fn method_not_found() -> Reply {
    Reply::Answer(json!({ "error": { "code": -32601, "message": "Method not found" } }))
}

/// Opens a connection of `client` to a server answering through `responder`, in a new session.
pub(super) async fn open_test_server(
    client: &McpClient,
    responder: Responder,
) -> (McpServerConnection, TestServer) {
    let (opened, server) = start_test_server(test_scope(client), responder, None).await;
    (opened.expect("the test server completes its start"), server)
}

/// The scope of `client`'s server `tracker` in a new session.
pub(super) fn test_scope(client: &McpClient) -> McpConnectionScope {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    client.connection_scope(
        session_id,
        FreeFormText::new("tracker".to_owned()).expect("a short server name"),
    )
}

/// Starts a server answering through `responder` and opens a connection to it in `scope`,
/// holding `process` for the connection's life.
pub(super) async fn start_test_server(
    scope: McpConnectionScope,
    mut responder: Responder,
    process: Option<StdioProcess>,
) -> (
    Result<McpServerConnection, crate::client::connection::McpConnectionError>,
    TestServer,
) {
    let (client_end, server_end) = tokio::io::duplex(1 << 16);
    let (client_read, client_write) = tokio::io::split(client_end);
    let (server_read, mut server_write) = tokio::io::split(server_end);
    let received = Arc::new(Mutex::new(Vec::new()));
    let (unasked, mut unasked_lines) = mpsc::unbounded_channel::<String>();
    let kept = Arc::clone(&received);
    tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        // The replies held until the client answers the server's own request, by its id.
        let mut held: HashMap<String, (Value, Value)> = HashMap::new();
        let mut next_request = 0;
        loop {
            let written = tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { return };
                    let message: Value =
                        serde_json::from_str(&line).expect("the client writes JSON");
                    kept.lock().expect("never poisoned").push((Instant::now(), message.clone()));
                    let Some(id) = message.get("id").cloned() else { continue };
                    let Some(method) = message.get("method").and_then(Value::as_str) else {
                        // The client's answer to the server's own request releases the held reply.
                        let released = id.as_str().and_then(|id| held.remove(id));
                        if let Some((client_id, then)) = released {
                            let reply = reply_line(then, &client_id);
                            write_lines(&mut server_write, vec![reply]).await;
                        }
                        continue;
                    };
                    match responder(method, &message["params"]) {
                        Reply::Answer(reply) => vec![reply_line(reply, &id)],
                        Reply::Silent => continue,
                        Reply::Raw(line) => vec![line.replace("{id}", &id.to_string())],
                        Reply::AskFirst { mut request, then } => {
                            next_request += 1;
                            let request_id = format!("server-{next_request}");
                            request["jsonrpc"] = json!("2.0");
                            request["id"] = json!(request_id);
                            held.insert(request_id, (id, then));
                            vec![request.to_string()]
                        }
                        Reply::AskThenSilent { mut request } => {
                            next_request += 1;
                            request["jsonrpc"] = json!("2.0");
                            request["id"] = json!(format!("server-{next_request}"));
                            vec![request.to_string()]
                        }
                    }
                }
                Some(line) = unasked_lines.recv() => vec![line],
            };
            if !write_lines(&mut server_write, written).await {
                return;
            }
        }
    });
    let session_id = scope.session_id;
    let raw = RawReplyCopy::default();
    let transport = rmcp::transport::async_rw::AsyncRwTransport::new_client(
        RawLineTee::new(client_read, raw.clone()),
        client_write,
    );
    let opened = McpServerConnection::open(
        transport,
        raw,
        scope,
        crate::client::connection::McpConnectionStart::stdio(None, process),
    )
    .await;
    (
        opened,
        TestServer {
            received,
            unasked,
            session_id,
        },
    )
}

// Writes each line with its newline; false once the client's end is gone.
async fn write_lines(writer: &mut (impl AsyncWriteExt + Unpin), lines: Vec<String>) -> bool {
    for mut text in lines {
        text.push('\n');
        if writer.write_all(text.as_bytes()).await.is_err() {
            return false;
        }
    }
    true
}

// The reply line answering request `id` with `reply`'s `result` or `error` member.
fn reply_line(mut reply: Value, id: &Value) -> String {
    reply["jsonrpc"] = json!("2.0");
    reply["id"] = id.clone();
    reply.to_string()
}

/// A client whose questions card is `card`.
pub(super) fn test_client() -> (McpClient, Arc<QuestionCard>) {
    let card = Arc::new(QuestionCard::default());
    let questions = PortRegistration::new("questions");
    let port: Arc<dyn QuestionPort> = card.clone();
    questions
        .register(port)
        .expect("a new registration takes its port");
    (
        McpClient::new(Arc::new(questions)).expect("the client builds"),
        card,
    )
}

/// A sink that keeps each handle with how many `tasks/get` the server had received by then.
pub(super) struct CountingSink {
    received: Arc<Mutex<Vec<(Instant, Value)>>>,
    recorded: Mutex<Vec<(usize, McpTaskHandleObservation)>>,
}

impl CountingSink {
    /// A sink counting the polls `server` received.
    pub(super) fn new(server: &TestServer) -> Self {
        Self {
            received: Arc::clone(&server.received),
            recorded: Mutex::new(Vec::new()),
        }
    }

    /// Each handle recorded, with the polls received before it.
    pub(super) fn recorded(&self) -> Vec<(usize, McpTaskHandleObservation)> {
        self.recorded.lock().expect("never poisoned").clone()
    }
}

impl McpTaskHandleSink for CountingSink {
    fn record(&self, observation: McpTaskHandleObservation) -> BoxFuture<'_, ()> {
        let polls = self
            .received
            .lock()
            .expect("never poisoned")
            .iter()
            .filter(|(_, message)| message["method"] == "tasks/get")
            .count();
        self.recorded
            .lock()
            .expect("never poisoned")
            .push((polls, observation));
        async {}.boxed()
    }
}

/// A call of the `track` tool on the `tracker` server, made by a new run.
pub(super) fn track_call() -> McpToolCall {
    McpToolCall {
        dispatch: track_dispatch(),
        arguments: None,
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
    }
}

/// The dispatch [`track_call`] makes.
pub(super) fn track_dispatch() -> McpTaskDispatchIdentity {
    McpTaskDispatchIdentity {
        command_id: "command-1".to_owned(),
        server_name: "tracker".to_owned(),
        tool_name: "track".to_owned(),
    }
}

/// A contact state for a call to publish into.
pub(super) fn contact() -> watch::Sender<McpTaskContact> {
    watch::Sender::new(McpTaskContact::Reached)
}

/// An elicitation form asking which board, with one text field.
pub(super) fn board_form() -> Value {
    json!({
        "mode": "form",
        "message": "Which board?",
        "requestedSchema": {
            "type": "object",
            "properties": { "board": { "type": "string" } },
            "required": ["board"],
        },
    })
}

/// The person's answer to [`board_form`]: the board `Roadmap`.
pub(super) fn board_answer() -> Vec<QuestionAnswer> {
    vec![QuestionAnswer::Typed {
        text: NonEmptyText::new("Roadmap".to_owned()).expect("a non-empty answer"),
    }]
}

/// What the server receives for [`board_answer`].
pub(super) fn board_accepted() -> Value {
    json!({ "action": "accept", "content": { "board": "Roadmap" } })
}

/// A tool result holding one line of text.
pub(super) fn text_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}
