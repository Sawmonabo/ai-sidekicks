//! Each session's inbox, which the driver listens on for the session's whole life under one name,
//! and the daemon's own, which Claude Code's answers come back to. A connection to a session whose
//! process is up is passed to that process at once; to one asleep or stopping, its first complete
//! line is held, the session woken for it, and only then is anything passed on, so a wake that
//! fails closes the connection having written nothing.

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::Value;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    PathRules, UnixDomainStream, bind_socket_listener, connect_unix_domain_socket,
    create_missing_private_folders, found_no_listener,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::task::{JoinHandle, JoinSet};

use crate::driver::claude::inbox::forward::ClaudeInboxForwarding;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::idle_sleep::ClaudeIdleSleep;
use crate::driver::claude::session::slots::ClaudeSessionSlots;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::port::session_inbox_address::SessionInboxAddresser;
use crate::port::session_wake::SessionWaker;

/// How long a connection to a sleeping session has to send its first complete line, as Claude
/// Code gives a sender.
const FIRST_LINE_LIMIT: Duration = Duration::from_secs(30);

/// How long the accept loop waits after an accept fails for a reason other than the one
/// connection, such as the process's open files running out, so a failing accept does not spin.
const ACCEPT_RETRY_WAIT: Duration = Duration::from_secs(1);

/// The folder under Claude Code's config folder where each process records itself by its id.
const SESSION_REGISTRY_FOLDER: &str = "sessions";

/// Every session's inbox and the daemon's own, each listened on until released.
pub(crate) struct ClaudeSessionInboxes {
    addresser: Arc<dyn SessionInboxAddresser>,
    session_wakes: Arc<PortRegistration<Arc<dyn SessionWaker>>>,
    slots: ClaudeSessionSlots,
    idle_sleep: Arc<ClaudeIdleSleep>,
    // Made with the daemon's inbox, at the first session's bind.
    forwarding: OnceLock<Arc<ClaudeInboxForwarding>>,
    daemon_inbox: Mutex<Option<JoinHandle<()>>>,
    session_inboxes: Mutex<HashMap<SessionId, JoinHandle<()>>>,
}

/// Why a connection to a session's inbox reached no process of the session.
#[derive(Debug, thiserror::Error)]
enum ClaudeInboxRefusal {
    /// The wake answered, but no process of the session is up.
    #[error("the session has no process to pass the message to")]
    NoProcess,
    /// The session's process named no inbox socket of its own.
    #[error("the session's process names no inbox socket")]
    NoProcessSocket,
}

impl ClaudeSessionInboxes {
    /// The inboxes at the addresses `addresser` gives, waking a sleeping session through
    /// `session_wakes` and passing each connection to the process `slots` holds live.
    pub(crate) fn new(
        addresser: Arc<dyn SessionInboxAddresser>,
        session_wakes: Arc<PortRegistration<Arc<dyn SessionWaker>>>,
        slots: ClaudeSessionSlots,
        idle_sleep: Arc<ClaudeIdleSleep>,
    ) -> Self {
        Self {
            addresser,
            session_wakes,
            slots,
            idle_sleep,
            forwarding: OnceLock::new(),
            daemon_inbox: Mutex::default(),
            session_inboxes: Mutex::default(),
        }
    }

    /// Listens on the session's inbox, and the daemon's own once, unless it already listens; held
    /// until the session's release. A failed bind is recorded and the session runs without an
    /// inbox, as Claude Code runs where its own socket cannot be made.
    pub(crate) async fn bind(self: &Arc<Self>, session_id: SessionId) {
        if lock(&self.session_inboxes).contains_key(&session_id) {
            return;
        }
        if let Err(error) = self.bind_daemon_inbox().await {
            record_inbox_failure(None, "binding the daemon's inbox", &error);
            return;
        }
        let address = self.addresser.session_inbox_address(&session_id, None);
        let listener = match bind_inbox(Path::new(address.as_str())).await {
            Ok(listener) => listener,
            Err(error) => {
                record_inbox_failure(Some(session_id), "binding the session's inbox", &error);
                return;
            }
        };
        let serving = tokio::spawn(serve_session_inbox(
            Arc::downgrade(self),
            session_id,
            address.as_str().to_owned(),
            listener,
        ));
        lock(&self.session_inboxes).insert(session_id, serving);
    }

    /// Stops listening on the session's inbox, which removes its socket, for the session's close
    /// or delete.
    pub(crate) fn release(&self, session_id: SessionId) {
        if let Some(serving) = lock(&self.session_inboxes).remove(&session_id) {
            serving.abort();
        }
    }

