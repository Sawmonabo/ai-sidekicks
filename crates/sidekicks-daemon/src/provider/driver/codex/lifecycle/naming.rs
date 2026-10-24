//! A Codex session's name: drawn from its first exchange in one short pass of Codex's own, on a
//! throwaway, read-only conversation with no tool, MCP server or hook, on the session's service
//! where its conversation is live, else in a one-shot `codex exec`; and told to Codex with
//! `thread/name/set`, so its own session list shows it. A conversation the person's own terminal
//! already named keeps that name.

mod lockdown;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::CodexDriver;
use crate::provider::driver::codex::app_server_protocol::{
    AskForApproval, ConfigReadParams, SandboxMode, ThreadReadParams, ThreadSetNameParams,
    ThreadSource, ThreadStartParams,
};
use crate::provider::driver::codex::attachments::compose_codex_text_input;
use crate::provider::driver::codex::capabilities::read_codex_service_model_catalog;
use crate::provider::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::provider::driver::codex::lifecycle::views::CodexConversationView;
use crate::provider::driver::codex::service::command::run_codex_command;
use crate::provider::driver::codex::service::home::CodexServiceKind;
use crate::provider::driver::codex::service::supervisor::start::compose_codex_native_launch;
use crate::provider::driver::codex::service::supervisor::{CodexService, CodexServiceDependencies};
use crate::provider::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames, stop_detached_turn,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::thread::settings::CodexTurnStartParams;
use crate::provider::driver::codex::thread::view::{read_thread, read_turn_id};
use crate::provider::driver::codex::transport::connection::{
    CodexAppServerConnection, read_codex_object,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::session_control::NameSessionParams;
use crate::provider::runtime_binding::resume::read_session_leg;
use crate::provider::spawned_version::ResolvedProviderExecutable;

const CONFIG_READ_METHOD: &str = "config/read";

const THREAD_START_METHOD: &str = "thread/start";

const THREAD_READ_METHOD: &str = "thread/read";

const THREAD_NAME_SET_METHOD: &str = "thread/name/set";

const TURN_START_METHOD: &str = "turn/start";

/// The item type of the pass's reply.
const CODEX_AGENT_MESSAGE_ITEM_TYPE: &str = "agentMessage";

/// What a title conversation is started from, as Codex names its own title pass's.
const TITLE_THREAD_SOURCE: &str = "thread_title";

/// The sandbox a title conversation's start must answer it runs under.
const READ_ONLY_SANDBOX_TYPE: &str = "readOnly";

/// The longest answer a pass reads a title from, in UTF-8 bytes; a longer one names nothing.
const TITLE_ANSWER_MAX_BYTES: usize = 8 * 1024;

/// The file the one-shot pass reads its answer's schema from, in its own empty folder.
const TITLE_SCHEMA_FILE_NAME: &str = "title-schema.json";

/// The file the one-shot pass writes its last answer to, beside the schema.
const TITLE_ANSWER_FILE_NAME: &str = "title.json";

/// How long `codex mcp list` may take to name the servers the one-shot pass disables, well inside
/// the pass's own bound.
const CODEX_SERVER_LIST_DEADLINE: Duration = Duration::from_secs(10);

/// How long either pass's turn may take to answer.
const CODEX_NAMING_DEADLINE: Duration = Duration::from_secs(90);

/// Codex's small model, which its own terminal names a conversation with where the account's
/// catalog offers it.
const TITLE_MODEL: &str = "gpt-5.6-luna";

/// The effort the small title model answers at.
const TITLE_MODEL_EFFORT: &str = "low";

/// The config keys of the model and its effort, which the one-shot pass sets as overrides.
const MODEL_KEY: &str = "model";

const REASONING_EFFORT_KEY: &str = "model_reasoning_effort";

/// The words the pass names the session by.
const TITLE_INSTRUCTIONS: &str = "Name this coding session from its first exchange below, in at \
                                  most six words, as a title would read. Answer with the title \
                                  alone.";

impl CodexDriver {
    /// The session's name from its first exchange: on the session's live service, a name the
    /// person's own terminal gave its conversation first, else a pass there; with no live leg, a
    /// failed pass or no name, a one-shot pass of Codex's program on the account the session's
    /// leg runs on. `None` when both gave no name, the session never ran, or once `cancel` fired.
    /// Fails as the stored leg cannot be read, the one-shot pass's launch cannot be composed or
    /// the MCP servers it disables cannot be listed.
    pub(crate) async fn name_session(
        &self,
        params: NameSessionParams,
    ) -> Result<Option<String>, DriverError> {
        let cancel = params.cancel;
        let prompt = compose_title_prompt(&params.first_message, &params.first_reply);
        // The one-shot pass runs on the session's own account, live or at rest.
        let (service, session_model) =
            if let Some(conversation) = self.views.conversation(params.session_id) {
                let service = Arc::clone(&conversation.service);
                let session_model = conversation.model.clone();
                // On a task of its own, so a caller that stops waiting still has its turn stopped.
                let pass = self.tasks.spawn(name_on_service(
                    conversation,
                    prompt.clone(),
                    cancel.clone(),
                ));
                match pass.await {
                    Ok(Ok(Some(name))) => return Ok(Some(name)),
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => tracing::info!(
                        error = &error as &(dyn std::error::Error + 'static),
                        session_id = %params.session_id,
                        "a codex session's name could not be drawn on its service"
                    ),
                    Err(error) => tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        session_id = %params.session_id,
                        "a codex session's naming pass on its service ended unfinished"
                    ),
                }
                (service, Some(session_model))
            } else {
                let leg = tokio::select! {
                    () = cancel.cancelled() => return Ok(None),
                    leg = read_session_leg(&self.reads, params.session_id) => leg?,
                };
                // A session that never ran has no exchange to name.
                let Some(leg) = leg else {
                    return Ok(None);
                };
                let account = leg.spawn_config.provider_account_id;
                tokio::select! {
                    () = cancel.cancelled() => return Ok(None),
                    service = self.registry.service_for(account.as_ref()) => (service?, None),
                }
            };
        tokio::select! {
            biased;
            () = cancel.cancelled() => Ok(None),
            named = name_in_one_shot(&service, &prompt, session_model.as_deref()) => Ok(named?),
        }
    }

    /// Tells Codex the name the session goes by: on its live conversation, else on its stored
    /// one, on the service of the account its leg ran on, started for the call; a session that
    /// never ran has no conversation to name and answers at once. Fails as the stored leg cannot be
    /// read, the service cannot start, or Codex refuses the name, an archived conversation among
    /// them.
    pub(crate) async fn tell_session_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> Result<(), DriverError> {
        let (service, thread_id) = if let Some(CodexConversationView {
            service, thread_id, ..
        }) = self.views.conversation(session_id)
        {
            (service, thread_id)
        } else {
            let Some(leg) = read_session_leg(&self.reads, session_id).await? else {
                return Ok(());
            };
            let Some(thread_id) = leg.resume_handle else {
                return Ok(());
            };
            let service = self
                .registry
                .service_for(leg.spawn_config.provider_account_id.as_ref())
                .await?;
            service
                .ensure_started(service.dependencies().startup_timeout)
                .await?;
            (service, thread_id)
        };
        service
            .connection()?
            .request(
                THREAD_NAME_SET_METHOD,
                &ThreadSetNameParams { name, thread_id },
            )
            .await?;
        Ok(())
    }
}

// The person's first message and the reply, under the naming instructions.
fn compose_title_prompt(first_message: &str, first_reply: &str) -> String {
    format!(
        "{TITLE_INSTRUCTIONS}\n\nThe person's message:\n{first_message}\n\nThe reply:\n\
         {first_reply}"
    )
}

// The schema the pass's answer meets: one title.
fn title_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "title": { "type": "string" } },
        "required": ["title"],
        "additionalProperties": false,
    })
}

