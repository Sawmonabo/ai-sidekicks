//! A session's process brought up and adopted: a create pinned to a new conversation, a resume of
//! one, and a fork at a recorded turn that moves the session onto it. Each holds its slot's claim
//! while it brings the process up, checks the model and level it runs at, carries the output
//! speed and a planning session's Plan onto it, and either installs it as the session's live
//! process, with its stream, routing and task, or ends it; nothing is left half adopted.

mod checks;
pub(crate) mod context;
pub(crate) mod figures;
mod fork;

use std::error::Error;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

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
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_platforms::{PathRules, Spawner};

use self::context::{ClaudeSpawnContextError, ClaudeStoredReadError, read_claude_step_bound};
use self::figures::ClaudeHeldFigures;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::events::canonicalizer::CanonicalizationRefusal;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::provider::callback_tools::spawn_binding::CallbackToolSpawnBinding;
use crate::provider::driver::SessionSpawnContextResolver;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::delivery::stream::{
    ClaudeSessionStream, ClaudeSessionStreams,
};
use crate::provider::driver::claude::frame_routing::ClaudeFrameRouting;
use crate::provider::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::provider::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::provider::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::provider::driver::claude::run::routes::ClaudeRunRoutes;
use crate::provider::driver::claude::run::start::claude_session_unavailable;
use crate::provider::driver::claude::session::arrivals::task::{
    ClaudeSessionTask, ClaudeSessionTaskServices,
};
use crate::provider::driver::claude::session::arrivals::{
    ClaudeSessionListener, claude_session_arrivals, drain_claude_session_arrivals,
};
use crate::provider::driver::claude::session::conversation_file::{
    find_claude_conversation_file, read_claude_conversation_outline,
};
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, record_unheard_claude_failure,
};
use crate::provider::driver::claude::session::ignored_settings::find_ignored_setting_notice;
use crate::provider::driver::claude::session::permissions::read_claude_session_rules;
use crate::provider::driver::claude::session::slots::{ClaudeSessionSlots, ClaudeSlotClaim};
use crate::provider::driver::claude::session::state::{
    CLAUDE_THREAD_FRAME_ROUTER_CONFIG, ClaudeHeldCommandChoices, ClaudeLiveSettings,
    ClaudeSessionRoutingBand, ClaudeSpawnBinding, ClaudeUsageEstablishment, LiveClaudeSession,
};
use crate::provider::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::provider::driver::claude::session::ultracode::requested_claude_ultracode;
use crate::provider::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::provider::driver::claude::spawn::environment::claude_config_folder;
use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::provider::driver::claude::spawn::launch::bring_up::{
    ClaudeBringUpRequest, ClaudeSessionSpawn,
};
use crate::provider::driver::claude::spawn::launch::installed_build::{
    ClaudeProcessStarts, ClaudeStartedSession,
};
use crate::provider::driver::claude::spawn::legs::{
    ClaudeSpawnLegServices, ClaudeSpawnLegsError, ClaudeSpawnLegsRequest,
    build_claude_spawn_binding, build_claude_spawn_bound_legs,
};
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::diagnostics::DriverDiagnosticKind;
use crate::provider::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::provider::driver::mcp_server_status::McpServerStatusProducer;
use crate::provider::driver::ports::DriverPorts;
use crate::provider::driver::session_control::{
    CreateSessionParams, DriverResumeResult, ProviderSessionHandle, ResumeSessionParams,
    SessionToolServer, SubagentPolicy,
};
use crate::provider::port::registration::PortRegistrationError;
use crate::provider::process_registry::ProviderProcessRegistry;
use crate::provider::runtime_binding::rebinder::RuntimeBindingRebinder;
use crate::provider::spawn_environment::ReservedEnvironmentNames;
use crate::provider::thread_frame_router::ThreadFrameRouter;
use crate::provider::usage_delta_accountant::UsageDeltaAccountant;
use crate::session::run::inbound::InboundDelivery;

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
    /// The session's stored step bound could not be read.
    #[error(transparent)]
    StepBound(#[from] ClaudeStoredReadError),
    /// The session's standing rules could not be read.
    #[error("the session's standing rules could not be read")]
    SessionRules(#[source] Box<dyn Error + Send + Sync>),
    /// The output schema has no canonical form to bind.
    #[error("the session's output schema has no canonical form")]
    OutputSchema(#[from] CanonicalizationRefusal),
    /// A handle the daemon registers after the drivers is not registered yet.
    #[error(transparent)]
    Port(#[from] PortRegistrationError),
    /// The session's binding could not be pointed at the conversation it moved onto.
    #[error("the session's binding could not be pointed at its new conversation")]
    Rebind(#[source] Box<dyn Error + Send + Sync>),
    /// A close took the session's slot while its process came up, so the process was ended.
    #[error("the session was closed while its Claude Code process came up")]
    Closed,
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
            | Self::StepBound(_)
            | Self::SessionRules(_)
            | Self::OutputSchema(_)
            | Self::Port(_)
            | Self::Rebind(_)
            | Self::Closed => RecoveryCondition::RecoveryNeeded,
        }
    }
}

impl From<ClaudeEstablishmentError> for DriverError {
    /// A session's refusal or a launch failure answers as its own; anything else is internal.
    fn from(error: ClaudeEstablishmentError) -> Self {
        match error {
            ClaudeEstablishmentError::Session(error) => error.into(),
            ClaudeEstablishmentError::Launch(error) => error.into(),
            error @ (ClaudeEstablishmentError::Context(_)
            | ClaudeEstablishmentError::Legs(_)
            | ClaudeEstablishmentError::StepBound(_)
            | ClaudeEstablishmentError::SessionRules(_)
            | ClaudeEstablishmentError::OutputSchema(_)
            | ClaudeEstablishmentError::Port(_)
            | ClaudeEstablishmentError::Rebind(_)
            | ClaudeEstablishmentError::Closed) => Self::Internal(Box::new(error)),
        }
    }
}

/// The daemon's services a spawn reads where it builds its legs and context.
pub(crate) struct ClaudeSpawnSources {
    /// The one thread every child is spawned from, which also checks the command sandbox.
    pub(crate) spawner: Spawner,
    /// Where each session's process runs.
    pub(crate) spawn_contexts: Arc<dyn SessionSpawnContextResolver>,
    /// Points the session's binding at the conversation it moved onto.
    #[expect(
        dead_code,
        reason = "a fork points the session's binding at its new conversation through it"
    )]
    pub(crate) runtime_bindings: Arc<dyn RuntimeBindingRebinder>,
    /// The read pool, for the session's stored settings.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Each posture's credential list.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The login shell's environment, every process's base.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The names no environment row may set.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// Which process runs each session.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
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
    provider_account_id: Option<ProviderAccountId>,
    session_mode: SessionMode,
    output_speed: Option<String>,
    establishment: ClaudeUsageEstablishment,
    command_choices: ClaudeHeldCommandChoices,
    spawn_binding: ClaudeSpawnBinding,
    model_check: ClaudeModelCheck,
    ultracode: Option<bool>,
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
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The Settings values the app stored for the provider.
    pub(crate) row_values: ProviderRowValues,
    /// The Ultracode value the agent asked for; `None` keeps Claude Code's own.
    pub(crate) ultracode: Option<bool>,
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
        let claim = self.slots.claim_bring_up(session_id)?;
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
        };
        let start = self
            .compose_start(
                claim,
                request,
                provider_session_id.clone(),
                ClaudeConversationStart::New {
                    provider_session_id: provider_session_id.clone(),
                },
                (
                    SessionMode::Build,
                    params.output_speed.map(FreeFormText::into_string),
                ),
                ClaudeUsageEstablishment::Fresh,
            )
            .await?;
        self.bring_up(start).await?;
        // Claude Code resumes by the conversation's id, so the handle is that id.
        Ok(ProviderSessionHandle {
            resume_handle: provider_session_id.clone(),
            provider_session_id,
        })
    }

    /// Resumes the conversation `params` names in a fresh process; every failure answers the
    /// `Failed` arm, nothing left running.
    pub(crate) async fn resume(&self, params: ResumeSessionParams) -> DriverResumeResult {
        match self.try_resume(params).await {
            Ok(result) => result,
            Err(error) => resume_failure(error.recovery_condition(), &error),
        }
    }

    // A resume's bring-up; its failures are the caller's to answer through the `Failed` arm.
    async fn try_resume(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, ClaudeEstablishmentError> {
        let session_id = params.session_id;
        if params.larger_window.is_some() {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::LargerWindowFigureUnsupported,
                session_id,
                None,
            )
            .into());
        }
        let claim = self.slots.claim_bring_up(session_id)?;
        let resume_handle = params.resume_handle.clone();
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
        };
        let start = self
            .compose_start(
                claim,
                request,
                resume_handle.clone(),
                ClaudeConversationStart::Resume {
                    resume_handle: resume_handle.clone(),
                },
                (
                    params.mode,
                    params.output_speed.map(FreeFormText::into_string),
                ),
                ClaudeUsageEstablishment::Resume {
                    prior_emitted_thread_id: resume_handle.clone(),
                },
            )
            .await?;
        // Where the conversation stood when it was resumed, read before the process adds to it.
        let session_position = read_turn_count(&start.legs.spawn_environment, &resume_handle).await;
        let started = self.bring_up(start).await?;
        Ok(DriverResumeResult::Resumed {
            binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
                .expect("a minted UUID is a binding id"),
            session_position,
            resume_handle: NonEmptyText::new(resume_handle)
                .expect("a resumed conversation's id is never empty"),
            spawned_version: started,
        })
    }

    // The start of a create or resume: the context resolved, the legs and callback tools bound,
    // and the creation figures read beside the spawn.
    async fn compose_start(
        &self,
        claim: ClaudeSlotClaim,
        request: ClaudeSpawnRequest,
        provider_session_id: String,
        conversation: ClaudeConversationStart,
        (session_mode, output_speed): (SessionMode, Option<String>),
        establishment: ClaudeUsageEstablishment,
    ) -> Result<ClaudeSessionStart, ClaudeEstablishmentError> {
        let sources = &self.sources;
        let context = context::resolve_claude_spawn_context(
            &*sources.spawn_contexts,
            &sources.pool,
            request.session_id,
            request.provider_account_id.clone(),
            &request.row_values,
        )
        .await?;
        let host = sources.ports.callback_tool_host.require_port()?;
        let data_folder = sources.data_folder.to_string_lossy();
        let provider_account_id = request.provider_account_id.clone();
        let (legs, binding) = build_claude_spawn_bound_legs(
            ClaudeSpawnLegsRequest {
                session_id: request.session_id,
                model: request.model,
                execution_posture: request.execution_posture,
                callback_tools: request.callback_tools,
                subagent_policy: request.subagent_policy,
                tool_servers: request.tool_servers,
                output_schema: request.output_schema,
                on_mcp_server_status: request.on_mcp_server_status,
                provider_account_id: request.provider_account_id,
                context,
            },
            &ClaudeSpawnLegServices {
                posture_service: &sources.execution_postures,
                callback_tool_host: host,
                is_in_process_route_registered: sources
                    .ports
                    .in_process_tool_servers
                    .port()
                    .is_some(),
                data_folder: &data_folder,
                base_environment: &sources.base_environment,
                reserved_names: &sources.reserved_names,
                path_rules: PathRules::NATIVE,
            },
        )
        .await?;
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
        })
    }

    // Brings the process up and adopts it, answering the build that runs it.
    async fn bring_up(
        &self,
        start: ClaudeSessionStart,
    ) -> Result<
        crate::provider::driver::contract::SpawnedVersionBindingCarriers,
        ClaudeEstablishmentError,
    > {
        self.bring_up_and(start, async |_live| Ok(())).await
    }

    // Brings the process up, checks it, runs `before_install` on it, then installs it as the
    // session's live process and starts its task; any failure ends the process and undoes its
    // registry, and the claim restores what the slot held.
    async fn bring_up_and(
        &self,
        start: ClaudeSessionStart,
        before_install: impl AsyncFnOnce(&LiveClaudeSession) -> Result<(), ClaudeEstablishmentError>,
    ) -> Result<
        crate::provider::driver::contract::SpawnedVersionBindingCarriers,
        ClaudeEstablishmentError,
    > {
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
        } = start;
        let session_id = legs.session_id;
        let sources = &self.sources;
        let step_bound = match read_claude_step_bound(&sources.pool, session_id).await {
            Ok(step_bound) => step_bound,
            Err(error) => {
                callback_tools.roll_back();
                return Err(error.into());
            }
        };
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
        let mut band = ClaudeSessionRoutingBand {
            router: ThreadFrameRouter::new(
                DESCRIPTOR.provider_id(),
                CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
            ),
            accountant: UsageDeltaAccountant::new(DESCRIPTOR.provider_id()),
        };
        self.routing.bind_session_thread(
            &mut band,
            session_id,
            &provider_session_id,
            &establishment,
        );
        let listener = Arc::new(ClaudeSessionListener::new(
            provider_session_id.clone(),
            Arc::new(Mutex::new(band)),
            Arc::clone(&self.routing),
            Arc::clone(&stream),
            arrivals,
        ));
        let in_process_servers = sources.ports.in_process_tool_servers.port();
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
                turn_holds: Some(
                    crate::provider::driver::claude::session::process::ClaudeTurnHolds {
                        routes: Arc::clone(&self.routes),
                        session_id,
                    },
                ),
            })
            .await;
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                callback_tools.roll_back();
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
                (session_mode, output_speed.as_deref()),
                (model_check, ultracode),
            )
            .await;
        let (applied_output_speed, ultracode_reading) = match checked {
            Ok(applied) => applied,
            Err(error) => {
                self.end_unadopted(&started, session_id, callback_tools)
                    .await;
                return Err(error);
            }
        };
        let live = Arc::new(LiveClaudeSession {
            session_id,
            agent_id,
            provider_session_id: provider_session_id.clone(),
            channel: Arc::clone(&started.channel),
            spawn_binding,
            initialize: started.initialize.clone(),
            command_choices,
            establishment,
            admitted_provider_account_id: provider_account_id,
            settings: Mutex::new(ClaudeLiveSettings {
                execution_posture: legs.execution_posture.clone(),
                session_mode,
                advisor_model: legs.advisor_model.clone(),
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
            served_bindings: Mutex::default(),
            spawn_bound_legs: legs,
        });
        if let Err(error) = before_install(&live).await {
            self.end_unadopted_live(&started, &live).await;
            return Err(error);
        }
        if let Err(live) = claim.install(Arc::clone(&live)) {
            self.end_unadopted_live(&started, &live).await;
            return Err(ClaudeEstablishmentError::Closed);
        }
        self.adopt(&live, stream, receiver, &started);
        Ok(started.spawned_version)
    }

    // The adopted process's stream, task and notices.
    fn adopt(
        &self,
        live: &Arc<LiveClaudeSession>,
        stream: Arc<ClaudeSessionStream>,
        receiver: crate::provider::driver::claude::session::arrivals::ClaudeArrivalReceiver,
        started: &ClaudeStartedSession,
    ) {
        let session_id = live.session_id;
        self.streams.insert(Arc::clone(&stream));
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
            lock(&self.helpers).limit_session(&session_id, limit);
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
    ) {
        started.channel.terminate().await;
        self.sources
            .processes
            .remove_exited(session_id, started.identity);
        callback_tools.roll_back();
    }

    // Ends a started process whose live session was built and never installed.
    async fn end_unadopted_live(&self, started: &ClaudeStartedSession, live: &LiveClaudeSession) {
        started.channel.terminate().await;
        self.sources
            .processes
            .remove_exited(live.session_id, started.identity);
    }
}

