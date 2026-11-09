//! A Codex session's name: drawn from its first exchange in one short pass of Codex's own, on a
//! throwaway, read-only conversation with no tool, MCP server or hook, on the session's service
//! where its conversation is live, else in a one-shot `codex exec`; and told to Codex with
//! `thread/name/set`, so its own session list shows it. A conversation the person's own terminal
//! already named keeps that name. What a pass spends is recorded and priced as the session's own,
//! counted toward no run, on the binding of its first completed run.

pub(crate) mod lockdown;
mod one_shot;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
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
use crate::driver::codex::lifecycle::views::CodexConversationView;
use crate::driver::codex::output_speed::read_codex_declared_tier;
use crate::driver::codex::pricing::CodexRecorderPricing;
use crate::driver::codex::service::command::run_codex_command;
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
    /// The session's name from its first exchange, drawn on the service of the account the
    /// session runs on: a name the person's own terminal gave its conversation first, else a pass
    /// there, on its live conversation's service, or at rest on its account's service, started
    /// for the pass in a scratch folder of its own; with a failed pass or no name, a one-shot pass
    /// of Codex's program on that account. `None` when both gave no name, the session never ran,
    /// once `cancel` fired, or once the pass ran past [`CODEX_NAMING_DEADLINE`], its turn then
    /// stopped as a cancel stops it. What either pass spent is recorded on `params.binding_id` as
    /// the session's own, each pass on a task of the driver's, so a cancel never drops it. Fails as
    /// the session pieces cannot be composed, the stored leg cannot be read, the one-shot pass's
    /// launch cannot be composed or the MCP servers it disables cannot be listed.
    pub(crate) async fn name_session(
        &self,
        params: NameSessionParams,
    ) -> Result<Option<String>, DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        let filing = |provider_account_id: &ProviderAccountId| SessionUsageFiling {
            usage: Arc::clone(&parts.ports.usage),
            session_id,
            binding_id: params.binding_id.clone(),
            provider_account_id: provider_account_id.clone(),
            pricing: CodexRecorderPricing::new(Arc::clone(&parts.pricing)),
        };
        let cancel = params.cancel.clone();
        // One deadline over both passes: the one-shot pass gets what the one on the service left.
        let deadline = Instant::now() + CODEX_NAMING_DEADLINE;
        let prompt = compose_title_prompt(&params.first_message, &params.first_reply);
        // The one-shot pass runs on the session's own account, live or at rest.
        let (service, session_model, account) = if let Some(conversation) =
            self.views.conversation(session_id)
        {
            let request = TitleRequest {
                session_id,
                service: Arc::clone(&conversation.service),
                thread_id: Some(conversation.thread_id),
                working_directory: conversation.working_directory,
                session_model: Some(conversation.model.clone()),
                prompt: prompt.clone(),
            };
            let account = conversation.provider_account_id;
            let pass = name_on_service(request, filing(&account), cancel.clone(), deadline);
            if let Some(name) = self.draw_on_service(session_id, pass).await {
                return Ok(Some(name));
            }
            (conversation.service, Some(conversation.model), account)
        } else {
            let leg = tokio::select! {
                () = cancel.cancelled() => return Ok(None),
                () = tokio::time::sleep_until(deadline) => return Ok(None),
                leg = self.read_session_leg(session_id) => leg?,
            };
            // A session that never ran has no exchange to name.
            let Some(leg) = leg else {
                return Ok(None);
            };
            let (account, thread_id) = (leg.spawn_config.provider_account_id, leg.resume_handle);
            let service = tokio::select! {
                () = cancel.cancelled() => return Ok(None),
                () = tokio::time::sleep_until(deadline) => return Ok(None),
                service = self.registry.service_for(&account) => service?,
            };
            // Started now, as the rename that follows would start it.
            let started = tokio::select! {
                () = cancel.cancelled() => return Ok(None),
                () = tokio::time::sleep_until(deadline) => return Ok(None),
                started = service.ensure_started(service.dependencies().startup_timeout) => {
                    started
                }
            };
            match started {
                Ok(()) => {
                    let (service, prompt) = (Arc::clone(&service), prompt.clone());
                    let (filing, cancel) = (filing(&account), cancel.clone());
                    let pass = async move {
                        let scratch = make_pass_folder()?;
                        let request = TitleRequest {
                            session_id,
                            service,
                            thread_id,
                            working_directory: scratch.path().to_owned(),
                            session_model: None,
                            prompt,
                        };
                        name_on_service(request, filing, cancel, deadline).await
                    };
                    if let Some(name) = self.draw_on_service(session_id, pass).await {
                        return Ok(Some(name));
                    }
                }
                Err(error) => tracing::info!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %session_id,
                    "a resting codex session's service did not start for its naming pass"
                ),
            }
            (service, None, account)
        };
        let one_shot_filing = filing(&account);
        let one_shot = self.tasks.spawn(async move {
            let model = session_model.as_deref();
            one_shot::name_in_one_shot(&service, &prompt, model, deadline, &cancel, one_shot_filing)
                .await
        });
        match one_shot.await {
            Ok(named) => Ok(named?),
            Err(error) => Err(DriverError::Internal(Box::new(error))),
        }
    }

    // The name `pass` drew on a service, run on a task of its own, so a caller that stops waiting
    // still has its turn stopped and what it spent recorded; `None`, logged, where it failed.
    async fn draw_on_service(
        &self,
        session_id: SessionId,
        pass: impl Future<Output = Result<Option<String>, CodexError>> + Send + 'static,
    ) -> Option<String> {
        match self.tasks.spawn(pass).await {
            Ok(Ok(named)) => named,
            Ok(Err(error)) => {
                tracing::info!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %session_id,
                    "a codex session's name could not be drawn on its service"
                );
                None
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %session_id,
                    "a codex session's naming pass on its service ended unfinished"
                );
                None
            }
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

