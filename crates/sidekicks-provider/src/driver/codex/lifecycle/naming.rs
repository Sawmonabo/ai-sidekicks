//! A Codex session's name: drawn from its first exchange in one short pass of Codex's own, on a
//! throwaway, read-only conversation with no tool, MCP server or hook, on the session's service
//! where its conversation is live, else in a one-shot `codex exec`; and told to Codex with
//! `thread/name/set`, so its own session list shows it. A conversation the person's own terminal
//! already named keeps that name. What a pass spends is recorded and priced as the session's own,
//! counted toward no run, on the binding of its first completed run.

pub(crate) mod exec_turn;
pub(crate) mod lockdown;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{CodexDriver, internal};
use crate::driver::codex::app_server_protocol::{
    AskForApproval, SandboxMode, ThreadSetNameParams, ThreadSource, ThreadStartParams,
};
use crate::driver::codex::attachments::compose_codex_text_input;
use crate::driver::codex::capabilities::read_codex_service_model_catalog;
use crate::driver::codex::config_read::read_codex_config;
use crate::driver::codex::lifecycle::naming::exec_turn::{ExecTurnEnd, read_exec_turn};
use crate::driver::codex::lifecycle::views::CodexConversationView;
use crate::driver::codex::output_speed::read_codex_declared_tier;
use crate::driver::codex::pricing::CodexRecorderPricing;
use crate::driver::codex::service::command::{CodexCommandError, run_codex_command};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceKind};
use crate::driver::codex::service::registry::home_exec_switches;
use crate::driver::codex::service::supervisor::start::compose_codex_native_launch;
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceDependencies};
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames, file_received_usage, read_detached_turn,
    stop_detached_turn,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::side_questions::copy_turn::{CopyTurnMeter, SessionUsageFiling};