#[derive(Deserialize)]
struct TitleAnswer {
    title: String,
}

// The title an answer holds, trimmed; `None` for one that holds none or runs past the cap.
fn read_title(answer: &str) -> Option<String> {
    if answer.len() > TITLE_ANSWER_MAX_BYTES {
        return None;
    }
    let title = serde_json::from_str::<TitleAnswer>(answer.trim())
        .ok()?
        .title;
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

// The name the person's own terminal gave a joined service's conversation, else one drawn on a
// throwaway conversation of `conversation`'s service over a connection of its own; `None` once
// `cancel` fired.
async fn name_on_service(
    conversation: CodexConversationView,
    prompt: String,
    cancel: CancellationToken,
) -> Result<Option<String>, CodexError> {
    let (events, mut frames) = CodexDetachedFrames::new();
    let service = &conversation.service;
    let connection = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(None),
        connection = service.open_detached_connection(events) => connection?,
    };
    // The throwaway conversation is ephemeral, so it ends with the connection, dropped here.
    draw_title(
        &connection,
        &mut frames,
        &TitleRequest {
            thread_id: &conversation.thread_id,
            is_joined: service.kind() == CodexServiceKind::Joined,
            working_directory: &conversation.working_directory.to_string_lossy(),
            session_model: &conversation.model,
            prompt: &prompt,
        },
        &cancel,
    )
    .await
}