// An empty folder of a pass's own, gone once dropped. Fails as it cannot be made.
fn make_pass_folder() -> Result<tempfile::TempDir, CodexError> {
    tempfile::tempdir().map_err(|error| CodexError::Transport {
        detail: "The folder of Codex's naming pass could not be made.".to_owned(),
        cause: Some(Box::new(error)),
    })
}

// The name the person's own terminal gave a joined service's conversation, else one drawn on a
// throwaway conversation of `request`'s service over a connection of its own, its spend filed
// through `filing`; `None` once `cancel` fired or `deadline` passed.
async fn name_on_service(
    request: TitleRequest,
    filing: SessionUsageFiling,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<Option<String>, CodexError> {
    let (events, frames) = CodexDetachedFrames::new();
    let connection = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(None),
        () = tokio::time::sleep_until(deadline) => return Ok(None),
        connection = request.service.open_detached_connection(events) => connection?,
    };
    draw_title(connection, frames, &request, filing, &cancel, deadline).await
}

/// What a title pass on a service reads of the session.
struct TitleRequest {
    /// The session, whose tier the title conversation's start declares.
    session_id: SessionId,
    /// The service the pass runs on, whose region its spend is priced in.
    service: Arc<CodexService>,
    /// The session's conversation, whose given name a joined service is asked for; `None` where
    /// none is stored.
    thread_id: Option<String>,
    /// The folder whose config the title conversation is read and started under: the session's
    /// own where it is live, else a scratch folder of the pass's.
    working_directory: PathBuf,
    /// The session's model, which the title turn runs on where the small title model is not
    /// offered; `None` at rest, where the home's default runs.
    session_model: Option<String>,
    /// The pass's prompt.
    prompt: String,
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
    request: &TitleRequest,
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
    request: &TitleRequest,
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
    let (service, folder) = (&*request.service, request.working_directory.as_path());
    // Held until the pass's read ends, so the export's twins of its filed requests pass over.
    let _copy_read =
        service
            .dependencies()
            .exports
            .copy_thread(service.id(), &title_thread_id, filing, folder);
    let turn = CodexTurnStartParams {
        thread_id: title_thread_id.clone(),
        input: vec![compose_codex_text_input(request.prompt.clone())],
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
    request: &TitleRequest,
) -> Result<TitleThread, CodexError> {
    // Only the person's own service may hold a name their terminal gave.
    if request.service.kind() == CodexServiceKind::Joined
        && let Some(thread_id) = &request.thread_id
    {
        let given = request_thread_reading(connection, thread_id, CODEX_REQUEST_TIMEOUT)
            .await?
            .and_then(|reading| reading.name);
        if let Some(given) = given {
            return Ok(TitleThread::Named(given));
        }
    }
    let folder = &request.working_directory;
    let config =
        read_codex_config::<Map<String, Value>>(connection, Some(folder.as_path()), false).await?;
    let server_names = lockdown::read_config_server_names(&config.config);
    let title_model = choose_title_model(Some(connection), request.session_model.as_deref()).await;
    let reply = connection
        .request(
            THREAD_START_METHOD,
            &ThreadStartParams {
                model: title_model.model.clone(),
                cwd: Some(folder.to_string_lossy().into_owned()),
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
    let launch = compose_codex_native_launch(&dependencies.data_folder, executable, arguments)
        .await?
        .launch;
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
