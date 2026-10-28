//! A command's start as the relay passes it on. Every start's environment turns git's terminal
//! prompt off. Where the command wrapper runs, its git and ssh prompts also go to the askpass, and
//! a start a conversation's call made runs under the wrapper, which tells the session's channel of
//! it: its own name moved to the wrapper's `--arg0`, and a login shell's line run after the
//! conversation's snapshot, as Codex's own path runs it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::RUNS_COMMAND_WRAPPER;
use sidekicks_std::mutex_lock::lock;

use crate::command::askpass::{GIT_TERMINAL_PROMPT_OFF, command_prompt_environment};
use crate::driver::codex::exec_relay::executor::CodexExecutor;
use crate::driver::codex::exec_relay::shell_snapshot::wrap::wrap_with_snapshot;
use crate::driver::codex::exec_relay::{CodexExecRelay, RelayedCommand, forward};

/// The wrapper's flags ahead of a relayed command's own words.
const CONVERSATION_FLAG: &str = "--conversation";
const PROCESS_FLAG: &str = "--process";
const ARG0_FLAG: &str = "--arg0";
const TTY_FLAG: &str = "--tty";
const WORDS_SEPARATOR: &str = "--";

// The members of a start the relay reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRead {
    process_id: String,
    metadata: Option<StartMetadata>,
    #[serde(default)]
    argv: Vec<String>,
    cwd: Option<String>,
    shell_snapshot: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartMetadata {
    thread_id: Option<String>,
    tool_call_id: Option<String>,
}

/// What a relayed start runs under: the wrapper, the session's channel and the snapshot.
pub(super) struct WrappedStart<'start> {
    /// The command wrapper's link.
    pub(super) wrapper_program: &'start Path,
    /// The session's channel folder.
    pub(super) channel_folder: &'start Path,
    /// The variables that reach the channel.
    pub(super) channel_environment: &'start [(String, String)],
    /// Codex's own id for the command's process, which the wrapper pairs its row by.
    pub(super) terminal_process_id: &'start str,
    /// The conversation's snapshot, where one was taken.
    pub(super) snapshot: Option<&'start Path>,
}

/// Adds the prompt variables to the start `params`: git's terminal prompt off always, and where
/// the wrapper runs, the askpass's at `askpass_program`.
pub(super) fn add_prompt_environment(params: &mut Map<String, Value>, askpass_program: &Path) {
    let environment = params
        .entry("env")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(environment) = environment {
        let (prompt_variable, prompt_off) = GIT_TERMINAL_PROMPT_OFF;
        environment.insert(
            prompt_variable.to_owned(),
            Value::String(prompt_off.to_owned()),
        );
        if RUNS_COMMAND_WRAPPER {
            for (name, value) in command_prompt_environment(askpass_program) {
                environment.insert(name.to_owned(), Value::String(value));
            }
        }
    }
}

