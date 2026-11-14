//! An in-process tool server for the client's tests: hand-written JSON lines over a pipe, so it can
//! answer in the 2025-11-25 shapes rmcp's own server no longer writes, stay silent, write a line
//! `serde_json` would not, or send a request of its own before it replies; each message it
//! receives is kept with the instant it arrived, and each arrival wakes the waits on the record.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::port::question::QuestionPort;
use sidekicks_provider::port::question::test_card::QuestionCard;
use sidekicks_std::port_registration::PortRegistration;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::client::McpClient;
use crate::client::connection::standing::McpStandingConnection;
use crate::client::connection::{McpConnectionScope, McpConnectionStart, McpServerConnection};
use crate::client::raw_copy::{RawLineTee, RawReplyCopy};
use crate::client::tasks::{
    McpServerEndpoint, McpTaskContact, McpTaskDispatchIdentity, McpTaskGeneration,
    McpTaskHandleObservation, McpTaskHandleSink, McpToolCall, McpToolCallEnd, McpToolCallError,
};
use crate::sign_in::address_digest::{ServerAddressDigest, ServerAddressKey};

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
    // Sent each time a message is kept, so a wait reads the record again only then.
    arrivals: watch::Sender<()>,
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

    /// Waits until `holds` reads true of the server, read again at each message it receives.
    pub(super) async fn wait_until(&self, mut holds: impl FnMut(&Self) -> bool) {
        let mut arrivals = self.arrivals.subscribe();
        while !holds(self) {
            arrivals
                .changed()
                .await
                .expect("the server keeps its sender while the test waits");
        }
    }
}

/// Waits until `contact` reads `wanted`.
pub(super) async fn wait_for_contact(
    contact: &watch::Sender<McpTaskContact>,
    wanted: McpTaskContact,
) {
    contact
        .subscribe()
        .wait_for(|read| *read == wanted)
        .await
        .expect("the test keeps the contact's sender while it waits");
}

/// A 2025-11-25 server's `initialize` result, declaring tasks on `tools/call` and `tasks/cancel`.
pub(super) fn v1_initialize_result() -> Value {
    json!({
        "protocolVersion": "2025-11-25",
        "capabilities": {
            "tools": {},
            "prompts": { "listChanged": true },
            "tasks": { "requests": { "tools": { "call": {} } }, "cancel": {} },
        },
        "serverInfo": { "name": "tracker", "version": "1.0.0" },
    })
}

/// The 2025-11-25 task `task-1` at `status`, kept 60 s and polled every 5 s.
pub(super) fn v1_task(status: &str) -> Value {
    json!({
        "taskId": "task-1",
        "status": status,
        "createdAt": "2026-10-24T12:00:00.000Z",
        "ttl": 60_000,
        "pollInterval": 5_000,
    })
}

/// A 2025-11-25 server's answer reading [`v1_task`] at `status`.
pub(super) fn v1_status_reply(status: &str) -> Reply {
    Reply::Answer(json!({ "result": v1_task(status) }))
}

/// The refusal of a method the server does not serve, `server/discover` on a 2025-11-25 server.
pub(super) fn method_not_found() -> Reply {
    Reply::Answer(json!({ "error": { "code": -32601, "message": "Method not found" } }))
}

/// Calls `call`'s tool as the tool call's dispatch does: whether the tool takes a task is read
/// first, then the call made with that answer, `connection` published as its session's live
/// connection for the call's life.
pub(super) async fn call_tool_as_dispatched(
    connection: &Arc<McpServerConnection>,
    call: McpToolCall,
    sink: &dyn McpTaskHandleSink,
    contact: &watch::Sender<McpTaskContact>,
) -> Result<McpToolCallEnd, McpToolCallError> {
    let is_task_tool = connection
        .is_task_tool(&call.dispatch.tool_name)
        .await
        .expect("the server's tools read");
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    feed.publish(Some(Arc::clone(connection)));
    connection
        .call_tool(&standing, call, is_task_tool, sink, contact)
        .await
}

/// Opens a connection of `client` to a server answering through `responder`, in a new session.
pub(super) async fn open_test_server(
    client: &McpClient,
    responder: Responder,
) -> (Arc<McpServerConnection>, TestServer) {
    let (opened, server) = start_test_server(
        test_scope(client),
        responder,
        McpConnectionStart::stdio(None, None),
    )
    .await;
    (
        Arc::new(opened.expect("the test server completes its start")),
        server,
    )
}

/// The scope of `client`'s server `tracker` in a new session.
pub(super) fn test_scope(client: &McpClient) -> McpConnectionScope {
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    client.connection_scope(
        session_id,
        FreeFormText::new("tracker".to_owned()).expect("a short server name"),
    )
}