/// What a title pass on a live service reads of the session's conversation.
struct TitleRequest<'pass> {
    /// The session's conversation, whose given name a joined service is asked for.
    thread_id: &'pass str,
    /// Whether the service is the person's own, where their terminal may have named it.
    is_joined: bool,
    /// The session's folder, whose config the title conversation is read and started under.
    working_directory: &'pass str,
    /// The session's model, which the title turn runs on where the small title model is not
    /// offered.
    session_model: &'pass str,
    /// The pass's prompt.
    prompt: &'pass str,
}

/// How a title conversation's start went: a name the conversation already had, or the
/// conversation started with the effort its turn runs at.
enum TitleThread {
    /// The person's own terminal named the conversation.
    Named(String),
    /// A throwaway conversation started.
    Started {
        /// The conversation.
        thread_id: String,
        /// The effort its turn runs at, `None` on the session's own model.
        effort: Option<&'static str>,
    },
}

// The title of `request`'s conversation drawn over `connection`, whose notifications arrive on
// `frames`, as `start_title_thread` starts it; `None` once `cancel` fired. A turn the pass leaves
// before it ends, at its deadline or its cancel, is stopped first, one canceled during its start
// once the start named it.
async fn draw_title(
    connection: &CodexAppServerConnection,
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    request: &TitleRequest<'_>,
    cancel: &CancellationToken,
) -> Result<Option<String>, CodexError> {
    let started = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(None),
        started = start_title_thread(connection, request) => started?,
    };
    let (title_thread_id, effort) = match started {
        TitleThread::Named(name) => return Ok(Some(name)),
        TitleThread::Started { thread_id, effort } => (thread_id, effort),
    };
    let turn = CodexTurnStartParams {
        thread_id: title_thread_id.clone(),
        input: vec![compose_codex_text_input(request.prompt.to_owned())],
        approvals_reviewer: None,
        collaboration_mode: None,
        model: None,
        client_user_message_id: None,
        output_schema: Some(title_schema()),
        effort: effort.map(|effort| effort.parse().expect("the title effort is an effort")),
        service_tier: None,
        service_tier_for_turn: None,
    };
    let start = connection.request(TURN_START_METHOD, &turn);
    tokio::pin!(start);
    let reply = tokio::select! {
        biased;
        reply = &mut start => reply?,
        () = cancel.cancelled() => {
            stop_detached_turn(connection, &title_thread_id, async {
                read_turn_id(&(&mut start).await?, TURN_START_METHOD)
            })
            .await;
            return Ok(None);
        }
    };
    let turn_id = read_turn_id(&reply, TURN_START_METHOD)?;
    let answered = tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        answered = tokio::time::timeout(
            CODEX_NAMING_DEADLINE,
            read_title_answer(frames, &title_thread_id),
        ) => answered.ok(),
    };
    let Some(answer) = answered else {
        stop_detached_turn(connection, &title_thread_id, async { Ok(turn_id) }).await;
        return Ok(None);
    };
    Ok(answer.as_deref().and_then(read_title))
}

