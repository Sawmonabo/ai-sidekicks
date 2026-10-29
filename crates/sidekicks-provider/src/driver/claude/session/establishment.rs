//! A session's process brought up and adopted: a create pinned to a new conversation, a resume of
//! one, and a fork at a recorded turn that moves the session onto it. Each holds its slot's claim
//! while it brings the process up, checks the model and level it runs at, carries the output
//! speed and a planning session's Plan onto it, and either installs it as the session's live
//! process, with its stream, routing and task, or ends it; nothing is left half adopted.

mod checks;
pub(crate) mod context;
pub(crate) mod figures;
mod fork;
mod resume;

use std::error::Error;
use std::io;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::session::controls::events::SessionNoticePostedPayload;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_platforms::{PathRules, Spawner};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::events::canonicalizer::CanonicalizationRefusal;
use tokio::sync::SetOnce;

use self::context::{ClaudeSpawnContextError, record_claude_resolved_advisor};
use self::figures::ClaudeHeldFigures;
use self::resume::ClaudeContinuedTurn;
use crate::background_work::BackgroundWorkForms;
use crate::callback_tools::spawn_binding::CallbackToolSpawnBinding;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::{
    ClaudeCommandChannel, ClaudeCommandChannels, ClaudeSessionChannel,
};
use crate::driver::claude::delivery::stream::{ClaudeSessionStream, ClaudeSessionStreams};
use crate::driver::claude::frame_routing::ClaudeFrameRouting;
use crate::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::driver::claude::inbox::listener::ClaudeSessionInboxes;
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::run::start::claude_session_unavailable;
use crate::driver::claude::session::arrivals::task::{
    ClaudeSessionTask, ClaudeSessionTaskServices,
};
use crate::driver::claude::session::arrivals::{
    ClaudeSessionListener, claude_session_arrivals, drain_claude_session_arrivals,
};
use crate::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, record_unheard_claude_failure,
};
use crate::driver::claude::session::ignored_settings::find_ignored_setting_notice;
use crate::driver::claude::session::permissions::read_claude_session_rules;
use crate::driver::claude::session::slots::{ClaudeSessionSlots, ClaudeSlotClaim};
use crate::driver::claude::session::state::{
    ClaudeHeldCommandChoices, ClaudeLiveSettings, ClaudeRequestedSpawn, ClaudeSessionRoutingBand,
    ClaudeSpawnBinding, ClaudeUsageEstablishment, LiveClaudeSession,
};
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::session::ultracode::requested_claude_ultracode;
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::claude::spawn::environment::without_interrupted_turn_resume;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::bring_up::{ClaudeBringUpRequest, ClaudeSessionSpawn};
use crate::driver::claude::spawn::launch::installed_build::{
    ClaudeProcessStarts, ClaudeStartedSession,
};
use crate::driver::claude::spawn::legs::{
    ClaudeCallbackToolRegistry, ClaudeSpawnLegServices, ClaudeSpawnLegsError,
    ClaudeSpawnLegsRequest, bind_claude_callback_tools, build_claude_spawn_binding,
    build_claude_spawn_bound_legs,
};
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::contract::{DriverError, SpawnedVersionBindingCarriers};
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::mcp_server_status::McpServerStatusProducer;
use crate::driver::ports::DriverPorts;
use crate::driver::session_control::{
    CreateSessionParams, DriverResumeResult, ProviderSessionHandle, SessionToolServer,
    SubagentPolicy,
};
use crate::process_registry::ProviderProcessRegistry;
use crate::run::delivery::InboundDelivery;
use crate::run::posture::{CredentialPolicyResolveError, ExecutionPostureService};
use crate::runtime_binding::writer::RuntimeBindingWriter;
use crate::spawn_environment::ReservedEnvironmentNames;
use sidekicks_std::port_registration::PortRegistrationError;