/// Rewrites the start `params` to run under the wrapper as `wrapped` says: the channel's
/// variables join its environment, a login shell's line is wrapped with the snapshot, and its own
/// name and terminal move to the wrapper's flags.
pub(super) fn wrap_start(params: &mut Map<String, Value>, wrapped: &WrappedStart<'_>) {
    let mut environment = match params.remove("env") {
        Some(Value::Object(environment)) => environment,
        _ => Map::new(),
    };
    for (name, value) in wrapped.channel_environment {
        environment.insert(name.clone(), Value::String(value.clone()));
    }
    let argv: Vec<String> = params
        .get("argv")
        .and_then(Value::as_array)
        .map(|words| {
            words
                .iter()
                .filter_map(|word| word.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let words = wrapped
        .snapshot
        .and_then(|snapshot| wrap_with_snapshot(&argv, snapshot, &environment))
        .unwrap_or(argv);
    let mut rewritten = vec![
        wrapped.wrapper_program.to_string_lossy().into_owned(),
        CONVERSATION_FLAG.to_owned(),
        wrapped.channel_folder.to_string_lossy().into_owned(),
        PROCESS_FLAG.to_owned(),
        wrapped.terminal_process_id.to_owned(),
    ];
    if let Some(arg0) = params.get("arg0").and_then(Value::as_str) {
        rewritten.extend([ARG0_FLAG.to_owned(), arg0.to_owned()]);
    }
    if params.get("tty").and_then(Value::as_bool) == Some(true) {
        rewritten.push(TTY_FLAG.to_owned());
    }
    rewritten.push(WORDS_SEPARATOR.to_owned());
    rewritten.extend(words);
    params.insert(
        "argv".to_owned(),
        Value::Array(rewritten.into_iter().map(Value::String).collect()),
    );
    params.insert("arg0".to_owned(), Value::Null);
    params.insert("env".to_owned(), Value::Object(environment));
}

/// Codex's own id for a process the executor names `executor_process_id`, which Codex writes
/// as that id, a dash and a fresh UUID.
pub(super) fn terminal_process_id(executor_process_id: &str) -> &str {
    executor_process_id
        .split_once('-')
        .map_or(executor_process_id, |(terminal, _fresh)| terminal)
}

impl CodexExecRelay {
    /// Passes the start in `line` on to `executor`, rewritten as this module says, recording the
    /// command under its call so the person's acts reach it; a start that cannot be read passes
    /// as it came.
    pub(super) async fn forward_process_start(
        self: Arc<Self>,
        executor: Arc<CodexExecutor>,
        line: String,
    ) {
        let Ok(mut message) = serde_json::from_str::<Map<String, Value>>(&line) else {
            forward(&executor, line).await;
            return;
        };
        let Some(read) = message
            .get("params")
            .and_then(|params| StartRead::deserialize(params).ok())
        else {
            forward(&executor, line).await;
            return;
        };
        let started = self.relayed_start(&read);
        if let Some(Value::Object(params)) = message.get_mut("params") {
            add_prompt_environment(params, &self.dependencies.askpass_program);
            if let Some((command, session_id)) = &started
                && RUNS_COMMAND_WRAPPER
                && read.shell_snapshot.is_none()
            {
                self.wrap_relayed_start(params, &executor, &read, command, *session_id)
                    .await;
            }
        }
        let call = read.metadata.and_then(|metadata| metadata.tool_call_id);
        let Some(((command, _session_id), call)) = started.zip(call) else {
            forward(&executor, Value::Object(message).to_string()).await;
            return;
        };
        // Watched before the start goes out, so an end that comes first is kept.
        let mut exited = executor.watch_exit(&command.executor_process_id);
        lock(&self.commands).insert(call.clone(), command);
        forward(&executor, Value::Object(message).to_string()).await;
        // A command is forgotten once it ends, so the record holds only running ones.
        let relay = Arc::downgrade(&self);
        drop((self, executor));
        if exited.wait_for(|is_exited| *is_exited).await.is_ok()
            && let Some(relay) = relay.upgrade()
        {
            lock(&relay.commands).remove(&call);
        }
    }

    // The command a start a session's call made runs, and its session; `None` for a start no
    // call of a session's conversation made.
    fn relayed_start(&self, read: &StartRead) -> Option<(RelayedCommand, SessionId)> {
        let metadata = read.metadata.as_ref()?;
        metadata.tool_call_id.as_ref()?;
        let thread_id = metadata.thread_id.clone()?;
        let session_id = (self.thread_sessions)(&thread_id)?;
        Some((
            RelayedCommand {
                session_id,
                thread_id,
                executor_process_id: read.process_id.clone(),
                terminal_process_id: terminal_process_id(&read.process_id).to_owned(),
            },
            session_id,
        ))
    }

    // Wraps the start in `params` for `session_id`'s channel; left as it is, logged, where the
    // channel cannot be opened, and as it is while no running commands are registered.
    async fn wrap_relayed_start(
        &self,
        params: &mut Map<String, Value>,
        executor: &CodexExecutor,
        read: &StartRead,
        command: &RelayedCommand,
        session_id: SessionId,
    ) {
        let channel = match self.session_channel(session_id, executor).await {
            Ok(Some(channel)) => channel,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    %error,
                    "a Codex session's command channel could not be opened; its command runs \
                     unwrapped"
                );
                return;
            }
        };
        let working_folder = read.cwd.as_deref().and_then(read_working_folder);
        let snapshot = match (read.argv.first(), working_folder) {
            (Some(shell), Some(working_folder))
                if read.argv.get(1).is_some_and(|flag| flag == "-lc") =>
            {
                self.snapshots
                    .snapshot_for(&command.thread_id, shell, &working_folder)
                    .await
            }
            _ => None,
        };
        wrap_start(
            params,
            &WrappedStart {
                wrapper_program: &self.dependencies.wrapper_program,
                channel_folder: channel.channel.folder(),
                channel_environment: &channel.environment,
                terminal_process_id: &command.terminal_process_id,
                snapshot: snapshot.as_deref(),
            },
        );
    }
}

// The folder a start's `cwd`, a `file:` address, names.
fn read_working_folder(cwd: &str) -> Option<PathBuf> {
    url::Url::parse(cwd).ok()?.to_file_path().ok()
}
