//! The daemon's relay between a Codex service and the executor that runs its commands. Each
//! account's service gets one relay for its life: the executor, `codex exec-server`, is the
//! daemon's own child on standard input and output, and the service reaches it through a loopback
//! WebSocket the relay serves under a token minted at every start of the service. Every message
//! passes unchanged but two: a command's start, rewritten to run under the command wrapper with
//! the conversation's shell snapshot, and a terminate, held until the wrapper ended the command.

mod bearer_token;
mod command_acts;
mod endpoint;
mod executor;
mod shell_snapshot;
mod start_rewrite;
mod terminate_hold;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use self::bearer_token::RelayBearerToken;
use self::endpoint::RelayEndpoint;
use self::executor::CodexExecutor;
use self::shell_snapshot::ShellSnapshots;
use crate::command::channel::CommandChannel;
use crate::command::running_set::RunningCommandSets;
use crate::command::waiting_checks::InputWaitReader;
use crate::driver::codex::app_server_protocol::EnvironmentAddParams;
use crate::driver::codex::session::errors::CodexError;

/// The id of the environment every relayed conversation's turns name, the relay's executor.
pub(crate) const CODEX_RELAY_ENVIRONMENT_ID: &str = "sidekicks-relay";

/// The arguments that start Codex's executor on its standard input and output.
pub(crate) const CODEX_EXECUTOR_ARGUMENTS: [&str; 3] = ["exec-server", "--listen", "stdio"];

/// The folder under a session's channel folder that its relayed commands' channel opens in.
const RELAY_CHANNEL_FOLDER: &str = "codex-relay";

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
}

/// The session a conversation of the relay's service belongs to; `None` for one the service
/// holds for no session.
pub(crate) type CodexThreadSessions = Arc<dyn Fn(&str) -> Option<SessionId> + Send + Sync>;

/// A command the relay started under its call's id: where it runs and what names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RelayedCommand {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The conversation that ran it.
    pub(crate) thread_id: String,
    /// The executor's handle on its process.
    pub(crate) executor_process_id: String,
    /// Codex's own id for its process, which its item and its background terminal carry.
    pub(crate) terminal_process_id: String,
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
    commands: Mutex<HashMap<String, RelayedCommand>>,
    channels: Mutex<HashMap<SessionId, Arc<SessionChannel>>>,
    snapshots: ShellSnapshots,
}

impl CodexExecRelay {
    /// A relay that has not started, resolving conversations through `thread_sessions` and
    /// calling `on_executor_ended` when a running executor ends, so its service starts again.
    pub(crate) fn new(
        dependencies: Arc<CodexExecRelayDependencies>,
        thread_sessions: CodexThreadSessions,
        on_executor_ended: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        let snapshots =
            ShellSnapshots::new(dependencies.spawner.clone(), &dependencies.data_folder);
        Arc::new_cyclic(|me| Self {
            dependencies,
            thread_sessions,
            on_executor_ended,
            me: me.clone(),
            starting: tokio::sync::Mutex::new(()),
            executor: Mutex::new(None),
            endpoint: Mutex::new(None),
            commands: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            snapshots,
        })
    }

    /// Readies the relay for one start of its service: the executor `command` runs, on
    /// `environment`, is started where none runs, the listener opened once, and a new token
    /// minted, which the answered `environment/add` hands the service. Fails with
    /// `CodexError::Transport` when the executor cannot be started, the port bound or the token
    /// minted.
    pub(crate) async fn start(
        &self,
        command: tokio::process::Command,
        environment: Vec<(String, String)>,
    ) -> Result<EnvironmentAddParams, CodexError> {
        let _starting = self.starting.lock().await;
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
    /// it did not start, or that has closed.
    pub(crate) fn relayed_command(
        &self,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Option<RelayedCommand> {
        lock(&self.commands)
            .get(command_id.as_str())
            .filter(|command| command.session_id == session_id)
            .cloned()
    }

    /// Closes `session_id`'s channel and forgets its commands, once the session has closed.
    /// Fails with the system's error when the channel's folder cannot be removed.
    pub(crate) async fn forget_session(&self, session_id: SessionId) -> std::io::Result<()> {
        lock(&self.commands).retain(|_call, command| command.session_id != session_id);
        let channel = lock(&self.channels).remove(&session_id);
        match channel {
            Some(channel) => channel.channel.close().await,
            None => Ok(()),
        }
    }

    // Makes `executor` the relay's: every open channel admits the parties under it, and its end
    // starts the service again.
    fn take_executor(&self, executor: Arc<CodexExecutor>) {
        lock(&self.commands).clear();
        if let Some(process_id) = executor.process_id() {
            for channel in lock(&self.channels).values() {
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
                tokio::spawn(relay.forward_process_start(Arc::clone(executor), line));
            }
            (Some(_), Some(PROCESS_TERMINATE_METHOD)) => {
                tokio::spawn(relay.forward_terminate(Arc::clone(executor), line));
            }
            _ => forward(executor, line).await,
        }
    }

    /// `session_id`'s channel for its relayed commands, opened and followed at its first command;
    /// `None` while the running commands are not registered or no executor runs.
    async fn session_channel(
        &self,
        session_id: SessionId,
        executor: &CodexExecutor,
    ) -> std::io::Result<Option<Arc<SessionChannel>>> {
        if let Some(channel) = lock(&self.channels).get(&session_id) {
            return Ok(Some(Arc::clone(channel)));
        }
        let (Some(sets), Some(process_id)) = (
            self.dependencies.command_output.port().cloned(),
            executor.process_id(),
        ) else {
            return Ok(None);
        };
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
        let environment = channel
            .environment()
            .into_iter()
            .map(|(name, value)| {
                value
                    .into_string()
                    .map(|value| (name.to_owned(), value))
                    .map_err(|_| {
                        std::io::Error::new(std::io::ErrorKind::InvalidData, "a path is no text")
                    })
            })
            .collect::<std::io::Result<Vec<_>>>()?;
        let watch = channel.watch().await?;
        channel.bind(process_id);
        let followed = crate::command::channel::records::follow_channel_records(
            session_id,
            Arc::clone(&channel),
            watch,
            sets,
            Arc::clone(&self.dependencies.input_waits),
        );
        let follower = tokio::spawn(async move {
            // The watch failing ends the following; the rows keep what Codex reports of them.
            if let Err(error) = followed.await {
                tracing::error!(
                    %session_id,
                    %error,
                    "a Codex session's relayed command channel stopped being followed"
                );
            }
        });
        let opened = Arc::new(SessionChannel {
            channel,
            environment,
            follower,
        });
        let kept = Arc::clone(
            lock(&self.channels)
                .entry(session_id)
                .or_insert_with(|| Arc::clone(&opened)),
        );
        Ok(Some(kept))
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
