//! The daemon's relay between a Codex service and the executor that runs its commands. Each
//! account's service gets one relay for its life: the executor, `codex exec-server`, is the
//! daemon's own child on standard input and output, and the service reaches it through a loopback
//! WebSocket the relay serves under a token minted at every start of the service. Every message
//! passes unchanged but two: a command's start, rewritten to run under the command wrapper with
//! the conversation's shell snapshot, and a terminate, held until the wrapper ended the command.
//! A command whose service was restarted while it ran is ended by the relay at its process's end,
//! since the new service never reports the old one's items.

mod bearer_token;
mod command_acts;
mod endpoint;
mod executor;
mod shell_snapshot;
mod start_rewrite;
mod terminate_hold;

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::command::{CommandId, ExitCode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::{OnceCell, mpsc};
use tokio::task::JoinHandle;

use self::bearer_token::RelayBearerToken;
use self::endpoint::RelayEndpoint;
use self::executor::{CodexExecutor, ProcessEnd};
use self::shell_snapshot::ShellSnapshots;
use crate::command::channel::CommandChannel;
use crate::command::running_set::RunningCommandSets;
use crate::command::waiting_checks::InputWaitReader;
use crate::driver::codex::app_server_protocol::EnvironmentAddParams;
use crate::driver::codex::session::errors::CodexError;
use crate::port::running_command_publisher::{ProviderCommandEnd, RunningCommandPublisher as _};

/// The id of the environment every relayed conversation's turns name, the relay's executor.
pub(crate) const CODEX_RELAY_ENVIRONMENT_ID: &str = "sidekicks-relay";

/// The arguments that start Codex's executor on its standard input and output.
pub(crate) const CODEX_EXECUTOR_ARGUMENTS: [&str; 3] = ["exec-server", "--listen", "stdio"];

/// The folder under a session's channel folder that its relayed commands' channel opens in.
const RELAY_CHANNEL_FOLDER: &str = "codex-relay";

/// The handshake every executor connection opens with.
const INITIALIZE_METHOD: &str = "initialize";
const INITIALIZED_METHOD: &str = "initialized";
const PROCESS_START_METHOD: &str = "process/start";
const PROCESS_TERMINATE_METHOD: &str = "process/terminate";

/// The channel folder of `session_id`'s relayed commands under `command_channel_root`, which the
/// session's command sandbox lets commands write.
pub(crate) fn compose_codex_command_channel_folder(
    command_channel_root: &Path,
    session_id: SessionId,
) -> PathBuf {
    command_channel_root
        .join(session_id.to_string())
        .join(RELAY_CHANNEL_FOLDER)
}

/// What every relay of one driver starts and reports through.
pub(crate) struct CodexExecRelayDependencies {
    /// The daemon's spawner thread, which starts the executor and each snapshot's shell.
    pub(crate) spawner: Spawner,
    /// The daemon's data folder, under which the snapshots are written.
    pub(crate) data_folder: PathBuf,
    /// The folder each session's command channel opens under.
    pub(crate) command_channel_root: PathBuf,
    /// Reads where a channel party's process sits, for its admission.
    pub(crate) caller_processes: Arc<dyn CallerProcessReader>,
    /// Reads whether a command waits for input.
    pub(crate) input_waits: Arc<dyn InputWaitReader>,
    /// The running commands every channel's records reach.
    pub(crate) command_output: Arc<PortRegistration<Arc<RunningCommandSets>>>,
    /// The command wrapper's link, absolute.
    pub(crate) wrapper_program: PathBuf,
    /// The command askpass's link, absolute.
    pub(crate) askpass_program: PathBuf,
    /// The one removal, per daemon run, of the shell snapshot folders a former run left.
    pub(crate) snapshot_sweep: Arc<OnceCell<()>>,
}

/// The session a conversation of the relay's service belongs to and what kind it is; `None` for
/// one the service holds for no session.
pub(crate) type CodexThreadSessions = Arc<dyn Fn(&str) -> Option<RelayedThread> + Send + Sync>;

/// A conversation of a session, as the relay reads it for a start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RelayedThread {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Whether it is a side question's read-only copy, whose commands ask the person nothing.
    pub(crate) is_side_question: bool,
}