    /// Stops listening on every inbox, the daemon's own included, for the driver's shutdown.
    pub(crate) fn release_all(&self) {
        for (_, serving) in lock(&self.session_inboxes).drain() {
            serving.abort();
        }
        if let Some(serving) = lock(&self.daemon_inbox).take() {
            serving.abort();
        }
    }

    // Listens on the daemon's inbox where nothing listens on it yet.
    async fn bind_daemon_inbox(&self) -> io::Result<()> {
        if lock(&self.daemon_inbox).is_some() {
            return Ok(());
        }
        let address = self.addresser.daemon_inbox_address(None);
        let listener = bind_inbox(Path::new(address.as_str())).await?;
        let forwarding = Arc::clone(
            self.forwarding
                .get_or_init(|| Arc::new(ClaudeInboxForwarding::new(address.as_str().to_owned()))),
        );
        let mut daemon_inbox = lock(&self.daemon_inbox);
        if daemon_inbox.is_none() {
            *daemon_inbox = Some(tokio::spawn(serve_daemon_inbox(forwarding, listener)));
        }
        Ok(())
    }

    // Carries one connection to the session's process, waking the session first where it sleeps.
    async fn carry(
        &self,
        session_id: SessionId,
        session_inbox: &str,
        connection: UnixDomainStream,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let forwarding = Arc::clone(
            self.forwarding
                .get()
                .expect("the daemon's inbox is bound before any session's"),
        );
        let (from_sender, mut to_sender) = tokio::io::split(connection);
        let mut from_sender = BufReader::new(from_sender);
        let awake = self
            .slots
            .live_session(session_id)
            .filter(|_| !self.idle_sleep.is_asleep(session_id));
        let (live, held_line) = match awake {
            Some(live) => (live, None),
            None => {
                let mut first_line = Vec::new();
                let Ok(read) = tokio::time::timeout(
                    FIRST_LINE_LIMIT,
                    from_sender.read_until(b'\n', &mut first_line),
                )
                .await
                else {
                    return Ok(());
                };
                read?;
                if !first_line.ends_with(b"\n") {
                    return Ok(());
                }
                self.session_wakes
                    .require_port()?
                    .wake_for_message(session_id)
                    .await?;
                let live = self
                    .slots
                    .live_session(session_id)
                    .ok_or(ClaudeInboxRefusal::NoProcess)?;
                (live, Some(first_line))
            }
        };
        let process_socket = process_socket_of(&live)
            .await
            .ok_or(ClaudeInboxRefusal::NoProcessSocket)?;
        let process = connect_unix_domain_socket(&process_socket).await?;
        let (mut from_process, mut to_process) = tokio::io::split(process);
        let inbound = async {
            let mut line = held_line.unwrap_or_default();
            loop {
                if line.is_empty() && from_sender.read_until(b'\n', &mut line).await? == 0 {
                    break;
                }
                let text = line.strip_suffix(b"\n").unwrap_or(&line);
                if let Some(mut forwarded) = forwarding.forward_line(text, session_inbox) {
                    forwarded.push(b'\n');
                    to_process.write_all(&forwarded).await?;
                }
                line.clear();
            }
            to_process.shutdown().await
        };
        let outbound = tokio::io::copy(&mut from_process, &mut to_sender);
        tokio::try_join!(inbound, outbound)?;
        Ok(())
    }
}

/// The inbox socket a `system/init` frame names for its process; `None` where it names none.
pub(crate) fn read_messaging_socket(init_frame: &str) -> Option<PathBuf> {
    let frame = serde_json::from_str::<Value>(init_frame).ok()?;
    Some(PathBuf::from(frame.get("messaging_socket_path")?.as_str()?))
}

// Binds an inbox at `path`, making its folder private where it is missing; a socket file no
// listener serves, which a stopped daemon left, is replaced.
async fn bind_inbox(path: &Path) -> io::Result<Listener> {
    if let Some(folder) = path.parent() {
        create_missing_private_folders(folder)?;
    }
    match bind_socket_listener(path) {
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            match connect_unix_domain_socket(path).await {
                Err(connect_error) if found_no_listener(&connect_error) => {
                    tokio::fs::remove_file(path).await?;
                    bind_socket_listener(path)
                }
                Ok(_) | Err(_) => Err(error),
            }
        }
        bound => bound,
    }
}

