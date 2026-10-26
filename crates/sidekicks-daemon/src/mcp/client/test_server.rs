//! An in-process tool server for the client's tests: hand-written JSON lines over a pipe, so it can
//! answer in the 2025-11-25 shapes rmcp's own server no longer writes, stay silent, write a line
//! `serde_json` would not, or send a request of its own before it replies; each message it
//! receives is kept with the instant it arrived. Beside it, a questions card that takes one open
//! question per run at a time, as a run waiting on one does, keeps the rest waiting for their run
//! until it reads running again, and can hold back its takes' outcomes and its withdrawals.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_contracts::question::{QuestionAnswer, QuestionAskedState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc, watch};
use tokio::time::{Duration, Instant, timeout};

use crate::mcp::client::McpClient;
use crate::mcp::client::connection::{McpConnectionScope, McpServerConnection};
use crate::mcp::client::raw_copy::{RawLineTee, RawReplyCopy};
use crate::mcp::client::stdio::StdioProcess;
use crate::mcp::client::tasks::{
    McpTaskContact, McpTaskDispatchIdentity, McpTaskHandleObservation, McpTaskHandleSink,
    McpToolCall,
};
use crate::provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionPort, ToolServerQuestionAnswer,
    WaitingQuestionOpening,
};
use crate::provider::port::registration::PortRegistration;

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
    Result<McpServerConnection, crate::mcp::client::connection::McpConnectionError>,
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
        crate::mcp::client::connection::McpConnectionStart::stdio(None, process),
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

/// One question on the card with its answerer.
type CardQuestion = (ProviderQuestion, Arc<dyn ToolServerQuestionAnswer>);

/// A questions card that holds one open question per run, as a run waiting on one refuses a
/// second, its run reading running again once none is open: each question opened, those still
/// open with their answerers until answered or withdrawn, and those waiting for their run.
#[derive(Default)]
pub(super) struct QuestionCard {
    taken: Mutex<Vec<ProviderQuestion>>,
    open: Mutex<Vec<CardQuestion>>,
    waiting: Mutex<Vec<CardQuestion>>,
    asked: Notify,
    /// Notified whenever an open question is answered or withdrawn, as its run reads running.
    closed: Notify,
    take_gate: Mutex<Option<Arc<Notify>>>,
    withdraw_gate: Mutex<Option<Arc<Notify>>>,
}

impl QuestionCard {
    /// Every question the card opened, in order.
    pub(super) fn taken(&self) -> Vec<ProviderQuestion> {
        self.taken.lock().expect("never poisoned").clone()
    }

    /// The questions on the card waiting for their run, in the order they came.
    pub(super) fn waiting(&self) -> Vec<ProviderQuestion> {
        self.waiting
            .lock()
            .expect("never poisoned")
            .iter()
            .map(|(question, _)| question.clone())
            .collect()
    }

    // Opens `question` with `answer`; the open list's lock is held by the caller.
    fn open_question(
        &self,
        open: &mut Vec<CardQuestion>,
        question: ProviderQuestion,
        answer: Arc<dyn ToolServerQuestionAnswer>,
    ) {
        self.taken
            .lock()
            .expect("never poisoned")
            .push(question.clone());
        open.push((question, answer));
        self.asked.notify_waiters();
    }

    // Whether `run_id` has a question open, so the run does not read running.
    fn is_waiting_on_question(open: &[CardQuestion], run_id: RunId) -> bool {
        open.iter().any(|(held, _)| held.run_id == run_id)
    }