/// A command the relay started under its call's id: where it runs and what names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RelayedCommand {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The conversation that ran it.
    pub(crate) thread_id: String,
    /// The executor's handle on its process.
    pub(crate) executor_process_id: String,
    /// Codex's own id for its process, which its background terminal carries.
    pub(crate) terminal_process_id: String,
    /// Whether the executor writes the person's input to it: it runs on a terminal or keeps its
    /// input open.
    pub(crate) accepts_input: bool,
    /// The start of the service it was started for.
    pub(crate) service_start: u64,
}

/// A started command as the relay keeps it until its item ended or, for a command of a former
/// start of the service, its process did.
struct CommandRecord {
    command: RelayedCommand,
    end: Option<ProcessEnd>,
}

/// One session's channel for its relayed commands, and the follower of its records.
struct SessionChannel {
    channel: Arc<CommandChannel>,
    environment: Vec<(String, String)>,
    follower: JoinHandle<()>,
}

impl Drop for SessionChannel {
    fn drop(&mut self) {
        self.follower.abort();
    }
}

// The members of a client's message the relay routes by.
#[derive(Deserialize)]
struct ClientMessage<'message> {
    #[serde(borrow)]
    id: Option<&'message RawValue>,
    method: Option<String>,
}

/// One service's relay.
pub(crate) struct CodexExecRelay {
    dependencies: Arc<CodexExecRelayDependencies>,
    thread_sessions: CodexThreadSessions,
    on_executor_ended: Arc<dyn Fn() + Send + Sync>,
    me: Weak<Self>,
    starting: tokio::sync::Mutex<()>,
    executor: Mutex<Option<Arc<CodexExecutor>>>,
    endpoint: Mutex<Option<RelayEndpoint>>,
    service_start: AtomicU64,
    commands: Mutex<HashMap<String, CommandRecord>>,
    channels: Mutex<HashMap<SessionId, Arc<OnceCell<Arc<SessionChannel>>>>>,
    snapshots: ShellSnapshots,
    // The process starts Codex sent through the relay, which a test reads.
    #[cfg(test)]
    process_starts: AtomicU64,
}

impl CodexExecRelay {
    /// A relay that has not started, resolving conversations through `thread_sessions` and
    /// calling `on_executor_ended` when a running executor ends, so its service starts again.
    pub(crate) fn new(
        dependencies: Arc<CodexExecRelayDependencies>,
        thread_sessions: CodexThreadSessions,
        on_executor_ended: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        let snapshots = ShellSnapshots::new(
            dependencies.spawner.clone(),
            &dependencies.data_folder,
            Arc::clone(&dependencies.snapshot_sweep),
        );
        Arc::new_cyclic(|me| Self {
            dependencies,
            thread_sessions,
            on_executor_ended,
            me: me.clone(),
            starting: tokio::sync::Mutex::new(()),
            executor: Mutex::new(None),
            endpoint: Mutex::new(None),
            service_start: AtomicU64::new(0),
            commands: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            snapshots,
            #[cfg(test)]
            process_starts: AtomicU64::new(0),
        })
    }