// The socket the session's process listens on: the one its `system/init` named, else the one its
// record in Claude Code's session registry names, which it writes at its start before any turn.
async fn process_socket_of(live: &LiveClaudeSession) -> Option<PathBuf> {
    if let Some(socket) = live.messaging_socket.get() {
        return Some(socket.clone());
    }
    let record = claude_config_folder(&live.spawn_bound_legs.spawn_environment, PathRules::NATIVE)?
        .join(SESSION_REGISTRY_FOLDER)
        .join(format!("{}.json", live.process_identity.process_id));
    let text = tokio::fs::read(&record).await.ok()?;
    let record = serde_json::from_slice::<Value>(&text).ok()?;
    Some(PathBuf::from(record.get("messagingSocketPath")?.as_str()?))
}

// Accepts each connection to one session's inbox and carries it on its own task, until the
// listener's task is aborted, which ends every connection with it.
async fn serve_session_inbox(
    inboxes: Weak<ClaudeSessionInboxes>,
    session_id: SessionId,
    session_inbox: String,
    listener: Listener,
) {
    let session_inbox: Arc<str> = session_inbox.into();
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let connection = match accepted {
                    Ok(connection) => connection,
                    Err(error) => {
                        let step = "accepting an inbox connection";
                        record_inbox_failure(Some(session_id), step, &error);
                        tokio::time::sleep(ACCEPT_RETRY_WAIT).await;
                        continue;
                    }
                };
                let Some(inboxes) = inboxes.upgrade() else {
                    return;
                };
                let session_inbox = Arc::clone(&session_inbox);
                connections.spawn(async move {
                    let carried = inboxes.carry(session_id, &session_inbox, connection).await;
                    if let Err(error) = carried {
                        record_inbox_failure(
                            Some(session_id),
                            "passing an inbox connection to the session's process",
                            &*error,
                        );
                    }
                });
            }
            Some(ended) = connections.join_next() => {
                if let Err(error) = ended {
                    record_inbox_failure(Some(session_id), "carrying an inbox connection", &error);
                }
            }
        }
    }
}

// Reads every line written to the daemon's inbox and passes each answer to a forwarded frame on to
// that frame's sender.
async fn serve_daemon_inbox(forwarding: Arc<ClaudeInboxForwarding>, listener: Listener) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let connection = match accepted {
                    Ok(connection) => connection,
                    Err(error) => {
                        let step = "accepting a connection to the daemon's inbox";
                        record_inbox_failure(None, step, &error);
                        tokio::time::sleep(ACCEPT_RETRY_WAIT).await;
                        continue;
                    }
                };
                let forwarding = Arc::clone(&forwarding);
                connections.spawn(async move {
                    if let Err(error) = pass_answers(&forwarding, connection).await {
                        record_inbox_failure(None, "reading the daemon's inbox", &error);
                    }
                });
            }
            Some(ended) = connections.join_next() => {
                if let Err(error) = ended {
                    record_inbox_failure(None, "reading the daemon's inbox", &error);
                }
            }
        }
    }
}

// Passes each answer one connection to the daemon's inbox carries to the sender of the frame it
// answers; a line that answers no forwarded frame has nowhere to go. Fails as the connection
// cannot be read.
async fn pass_answers(
    forwarding: &ClaudeInboxForwarding,
    connection: UnixDomainStream,
) -> io::Result<()> {
    let mut lines = BufReader::new(connection);
    let mut line = Vec::new();
    while lines.read_until(b'\n', &mut line).await? > 0 {
        let text = line.strip_suffix(b"\n").unwrap_or(&line);
        if let Some((sender_socket, mut answer)) = forwarding.route_answer(text) {
            answer.push(b'\n');
            // A sender that stopped listening misses its answer; the next ones still go.
            if let Err(error) = write_answer(&sender_socket, &answer).await {
                record_inbox_failure(None, "passing an answer to its sender", &error);
            }
        }
        line.clear();
    }
    Ok(())
}

// Writes one answer to the sender listening at `sender_socket`.
async fn write_answer(sender_socket: &Path, answer: &[u8]) -> io::Result<()> {
    let mut sender = connect_unix_domain_socket(sender_socket).await?;
    sender.write_all(answer).await?;
    sender.shutdown().await
}

fn record_inbox_failure(session_id: Option<SessionId>, step: &str, error: &(dyn Error + 'static)) {
    record_unheard_claude_failure(
        DriverDiagnosticKind::SessionInboxFailed,
        session_id,
        step,
        error,
    );
}

#[cfg(test)]
mod tests;