/// Why a session's process could not be brought up and adopted.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeEstablishmentError {
    /// The session refused the operation, or its process failed a request.
    #[error(transparent)]
    Session(#[from] ClaudeSessionError),
    /// The process could not be started or brought up.
    #[error(transparent)]
    Launch(#[from] ClaudeLaunchError),
    /// The session's spawn context could not be resolved.
    #[error(transparent)]
    Context(#[from] ClaudeSpawnContextError),
    /// The legs the process starts with could not be built.
    #[error(transparent)]
    Legs(#[from] ClaudeSpawnLegsError),
    /// The session's standing rules could not be read.
    #[error("the session's standing rules could not be read")]
    SessionRules(#[source] Box<dyn Error + Send + Sync>),
    /// The advisor Claude Code resolved could not be kept as the session's own.
    #[error("the session's resolved advisor could not be kept")]
    AdvisorRecord(#[source] Box<dyn Error + Send + Sync>),
    /// The output schema has no canonical form to bind.
    #[error("the session's output schema has no canonical form")]
    OutputSchema(#[from] CanonicalizationRefusal),
    /// A handle the daemon registers after the drivers is not registered yet.
    #[error(transparent)]
    Port(#[from] PortRegistrationError),
    /// The session's binding could not be pointed at the conversation it moved onto.
    #[error("the session's binding could not be pointed at its new conversation")]
    Rebind(#[source] Box<dyn Error + Send + Sync>),
    /// The resumed conversation's file could not be found or read.
    #[error("the conversation {resume_handle} could not be read")]
    ConversationUnreadable {
        /// Claude Code's id of the conversation.
        resume_handle: String,
        /// The read that failed.
        #[source]
        source: io::Error,
    },
    /// A close took the session's slot while its process came up, so the process was ended.
    #[error("the session was closed while its Claude Code process came up")]
    Closed,
    /// Claude Code cannot run the session at its level on its model or this system
    /// (`session.permissionLevel.notOffered`), so the process was ended.
    #[error(transparent)]
    LevelNotOffered(DomainError),
    /// The session's command channel could not be opened.
    #[error("the session's command channel could not be opened")]
    CommandChannel(#[source] io::Error),
}

impl ClaudeEstablishmentError {
    // A refused sign-in needs a sign-in again; anything else needs recovering.
    fn recovery_condition(&self) -> RecoveryCondition {
        match self {
            Self::Session(error) | Self::Launch(ClaudeLaunchError::Session(error)) => {
                error.recovery_condition()
            }
            Self::Launch(_)
            | Self::Context(_)
            | Self::Legs(_)
            | Self::SessionRules(_)
            | Self::AdvisorRecord(_)
            | Self::OutputSchema(_)
            | Self::Port(_)
            | Self::Rebind(_)
            | Self::ConversationUnreadable { .. }
            | Self::Closed
            | Self::LevelNotOffered(_)
            | Self::CommandChannel(_) => RecoveryCondition::RecoveryNeeded,
        }
    }
}

impl From<ClaudeEstablishmentError> for DriverError {
    /// A session's refusal or a launch failure answers as its own, a level the session cannot run
    /// as `session.permissionLevel.notOffered`; anything else is internal.
    fn from(error: ClaudeEstablishmentError) -> Self {
        match error {
            ClaudeEstablishmentError::Session(error) => error.into(),
            ClaudeEstablishmentError::Launch(error) => error.into(),
            ClaudeEstablishmentError::LevelNotOffered(refusal) => Self::Refused(refusal),
            error @ (ClaudeEstablishmentError::Context(_)
            | ClaudeEstablishmentError::Legs(_)
            | ClaudeEstablishmentError::SessionRules(_)
            | ClaudeEstablishmentError::AdvisorRecord(_)
            | ClaudeEstablishmentError::OutputSchema(_)
            | ClaudeEstablishmentError::Port(_)
            | ClaudeEstablishmentError::Rebind(_)
            | ClaudeEstablishmentError::ConversationUnreadable { .. }
            | ClaudeEstablishmentError::Closed
            | ClaudeEstablishmentError::CommandChannel(_)) => Self::Internal(Box::new(error)),
        }
    }
}

/// The daemon's services a spawn reads where it builds its legs and context.
pub(crate) struct ClaudeSpawnSources {
    /// The one thread every child is spawned from, which also checks the command sandbox.
    pub(crate) spawner: Spawner,
    /// Points the session's binding at the conversation it moved onto.
    pub(crate) runtime_bindings: Arc<dyn RuntimeBindingWriter>,
    /// The read pool, for the session's stored settings.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Each posture's credential list.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The login shell's environment, every process's base.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The names no environment row may set.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// Every provider's background work, which a process's settings deny.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// Which process runs each session.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// Every session's command channel.
    pub(crate) command_channels: Arc<ClaudeCommandChannels>,
    /// The handles the daemon registers after the drivers.
    pub(crate) ports: Arc<DriverPorts>,
}

/// What every establishment shares: the build processes start from, the figures held for it, the
/// session's slots and runs, and the pieces a live process is wired through.
pub(crate) struct ClaudeSessionEstablishment {
    /// Every process the driver starts.
    pub(crate) starts: Arc<dyn ClaudeProcessStarts>,
    /// The figures held for the installed build.
    pub(crate) figures: Arc<ClaudeHeldFigures>,
    /// Every session's slot.
    pub(crate) slots: ClaudeSessionSlots,
    /// The runs bound to each session.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// Each live session's stream.
    pub(crate) streams: Arc<ClaudeSessionStreams>,
    /// The messages written and not yet reported taken.
    pub(crate) prompts: Arc<Mutex<ClaudeSentPrompts>>,
    /// Each process's handshake.
    pub(crate) handshakes: Arc<ClaudeHandshakeRegister>,
    /// The routing every session's frames go through.
    pub(crate) routing: Arc<ClaudeFrameRouting>,
    /// Every session's helper limit.
    pub(crate) helpers: Arc<Mutex<ClaudeHelperLimit>>,
    /// What every live process's task shares.
    pub(crate) task_services: Arc<ClaudeSessionTaskServices>,
    /// The daemon's services a spawn reads.
    pub(crate) sources: Arc<ClaudeSpawnSources>,
}

// The callback tools a spawn binds: its own, rolled back should it fail, or a fork's, shared with
// the process it forks.
enum ClaudeCallbackBinding {
    Own(CallbackToolSpawnBinding),
    Shared(Arc<CallbackToolSpawnBinding>),
}

impl ClaudeCallbackBinding {
    // The spawn failed: its own registry is undone, a shared one stays its owner's.
    fn roll_back(self) {
        match self {
            Self::Own(binding) => binding.rollback(),
            Self::Shared(_) => {}
        }
    }

    fn into_shared(self) -> Arc<CallbackToolSpawnBinding> {
        match self {
            Self::Own(binding) => Arc::new(binding),
            Self::Shared(binding) => binding,
        }
    }
}

// Whether the model the process runs is checked against the catalog it declared.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ClaudeModelCheck {
    Checked,
    Unchecked,
}

// One process brought up for a session and the settings it starts with.
struct ClaudeSessionStart {
    claim: ClaudeSlotClaim,
    agent_id: AgentId,
    provider_session_id: String,
    conversation: ClaudeConversationStart,
    legs: ClaudeSpawnBoundLegs,
    callback_tools: ClaudeCallbackBinding,
    provider_account_id: ProviderAccountId,
    session_mode: SessionMode,
    output_speed: Option<String>,
    establishment: ClaudeUsageEstablishment,
    command_choices: ClaudeHeldCommandChoices,
    spawn_binding: ClaudeSpawnBinding,
    model_check: ClaudeModelCheck,
    ultracode: Option<bool>,
    step_bound: Option<SafeInt<1>>,
    // The binding a resume answers once the process is up; `None` for a create or a fork.
    resumed_binding_id: Option<RuntimeBindingId>,
    requested_spawn: ClaudeRequestedSpawn,
    // The turn a resume's process continues; `None` for any other start.
    continued_turn: Option<ClaudeContinuedTurn>,
}

/// A resume's result, and whether the resume brought the process it answers up itself.
pub(crate) struct ClaudeResumeAnswer {
    /// The result the driver answers.
    pub(crate) result: DriverResumeResult,
    /// Whether the resume started a process: `false` when it failed or answered the session's
    /// live process.
    pub(crate) has_started_process: bool,
}

/// What a resume or create asks a spawn to start with, beside its legs.
pub(crate) struct ClaudeSpawnRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's lead.
    pub(crate) agent_id: AgentId,
    /// The model, as Claude Code takes `--model`.
    pub(crate) model: String,
    /// The level the session runs at.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The callback tools the session offers.
    pub(crate) callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The helpers' policy.
    pub(crate) subagent_policy: Option<SubagentPolicy>,
    /// The tool servers the session reaches.
    pub(crate) tool_servers: Option<Vec<SessionToolServer>>,
    /// The output schema a run's answer fills.
    pub(crate) output_schema: Option<Map<String, Value>>,
    /// Takes the tool servers' live status.
    pub(crate) on_mcp_server_status: Option<McpServerStatusProducer>,
    /// The account the process runs on.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The Settings values the app stored for the provider.
    pub(crate) row_values: ProviderRowValues,
    /// The Ultracode value the agent asked for; `None` keeps Claude Code's own.
    pub(crate) ultracode: Option<bool>,
    /// The turn of the run in progress a resume's process continues; `None` for a create and a
    /// resume naming no run in progress.
    pub(crate) continued_turn: Option<ClaudeContinuedTurn>,
}

impl ClaudeSessionEstablishment {
    /// Brings a new conversation up for the session, pinned to an id the daemon mints. Refuses a
    /// larger-window figure, since Claude Code's model id names its window, and a session whose
    /// slot is held; fails as the bring-up or its checks fail, nothing left running.
    pub(crate) async fn create(
        &self,
        params: CreateSessionParams,
    ) -> Result<ProviderSessionHandle, DriverError> {
        let session_id = params.session_id;
        if params.larger_window.is_some() {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::LargerWindowFigureUnsupported,
                session_id,
                None,
            )
            .into());
        }
        let claim = self.slots.claim_create(session_id)?;
        let provider_session_id = mint_uuid_v7().to_string();
        let request = ClaudeSpawnRequest {
            session_id,
            agent_id: params.agent_id,
            model: params.model.as_str().to_owned(),
            execution_posture: params.execution_posture,
            callback_tools: params.callback_tools,
            subagent_policy: params.subagent_policy,
            tool_servers: params.tool_servers,
            output_schema: params.output_schema,
            on_mcp_server_status: params.on_mcp_server_status,
            provider_account_id: params.provider_account_id,
            ultracode: requested_claude_ultracode(&params.options),
            row_values: params.row_values,
            continued_turn: None,
        };
        let output_speed = params.output_speed.map(FreeFormText::into_string);
        let spawned_version = self
            .spawn_on_command_channel(session_id, async |command_channel| {
                let start = self
                    .compose_start(
                        claim,
                        request,
                        command_channel,
                        provider_session_id.clone(),
                        ClaudeConversationStart::New {
                            provider_session_id: provider_session_id.clone(),
                        },
                        (params.mode, output_speed),
                        ClaudeUsageEstablishment::Fresh,
                    )
                    .await?;
                self.bring_up(start).await
            })
            .await?;
        // Claude Code resumes by the conversation's id, so the handle is that id.
        Ok(ProviderSessionHandle {
            resume_handle: provider_session_id.clone(),
            provider_session_id,
            spawned_version,
        })
    }

    // Runs `spawn` on the session's command channel, opened first: one opened for this spawn is
    // closed should the spawn fail, and one the session held from an earlier spawn is kept.
    async fn spawn_on_command_channel<Spawn, Spawned>(
        &self,
        session_id: SessionId,
        spawn: Spawn,
    ) -> Result<Spawned, ClaudeEstablishmentError>
    where
        Spawn: AsyncFnOnce(
            Option<Arc<ClaudeCommandChannel>>,
        ) -> Result<Spawned, ClaudeEstablishmentError>,
    {
        let channels = &self.sources.command_channels;
        let opening = channels
            .open(session_id)
            .await
            .map_err(ClaudeEstablishmentError::CommandChannel)?;
        let spawned = spawn(
            opening
                .as_ref()
                .map(|opening| Arc::clone(opening.channel())),
        )
        .await;
        if spawned.is_err()
            && matches!(opening, Some(ClaudeSessionChannel::Opened(_)))
            && let Err(error) = channels.close(session_id).await
        {
            tracing::error!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "a failed spawn's command channel could not be removed"
            );
        }
        spawned
    }

    // The start of a create or resume: the context resolved, the legs and callback tools bound,
    // and the creation figures read beside the spawn.
    async fn compose_start(
        &self,
        claim: ClaudeSlotClaim,
        request: ClaudeSpawnRequest,
        command_channel: Option<Arc<ClaudeCommandChannel>>,
        provider_session_id: String,
        conversation: ClaudeConversationStart,
        (session_mode, output_speed): (SessionMode, Option<String>),
        establishment: ClaudeUsageEstablishment,
    ) -> Result<ClaudeSessionStart, ClaudeEstablishmentError> {
        let sources = &self.sources;
        let context = context::resolve_claude_spawn_context(
            &sources.ports.spawn_contexts,
            &sources.pool,
            request.session_id,
            request.provider_account_id.clone(),
            &request.row_values,
        )
        .await?;
        let step_bound = context.step_bound;
        let host = sources.ports.callback_tool_host.require_port()?;
        let session_id = request.session_id;
        let requested_spawn = ClaudeRequestedSpawn {
            callback_tools: request.callback_tools.clone(),
            row_values: request.row_values,
        };
        let provider_account_id = request.provider_account_id.clone();
        let legs = build_claude_spawn_bound_legs(
            ClaudeSpawnLegsRequest {
                session_id,
                model: request.model,
                execution_posture: request.execution_posture,
                subagent_policy: request.subagent_policy,
                tool_servers: request.tool_servers,
                output_schema: request.output_schema,
                on_mcp_server_status: request.on_mcp_server_status,
                provider_account_id: request.provider_account_id,
                command_channel,
                context,
                continues_interrupted_turn: request.continued_turn.is_some(),
            },
            &ClaudeSpawnLegServices::of(sources),
        )
        .await
        .map_err(|error| legs_failure(error, session_id))?;
        let (legs, binding) = bind_claude_callback_tools(
            legs,
            &ClaudeCallbackToolRegistry {
                host,
                is_in_process_route_registered: sources
                    .ports
                    .in_process_tool_servers
                    .port()
                    .is_some(),
            },
            request.callback_tools,
        );
        let spawn_binding = match build_claude_spawn_binding(&legs) {
            Ok(spawn_binding) => spawn_binding,
            Err(refusal) => {
                binding.rollback();
                return Err(refusal.into());
            }
        };
        let command_choices = self.figures.read_creation_figures(&legs);
        Ok(ClaudeSessionStart {
            claim,
            agent_id: request.agent_id,
            provider_session_id,
            conversation,
            legs,
            callback_tools: ClaudeCallbackBinding::Own(binding),
            provider_account_id,
            session_mode,
            output_speed,
            establishment,
            command_choices,
            spawn_binding,
            model_check: ClaudeModelCheck::Checked,
            ultracode: request.ultracode,
            step_bound,
            resumed_binding_id: None,
            requested_spawn,
            continued_turn: request.continued_turn,
        })
    }

    // Brings the process up and adopts it, answering the build that runs it.
    async fn bring_up(
        &self,
        start: ClaudeSessionStart,
    ) -> Result<SpawnedVersionBindingCarriers, ClaudeEstablishmentError> {
        self.bring_up_and(start, async |_live| Ok(())).await
    }

    // Brings the process up, checks it, runs `before_install` on it, then installs it as the
    // session's live process and starts its task; any failure ends the process and undoes its
    // registry, and the claim restores what the slot held.
    async fn bring_up_and<BeforeInstall>(
        &self,
        start: ClaudeSessionStart,
        before_install: BeforeInstall,
    ) -> Result<SpawnedVersionBindingCarriers, ClaudeEstablishmentError>
    where
        BeforeInstall: AsyncFnOnce(&LiveClaudeSession) -> Result<(), ClaudeEstablishmentError>,
    {
        let ClaudeSessionStart {
            claim,
            agent_id,
            provider_session_id,
            conversation,
            legs,
            callback_tools,
            provider_account_id,
            session_mode,
            output_speed,
            establishment,
            command_choices,
            spawn_binding,
            model_check,
            ultracode,
            step_bound,
            resumed_binding_id,
            requested_spawn,
            continued_turn,
        } = start;
        let session_id = legs.session_id;
        let sources = &self.sources;
        let session_rules =
            match read_claude_session_rules(&sources.ports.session_rules, session_id).await {
                Ok(rules) => rules,
                Err(error) => {
                    callback_tools.roll_back();
                    return Err(ClaudeEstablishmentError::SessionRules(error));
                }
            };
        let (arrivals, receiver) = claude_session_arrivals(session_id);
        let stream = Arc::new(ClaudeSessionStream::new(
            provider_account_id.clone(),
            step_bound,
            arrivals.clone(),
            Arc::clone(&self.routes),
            Arc::clone(&self.prompts),
        ));
        let is_continuing_turn = continued_turn.is_some();
        if let Some(turn) = continued_turn {
            stream.continue_turn(turn.run, turn.turn_number, turn.provider_turn_id);
        }
        let mut band = ClaudeSessionRoutingBand::new();
        self.routing
            .bind_session_thread(&mut band, session_id, &provider_session_id, &establishment)
            .await;
        let band = Arc::new(Mutex::new(band));
        let listener = Arc::new(ClaudeSessionListener::new(
            provider_session_id.clone(),
            Arc::clone(&band),
            Arc::clone(&self.routing),
            Arc::clone(&stream),
            arrivals,
        ));
        let in_process_servers = sources.ports.in_process_tool_servers.port();
        let messaging_socket = self.task_services.inboxes.mint_process_socket(session_id);
        let started = self
            .starts
            .start_session(ClaudeBringUpRequest {
                spawn: ClaudeSessionSpawn {
                    legs: &legs,
                    provider_account_id: provider_account_id.clone(),
                    session_rules: &session_rules,
                    step_bound: step_bound
                        .map(|bound| u32::try_from(bound.get()).unwrap_or(u32::MAX)),
                    in_process_servers,
                    path_rules: PathRules::NATIVE,
                },
                provider_session_id: provider_session_id.clone(),
                conversation,
                listener,
                turn_holds: Some(crate::driver::claude::session::process::ClaudeTurnHolds {
                    routes: Arc::clone(&self.routes),
                    session_id,
                }),
                // A process starts in its level's own mode, so only Plan is named.
                permission_mode: (session_mode == SessionMode::Plan)
                    .then_some(ClaudePermissionMode::Plan),
                messaging_socket: messaging_socket.as_deref(),
            })
            .await;
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                callback_tools.roll_back();
                if let Some(socket) = &messaging_socket {
                    ClaudeSessionInboxes::remove_process_socket(session_id, socket).await;
                }
                return Err(error.into());
            }
        };
        sources.processes.record(session_id, started.identity);
        self.figures
            .note_build(&started.spawned_version.cli_version.raw_version);
        let checked = self
            .check_started(
                &started,
                &legs,
                agent_id,
                output_speed.as_deref(),
                (model_check, ultracode),
            )
            .await;
        let (applied_output_speed, ultracode_reading) = match checked {
            Ok(applied) => applied,
            Err(error) => {
                self.end_unadopted(
                    &started,
                    session_id,
                    callback_tools,
                    messaging_socket.as_deref(),
                )
                .await;
                return Err(error);
            }
        };
        if let Err(error) = record_claude_resolved_advisor(
            sources.ports.session_advisors.port(),
            session_id,
            &legs.advisor,
            &started.settings_readback.resolved_advisor,
        )
        .await
        {
            self.end_unadopted(
                &started,
                session_id,
                callback_tools,
                messaging_socket.as_deref(),
            )
            .await;
            return Err(ClaudeEstablishmentError::AdvisorRecord(error));
        }
        let live = Arc::new(LiveClaudeSession {
            session_id,
            agent_id,
            provider_session_id: provider_session_id.clone(),
            channel: Arc::clone(&started.channel),
            spawn_binding,
            initialize: started.initialize.clone(),
            command_choices,
            admitted_provider_account_id: provider_account_id,
            settings: Mutex::new(ClaudeLiveSettings {
                execution_posture: legs.execution_posture.clone(),
                session_mode,
                // An advisor no one picked is the one Claude Code resolved, which the session then
                // keeps, so a later change to the person's own setting never reaches it.
                advisor: match &legs.advisor {
                    ClaudeSessionAdvisor::Unpicked => {
                        started.settings_readback.resolved_advisor.clone()
                    }
                    picked @ (ClaudeSessionAdvisor::Off | ClaudeSessionAdvisor::Model(_)) => {
                        picked.clone()
                    }
                },
                output_style: legs.output_style.clone(),
                running_model: legs.model.clone(),
                attached_advisor: started.settings_readback.attached_advisor.clone(),
                applied_output_speed,
                ultracode_requested: ultracode,
                ultracode: ultracode_reading.or(started.settings_readback.ultracode),
            }),
            process_identity: started.identity,
            callback_tool_binding: callback_tools.into_shared(),
            process_exit: OnceLock::new(),
            task_ended: SetOnce::new(),
            served_bindings: Mutex::default(),
            messaging_socket,
            spawned_version: started.spawned_version.clone(),
            resumed_binding_id,
            requested_spawn,
            // A later process started from these legs, a fork or a side question, continues no turn.
            spawn_bound_legs: if is_continuing_turn {
                ClaudeSpawnBoundLegs {
                    spawn_environment: without_interrupted_turn_resume(legs.spawn_environment),
                    ..legs
                }
            } else {
                legs
            },
        });
        if let Err(error) = before_install(&live).await {
            self.end_unadopted_live(&started, &live).await;
            return Err(error);
        }
        // Bound while the claim still holds the slot, so a close waits for it and releases the
        // inbox after, and a message meanwhile waits for the process instead of waking a closed
        // session.
        self.task_services.inboxes.bind(session_id).await;
        if let Err(live) = claim.install(Arc::clone(&live)) {
            self.end_unadopted_live(&started, &live).await;
            return Err(ClaudeEstablishmentError::Closed);
        }
        self.adopt(&live, stream, band, receiver, &started);
        Ok(started.spawned_version)
    }

    // The adopted process's stream, task and notices; the helper limit counts the helpers its
    // routing `band` holds, and an interrupt reads there the helpers the session waits on.
    fn adopt(
        &self,
        live: &Arc<LiveClaudeSession>,
        stream: Arc<ClaudeSessionStream>,
        band: Arc<Mutex<ClaudeSessionRoutingBand>>,
        receiver: crate::driver::claude::session::arrivals::ClaudeArrivalReceiver,
        started: &ClaudeStartedSession,
    ) {
        let session_id = live.session_id;
        // A fork's bring-up left the channel on its predecessor's process until now.
        if let Some(channel) = &live.spawn_bound_legs.command_channel {
            channel.follow(live.process_identity.process_id);
        }
        self.task_services.idle_sleep.note_awake(session_id);
        self.streams.insert(Arc::clone(&stream));
        // A resume reuses its predecessor's conversation id, which a held record would match.
        self.handshakes.forget_handshake(session_id);
        self.task_services
            .interventions
            .register_routing_band(session_id, Arc::clone(&band));
        self.handshakes.hold_fast_mode(
            session_id,
            &live.provider_session_id,
            &started.initialize.fast_mode,
        );
        if let Some(SubagentPolicy::Enabled {
            helpers_at_once: Some(helpers_at_once),
            ..
        }) = &live.spawn_bound_legs.subagent_policy
        {
            let limit = usize::try_from(helpers_at_once.get())
                .ok()
                .and_then(NonZeroUsize::new)
                .unwrap_or(NonZeroUsize::MAX);
            lock(&self.helpers).limit_session(&session_id, limit, band);
        }
        let mut task = ClaudeSessionTask::new(
            Arc::clone(&self.task_services),
            Arc::clone(live),
            Arc::clone(&stream),
        );
        let account = live.admitted_provider_account_id.clone();
        tokio::spawn(async move {
            drain_claude_session_arrivals(receiver, &mut task, account).await;
        });
        let cleanup_period_days = started.settings_readback.cleanup_period_days;
        tokio::spawn(async move {
            let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
            let check = find_ignored_setting_notice(
                session_id,
                cleanup_period_days,
                managed_settings_folder.as_deref(),
            )
            .await;
            for failure in &check.failures {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    session_id,
                    "a managed settings read",
                    failure,
                );
            }
            if let Some(notice) = check.notice {
                // The notice keeps its place among the process's rows through its queue.
                drop(
                    stream
                        .arrivals()
                        .dispatch(InboundDelivery::SessionNotice {
                            session_id,
                            notice: SessionNoticePostedPayload::SettingsIgnoredAtKey(notice),
                        })
                        .await,
                );
            }
        });
    }

    // Ends a started process that was not adopted, before its live session existed.
    async fn end_unadopted(
        &self,
        started: &ClaudeStartedSession,
        session_id: SessionId,
        callback_tools: ClaudeCallbackBinding,
        messaging_socket: Option<&Path>,
    ) {
        started.channel.terminate().await;
        self.sources
            .processes
            .remove_exited(session_id, started.identity);
        callback_tools.roll_back();
        if let Some(socket) = messaging_socket {
            ClaudeSessionInboxes::remove_process_socket(session_id, socket).await;
        }
    }

    // Ends a started process whose live session was built and never installed.
    async fn end_unadopted_live(&self, started: &ClaudeStartedSession, live: &LiveClaudeSession) {
        started.channel.terminate().await;
        self.sources
            .processes
            .remove_exited(live.session_id, started.identity);
        if let Some(socket) = &live.messaging_socket {
            ClaudeSessionInboxes::remove_process_socket(live.session_id, socket).await;
        }
    }
}

// A folder the session's commands are kept from that could not be resolved refuses the start
// naming it; any other failure of the legs is the legs' own.
fn legs_failure(error: ClaudeSpawnLegsError, session_id: SessionId) -> ClaudeEstablishmentError {
    match error {
        ClaudeSpawnLegsError::CredentialPolicy(CredentialPolicyResolveError::DenyPath {
            path,
            cause,
        }) => ClaudeSessionError::Unavailable {
            reason: ClaudeSessionUnavailableReason::CredentialFolderUnresolvable,
            detail: Some(format!("{}: {cause}", path.display())),
            session_id: Some(session_id),
            run_id: None,
        }
        .into(),
        error @ (ClaudeSpawnLegsError::HomeRetention(_)
        | ClaudeSpawnLegsError::CredentialPolicy(_)
        | ClaudeSpawnLegsError::Environment(_)) => error.into(),
    }
}
