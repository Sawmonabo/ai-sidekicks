//! The daemon's own Codex executor and the many connections the relay serves onto it:
//! newline-delimited JSON-RPC both ways, the relay's own requests answered by their ids, each
//! connection's request sent under a relay id and its answer handed to that connection alone under
//! the connection's own id. Each connection's processes, open files and http requests run under
//! relay ids, and every message naming one, a policy ask and a streamed body among them, reaches
//! its connection alone under its own id. Each connection opens a session of its own at its
//! `initialize`; a dropped connection's processes are held under that session for its resume, and
//! its open files are closed. A process started once no connection owns it is ended at its start's
//! answer, as a file opened then is closed, unless it is a command the relay records, which runs
//! to its end. Every connection's missing-path watch joins one on the executor. An
//! executor request no connection owns is refused and an unrouted notification dropped, so
//! nothing reaches every connection. Each process's end is watched so a held terminate or a stop
//! can wait on it, the answer to a client's request where the relay keeps something for it, and
//! what each connection is owed at the executor's end kept until the relay settles it.

mod connection_ids;
mod connection_queue;
mod detached;
mod missing_watches;
mod policy_requests;
mod routing;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use process_wrap::tokio::ChildWrapper;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_platforms::{Spawner, wrap_child_command};
use sidekicks_std::mutex_lock::lock;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::Command;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};
use tokio_util::sync::CancellationToken;