// A name a joined service's conversation already has, else a throwaway conversation started over
// `connection` that runs read-only on the small title model where the account's catalog offers
// it, with no environment, tool, MCP server, hook or feature. Fails closed when the config naming
// the MCP servers cannot be read or the start does not answer read-only.
async fn start_title_thread(
    connection: &CodexAppServerConnection,
    request: &TitleRequest<'_>,
) -> Result<TitleThread, CodexError> {
    if request.is_joined {
        let reply = connection
            .request(
                THREAD_READ_METHOD,
                &ThreadReadParams {
                    thread_id: request.thread_id.to_owned(),
                    include_turns: Some(false),
                },
            )
            .await?;
        let given = read_codex_object::<ThreadReadReply>(reply.get())
            .and_then(|reply| reply.thread?.name)
            .filter(|name| !name.trim().is_empty());
        if let Some(given) = given {
            return Ok(TitleThread::Named(given));
        }
    }
    let config = connection
        .request(
            CONFIG_READ_METHOD,
            &ConfigReadParams {
                cwd: Some(request.working_directory.to_owned()),
                include_layers: Some(false),
            },
        )
        .await?;
    let server_names = lockdown::read_config_server_names(&config)?;
    let title_model = choose_title_model(Some(connection), Some(request.session_model)).await;
    let reply = connection
        .request(
            THREAD_START_METHOD,
            &ThreadStartParams {
                model: title_model.model,
                cwd: Some(request.working_directory.to_owned()),
                ephemeral: Some(true),
                sandbox: Some(SandboxMode::ReadOnly),
                approval_policy: Some(AskForApproval::Never),
                runtime_workspace_roots: Some(Vec::new()),
                environments: Some(Vec::new()),
                dynamic_tools: Some(Vec::new()),
                selected_capability_roots: Some(Vec::new()),
                thread_source: Some(ThreadSource(TITLE_THREAD_SOURCE.to_owned())),
                config: Some(
                    lockdown::compose_title_overrides(&server_names)
                        .into_iter()
                        .collect(),
                ),
                ..ThreadStartParams::default()
            },
        )
        .await?;
    if read_codex_object::<StartedSandbox>(reply.get())
        .and_then(|reply| reply.sandbox)
        .and_then(|sandbox| sandbox.sandbox_type)
        .as_deref()
        != Some(READ_ONLY_SANDBOX_TYPE)
    {
        return Err(CodexError::Transport {
            detail: "Codex did not start the title conversation read-only.".to_owned(),
            cause: None,
        });
    }
    Ok(TitleThread::Started {
        thread_id: read_thread(&reply, THREAD_START_METHOD)?.id,
        effort: title_model.effort,
    })
}

// The last answer the title conversation `title_thread_id` gave once its turn completed, or once
// its connection dropped.
async fn read_title_answer(
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    title_thread_id: &str,
) -> Option<String> {
    let mut answer = None;
    while let Some((method, params)) = frames.recv().await {
        let Some(frame) = read_codex_object::<TitleFrame>(params.get()) else {
            continue;
        };
        if frame.thread_id.as_deref() != Some(title_thread_id) {
            continue;
        }
        match method.as_str() {
            CODEX_ITEM_COMPLETED_METHOD => {
                if let Some(text) = frame
                    .item
                    .filter(|item| item.item_type.as_deref() == Some(CODEX_AGENT_MESSAGE_ITEM_TYPE))
                    .and_then(|item| item.text)
                {
                    answer = Some(text);
                }
            }
            CODEX_TURN_COMPLETED_METHOD => break,
            _ => {}
        }
    }
    answer
}

/// The model and effort a title turn runs on.
struct TitleModel {
    /// The model, `None` for the home's default.
    model: Option<String>,
    /// The effort, `None` for the model's own.
    effort: Option<&'static str>,
}

// Codex's small title model at low effort where the catalog `connection` lists for the account
// offers it, else `session_model` at its own effort; a catalog that cannot be read offers nothing.
async fn choose_title_model(
    connection: Option<&CodexAppServerConnection>,
    session_model: Option<&str>,
) -> TitleModel {
    let is_offered = match connection {
        Some(connection) => match read_codex_service_model_catalog(connection).await {
            Ok(models) => models.iter().any(|model| model.id.as_str() == TITLE_MODEL),
            Err(error) => {
                tracing::info!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "codex's model catalog could not be read for a title pass"
                );
                false
            }
        },
        None => false,
    };
    if is_offered {
        return TitleModel {
            model: Some(TITLE_MODEL.to_owned()),
            effort: Some(TITLE_MODEL_EFFORT),
        };
    }
    TitleModel {
        model: session_model.map(str::to_owned),
        effort: None,
    }
}