// The conversation file `handle` names in the Claude Code home `spawn_environment` reads.
/// The file of conversation `handle` in the Claude Code home `spawn_environment` names; `None`
/// where the home names no folder or holds no such file. Fails as the home cannot be listed.
pub(crate) async fn conversation_file_of(
    spawn_environment: &[(String, String)],
    handle: &str,
) -> std::io::Result<Option<PathBuf>> {
    let Some(config_folder) = claude_config_folder(spawn_environment, PathRules::NATIVE) else {
        return Ok(None);
    };
    find_claude_conversation_file(&config_folder, handle).await
}

// How many turns the conversation holds; a conversation with no readable file holds none yet.
async fn read_turn_count(spawn_environment: &[(String, String)], handle: &str) -> SafeInt<0> {
    let count = match conversation_file_of(spawn_environment, handle).await {
        Ok(Some(file)) => read_claude_conversation_outline(&file)
            .await
            .map_or(0, |outline| outline.turn_end_uuids.len()),
        Ok(None) | Err(_) => 0,
    };
    u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a conversation's turn count is far below the wire's integer cap")
}

/// The `Failed` resume arm for `error`, its words fitted to the detail's cap.
pub(crate) fn resume_failure(
    recovery_condition: RecoveryCondition,
    error: &(dyn Error + 'static),
) -> DriverResumeResult {
    DriverResumeResult::Failed {
        recovery_condition,
        provider_failure_detail: bound_failure_detail(
            &crate::error_description::describe_error(error),
            UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
        ),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
