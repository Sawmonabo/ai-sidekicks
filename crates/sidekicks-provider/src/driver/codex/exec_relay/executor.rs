//! The daemon's own Codex executor and the many connections the relay serves onto it:
//! newline-delimited JSON-RPC both ways, the relay's own requests answered by their ids, each
//! connection's request sent under a relay id and its answer handed to that connection alone under
//! the connection's own id. Each connection's processes, open files and http requests run under
//! relay ids, and every message naming one, a policy ask and a streamed body among them, reaches
//! its connection alone under its own id; a dropped connection's open files are closed. Every
//! connection's missing-path watch joins one on the executor. An executor request no connection
//! owns is refused and an unrouted notification dropped, so nothing reaches every connection. Each
//! process's end is watched so a held terminate or a stop can wait on it, the answer to a
//! client's request where the relay keeps something for it, and what each connection is owed at
//! the executor's end kept until the relay settles it.

mod connection_ids;
mod missing_watches;
mod policy_requests;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use process_wrap::tokio::ChildWrapper;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_platforms::{Spawner, wrap_child_command};
use sidekicks_std::mutex_lock::lock;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

use self::connection_ids::{ConnectionIds, UNKNOWN_ID};
use self::missing_watches::MissingWatches;
use self::policy_requests::{PolicyRequests, deny_answer};
use crate::driver::codex::exec_relay::executor_end::{
    ProcessEventKind, ProcessLedger, compose_executor_ended_answer,
};
use crate::driver::codex::exec_relay::message::{RoutedMessage, RoutedParams, splice, text_of};
use crate::driver::codex::exec_relay::methods::{
    ClientMethod, FS_CLOSE_METHOD, FS_MISSING_CHANGED_METHOD, HTTP_REQUEST_BODY_DELTA_METHOD,
    INITIALIZE_METHOD, INITIALIZED_METHOD, NETWORK_POLICY_REQUEST_METHOD, PROCESS_CLOSED_METHOD,
    RelayIdKind, is_process_notification,
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

// A client's request the executor has not answered: the connection that sent it, the id it sent
// it under, as raw JSON text, how the relay carries its method, and the relay id it names in its
// method's table: the one it minted, forgotten when the mint is refused, or the handle a close
// names, forgotten at its answer; and whether an http request streams its body.
struct ClientRequest {
    connection: RelayConnectionId,
    client_id: Box<str>,
    method: ClientMethod,
    relay_id: Option<String>,
    streams: bool,
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
    process_ids: Mutex<ConnectionIds>,
    file_handles: Mutex<ConnectionIds>,
    http_requests: Mutex<ConnectionIds>,
    policy_requests: Mutex<PolicyRequests>,
    missing_watches: MissingWatches,
    // Keyed by the relay's process id.
    exits: Mutex<HashMap<String, watch::Sender<Option<ProcessEnd>>>>,
    client_replies: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    ledger: Mutex<ProcessLedger>,
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
            process_ids: Mutex::new(ConnectionIds::new(RelayIdKind::Process)),
            file_handles: Mutex::new(ConnectionIds::new(RelayIdKind::FileHandle)),
            http_requests: Mutex::new(ConnectionIds::new(RelayIdKind::HttpRequest)),
            policy_requests: Mutex::new(PolicyRequests::default()),
            missing_watches: MissingWatches::default(),
            exits: Mutex::new(HashMap::new()),
            client_replies: Mutex::new(HashMap::new()),
            ledger: Mutex::new(ProcessLedger::default()),
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

    /// Lets the connection `connection` go, forgetting every request it has in flight but its
    /// opens, whose answers then reach no one, and its ids, whose messages then reach no one,
    /// closing its queue, denying every policy ask it had not answered and closing its open files
    /// on the executor; a file still opening is closed at its open's answer.
    pub(super) async fn detach_client(&self, connection: RelayConnectionId) {
        lock(&self.client_requests).retain(|_relay_id, request| {
            request.connection != connection || request.method == ClientMethod::FileOpen
        });
        lock(&self.process_ids).forget_connection(connection);
        let open_files = lock(&self.file_handles).forget_connection(connection);
        // A streamed body runs on to its last delta, since no method cancels it, and reaches no one.
        lock(&self.http_requests).forget_connection(connection);
        lock(&self.clients).remove(&connection);
        // After the connection's queue goes, so a join answered meanwhile finds it gone or is
        // forgotten here.
        self.missing_watches.forget_connection(connection);
        let unanswered = lock(&self.policy_requests).take_connection(connection);
        for id in unanswered {
            self.deny_policy_request(&id).await;
        }
        self.close_file_handles(open_files).await;
    }

    /// Whether the connection `connection`'s answer under `id` to one of the executor's requests
    /// goes on to the executor: only when that request was asked of it, and only once.
    pub(super) fn takes_client_answer(&self, connection: RelayConnectionId, id: &RawValue) -> bool {
        lock(&self.policy_requests).answer(id, connection)
    }

    /// `line`, a request the connection `connection` sent under `id` for `method`, with a new relay
    /// id in that id's place and, for a method that names an id of its own in `params`, the
    /// relay's id in its place: minted for a method that mints one, and for any other the one
    /// minted for it, or [`UNKNOWN_ID`] for an id the connection never minted. Both are slices of
    /// `line` its parse read. The connection and its id are kept under the relay id until the
    /// executor answers it, the connection goes or the executor's end answers it. `None` once the
    /// executor ended, nothing then kept.
    pub(super) fn relay_client_request(
        &self,
        connection: RelayConnectionId,
        line: &str,
        id: &RawValue,
        method: ClientMethod,
        params: Option<&RoutedParams<'_>>,
    ) -> Option<String> {
        let relay_request_id = format!(
            "\"{CLIENT_REQUEST_PREFIX}{}\"",
            self.next_client_request.fetch_add(1, Ordering::Relaxed)
        );
        let mut kept_id = None;
        let relay_named = method.named_id().and_then(|named| {
            let raw = params?.id_of(named.kind)?;
            let own_id = text_of(raw)?;
            let mut ids = lock(self.ids_of(named.kind));
            let relay_id = if named.mints {
                let (relay_id, is_new) = ids.mint(connection, &own_id);
                if is_new {
                    kept_id = Some(relay_id.clone());
                }
                relay_id
            } else {
                let relay_id = ids.relay_id(connection, &own_id).to_owned();
                if method == ClientMethod::FileClose && relay_id != UNKNOWN_ID {
                    kept_id = Some(relay_id.clone());
                }
                relay_id
            };
            Some((raw, format!("\"{relay_id}\"")))
        });
        let relayed = splice(
            line,
            std::iter::once((id, relay_request_id.as_str())).chain(
                relay_named
                    .as_ref()
                    .map(|(raw, relay_id)| (*raw, relay_id.as_str())),
            ),
        );
        let mut client_requests = lock(&self.client_requests);
        // Read under the requests' lock, which the end's settle drains, so a request kept here is
        // answered by that settle.
        if *self.ended.borrow() {
            return None;
        }
        client_requests.insert(
            relay_request_id,
            ClientRequest {
                connection,
                client_id: id.get().into(),
                method,
                relay_id: kept_id,
                streams: method == ClientMethod::HttpRequest
                    && params.is_some_and(|params| params.stream_response),
            },
        );
        Some(relayed)
    }

    // The table of `kind`'s ids.
    fn ids_of(&self, kind: RelayIdKind) -> &Mutex<ConnectionIds> {
        match kind {
            RelayIdKind::Process => &self.process_ids,
            RelayIdKind::FileHandle => &self.file_handles,
            RelayIdKind::HttpRequest => &self.http_requests,
        }
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

    /// Hands each attached connection what the executor's end owes it: an error answer to each of
    /// its requests left unanswered and the end of each of its processes the executor had not
    /// closed, under its own ids.
    pub(super) async fn settle_clients(&self) {
        let requests: Vec<_> = lock(&self.client_requests)
            .drain()
            .map(|(_relay_id, request)| {
                let answer = compose_executor_ended_answer(&request.client_id);
                (request.connection, answer)
            })
            .collect();
        let process_ends = {
            let mut process_ids = lock(&self.process_ids);
            let owed = lock(&self.ledger).take_owed_lines(|relay_id| {
                let owner = process_ids.owner(relay_id)?;
                Some((owner.connection, owner.own_id.clone()))
            });
            process_ids.clear();
            owed
        };
        for (connection, line) in requests.into_iter().chain(process_ends) {
            self.answer_connection(connection, line).await;
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

    /// Sends the relay's own request and answers its result, `None` when `timeout`, if any,
    /// passed first. Fails with `CodexError::Transport` when the executor refused it or the
    /// connection ended, at once for a request sent once it had.
    pub(super) async fn request_within(
        &self,
        method: &str,
        params: &serde_json::Value,
        timeout: impl Into<Option<Duration>>,
    ) -> Result<Option<Box<RawValue>>, CodexError> {
        let id = self.next_relay_request_id();
        let (answer, answered) = oneshot::channel();
        {
            // Read under the waiters' lock, which the end clears after marking itself, so no
            // waiter is kept once the end has passed.
            let mut pending = lock(&self.pending);
            if *self.ended.borrow() {
                return Err(ended());
            }
            pending.insert(id.clone(), answer);
        }
        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        if let Err(error) = self.send_line(message).await {
            lock(&self.pending).remove(&id);
            return Err(error);
        }
        let answer = match timeout.into() {
            Some(timeout) => {
                let Ok(answer) = tokio::time::timeout(timeout, answered).await else {
                    lock(&self.pending).remove(&id);
                    return Ok(None);
                };
                answer
            }
            None => answered.await,
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

    // A new id for a request of the relay's own.
    fn next_relay_request_id(&self) -> String {
        format!(
            "{RELAY_REQUEST_PREFIX}{}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        )
    }

    // Closes each of `handles` on the executor, one `fs/close` apiece under a relay request id no
    // one waits on, whose answer is dropped; a close cannot fail and runs on the executor's control
    // lane, so none is awaited.
    async fn close_file_handles(&self, handles: Vec<String>) {
        for handle in handles {
            let close = json!({
                "id": self.next_relay_request_id(),
                "method": FS_CLOSE_METHOD,
                "params": { "handleId": handle },
            });
            if let Err(error) = self.send_line(close.to_string()).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the relay's close of a Codex file could not be sent"
                );
                return;
            }
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
            let (answer, unowned_file) = self.client_answer(&line, &message, id, &request);
            self.answer_connection(request.connection, answer).await;
            if let Some(handle) = unowned_file {
                self.close_file_handles(vec![handle]).await;
            }
            return;
        }
        if message.method.as_deref() == Some(NETWORK_POLICY_REQUEST_METHOD)
            && let Some(id) = message.id
        {
            let params = message.params.unwrap_or_default();
            self.take_policy_request(&line, id, &params).await;
            return;
        }
        if message.method.as_deref() == Some(HTTP_REQUEST_BODY_DELTA_METHOD) && message.id.is_none()
        {
            let params = message.params.unwrap_or_default();
            self.take_body_delta(&line, &params).await;
            return;
        }
        if let Some(method) = message.method.as_deref()
            && message.id.is_none()
            && is_process_notification(method)
        {
            let params = message.params.unwrap_or_default();
            self.take_process_notification(&line, method, &params).await;
            return;
        }
        match (message.method.as_deref(), message.id) {
            (Some(FS_MISSING_CHANGED_METHOD), None) => {
                let watch_id = message.params.and_then(|params| params.watch_id);
                self.fire_missing_watch(watch_id).await;
            }
            // No connection owns it, so it is refused as Codex's client refuses one it lacks.
            (Some(method), Some(id)) => {
                let refusal = json!({ "id": id, "error": {
                    "code": JsonRpcErrorCode::MethodNotFound.code(),
                    "message": format!("The relay does not serve {method}."),
                }});
                if let Err(error) = self.send_line(refusal.to_string()).await {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "the relay's refusal of a Codex executor request could not be sent"
                    );
                }
            }
            (Some(method), None) => {
                tracing::debug!(
                    method,
                    "the Codex executor's notification reached no connection"
                );
            }
            (None, _) => tracing::debug!(
                length = line.len(),
                "the Codex executor wrote a message with no method and no id"
            ),
        }
    }

    // The executor's answer `line` to the client's `request` under the client's own id, the table
    // its method names kept in step, and the handle of a file opened after its connection went,
    // for the caller to close.
    fn client_answer(
        &self,
        line: &str,
        message: &RoutedMessage<'_>,
        id: &RawValue,
        request: &ClientRequest,
    ) -> (String, Option<String>) {
        match request.method {
            // A process started after its connection went runs on; only a file is closed.
            ClientMethod::ProcessStart => {
                let (answer, _unowned) =
                    self.mint_answer(RelayIdKind::Process, line, message, id, request);
                if message.error.is_none()
                    && let Some(minted) = &request.relay_id
                {
                    lock(&self.ledger).open_process(minted);
                }
                (answer, None)
            }
            ClientMethod::FileOpen => {
                self.mint_answer(RelayIdKind::FileHandle, line, message, id, request)
            }
            ClientMethod::FileClose => {
                if let Some(handle) = &request.relay_id {
                    lock(&self.file_handles).close(handle);
                }
                (splice(line, [(id, &*request.client_id)]), None)
            }
            // A streamed request's id lives until its last delta; any other's ends at its answer.
            ClientMethod::HttpRequest => {
                if let Some(minted) = &request.relay_id {
                    let mut ids = lock(&self.http_requests);
                    if request.streams && message.error.is_none() {
                        ids.mark_live(minted);
                    } else {
                        ids.forget(minted);
                    }
                }
                (splice(line, [(id, &*request.client_id)]), None)
            }
            ClientMethod::Initialize
            | ClientMethod::Initialized
            | ClientMethod::ProcessTerminate
            | ClientMethod::ProcessNamed
            | ClientMethod::FileNamed
            | ClientMethod::WatchMissing
            | ClientMethod::Passed => (splice(line, [(id, &*request.client_id)]), None),
        }
    }

    // The executor's answer `line` to `request`, which minted an id of `kind`, under the client's
    // own id: a refused mint's id is forgotten, and an answered one is live and names the
    // connection's own id again. The relay id an answer names that no connection holds any more is
    // answered beside it.
    fn mint_answer(
        &self,
        kind: RelayIdKind,
        line: &str,
        message: &RoutedMessage<'_>,
        id: &RawValue,
        request: &ClientRequest,
    ) -> (String, Option<String>) {
        let mut ids = lock(self.ids_of(kind));
        if message.error.is_some()
            && let Some(minted) = &request.relay_id
        {
            ids.forget(minted);
        }
        let mut unowned = None;
        let named = message
            .result
            .and_then(|result| serde_json::from_str::<RoutedParams<'_>>(result.get()).ok())
            .and_then(|result| result.id_of(kind))
            .and_then(|raw| {
                let relay_id = text_of(raw)?;
                let Some(owner) = ids.owner(&relay_id) else {
                    unowned = Some(relay_id);
                    return None;
                };
                let own_id = serde_json::to_string(&owner.own_id).ok()?;
                ids.mark_live(&relay_id);
                Some((raw, own_id))
            });
        drop(ids);
        let answer = splice(
            line,
            std::iter::once((id, &*request.client_id))
                .chain(named.as_ref().map(|(raw, own_id)| (*raw, own_id.as_str()))),
        );
        (answer, unowned)
    }

    // Hands `line`, the executor's policy ask `id` about the process `params` names by its relay
    // id, to the connection that started it under its own id, keeping the ask until that
    // connection answers it or goes; an ask no connection can answer is denied at once.
    async fn take_policy_request(&self, line: &str, id: &RawValue, params: &RoutedParams<'_>) {
        let owner = params
            .process_id
            .and_then(text_of)
            .and_then(|relay_id| lock(&self.process_ids).owner(&relay_id).cloned());
        let routed = owner.and_then(|owner| {
            let raw = params.process_id?;
            let own_id = serde_json::to_string(&owner.own_id).expect("a string serializes");
            // Kept while the connection is held, so its detach either finds the ask or comes first.
            let clients = lock(&self.clients);
            let client = clients.get(&owner.connection)?.clone();
            lock(&self.policy_requests).ask(id, owner.connection);
            drop(clients);
            Some((
                owner.connection,
                client,
                splice(line, [(raw, own_id.as_str())]),
            ))
        });
        let Some((connection, client, routed)) = routed else {
            self.deny_policy_request(id.get()).await;
            return;
        };
        if client.send(routed).await.is_err() && lock(&self.policy_requests).answer(id, connection)
        {
            self.deny_policy_request(id.get()).await;
        }
    }

    // Answers the executor's policy ask `id`, raw JSON text, with the relay's deny.
    async fn deny_policy_request(&self, id: &str) {
        if let Err(error) = self.send_line(deny_answer(id)).await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the relay's deny of a Codex policy ask could not be sent"
            );
        }
    }

    // Hands `line`, the executor's `method` about the process `params` names by its relay id, to
    // the connection that started it under its own id, recording the process's end; a process no
    // connection owns has its message reach no one.
    async fn take_process_notification(&self, line: &str, method: &str, params: &RoutedParams<'_>) {
        let relay_id = params.process_id.and_then(text_of);
        if let Some(relay_id) = &relay_id
            && let Some(kind) = ProcessEventKind::from_method(method)
        {
            lock(&self.ledger).record_event(relay_id, kind, params.seq, params.stream);
            if kind != ProcessEventKind::Output {
                let mut exits = lock(&self.exits);
                if let Some(exit) = exits.get(relay_id) {
                    record_end(exit, params.exit_code);
                }
                if kind == ProcessEventKind::Closed {
                    exits.remove(relay_id);
                }
            }
        }
        let owned = relay_id.as_ref().and_then(|relay_id| {
            let mut ids = lock(&self.process_ids);
            let owner = ids.owner(relay_id).cloned();
            if method == PROCESS_CLOSED_METHOD {
                ids.close(relay_id);
            }
            owner
        });
        let (Some(raw), Some(owner)) = (params.process_id, owned) else {
            tracing::debug!(
                method,
                process_id = relay_id.as_deref().unwrap_or(UNKNOWN_ID),
                "the Codex executor wrote of a process no connection owns"
            );
            return;
        };
        let own_id = serde_json::to_string(&owner.own_id).expect("a string serializes");
        let routed = splice(line, [(raw, own_id.as_str())]);
        self.answer_connection(owner.connection, routed).await;
    }

    // Hands `line`, a body delta of the http request `params` names by its relay id, to the
    // connection that sent it under its own id, forgetting the id at its last delta; a delta no
    // connection owns reaches no one, as Codex drops one.
    async fn take_body_delta(&self, line: &str, params: &RoutedParams<'_>) {
        let relay_id = params.request_id.and_then(text_of);
        let owned = relay_id.as_ref().and_then(|relay_id| {
            let mut ids = lock(&self.http_requests);
            let owner = ids.owner(relay_id).cloned();
            if params.done || params.error.is_some() {
                ids.close(relay_id);
            }
            owner
        });
        let (Some(raw), Some(owner)) = (params.request_id, owned) else {
            tracing::debug!(
                request_id = relay_id.as_deref().unwrap_or(UNKNOWN_ID),
                "the Codex executor streamed a body no connection asked for"
            );
            return;
        };
        let own_id = serde_json::to_string(&owner.own_id).expect("a string serializes");
        let routed = splice(line, [(raw, own_id.as_str())]);
        self.answer_connection(owner.connection, routed).await;
    }

    // Marks the connection ended: every waiting request fails, every watched process ends and the
    // connections' files, http requests, watches and policy asks are forgotten. The connections
    // stay attached, and their requests and processes kept, for what the end owes them.
    fn end(&self) {
        self.ended.send_replace(true);
        lock(&self.pending).clear();
        lock(&self.client_replies).clear();
        for exit in lock(&self.exits).values() {
            record_end(exit, None);
        }
        lock(&self.file_handles).clear();
        lock(&self.http_requests).clear();
        self.missing_watches.clear();
        lock(&self.policy_requests).clear();
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
