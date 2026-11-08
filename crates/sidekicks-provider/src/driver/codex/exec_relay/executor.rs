//! The daemon's own Codex executor and the many connections the relay serves onto it:
//! newline-delimited JSON-RPC both ways, the relay's own requests answered by their ids, each
//! connection's request sent under a relay id and its answer handed to that connection alone under
//! the connection's own id, every other message handed to every connection, each process's end
//! watched so a held terminate or a stop can wait on it, and the answer to a client's request
//! watched where the relay keeps something for it.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use process_wrap::tokio::ChildWrapper;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_platforms::{Spawner, wrap_child_command};
use sidekicks_std::mutex_lock::lock;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

use crate::driver::codex::exec_relay::message::{RoutedMessage, splice, text_of};
use crate::driver::codex::exec_relay::methods::{
    INITIALIZE_METHOD, INITIALIZED_METHOD, PROCESS_CLOSED_METHOD, PROCESS_EXITED_METHOD,
};
use crate::driver::codex::session::errors::CodexError;

/// What opens the id of every request the relay sends itself, so its answer is told apart from an
/// answer to the client's own requests.
const RELAY_REQUEST_PREFIX: &str = "sidekicks-relay-";

/// What opens the relay id every client's request reaches the executor under, so two connections'
/// own ids never meet there.
const CLIENT_REQUEST_PREFIX: &str = "sidekicks-client-";

/// The longest message line either side reads, the most one WebSocket message carries by default.
const EXECUTOR_LINE_MAX_BYTES: usize = 64 << 20;

/// The longest line of the executor's own log the relay reads.
const EXECUTOR_ERROR_LINE_MAX_BYTES: usize = 64 << 10;

/// How many lines wait for the executor's input or for the client before their sender waits.
const LINE_QUEUE_CAPACITY: usize = 256;

/// The name the relay gives the executor at its `initialize`.
const RELAY_CLIENT_NAME: &str = "sidekicks-relay";

/// How long the relay's own `initialize` may take.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);

/// The answer a request of the relay's own gets: its result, or the executor's refusal in words.
type RelayAnswer = Result<Box<RawValue>, String>;

/// How one of the executor's processes ended: the exit code its `process/exited` reported, `None`
/// for one that closed or whose connection ended with no code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ProcessEnd {
    /// The process's exit code.
    pub(super) exit_code: Option<i32>,
}

/// One connection the relay serves onto its executor, unique for the executor's life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct RelayConnectionId(u64);

// A client's request the executor has not answered: the connection that sent it and the id it
// sent it under, as raw JSON text.
struct ClientRequest {
    connection: RelayConnectionId,
    client_id: Box<str>,
}

/// One executor and the daemon's connection to it.
pub(super) struct CodexExecutor {
    lines: mpsc::Sender<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<RelayAnswer>>>,
    next_request: AtomicU64,
    // Each connection's only sender, so removing its entry closes the connection.
    clients: Mutex<HashMap<RelayConnectionId, mpsc::Sender<String>>>,
    next_connection: AtomicU64,
    // Keyed by the relay id as raw JSON text.
    client_requests: Mutex<HashMap<String, ClientRequest>>,
    next_client_request: AtomicU64,
    exits: Mutex<HashMap<String, watch::Sender<Option<ProcessEnd>>>>,
    client_replies: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    ended: watch::Sender<bool>,
    process_id: Option<u32>,
    initialize_result: Mutex<Option<Box<RawValue>>>,
}