use self::connection_ids::{ConnectionIds, IdMint, UNKNOWN_ID};
use self::connection_queue::ConnectionQueue;
#[cfg(test)]
pub(super) use self::connection_queue::QUEUE_STALL_BOUND;
use self::detached::DetachedConnections;
pub(super) use self::detached::{ConnectionHold, DETACHED_CONNECTION_HOLD};
use self::missing_watches::MissingWatches;
use self::policy_requests::{PolicyRequests, deny_answer};
use crate::driver::codex::exec_relay::executor_end::{
    ProcessLedger, compose_executor_ended_answer, compose_executor_ended_body_delta,
};
use crate::driver::codex::exec_relay::message::{RoutedParams, splice, text_of};
use crate::driver::codex::exec_relay::methods::{
    ClientMethod, FS_CLOSE_METHOD, INITIALIZE_METHOD, INITIALIZED_METHOD, PROCESS_TERMINATE_METHOD,
    RelayIdKind,
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

/// How many lines wait for the executor's input before their sender waits.
const LINE_QUEUE_CAPACITY: usize = 256;

/// How many of the relay's own lines wait for the executor's input before one is dropped.
const OWN_LINE_QUEUE_CAPACITY: usize = 1024;

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

impl ClientRequest {
    // Whether the request is kept past its connection's forget: a file open, whose answer closes
    // the handle no one holds, and a process start, whose answer ends the process no one owns.
    // Nothing joins them once the connection is forgotten, and each goes at its answer or at the
    // executor's end, so what is kept is at most the starts and opens in flight at the forget.
    fn outlives_its_connection(&self) -> bool {
        matches!(
            self.method,
            ClientMethod::FileOpen | ClientMethod::ProcessStart
        )
    }
}

/// What a connection's detach leaves: the hold of the session it opened, for its resume, or, for
/// a connection that opened none, the live processes it started, by their relay ids, which no one
/// owns any more.
pub(super) enum DetachedClient {
    /// The connection's session, held for its resume.
    Held(ConnectionHold),
    /// The live processes of a connection with no session, for the relay to end.
    Released(Vec<String>),
}

/// One executor and the daemon's connection to it.
pub(super) struct CodexExecutor {
    me: Weak<Self>,
    lines: mpsc::Sender<String>,
    own_lines: mpsc::Sender<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<RelayAnswer>>>,
    next_request: AtomicU64,
    // Each connection's only sender, so removing its entry closes the connection.
    clients: Mutex<HashMap<RelayConnectionId, ConnectionQueue>>,
    next_connection: AtomicU64,
    sessions: Mutex<DetachedConnections>,
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
        let (own_lines, own_queued) = mpsc::channel(OWN_LINE_QUEUE_CAPACITY);
        tokio::spawn(forward_own_lines(own_queued, lines.clone()));
        let executor = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            lines,
            own_lines,
            pending: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            clients: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(1),
            sessions: Mutex::new(DetachedConnections::default()),
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

    /// Attaches `client`, the queue of a connection `environment`'s token admitted, beside the
    /// others and answers the connection's id; `None` once the executor's connection ended. The
    /// executor keeps the queue's only sender, so the connection's detach or the executor's end
    /// closes it, and cancels `closed` once the queue stays full past its bound, for the
    /// connection to close as a closed socket does.
    pub(super) fn attach_client(
        &self,
        client: mpsc::Sender<String>,
        closed: CancellationToken,
        environment: Arc<str>,
    ) -> Option<RelayConnectionId> {
        let mut clients = lock(&self.clients);
        if *self.ended.borrow() {
            return None;
        }
        let connection = RelayConnectionId(self.next_connection.fetch_add(1, Ordering::Relaxed));
        clients.insert(
            connection,
            ConnectionQueue::new(client, closed, environment),
        );
        Some(connection)
    }

    /// How many connections are attached, which a test reads.
    #[cfg(test)]
    pub(super) fn connection_count(&self) -> usize {
        lock(&self.clients).len()
    }

    /// Lets the connection `connection` go, closing its queue, denying every policy ask it had
    /// not answered and closing its open files on the executor; a file still opening is closed at
    /// its open's answer. A connection that opened a session keeps its processes under the hold
    /// this answers, for its resume; any other's process ids are forgotten and its live processes
    /// answered for the relay to end, a process still starting ended at its start's answer. Its
    /// other requests in flight are forgotten, their answers and messages then reaching no one.
    pub(super) fn detach_client(&self, connection: RelayConnectionId) -> DetachedClient {
        let hold = lock(&self.sessions).hold(connection);
        let detached = match hold {
            Some(hold) => DetachedClient::Held(hold),
            None => DetachedClient::Released(lock(&self.process_ids).forget_connection(connection)),
        };
        self.forget_requests_of(connection);
        let open_files = lock(&self.file_handles).forget_connection(connection);
        // A streamed body runs on to its last delta, since no method cancels it, and reaches no
        // one.
        lock(&self.http_requests).forget_connection(connection);
        lock(&self.clients).remove(&connection);
        // After the connection's queue goes, so a join answered meanwhile finds it gone or is
        // forgotten here.
        self.missing_watches.forget_connection(connection);
        let unanswered = lock(&self.policy_requests).take_connection(connection);
        let denies = unanswered.iter().map(|id| deny_answer(id));
        let closes = open_files
            .into_iter()
            .map(|handle| self.compose_file_close(&handle));
        self.send_own_lines(denies.chain(closes).collect());
        detached
    }

    // Forgets the requests in flight of `connection`, which went away, but those that outlive it.
    fn forget_requests_of(&self, connection: RelayConnectionId) {
        lock(&self.client_requests).retain(|_relay_id, request| {
            request.connection != connection || request.outlives_its_connection()
        });
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
    /// executor answers it, the connection goes or the executor's end answers it. Answers the line
    /// with whether it minted a new relay id, which only its refusal then forgets. Fails with the
    /// answer the connection gets instead, nothing then kept: the error naming the end once the
    /// executor ended, and a refusal for a mint under an own id whose earlier mint is unanswered,
    /// as the executor refuses an id already in use.
    pub(super) fn relay_client_request(
        &self,
        connection: RelayConnectionId,
        line: &str,
        id: &RawValue,
        method: ClientMethod,
        params: Option<&RoutedParams<'_>>,
    ) -> Result<(String, bool), String> {
        let relay_request_id = format!(
            "\"{CLIENT_REQUEST_PREFIX}{}\"",
            self.next_client_request.fetch_add(1, Ordering::Relaxed)
        );
        let mut kept_id = None;
        let mut pending_id = None;
        let relay_named = method.named_id().and_then(|named| {
            let raw = params?.id_of(named.kind)?;
            let own_id = text_of(raw)?;
            let mut ids = lock(self.ids_of(named.kind));
            let relay_id = if named.mints {
                match ids.mint(connection, &own_id) {
                    IdMint::New(relay_id) => {
                        kept_id = Some(relay_id.clone());
                        relay_id
                    }
                    IdMint::Live(relay_id) => relay_id,
                    IdMint::Pending => {
                        pending_id = Some(own_id);
                        return None;
                    }
                }
            } else {
                let relay_id = ids.relay_id(connection, &own_id).to_owned();
                if method == ClientMethod::FileClose && relay_id != UNKNOWN_ID {
                    kept_id = Some(relay_id.clone());
                }
                relay_id
            };
            Some((raw, format!("\"{relay_id}\"")))
        });
        if let Some(own_id) = pending_id {
            let refusal = json!({ "id": id, "error": {
                "code": JsonRpcErrorCode::InvalidRequest.code(),
                "message": format!("{own_id} already exists"),
            }});
            return Err(refusal.to_string());
        }
        let relayed = splice(
            line,
            std::iter::once((id, relay_request_id.as_str())).chain(
                relay_named
                    .as_ref()
                    .map(|(raw, relay_id)| (*raw, relay_id.as_str())),
            ),
        );
        let is_minted = method.named_id().is_some_and(|named| named.mints) && kept_id.is_some();
        let mut client_requests = lock(&self.client_requests);
        // Read under the requests' lock, which the end's settle drains, so a request kept here is
        // answered by that settle.
        if *self.ended.borrow() {
            return Err(compose_executor_ended_answer(id.get()));
        }
        if method == ClientMethod::ProcessStart
            && let Some(minted) = &kept_id
        {
            lock(&self.ledger).expect_process(minted);
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
        Ok((relayed, is_minted))
    }

    // The table of `kind`'s ids.
    fn ids_of(&self, kind: RelayIdKind) -> &Mutex<ConnectionIds> {
        match kind {
            RelayIdKind::Process => &self.process_ids,
            RelayIdKind::FileHandle => &self.file_handles,
            RelayIdKind::HttpRequest => &self.http_requests,
        }
    }

    /// Hands each attached connection what the executor's end owes it, under its own ids: an
    /// error answer to each of its requests left unanswered, the end of each of its processes the
    /// executor had not closed, a last delta carrying the error to each of its streamed http
    /// bodies, and the fire of its missing-path watch.
    pub(super) fn settle_clients(&self) {
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
        let body_ends = lock(&self.http_requests)
            .clear()
            .into_iter()
            .map(|(owner, last_seq)| {
                let line = compose_executor_ended_body_delta(&owner.own_id, last_seq + 1);
                (owner.connection, line)
            });
        let lines: Vec<_> = requests
            .into_iter()
            .chain(process_ends)
            .chain(body_ends)
            .collect();
        for (connection, line) in lines {
            self.answer_connection(connection, line);
        }
        self.fire_every_missing_watch();
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

    // The `fs/close` of `handle` under a relay request id no one waits on, whose answer is
    // dropped; a close cannot fail and runs on the executor's control lane, so none is awaited.
    fn compose_file_close(&self, handle: &str) -> String {
        self.compose_own_request(FS_CLOSE_METHOD, &json!({ "handleId": handle }))
    }

    /// The `process/terminate` of the process the relay runs under `relay_id`, under a relay
    /// request id no one waits on, whose answer is dropped.
    pub(super) fn compose_process_terminate(&self, relay_id: &str) -> String {
        self.compose_own_request(PROCESS_TERMINATE_METHOD, &json!({ "processId": relay_id }))
    }

    // The relay's own request of `method` with `params` under a relay request id no one waits on.
    fn compose_own_request(&self, method: &str, params: &Value) -> String {
        json!({ "id": self.next_relay_request_id(), "method": method, "params": params })
            .to_string()
    }

    // Queues `own_lines`, the relay's own, for the executor in order behind the relay's earlier
    // own lines, so the reader or the detach that composed them never waits on the executor's
    // input; a line past the queue's bound is dropped and logged, and so are lines the ended
    // connection no longer takes.
    fn send_own_lines(&self, own_lines: Vec<String>) {
        for line in own_lines {
            match self.own_lines.try_send(line) {
                Ok(()) => {}
                Err(TrySendError::Full(_line)) => tracing::warn!(
                    "the Codex executor's input fell the relay's own queue behind, so a line of \
                     the relay's own was dropped"
                ),
                Err(TrySendError::Closed(_line)) => {
                    tracing::debug!(
                        "the Codex executor ended before the relay's own lines went out"
                    );
                    return;
                }
            }
        }
    }

    // Marks the connection ended: every waiting request fails, every watched process ends and the
    // connections' files and policy asks are forgotten. The connections stay attached, and their
    // requests, processes, streamed bodies and watches kept, for what the end owes them.
    fn end(&self) {
        self.ended.send_replace(true);
        lock(&self.pending).clear();
        lock(&self.client_replies).clear();
        for exit in lock(&self.exits).values() {
            record_end(exit, None);
        }
        lock(&self.file_handles).clear();
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

// Hands the relay's own lines on to the executor's input in order until either closes.
async fn forward_own_lines(mut own_lines: mpsc::Receiver<String>, lines: mpsc::Sender<String>) {
    while let Some(line) = own_lines.recv().await {
        if lines.send(line).await.is_err() {
            return;
        }
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
            Ok(line) => executor.take_line(&line),
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