use crate::driver::codex::thread::settings::CodexTurnStartParams;
use crate::driver::codex::thread::view::{
    THREAD_START_METHOD, TURN_START_METHOD, read_thread, read_turn_id, request_thread_reading,
};
use crate::driver::codex::transport::connection::{
    CODEX_REQUEST_TIMEOUT, CodexAppServerConnection, read_codex_object,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{NameSessionParams, run_naming_pass_until};
use crate::runtime_binding::store::RuntimeBinding;
use crate::spawned_version::ResolvedProviderExecutable;

const THREAD_NAME_SET_METHOD: &str = "thread/name/set";

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

/// How long `codex mcp list` may take to name the servers a one-shot `codex exec` disables, well
/// inside the pass's own bound.
pub(crate) const CODEX_SERVER_LIST_DEADLINE: Duration = Duration::from_secs(10);

/// How long a whole naming pass may run, its pass on the live service and its one-shot pass
/// together.
const CODEX_NAMING_DEADLINE: Duration = Duration::from_secs(90);

/// Codex's small model, which its own terminal names a conversation with where the account's
/// catalog offers it, and which a window-start turn runs on.
pub(crate) const CODEX_SMALL_MODEL: &str = "gpt-5.6-luna";

/// The effort Codex's small model answers at.
pub(crate) const CODEX_SMALL_MODEL_EFFORT: &str = "low";

/// The config key of the model, which a one-shot `codex exec` sets as an override.
pub(crate) const MODEL_KEY: &str = "model";

/// The config key of the model's effort, which a one-shot `codex exec` sets as an override.
pub(crate) const REASONING_EFFORT_KEY: &str = "model_reasoning_effort";

/// The words the pass names the session by.
const TITLE_INSTRUCTIONS: &str = "Name this coding session from its first exchange below, in at \
                                  most six words, as a title would read. Answer with the title \
                                  alone.";

impl CodexDriver {
    /// The session's name from its first exchange: on the session's live service, a name the
    /// person's own terminal gave its conversation first, else a pass there; with no live leg, a
    /// failed pass or no name, a one-shot pass of Codex's program on the account the session's
    /// leg runs on. `None` when both gave no name, the session never ran, once `cancel` fired, or
    /// once the pass ran past [`CODEX_NAMING_DEADLINE`], its turn then stopped as a cancel stops
    /// it. What either pass spent is recorded on `params.binding_id` as the session's own, each
    /// pass on a task of the driver's, so a cancel never drops it. Fails as the session pieces
    /// cannot be composed, the stored leg cannot be read, the one-shot pass's launch cannot be
    /// composed or the MCP servers it disables cannot be listed.
    pub(crate) async fn name_session(
        &self,
        params: NameSessionParams,
    ) -> Result<Option<String>, DriverError> {
        let parts = self.parts()?;
        let filing = |provider_account_id: &ProviderAccountId| SessionUsageFiling {
            usage: Arc::clone(&parts.ports.usage),
            session_id: params.session_id,
            binding_id: params.binding_id.clone(),
            provider_account_id: provider_account_id.clone(),
            pricing: CodexRecorderPricing::new(Arc::clone(&parts.pricing)),
        };
        let cancel = params.cancel.clone();
        // One deadline over both passes: the one-shot pass gets what the live one left.
        let deadline = Instant::now() + CODEX_NAMING_DEADLINE;
        let prompt = compose_title_prompt(&params.first_message, &params.first_reply);
        // The one-shot pass runs on the session's own account, live or at rest.
        let (service, session_model, account) =
            if let Some(conversation) = self.views.conversation(params.session_id) {
                let service = Arc::clone(&conversation.service);
                let session_model = conversation.model.clone();
                let account = conversation.provider_account_id.clone();
                let pass_filing = filing(&account);
                // On a task of its own, so a caller that stops waiting still has its turn stopped
                // and what it spent recorded.
                let pass = self.tasks.spawn(name_on_service(
                    conversation,
                    params.session_id,
                    prompt.clone(),
                    pass_filing,
                    cancel.clone(),
                    deadline,
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
                (service, Some(session_model), account)
            } else {
                let leg = tokio::select! {
                    () = cancel.cancelled() => return Ok(None),
                    () = tokio::time::sleep_until(deadline) => return Ok(None),
                    leg = self.read_session_leg(params.session_id) => leg?,
                };
                // A session that never ran has no exchange to name.
                let Some(leg) = leg else {
                    return Ok(None);
                };
                let account = leg.spawn_config.provider_account_id;
                tokio::select! {
                    () = cancel.cancelled() => return Ok(None),
                    () = tokio::time::sleep_until(deadline) => return Ok(None),
                    service = self.registry.service_for(&account) => (service?, None, account),
                }
            };
        let one_shot_filing = filing(&account);
        let one_shot = self.tasks.spawn(async move {
            let model = session_model.as_deref();
            name_in_one_shot(&service, &prompt, model, deadline, &cancel, one_shot_filing).await
        });
        match one_shot.await {
            Ok(named) => Ok(named?),
            Err(error) => Err(DriverError::Internal(Box::new(error))),
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
            let Some(leg) = self.read_session_leg(session_id).await? else {
                return Ok(());
            };
            let Some(thread_id) = leg.resume_handle else {
                return Ok(());
            };
            let service = self
                .registry
                .service_for(&leg.spawn_config.provider_account_id)
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

    // The session's stored leg, as the run engine reads it; `None` for a session that never ran.
    pub(super) async fn read_session_leg(
        &self,
        session_id: SessionId,
    ) -> Result<Option<RuntimeBinding>, DriverError> {
        self.ports
            .run_engine
            .require_port()
            .map_err(internal)?
            .read_session_leg(session_id)
            .await
            .map_err(DriverError::Internal)
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
// throwaway conversation of `conversation`'s service over a connection of its own, its spend filed
// through `filing`; `None` once `cancel` fired or `deadline` passed.
async fn name_on_service(
    conversation: CodexConversationView,
    session_id: SessionId,
    prompt: String,
    filing: SessionUsageFiling,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<Option<String>, CodexError> {
    let (events, frames) = CodexDetachedFrames::new();
    let service = &conversation.service;
    let connection = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(None),
        () = tokio::time::sleep_until(deadline) => return Ok(None),
        connection = service.open_detached_connection(events) => connection?,
    };
    draw_title(
        connection,
        frames,
        &TitleRequest {
            session_id,
            service,
            thread_id: &conversation.thread_id,
            is_joined: service.kind() == CodexServiceKind::Joined,
            working_directory: &conversation.working_directory.to_string_lossy(),
            session_model: &conversation.model,
            prompt: &prompt,
        },
        filing,
        &cancel,
        deadline,
    )
    .await
}

/// What a title pass on a live service reads of the session's conversation.
struct TitleRequest<'pass> {
    /// The session, whose tier the title conversation's start declares.
    session_id: SessionId,
    /// The service the pass runs on, whose region its spend is priced in.
    service: &'pass CodexService,
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
        /// The conversation's meter, at the model and tier its start named.
        meter: Box<CopyTurnMeter>,
        /// The effort its turn runs at, `None` on the session's own model.
        effort: Option<&'static str>,
    },
}

// The title of `request`'s conversation drawn over `connection`, whose notifications arrive on
// `frames`, as `start_title_thread` starts it, each usage reading filed through `filing`; `None`
// once `cancel` fired or `deadline` passed, either of which stops its turn and files what it
// received by then. The connection is let go of as the pass ends, which ends its ephemeral
// conversation, so the service can unload it.
async fn draw_title(
    connection: CodexAppServerConnection,
    mut frames: mpsc::UnboundedReceiver<CodexDetachedFrame>,
    request: &TitleRequest<'_>,
    mut filing: SessionUsageFiling,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Option<String>, CodexError> {
    let (connection, frames, filing) = (&connection, &mut frames, &mut filing);
    run_naming_pass_until(cancel, deadline, |stop| async move {
        draw_title_until_stopped(connection, frames, request, filing, &stop).await
    })
    .await
}

// `draw_title` until `stop` fires: a turn the pass leaves before it ends is stopped first, one
// stopped during its start once the start named it, and the readings it received are filed.
async fn draw_title_until_stopped(
    connection: &CodexAppServerConnection,
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    request: &TitleRequest<'_>,
    filing: &mut SessionUsageFiling,
    stop: &CancellationToken,
) -> Result<Option<String>, CodexError> {
    let started = tokio::select! {
        biased;
        () = stop.cancelled() => return Ok(None),
        started = start_title_thread(connection, request) => started?,
    };
    let (mut meter, effort) = match started {
        TitleThread::Named(name) => return Ok(Some(name)),
        TitleThread::Started { meter, effort } => (meter, effort),
    };
    let title_thread_id = meter.thread_id.clone();
    let (service, folder) = (request.service, Path::new(request.working_directory));
    let turn = CodexTurnStartParams {
        thread_id: title_thread_id.clone(),
        input: vec![compose_codex_text_input(request.prompt.to_owned())],
        approvals_reviewer: None,
        collaboration_mode: None,
        model: None,
        client_user_message_id: None,
        turn_trigger: None,
        root_turn_id: None,
        output_schema: Some(title_schema()),
        effort: effort.map(|effort| effort.parse().expect("the title effort is an effort")),
        service_tier: None,
        service_tier_for_turn: None,
        // The title thread started with no environment, which the turn keeps.
        environments: None,
    };
    let start = connection.request(TURN_START_METHOD, &turn);
    tokio::pin!(start);
    let reply = tokio::select! {
        biased;
        reply = &mut start => reply?,
        () = stop.cancelled() => {
            stop_detached_turn(connection, &title_thread_id, async {
                read_turn_id(&(&mut start).await?, TURN_START_METHOD)
            })
            .await;
            file_received_usage(frames, &mut meter, filing, service, folder).await;
            return Ok(None);
        }
    };
    let turn_id = read_turn_id(&reply, TURN_START_METHOD)?;
    let read = read_detached_turn(
        frames,
        &mut meter,
        filing,
        service,
        folder,
        stop.cancelled(),
    );
    let Some(read) = read.await else {
        stop_detached_turn(connection, &title_thread_id, async { Ok(turn_id) }).await;
        file_received_usage(frames, &mut meter, filing, service, folder).await;
        return Ok(None);
    };
    Ok(read.answer.as_deref().and_then(read_title))
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
        let given = request_thread_reading(connection, request.thread_id, CODEX_REQUEST_TIMEOUT)
            .await?
            .and_then(|reading| reading.name);
        if let Some(given) = given {
            return Ok(TitleThread::Named(given));
        }
    }
    let config = read_codex_config::<Map<String, Value>>(
        connection,
        Path::new(request.working_directory),
        false,
    )
    .await?;
    let server_names = lockdown::read_config_server_names(&config.config);
    let title_model = choose_title_model(Some(connection), Some(request.session_model)).await;
    let reply = connection
        .request(
            THREAD_START_METHOD,
            &ThreadStartParams {
                model: title_model.model.clone(),
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
                    lockdown::compose_lockdown_overrides(&server_names)
                        .into_iter()
                        .collect(),
                ),
                ..ThreadStartParams::default()
            },
        )
        .await?;
    let started = read_codex_object::<StartedTitleThread>(reply.get());
    let sandbox_type = started
        .as_ref()
        .and_then(|started| started.sandbox.as_ref())
        .and_then(|sandbox| sandbox.sandbox_type.as_deref());
    if sandbox_type != Some(READ_ONLY_SANDBOX_TYPE) {
        return Err(CodexError::Transport {
            detail: "Codex did not start the title conversation read-only.".to_owned(),
            cause: None,
        });
    }
    // Codex resolves the model from the conversation's config, so its start names what it runs.
    let model = started
        .and_then(|started| started.model)
        .or(title_model.model);
    let declared_tier = read_codex_declared_tier(request.session_id, &reply);
    Ok(TitleThread::Started {
        meter: Box::new(CopyTurnMeter::new(
            read_thread(&reply, THREAD_START_METHOD)?.id,
            model.as_deref(),
            declared_tier.as_ref(),
        )),
        effort: title_model.effort,
    })
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
            Ok(models) => models
                .iter()
                .any(|model| model.id.as_str() == CODEX_SMALL_MODEL),
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
            model: Some(CODEX_SMALL_MODEL.to_owned()),
            effort: Some(CODEX_SMALL_MODEL_EFFORT),
        };
    }
    TitleModel {
        model: session_model.map(str::to_owned),
        effort: None,
    }
}

// One `codex exec` of the account's home, ephemeral and in an empty folder of its own, under the
// title conversation's config with each MCP server the home lists disabled, its answer held to the
// title's schema, all within `deadline`; the counts of its turn, which it prints, filed through
// `filing` before its answer is read, so a pass that names nothing keeps its spend. `None` with
// nothing launched once `deadline` passed, and once `cancel` fired before the command ended. Fails
// as the launch cannot be composed or the servers cannot be listed.
async fn name_in_one_shot(
    service: &CodexService,
    prompt: &str,
    session_model: Option<&str>,
    deadline: Instant,
    cancel: &CancellationToken,
    mut filing: SessionUsageFiling,
) -> Result<Option<String>, CodexError> {
    let ran = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(None),
        ran = run_title_exec(service, prompt, session_model, deadline) => ran?,
    };
    let Some(TitleExec { folder, model, ran }) = ran else {
        return Ok(None);
    };
    let printed = match ran {
        Ok(printed) => printed,
        Err(error) => {
            tracing::info!(
                error = &error as &(dyn std::error::Error + 'static),
                "codex's one-shot naming pass gave no name"
            );
            return Ok(None);
        }
    };
    match read_exec_turn(&printed) {
        // No event states the tier, so the row is at the standard one; zero counts meter nothing.
        Some(ExecTurnEnd::Completed { thread_id, counts }) => {
            let delta = CopyTurnMeter::new(thread_id, model.as_deref(), None).meter(counts);
            if let Some(delta) = delta {
                filing.file(delta, service, folder.path()).await;
            }
        }
        // A failed turn and one that printed no end state no counts.
        Some(ExecTurnEnd::Failed) | None => {}
    }
    // The answer is read from its file, since the pass prints more than the answer.
    match tokio::fs::read_to_string(folder.path().join(TITLE_ANSWER_FILE_NAME)).await {
        Ok(answer) => Ok(read_title(&answer)),
        Err(error) => {
            tracing::info!(
                error = &error as &(dyn std::error::Error + 'static),
                "codex's one-shot naming pass wrote no answer"
            );
            Ok(None)
        }
    }
}

/// A one-shot pass's `codex exec` that ran: the folder it ran in, which holds its answer, the
/// model it ran on, `None` for the home's default, and what came of the command.
struct TitleExec {
    /// The pass's own folder, dropped once its spend is filed and its answer read.
    folder: tempfile::TempDir,
    /// The model the pass set, `None` for the home's default.
    model: Option<String>,
    /// What the command printed, or why it failed.
    ran: Result<String, CodexCommandError>,
}

// The one-shot pass's `codex exec`, run to its end within `deadline`; `None` with nothing launched
// once it passed. Fails as `name_in_one_shot` fails.
async fn run_title_exec(
    service: &CodexService,
    prompt: &str,
    session_model: Option<&str>,
    deadline: Instant,
) -> Result<Option<TitleExec>, CodexError> {
    let time_left = || deadline.saturating_duration_since(Instant::now());
    if time_left().is_zero() {
        return Ok(None);
    }
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
    let executable = tokio::select! {
        () = tokio::time::sleep_until(deadline) => return Ok(None),
        executable = dependencies.program.resolve(service.home()) => {
            executable.map_err(CodexError::Driver)?
        }
    };
    let server_names = list_mcp_server_names(
        dependencies,
        &executable,
        &service.home().kind,
        time_left().min(CODEX_SERVER_LIST_DEADLINE),
    )
    .await?;
    // The catalog is read on the service where it is up; the one-shot pass starts none.
    let connection = service.connection().ok();
    let title_model = tokio::select! {
        () = tokio::time::sleep_until(deadline) => return Ok(None),
        title_model = choose_title_model(connection.as_deref(), session_model) => title_model,
    };
    let mut overrides = lockdown::compose_lockdown_overrides(&server_names);
    overrides.extend(
        title_model
            .model
            .clone()
            .map(|model| (MODEL_KEY.to_owned(), Value::String(model))),
    );
    overrides.extend(title_model.effort.map(|effort| {
        (
            REASONING_EFFORT_KEY.to_owned(),
            Value::String(effort.to_owned()),
        )
    }));
    let mut arguments = home_exec_switches(&service.home().kind);
    arguments.extend(lockdown::write_exec_overrides(overrides));
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
        // Its events as lines, the turn's counts among them.
        "--json".to_owned(),
        prompt.to_owned(),
    ]);
    let mut launch =
        compose_codex_native_launch(&dependencies.data_folder, &executable, arguments).await?;
    launch.working_folder = folder.path().to_owned();
    let left = time_left();
    if left.is_zero() {
        return Ok(None);
    }
    let ran = run_codex_command(&dependencies.spawner, launch, left).await;
    Ok(Some(TitleExec {
        folder,
        model: title_model.model,
        ran,
    }))
}

/// The MCP servers `codex mcp list --json` names on the home of `home_kind` `executable` runs
/// for, with that home's own switches, within `deadline`. Fails with `CodexError::Transport` when
/// the list cannot be run or read.
pub(crate) async fn list_mcp_server_names(
    dependencies: &CodexServiceDependencies,
    executable: &ResolvedProviderExecutable,
    home_kind: &CodexHomeKind,
    deadline: Duration,
) -> Result<Vec<String>, CodexError> {
    let mut arguments = home_exec_switches(home_kind);
    arguments.extend(["mcp".to_owned(), "list".to_owned(), "--json".to_owned()]);
    let launch =
        compose_codex_native_launch(&dependencies.data_folder, executable, arguments).await?;
    let listing = run_codex_command(&dependencies.spawner, launch, deadline)
        .await
        .map_err(|error| CodexError::Transport {
            detail: "Codex's MCP server list could not be read.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
    lockdown::read_listed_server_names(&listing)
}

// The sandbox a title conversation's start answers it runs under, and the model it runs.
#[derive(Deserialize)]
struct StartedTitleThread {
    sandbox: Option<SandboxReading>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct SandboxReading {
    #[serde(rename = "type")]
    sandbox_type: Option<String>,
}