// One `codex exec` of the account's home, ephemeral and in an empty folder of its own, under the
// title conversation's config with each MCP server the home lists disabled, its answer held to the
// title's schema. Fails as the launch cannot be composed or the servers cannot be listed.
async fn name_in_one_shot(
    service: &CodexService,
    prompt: &str,
    session_model: Option<&str>,
) -> Result<Option<String>, CodexError> {
    let folder = tempfile::tempdir().map_err(|error| CodexError::Transport {
        detail: "The folder of Codex's naming pass could not be made.".to_owned(),
        cause: Some(Box::new(error)),
    })?;
    let schema_file = folder.path().join(TITLE_SCHEMA_FILE_NAME);
    let answer_file = folder.path().join(TITLE_ANSWER_FILE_NAME);
    tokio::fs::write(&schema_file, title_schema().to_string())
        .await
        .map_err(|error| CodexError::Transport {
            detail: "The schema of Codex's naming pass could not be written.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
    let dependencies = service.dependencies();
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .map_err(CodexError::Driver)?;
    let server_names = list_mcp_server_names(dependencies, &executable).await?;
    // The catalog is read on the service where it is up; the one-shot pass starts none.
    let connection = service.connection().ok();
    let title_model = choose_title_model(connection.as_deref(), session_model).await;
    let mut overrides = lockdown::compose_title_overrides(&server_names);
    overrides.extend(
        title_model
            .model
            .map(|model| (MODEL_KEY.to_owned(), Value::String(model))),
    );
    overrides.extend(title_model.effort.map(|effort| {
        (
            REASONING_EFFORT_KEY.to_owned(),
            Value::String(effort.to_owned()),
        )
    }));
    let mut arguments = lockdown::write_exec_overrides(overrides);
    arguments.extend([
        "exec".to_owned(),
        "--ephemeral".to_owned(),
        "--skip-git-repo-check".to_owned(),
        "--sandbox".to_owned(),
        "read-only".to_owned(),
        "--output-schema".to_owned(),
        schema_file.to_string_lossy().into_owned(),
        "--output-last-message".to_owned(),
        answer_file.to_string_lossy().into_owned(),
        prompt.to_owned(),
    ]);
    let mut launch =
        compose_codex_native_launch(&dependencies.data_folder, &executable, arguments).await?;
    launch.working_folder = folder.path().to_owned();
    // The answer is read from its file, since the pass prints more than the answer.
    match run_codex_command(&dependencies.spawner, launch, CODEX_NAMING_DEADLINE).await {
        Ok(_printed) => match tokio::fs::read_to_string(&answer_file).await {
            Ok(answer) => Ok(read_title(&answer)),
            Err(error) => {
                tracing::info!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "codex's one-shot naming pass wrote no answer"
                );
                Ok(None)
            }
        },
        Err(error) => {
            tracing::info!(
                error = &error as &(dyn std::error::Error + 'static),
                "codex's one-shot naming pass gave no name"
            );
            Ok(None)
        }
    }
}

// The MCP servers `codex mcp list --json` names on the home `executable` runs for. Fails with
// `CodexError::Transport` when the list cannot be run or read.
async fn list_mcp_server_names(
    dependencies: &CodexServiceDependencies,
    executable: &ResolvedProviderExecutable,
) -> Result<Vec<String>, CodexError> {
    let launch = compose_codex_native_launch(
        &dependencies.data_folder,
        executable,
        vec!["mcp".to_owned(), "list".to_owned(), "--json".to_owned()],
    )
    .await?;
    let listing = run_codex_command(&dependencies.spawner, launch, CODEX_SERVER_LIST_DEADLINE)
        .await
        .map_err(|error| CodexError::Transport {
            detail: "Codex's MCP server list could not be read.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
    lockdown::read_listed_server_names(&listing)
}

// The members of a title conversation's frame the pass reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleFrame {
    thread_id: Option<String>,
    item: Option<TitleItem>,
}

#[derive(Deserialize)]
struct TitleItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
}

// The sandbox a title conversation's start answers it runs under.
#[derive(Deserialize)]
struct StartedSandbox {
    sandbox: Option<SandboxReading>,
}

#[derive(Deserialize)]
struct SandboxReading {
    #[serde(rename = "type")]
    sandbox_type: Option<String>,
}

#[derive(Deserialize)]
struct ThreadReadReply {
    thread: Option<ReadThread>,
}

#[derive(Deserialize)]
struct ReadThread {
    name: Option<String>,
}