    /// Waits until no question is open, as once every one was answered or withdrawn; fails the
    /// test past 60 s.
    pub(super) async fn wait_until_none_open(&self) {
        let none_open = async {
            while !self.open.lock().expect("never poisoned").is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), none_open)
            .await
            .expect("every question is answered or withdrawn");
    }

    /// Waits until the card took `count` questions; fails the test past 60 s.
    pub(super) async fn wait_until_taken(&self, count: usize) {
        let taken = async {
            while self.taken().len() < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), taken)
            .await
            .expect("the card takes the questions");
    }

    /// Waits until `count` questions wait for their run on the card; fails the test past 60 s.
    pub(super) async fn wait_until_waiting(&self, count: usize) {
        let waiting = async {
            while self.waiting().len() < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), waiting)
            .await
            .expect("the card holds the questions waiting for their run");
    }

    /// Waits until no question waits for its run on the card, as once each was opened or
    /// withdrawn; fails the test past 60 s.
    pub(super) async fn wait_until_none_waiting(&self) {
        let none_waiting = async {
            while !self.waiting().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(60), none_waiting)
            .await
            .expect("no question waits for its run");
    }

    /// Holds back the outcome of each later take until the returned gate is notified, the question
    /// already on the card, as a take whose write is enqueued before it answers.
    pub(super) fn hold_takes(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.take_gate.lock().expect("never poisoned") = Some(Arc::clone(&gate));
        gate
    }

    /// Holds back each later withdrawal until the returned gate is notified, the question still
    /// open, as a withdrawal whose write waits behind another.
    pub(super) fn hold_withdrawals(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.withdraw_gate.lock().expect("never poisoned") = Some(Arc::clone(&gate));
        gate
    }

    /// Waits for an open question, answers the oldest with `answers` through its answerer and
    /// closes it.
    pub(super) async fn answer_open(&self, answers: Vec<QuestionAnswer>) -> ProviderQuestion {
        loop {
            let asked = self.asked.notified();
            let open = {
                let mut open = self.open.lock().expect("never poisoned");
                (!open.is_empty()).then(|| open.remove(0))
            };
            if let Some((question, answer)) = open {
                answer.answer(answers).await.expect("the answer is sent");
                self.closed.notify_waiters();
                return question;
            }
            asked.await;
        }
    }
}

impl QuestionPort for QuestionCard {
    fn take_tool_server_question(
        &self,
        question: ProviderQuestion,
        answer: Arc<dyn ToolServerQuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let taken = {
            let mut open = self.open.lock().expect("never poisoned");
            if Self::is_waiting_on_question(&open, question.run_id) {
                Err("the run already waits on a question".into())
            } else {
                self.open_question(&mut open, question, answer);
                Ok(())
            }
        };
        let gate = self.take_gate.lock().expect("never poisoned").clone();
        async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            taken
        }
        .boxed()
    }

    fn record_question_in_turn(
        &self,
        question: ProviderQuestion,
        answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
        may_open: bool,
    ) -> BoxFuture<'_, Result<QuestionAskedState, Box<dyn Error + Send + Sync>>> {
        let Some(answer) = answer else {
            return async { Err("the tool-server client asks no driver question".into()) }.boxed();
        };
        let taking = {
            let mut open = self.open.lock().expect("never poisoned");
            if may_open && !Self::is_waiting_on_question(&open, question.run_id) {
                self.open_question(&mut open, question, answer);
                QuestionAskedState::Open
            } else {
                self.waiting
                    .lock()
                    .expect("never poisoned")
                    .push((question, answer));
                QuestionAskedState::WaitingForRun
            }
        };
        let gate = self.take_gate.lock().expect("never poisoned").clone();
        async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            Ok(taking)
        }
        .boxed()
    }

    fn open_waiting_question(
        &self,
        _session_id: SessionId,
        request_id: String,
    ) -> BoxFuture<'_, Result<WaitingQuestionOpening, Box<dyn Error + Send + Sync>>> {
        let opening = {
            let mut open = self.open.lock().expect("never poisoned");
            let mut waiting = self.waiting.lock().expect("never poisoned");
            match waiting
                .iter()
                .position(|(held, _)| held.request_id == request_id)
            {
                None => WaitingQuestionOpening::Settled,
                Some(place) if Self::is_waiting_on_question(&open, waiting[place].0.run_id) => {
                    WaitingQuestionOpening::RunNotRunning
                }
                Some(place) => {
                    let (question, answer) = waiting.remove(place);
                    self.open_question(&mut open, question, answer);
                    WaitingQuestionOpening::Opened
                }
            }
        };
        async move { Ok(opening) }.boxed()
    }

    fn wait_until_running(
        &self,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let mut closed = std::pin::pin!(self.closed.notified());
            closed.as_mut().enable();
            if Self::is_waiting_on_question(&self.open.lock().expect("never poisoned"), run_id) {
                closed.await;
            }
            Ok(())
        }
        .boxed()
    }

    fn withdraw_question(
        &self,
        withdrawal: ProviderQuestionWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let gate = self.withdraw_gate.lock().expect("never poisoned").clone();
        async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            self.open
                .lock()
                .expect("never poisoned")
                .retain(|(held, _)| held.request_id != withdrawal.request_id);
            self.waiting
                .lock()
                .expect("never poisoned")
                .retain(|(held, _)| held.request_id != withdrawal.request_id);
            self.closed.notify_waiters();
            Ok(())
        }
        .boxed()
    }
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