impl CodexExecutor {
    /// Starts `command`, the executor on standard input and output, as the daemon's child on
    /// `spawner`, and initializes it. Fails with `CodexError::Transport` when it cannot be started
    /// or does not answer its `initialize`.
    pub(super) async fn start(
        spawner: &Spawner,
        mut command: Command,
    ) -> Result<Arc<Self>, CodexError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let daemon_pid = std::process::id();
        let mut child = spawner
            .run(move || wrap_child_command(command, daemon_pid).spawn())
            .await
            .and_then(|spawned| spawned)
            .map_err(|error| CodexError::Transport {
                detail: "The Codex executor could not be started.".to_owned(),
                cause: Some(Box::new(error)),
            })?;
        let input = child
            .stdin()
            .take()
            .expect("the executor's standard input is piped");
        let output = child
            .stdout()
            .take()
            .expect("the executor's standard output is piped");
        let errors = child
            .stderr()
            .take()
            .expect("the executor's standard error is piped");
        let process_id = child.id();
        tokio::spawn(log_error_lines(errors));
        let executor = Self::over(output, input, process_id);
        tokio::spawn(own_executor_child(child, executor.ended.subscribe()));
        executor.initialize().await?;
        Ok(executor)
    }

    /// The connection over `output` and `input`, the executor's standard output and input, for
    /// the process `process_id` names; nothing is sent until a request is.
    pub(super) fn over(
        output: impl AsyncRead + Send + Unpin + 'static,
        input: impl AsyncWrite + Send + Unpin + 'static,
        process_id: Option<u32>,
    ) -> Arc<Self> {
        let (lines, queued) = mpsc::channel(LINE_QUEUE_CAPACITY);
        let executor = Arc::new(Self {
            lines,
            pending: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            clients: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(1),
            client_requests: Mutex::new(HashMap::new()),
            next_client_request: AtomicU64::new(1),
            exits: Mutex::new(HashMap::new()),
            client_replies: Mutex::new(HashMap::new()),
            ended: watch::Sender::new(false),
            process_id,
            initialize_result: Mutex::new(None),
        });
        tokio::spawn(write_lines(input, queued, Arc::downgrade(&executor)));
        tokio::spawn(read_lines(output, Arc::downgrade(&executor)));
        executor
    }

    /// The executor's process id, when the system gave one.
    pub(super) fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    /// Whether the connection still runs.
    pub(super) fn is_running(&self) -> bool {
        !*self.ended.borrow()
    }

    /// A watch that turns true once the connection ended.
    pub(super) fn ended(&self) -> watch::Receiver<bool> {
        self.ended.subscribe()
    }

    /// Sends the relay's own `initialize` and `initialized`, keeping the answer every client's
    /// `initialize` is given, since the executor takes one per connection. Fails with
    /// `CodexError::Transport` when it is refused or not answered.
    pub(super) async fn initialize(&self) -> Result<(), CodexError> {
        let params = json!({ "clientName": RELAY_CLIENT_NAME });
        let result = self
            .request_within(INITIALIZE_METHOD, &params, INITIALIZE_TIMEOUT)
            .await?
            .ok_or_else(|| CodexError::Transport {
                detail: "The Codex executor did not answer its initialize.".to_owned(),
                cause: None,
            })?;
        *lock(&self.initialize_result) = Some(result);
        self.send_line(json!({ "method": INITIALIZED_METHOD }).to_string())
            .await
    }

    /// The executor's answer to the relay's `initialize`, which a client's `initialize` gets.
    pub(super) fn initialize_result(&self) -> Option<Box<RawValue>> {
        lock(&self.initialize_result).clone()
    }

    /// Attaches `client`, a connection's queue, beside the others and answers the connection's
    /// id; `None` once the executor's connection ended. The executor keeps the queue's only
    /// sender, so the connection's detach or the executor's end closes it.
    pub(super) fn attach_client(&self, client: mpsc::Sender<String>) -> Option<RelayConnectionId> {
        let mut clients = lock(&self.clients);
        if *self.ended.borrow() {
            return None;
        }
        let connection = RelayConnectionId(self.next_connection.fetch_add(1, Ordering::Relaxed));
        clients.insert(connection, client);
        Some(connection)
    }

    /// How many connections are attached, which a test reads.
    #[cfg(test)]
    pub(super) fn connection_count(&self) -> usize {
        lock(&self.clients).len()
    }

    /// Lets the connection `connection` go, forgetting every request it has in flight, whose
    /// answers then reach no one, and then closing its queue.
    pub(super) fn detach_client(&self, connection: RelayConnectionId) {
        lock(&self.client_requests).retain(|_relay_id, request| request.connection != connection);
        lock(&self.clients).remove(&connection);
    }

    /// `line`, a request the connection `connection` sent under `id`, the slice of `line` its
    /// parse read, with a new relay id in that id's place; the connection and its id are kept
    /// under the relay id until the executor answers it or the connection goes.
    pub(super) fn relay_client_request(
        &self,
        connection: RelayConnectionId,
        line: &str,
        id: &RawValue,
    ) -> String {
        let relay_id = format!(
            "\"{CLIENT_REQUEST_PREFIX}{}\"",
            self.next_client_request.fetch_add(1, Ordering::Relaxed)
        );
        let relayed = splice(line, [(id, relay_id.as_str())]);
        lock(&self.client_requests).insert(
            relay_id,
            ClientRequest {
                connection,
                client_id: id.get().into(),
            },
        );
        relayed
    }

    /// Hands `line`, an answer the relay gives in the executor's place, to the connection
    /// `connection` alone; dropped once that connection is gone.
    pub(super) async fn answer_connection(&self, connection: RelayConnectionId, line: String) {
        let client = lock(&self.clients).get(&connection).cloned();
        let Some(client) = client else {
            tracing::debug!("the Codex relay's client went away before its answer was handed on");
            return;
        };
        if client.send(line).await.is_err() {
            tracing::debug!("the Codex relay's client went away before its answer reached it");
        }
    }

    // Hands `line` to every connection, one copy for each past the first.
    async fn send_to_every_connection(&self, line: String) {
        let clients: Vec<_> = lock(&self.clients).values().cloned().collect();
        let Some((last, others)) = clients.split_last() else {
            return;
        };
        for client in others {
            if client.send(line.clone()).await.is_err() {
                tracing::debug!("a Codex relay client went away before a message reached it");
            }
        }
        if last.send(line).await.is_err() {
            tracing::debug!("a Codex relay client went away before a message reached it");
        }
    }

    /// Writes one message to the executor as its own line. Fails with `CodexError::Transport`
    /// once the connection ended.
    pub(super) async fn send_line(&self, message: String) -> Result<(), CodexError> {
        self.lines.send(message).await.map_err(|_closed| ended())
    }

    /// Watches the end of the executor's process `process_id`; the watch holds its end from its
    /// `process/exited` or `process/closed`, or once the connection ends.
    pub(super) fn watch_exit(&self, process_id: &str) -> watch::Receiver<Option<ProcessEnd>> {
        let is_ended = *self.ended.borrow();
        lock(&self.exits)
            .entry(process_id.to_owned())
            .or_insert_with(|| {
                watch::Sender::new(is_ended.then_some(ProcessEnd { exit_code: None }))
            })
            .subscribe()
    }

    /// Stops watching `process_id`, whose start the executor refused, so it never ends.
    pub(super) fn forget_exit(&self, process_id: &str) {
        lock(&self.exits).remove(process_id);
    }

    /// Watches the executor's answer to the client's request whose relay id is `id` as compact
    /// JSON, still handed to the client: true for a refusal, false for a result; the sender drops
    /// when the connection ends first.
    pub(super) fn watch_client_answer(&self, id: String) -> oneshot::Receiver<bool> {
        let (answer, answered) = oneshot::channel();
        lock(&self.client_replies).insert(id, answer);
        answered
    }

    /// Sends the relay's own request and answers its result, `None` when `timeout` passed first.
    /// Fails with `CodexError::Transport` when the executor refused it or the connection ended.
    pub(super) async fn request_within(
        &self,
        method: &str,
        params: &serde_json::Value,
        timeout: Duration,
    ) -> Result<Option<Box<RawValue>>, CodexError> {
        let id = format!(
            "{RELAY_REQUEST_PREFIX}{}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let (answer, answered) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), answer);
        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        if let Err(error) = self.send_line(message).await {
            lock(&self.pending).remove(&id);
            return Err(error);
        }
        let Ok(answer) = tokio::time::timeout(timeout, answered).await else {
            lock(&self.pending).remove(&id);
            return Ok(None);
        };
        match answer {
            Ok(Ok(result)) => Ok(Some(result)),
            Ok(Err(message)) => Err(CodexError::Transport {
                detail: format!("The Codex executor refused \"{method}\": {message}"),
                cause: None,
            }),
            Err(_dropped) => Err(ended()),
        }
    }

    // Routes one line the executor wrote.
    async fn take_line(&self, line: String) {
        let Some(message) = RoutedMessage::read(&line) else {
            tracing::warn!(
                length = line.len(),
                "the Codex executor wrote a line that is no message"
            );
            return;
        };
        if message.method.is_none()
            && let Some(id) = message
                .id
                .and_then(|id| serde_json::from_str::<String>(id.get()).ok())
                .filter(|id| id.starts_with(RELAY_REQUEST_PREFIX))
        {
            let answer = match (message.result, message.error) {
                (Some(result), _) => Ok(result.to_owned()),
                (None, error) => Err(error
                    .and_then(|error| error.message)
                    .unwrap_or_else(|| "no reason given".to_owned())),
            };
            if let Some(waiting) = lock(&self.pending).remove(&id)
                && waiting.send(answer).is_err()
            {
                tracing::debug!(id, "a relay request's caller stopped waiting");
            }
            return;
        }
        if message.method.is_none()
            && let Some(id) = message.id
        {
            let watching = lock(&self.client_replies).remove(id.get());
            if let Some(watching) = watching {
                // The relay's watch may have stopped waiting; the client still gets the answer.
                let _unheard = watching.send(message.error.is_some());
            }
            let request = lock(&self.client_requests).remove(id.get());
            let Some(request) = request else {
                tracing::debug!(
                    length = line.len(),
                    "the Codex executor answered a request no connection waits on"
                );
                return;
            };
            let answer = splice(&line, [(id, &*request.client_id)]);
            self.answer_connection(request.connection, answer).await;
            return;
        }
        if let Some(method) = message.method.as_deref()
            && message.id.is_none()
            && (method == PROCESS_EXITED_METHOD || method == PROCESS_CLOSED_METHOD)
            && let Some(params) = &message.params
            && let Some(process_id) = params.process_id.and_then(text_of)
        {
            let mut exits = lock(&self.exits);
            if let Some(exit) = exits.get(&process_id) {
                record_end(exit, params.exit_code);
            }
            if method == PROCESS_CLOSED_METHOD {
                exits.remove(&process_id);
            }
        }
        self.send_to_every_connection(line).await;
    }

    // Marks the connection ended: every waiting request fails, every watched process ends and
    // every connection onto it closes.
    fn end(&self) {
        self.ended.send_replace(true);
        lock(&self.pending).clear();
        lock(&self.client_replies).clear();
        for exit in lock(&self.exits).values() {
            record_end(exit, None);
        }
        lock(&self.clients).clear();
        lock(&self.client_requests).clear();
    }
}