    /// Readies the relay for one start of its service: the executor `command` runs, on
    /// `environment`, is started where none runs, the listener opened once, and a new token
    /// minted, which the answered `environment/add` hands the service. The commands of the
    /// service's former start that already ended are ended now, since no item of theirs will be
    /// reported. Fails with `CodexError::Transport` when the executor cannot be started, the port
    /// bound or the token minted.
    pub(crate) async fn start(
        &self,
        command: tokio::process::Command,
        environment: Vec<(String, String)>,
    ) -> Result<EnvironmentAddParams, CodexError> {
        let _starting = self.starting.lock().await;
        self.service_start.fetch_add(1, Ordering::AcqRel);
        let ended: Vec<_> = {
            let mut commands = lock(&self.commands);
            let calls: Vec<String> = commands
                .iter()
                .filter(|(_call, record)| record.end.is_some())
                .map(|(call, _record)| call.clone())
                .collect();
            calls
                .into_iter()
                .filter_map(|call| commands.remove_entry(&call))
                .collect()
        };
        for (call, record) in ended {
            self.end_row(&call, &record.command, record.end);
        }
        let is_running = lock(&self.executor)
            .as_ref()
            .is_some_and(|executor| executor.is_running());
        if !is_running {
            self.snapshots.set_environment(environment);
            let executor = CodexExecutor::start(&self.dependencies.spawner, command).await?;
            self.take_executor(executor);
        }
        let token = RelayBearerToken::mint().map_err(|error| CodexError::Transport {
            detail: "The Codex relay's token could not be minted.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
        let has_endpoint = lock(&self.endpoint).is_some();
        if !has_endpoint {
            let endpoint = RelayEndpoint::listen(self.me.clone(), token)
                .await
                .map_err(|error| CodexError::Transport {
                    detail: "The Codex relay could not listen.".to_owned(),
                    cause: Some(Box::new(error)),
                })?;
            *lock(&self.endpoint) = Some(endpoint);
        } else if let Some(endpoint) = lock(&self.endpoint).as_ref() {
            endpoint.replace_token(token);
        }
        let endpoint = lock(&self.endpoint);
        let endpoint = endpoint
            .as_ref()
            .expect("the relay's listener is open once its start reaches here");
        Ok(EnvironmentAddParams {
            auth_bearer_token: Some(endpoint.token().text().to_owned()),
            connect_timeout_ms: None,
            environment_id: CODEX_RELAY_ENVIRONMENT_ID.to_owned(),
            exec_server_url: endpoint.url(),
            skills: None,
            websocket_request_id: None,
        })
    }

    /// The command the relay started for `session_id` under the call `command_id`; `None` for one
    /// it did not start, or whose process has ended.
    pub(crate) fn relayed_command(
        &self,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Option<RelayedCommand> {
        lock(&self.commands)
            .get(command_id.as_str())
            .filter(|record| record.command.session_id == session_id && record.end.is_none())
            .map(|record| record.command.clone())
    }

    /// Forgets the command of the call `command_id`, whose item ended.
    pub(crate) fn command_completed(&self, command_id: &CommandId) {
        lock(&self.commands).remove(command_id.as_str());
    }

    /// Closes `session_id`'s channel, removing the session's folder once nothing else is in it,
    /// and forgets its commands and its conversations' snapshots, once the session has closed.
    /// Fails with the system's error when a folder cannot be removed.
    pub(crate) async fn forget_session(&self, session_id: SessionId) -> std::io::Result<()> {
        lock(&self.commands).retain(|_call, record| record.command.session_id != session_id);
        self.snapshots.forget_session(session_id).await;
        let channel = lock(&self.channels).remove(&session_id);
        let Some(channel) = channel.and_then(|cell| cell.get().cloned()) else {
            return Ok(());
        };
        channel.channel.close().await?;
        let session_folder = compose_codex_command_channel_folder(
            &self.dependencies.command_channel_root,
            session_id,
        );
        match session_folder.parent().map(tokio::fs::remove_dir) {
            Some(removed) => match removed.await {
                Err(error)
                    if !matches!(
                        error.kind(),
                        ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
                    ) =>
                {
                    Err(error)
                }
                _ => Ok(()),
            },
            None => Ok(()),
        }
    }

    /// How many process starts Codex sent through the relay.
    #[cfg(test)]
    pub(crate) fn process_starts(&self) -> u64 {
        self.process_starts.load(Ordering::Relaxed)
    }

    // The start of the service now, which a command started now is stamped with.
    fn current_service_start(&self) -> u64 {
        self.service_start.load(Ordering::Acquire)
    }

    // Keeps `command`, the call `call`, until its item or its process ends.
    fn record_command(&self, call: String, command: RelayedCommand) {
        lock(&self.commands).insert(call, CommandRecord { command, end: None });
    }

    // Forgets the call `call`, whose start the executor refused.
    fn forget_command(&self, call: &str) {
        lock(&self.commands).remove(call);
    }

    // The process of the call `call` ended as `end`: a command of the service's current start
    // waits for its item, which ends its row; one of a former start ends its row now.
    fn command_exited(&self, call: &str, end: Option<ProcessEnd>) {
        let current = self.current_service_start();
        let ended = {
            let mut commands = lock(&self.commands);
            let Some(record) = commands.get_mut(call) else {
                return;
            };
            if record.command.service_start == current {
                record.end = end;
                return;
            }
            commands.remove(call)
        };
        if let Some(record) = ended {
            self.end_row(call, &record.command, end);
        }
    }

    // Ends the row of `command`, the call `call`, with the exit code its process ended with.
    fn end_row(&self, call: &str, command: &RelayedCommand, end: Option<ProcessEnd>) {
        let (Some(sets), Some(command_id)) = (
            self.dependencies.command_output.port(),
            CommandId::new(call.to_owned()),
        ) else {
            return;
        };
        let exit_code = end
            .and_then(|end| end.exit_code)
            .and_then(|code| ExitCode::new(i64::from(code)));
        sets.command_ended(
            command.session_id,
            command_id,
            ProviderCommandEnd {
                exit_code,
                is_stopped_by_provider: false,
                summary: None,
            },
        );
    }

    // Makes `executor` the relay's: every open channel admits the parties under it, and its end
    // starts the service again. The former executor's commands end as its connection did.
    fn take_executor(&self, executor: Arc<CodexExecutor>) {
        if let Some(process_id) = executor.process_id() {
            for channel in lock(&self.channels).values().filter_map(|cell| cell.get()) {
                channel.channel.bind(process_id);
            }
        }
        let mut ended = executor.ended();
        let on_executor_ended = Arc::clone(&self.on_executor_ended);
        tokio::spawn(async move {
            if ended.wait_for(|is_ended| *is_ended).await.is_ok() {
                on_executor_ended();
            }
        });
        *lock(&self.executor) = Some(executor);
    }

    /// Makes `client` the connection the executor answers; `None` while no executor runs.
    fn attach_client(&self, client: mpsc::Sender<String>) -> Option<Arc<CodexExecutor>> {
        let executor = lock(&self.executor).clone()?;
        executor.attach_client(client);
        Some(executor)
    }

    /// Carries one of the client's messages to `executor`: an `initialize` is answered with the
    /// executor's own, an `initialized` is already sent, a start and a terminate go through their
    /// tasks, and everything else passes as it came.
    async fn take_client_message(&self, executor: &Arc<CodexExecutor>, text: String) {
        let line = one_line(text);
        let Ok(message) = serde_json::from_str::<ClientMessage<'_>>(&line) else {
            forward(executor, line).await;
            return;
        };
        let Some(relay) = self.me.upgrade() else {
            return;
        };
        match (message.id, message.method.as_deref()) {
            (Some(id), Some(INITIALIZE_METHOD)) => {
                let answer = json!({ "id": id, "result": executor.initialize_result() });
                executor.answer_client(answer.to_string()).await;
            }
            (None, Some(INITIALIZED_METHOD)) => {}
            (Some(_), Some(PROCESS_START_METHOD)) => {
                #[cfg(test)]
                self.process_starts.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(relay.forward_process_start(Arc::clone(executor), line));
            }
            (Some(_), Some(PROCESS_TERMINATE_METHOD)) => {
                tokio::spawn(relay.forward_terminate(Arc::clone(executor), line));
            }
            _ => forward(executor, line).await,
        }
    }

    /// `session_id`'s channel for its relayed commands, opened and followed at its first command,
    /// once for the session however many commands start at once; `None` while the running
    /// commands are not registered or no executor runs.
    async fn session_channel(
        &self,
        session_id: SessionId,
        executor: &CodexExecutor,
    ) -> std::io::Result<Option<Arc<SessionChannel>>> {
        let (Some(sets), Some(process_id)) = (
            self.dependencies.command_output.port().cloned(),
            executor.process_id(),
        ) else {
            return Ok(None);
        };
        let cell = Arc::clone(lock(&self.channels).entry(session_id).or_default());
        let channel = cell
            .get_or_try_init(|| async {
                let opened = self
                    .open_session_channel(session_id, sets, process_id)
                    .await?;
                // A session forgotten while its channel opened keeps none, so nothing would close
                // it.
                let is_kept = lock(&self.channels)
                    .get(&session_id)
                    .is_some_and(|kept| Arc::ptr_eq(kept, &cell));
                if is_kept {
                    return Ok(opened);
                }
                opened.channel.close().await?;
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "the session closed while its command channel opened",
                ))
            })
            .await?;
        Ok(Some(Arc::clone(channel)))
    }