/// The keyed digest of the server `tracker` when it is reached at an address, which a connection
/// over the test's pipe declares through [`McpConnectionStart::http`].
pub(super) fn tracker_digest() -> ServerAddressDigest {
    ServerAddressKey::of_test_fill(1)
        .digest(&McpServerAddress::new("https://tracker.example.com/mcp").expect("an address"))
}

/// Starts a server answering through `responder` and opens a connection to it in `scope`, over
/// the test's pipe whatever endpoint `start` declares.
pub(super) async fn start_test_server(
    scope: McpConnectionScope,
    mut responder: Responder,
    start: McpConnectionStart,
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
    let arrivals = watch::Sender::new(());
    let arrived = arrivals.clone();
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
                    arrived.send_replace(());
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
    let opened = McpServerConnection::open(transport, raw, scope, start).await;
    (
        opened,
        TestServer {
            received,
            arrivals,
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
        McpClient::new(
            Arc::new(questions),
            ReleaseVersion::new("0.0.0".to_owned()).expect("a release version"),
        )
        .expect("the client builds"),
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
        tool_name: "track".to_owned(),
    }
}

/// The handle `task-1` the stdio server `tracker` accepts [`track_dispatch`] under, on a server
/// of `mcp_task_generation`.
pub(super) fn track_task_handle(
    mcp_task_generation: McpTaskGeneration,
) -> McpTaskHandleObservation {
    McpTaskHandleObservation {
        dispatch: track_dispatch(),
        mcp_task_id: "task-1".to_owned(),
        mcp_task_generation,
        server_name: FreeFormText::new("tracker".to_owned()).expect("a short server name"),
        endpoint: McpServerEndpoint::stdio(),
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

/// A 2026-07-28 server declaring tasks, whose `tools/call` starts task `task-1` and whose
/// `tasks/get` answers the task's state from `state`, given the poll's number and the
/// `tasks/update` and `tasks/cancel` requests received so far.
pub(super) fn v2_task_server(
    mut state: impl FnMut(usize, usize, usize) -> Value + Send + 'static,
) -> Responder {
    let (mut polls, mut updates, mut cancels) = (0, 0, 0);
    Box::new(move |method, _params| match method {
        "server/discover" => Reply::Answer(json!({ "result": {
            "resultType": "complete",
            "supportedVersions": ["2026-07-28"],
            "capabilities": {
                "tools": {},
                "extensions": { "io.modelcontextprotocol/tasks": {} },
            },
            "ttlMs": 0,
            "cacheScope": "private",
        } })),
        "tools/call" => {
            let mut created = v2_task(&json!({ "status": "working" }));
            created["resultType"] = json!("task");
            Reply::Answer(json!({ "result": created }))
        }
        "tasks/get" => {
            polls += 1;
            let mut task = v2_task(&state(polls, updates, cancels));
            task["resultType"] = json!("complete");
            Reply::Answer(json!({ "result": task }))
        }
        "tasks/update" => {
            updates += 1;
            Reply::Answer(json!({ "result": {} }))
        }
        "tasks/cancel" => {
            cancels += 1;
            Reply::Answer(json!({ "result": {} }))
        }
        _ => method_not_found(),
    })
}

/// Task `task-1` with `state`'s status and payload members.
fn v2_task(state: &Value) -> Value {
    let mut task = json!({
        "taskId": "task-1",
        "createdAt": "2026-10-24T12:00:00Z",
        "lastUpdatedAt": "2026-10-24T12:00:00Z",
        "ttlMs": 60_000,
        "pollIntervalMs": 5_000,
    });
    task.as_object_mut()
        .expect("an object")
        .extend(state.as_object().expect("an object").clone());
    task
}

/// A task waiting on the elicitations `keys`, each asking [`board_form`].
pub(super) fn input_required(keys: &[&str]) -> Value {
    let requests: Map<String, Value> = keys
        .iter()
        .map(|key| {
            let request = json!({ "method": "elicitation/create", "params": board_form() });
            ((*key).to_owned(), request)
        })
        .collect();
    json!({ "status": "input_required", "inputRequests": requests })
}

/// Task `task-1` completed, its result [`text_result`] `tracked` inline.
pub(super) fn completed() -> Value {
    json!({ "status": "completed", "result": text_result("tracked") })
}

/// A tool result holding one line of text.
pub(super) fn text_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// The end of a call answered with [`text_result`] `tracked`.
pub(super) fn tracked_end() -> McpToolCallEnd {
    McpToolCallEnd::Answered {
        result: serde_json::from_value(text_result("tracked")).expect("an object"),
    }
}