// Records a process's end with `exit_code` where none was recorded yet: a `process/closed` after
// its `process/exited` keeps the code.
fn record_end(exit: &watch::Sender<Option<ProcessEnd>>, exit_code: Option<i32>) {
    exit.send_if_modified(|end| {
        let is_first = end.is_none();
        if is_first {
            *end = Some(ProcessEnd { exit_code });
        }
        is_first
    });
}

fn ended() -> CodexError {
    CodexError::Transport {
        detail: "The Codex executor's connection has ended.".to_owned(),
        cause: None,
    }
}

// Writes each queued line and its newline to the executor until the queue or the input closes.
async fn write_lines(
    input: impl AsyncWrite + Send + Unpin,
    mut queued: mpsc::Receiver<String>,
    executor: Weak<CodexExecutor>,
) {
    let mut writer = FramedWrite::new(input, LinesCodec::new());
    while let Some(line) = queued.recv().await {
        if let Err(error) = writer.send(line).await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the Codex executor's input closed"
            );
            break;
        }
    }
    if let Some(executor) = executor.upgrade() {
        executor.end();
    }
}

// Reads the executor's lines until its output ends or fails, then ends the connection.
async fn read_lines(output: impl AsyncRead + Send + Unpin, executor: Weak<CodexExecutor>) {
    let mut lines = FramedRead::new(
        output,
        LinesCodec::new_with_max_length(EXECUTOR_LINE_MAX_BYTES),
    );
    while let Some(read) = lines.next().await {
        let Some(executor) = executor.upgrade() else {
            return;
        };
        match read {
            Ok(line) => executor.take_line(line).await,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the Codex executor's output could not be read"
                );
                break;
            }
        }
    }
    if let Some(executor) = executor.upgrade() {
        executor.end();
    }
}

// Logs each line the executor writes on its standard error, its own diagnostics, until it closes.
async fn log_error_lines(errors: impl AsyncRead + Send + Unpin) {
    let mut lines = FramedRead::new(
        errors,
        LinesCodec::new_with_max_length(EXECUTOR_ERROR_LINE_MAX_BYTES),
    );
    while let Some(read) = lines.next().await {
        match read {
            Ok(line) => tracing::debug!(line, "the Codex executor logged"),
            Err(error) => {
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the Codex executor's log could not be read"
                );
                return;
            }
        }
    }
}

// Holds the executor's child until the connection ends, then ends it; its handle's drop kills it.
async fn own_executor_child(mut child: Box<dyn ChildWrapper>, mut ended: watch::Receiver<bool>) {
    tokio::select! {
        status = child.wait() => match status {
            Ok(status) => tracing::warn!(%status, "the Codex executor exited"),
            Err(error) => {
                let error = &error as &(dyn std::error::Error + 'static);
                tracing::warn!(error, "the Codex executor's end could not be read");
            }
        },
        // The connection ended or every handle on it dropped; the child's drop kills it.
        _ended = ended.wait_for(|is_ended| *is_ended) => {}
    }
}