    // Opens `session_id`'s channel for the executor `process_id` and follows its records into
    // `sets`; a channel that cannot be followed takes its folder with it.
    async fn open_session_channel(
        &self,
        session_id: SessionId,
        sets: Arc<RunningCommandSets>,
        process_id: u32,
    ) -> std::io::Result<Arc<SessionChannel>> {
        let folder = compose_codex_command_channel_folder(
            &self.dependencies.command_channel_root,
            session_id,
        );
        let caller_processes = Arc::clone(&self.dependencies.caller_processes);
        let channel =
            tokio::task::spawn_blocking(move || CommandChannel::open(folder, caller_processes))
                .await
                .map_err(std::io::Error::other)??;
        let channel = Arc::new(channel);
        match self
            .follow_session_channel(session_id, &channel, sets, process_id)
            .await
        {
            Ok(followed) => Ok(followed),
            Err(error) => {
                if let Err(close_error) = channel.close().await {
                    tracing::warn!(
                        %session_id,
                        error = &close_error as &(dyn std::error::Error + 'static),
                        "a command channel that could not be followed left its folder behind"
                    );
                }
                Err(error)
            }
        }
    }

    // The opened `channel` bound to the executor `process_id` and followed into `sets`.
    async fn follow_session_channel(
        &self,
        session_id: SessionId,
        channel: &Arc<CommandChannel>,
        sets: Arc<RunningCommandSets>,
        process_id: u32,
    ) -> std::io::Result<Arc<SessionChannel>> {
        let environment = channel
            .environment()
            .into_iter()
            .map(|(name, value)| {
                value
                    .into_string()
                    .map(|value| (name.to_owned(), value))
                    .map_err(|value| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!("the path {} is no text", value.to_string_lossy()),
                        )
                    })
            })
            .collect::<std::io::Result<Vec<_>>>()?;
        let watch = channel.watch().await?;
        channel.bind(process_id);
        // The relay's channel serves the session's own service, never a run's process apart.
        let followed = crate::command::channel::records::follow_channel_records(
            session_id,
            None,
            Arc::clone(channel),
            watch,
            sets,
            Arc::clone(&self.dependencies.input_waits),
        );
        let follower = tokio::spawn(async move {
            // The watch failing ends the following; the rows keep what Codex reports of them.
            if let Err(error) = followed.await {
                tracing::error!(
                    %session_id,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a Codex session's relayed command channel stopped being followed"
                );
            }
        });
        Ok(Arc::new(SessionChannel {
            channel: Arc::clone(channel),
            environment,
            follower,
        }))
    }
}

// `text` as one line: a raw line break in JSON can only be whitespace between its tokens.
fn one_line(text: String) -> String {
    if text.contains(['\n', '\r']) {
        text.replace(['\n', '\r'], " ")
    } else {
        text
    }
}

// Passes `line` on to the executor as it came.
async fn forward(executor: &CodexExecutor, line: String) {
    if let Err(error) = executor.send_line(line).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a message for the Codex executor could not be sent"
        );
    }
}

#[cfg(test)]
mod tests;
