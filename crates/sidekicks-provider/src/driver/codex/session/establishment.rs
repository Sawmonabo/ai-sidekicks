//! A Codex session's establishment: its conversation started on its account's service, reopened
//! at a daemon restart by forking it there with every setting the session holds, or resumed in
//! place after its service came back or moved; then its record composed, its routing band bound and
//! its conversation registered on the service. A failed resume never becomes a new conversation:
//! it answers the failure.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::PathRules;

use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::SessionSpawnContextResolver;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::auth_status::classify_codex_resume_recovery_condition;
use crate::driver::codex::capabilities::read_codex_service_model_catalog;
use crate::driver::codex::commands::CodexProviderCommandCache;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::model_windows::read_codex_larger_window;
use crate::driver::codex::notification_routing::{CodexRoutedFrames, CodexSessionRouting};
use crate::driver::codex::output_speed::{
    compose_codex_service_tier, read_codex_declared_tier, resolve_codex_output_speed_level,
};
use crate::driver::codex::permission_level::CodexProfileFolders;
use crate::driver::codex::service::command::read_codex_model_catalog_dump;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::threads::ThreadClaim;
use crate::driver::codex::session::calls::CodexSessionTask;
use crate::driver::codex::session::controls::update_codex_session_mode;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::{
    CodexForkBoundary, CodexForkSource, read_codex_fork_or_let_go, request_codex_fork,
};
use crate::driver::codex::session::helper_roles::{
    read_codex_role_file_withheld_fields, write_codex_helper_roles,
};
use crate::driver::codex::session::history::{CodexListedTurn, read_codex_turns};
use crate::driver::codex::session::inbound::{CodexSessionInboundReceiver, codex_session_inbound};
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::codex::session::state::{CodexEstablishedConversation, CodexSessionRecord};
use crate::driver::codex::thread::permission_profiles::CodexThreadPermissionProfiles;
use crate::driver::codex::thread::settings::{
    CodexServiceTierChange, CodexThreadSettings, compose_codex_thread_resume_params,
    compose_codex_thread_start_params,
};
use crate::driver::codex::thread::view::{
    assert_codex_thread_profile, read_thread, read_thread_reasoning_effort,
};
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::contract::{DriverError, bound_failure_detail};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::driver::session_control::{
    CreateSessionParams, DriverResumeResult, ProviderSessionHandle, ResumeSessionParams,
    SessionToolServer, SubagentDefinition, SubagentPolicy,
};
use crate::port::tool_server_route::ToolServerRoute;
use crate::process_identity::ProviderProcessIds as _;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::posture::ExecutionPostureService;
use crate::runtime_binding::store::mint_runtime_binding_id;
use crate::spawn_environment::{
    ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
    build_conversation_command_environment,
};
use crate::spawned_version::to_binding_version_carriers;
use crate::usage_delta_accountant::{ThreadBaseEstablishment, UsageAxisCounts};
use sidekicks_std::port_registration::PortRegistration;

const THREAD_START_METHOD: &str = "thread/start";
const THREAD_RESUME_METHOD: &str = "thread/resume";

/// What the establishment reads and composes through, shared by every session of the driver.
pub(crate) struct CodexSessionEstablishmentDependencies {
    /// The services, one per credential home.
    pub(crate) services: Arc<CodexServiceRegistry>,
    /// Where each session runs, resolved at every start and resume.
    pub(crate) spawn_contexts: Arc<PortRegistration<Arc<dyn SessionSpawnContextResolver>>>,
    /// Resolves each posture's curated credential list.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The login shell's environment captured at the daemon's start.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The names no environment row may set.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// The folder the helpers' role files are written under, one folder per session.
    pub(crate) helper_roles_folder: PathBuf,
    /// The route to the daemon's tool servers, once its owner registered it.
    pub(crate) tool_server_route: Arc<PortRegistration<Arc<dyn ToolServerRoute>>>,
    /// The frame delivery, which the frames that waited for a conversation go to.
    pub(crate) delivery: Arc<CodexFrameDelivery>,
    /// The compaction waits each session's routing band settles.
    pub(crate) pending_compactions: PendingCompactionRegistry,
    /// The provider command lists, whose list read before a resume is dropped.
    pub(crate) provider_commands: Arc<CodexProviderCommandCache>,
    /// Which provider process runs each session, where each session's service process is kept.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
}

/// A conversation established and not yet open: its record and queue, the claim that holds its
/// frames, and how its usage is based once its routing band binds it.
pub(crate) struct CodexEstablishedSession {
    record: CodexSessionRecord,
    receiver: CodexSessionInboundReceiver,
    claim: ThreadClaim,
    is_resumed: bool,
}

/// A conversation open on its service: what its session's task holds, and the frames binding it
/// released, which the task applies first.
pub(crate) struct CodexOpenedSession {
    /// The record.
    pub(crate) record: CodexSessionRecord,
    /// The queue the task drains.
    pub(crate) receiver: CodexSessionInboundReceiver,
    /// The routing band, bound to the conversation.
    pub(crate) routing: CodexSessionRouting,
    /// The frames that waited for the conversation, delivered.
    pub(crate) routed: CodexRoutedFrames,
}

/// What a resume as a fork did: the result to answer, and the session to open once it resumed.
pub(crate) struct CodexForkedResume {
    /// The result.
    pub(crate) result: DriverResumeResult,
    /// The session, `None` when the resume failed.
    pub(crate) established: Option<CodexEstablishedSession>,
}

/// A conversation resumed in place, its turns as Codex listed them, none when it failed, and the
/// frames rebinding it released, which the session's task applies.
pub(crate) struct CodexInPlaceResume {
    /// The result.
    pub(crate) result: DriverResumeResult,
    /// The conversation's turns, oldest first.
    pub(crate) listed_turns: Vec<CodexListedTurn>,
    /// The frames that waited for the conversation, delivered.
    pub(crate) routed: CodexRoutedFrames,
}

/// What a start or a resume composes the conversation's settings from.
struct CodexSettingsRequest<'params> {
    session_id: SessionId,
    model: &'params str,
    larger_window: Option<SafeInt<1>>,
    execution_posture: Option<&'params ExecutionPosture>,
    subagent_policy: Option<&'params SubagentPolicy>,
    tool_servers: Option<&'params [SessionToolServer]>,
    provider_account_id: Option<&'params ProviderAccountId>,
}

/// Starts, reopens and resumes the conversations of the driver's sessions; the caller holds each
/// session's slot. The service stays up whatever a leg does to its own conversation.
pub(crate) struct CodexSessionEstablishment {
    dependencies: CodexSessionEstablishmentDependencies,
}

impl CodexSessionEstablishment {
    /// The establishment over `dependencies`.
    pub(crate) fn new(dependencies: CodexSessionEstablishmentDependencies) -> Self {
        Self { dependencies }
    }

    /// Starts a fresh conversation on the account's service and answers its handle, with the
    /// version the service reported, and the session to open; a failure leaves nothing behind, a
    /// conversation started under another profile or on a service that reported no version let go
    /// first. Fails as the settings' composition, the service's start, the larger window's check
    /// (`CodexError::LargerWindowUnavailable` for one the catalog does not offer at that figure
    /// now), the request or the profile's read-back fails, and when the service reported no
    /// version.
    pub(crate) async fn create(
        &self,
        params: &CreateSessionParams,
    ) -> Result<(ProviderSessionHandle, CodexEstablishedSession), CodexError> {
        // Composed before the service is touched, so an unresolvable context costs nothing.
        let settings = self
            .compose_thread_settings(CodexSettingsRequest {
                session_id: params.session_id,
                model: params.model.as_str(),
                larger_window: params.larger_window,
                execution_posture: params.execution_posture.as_ref(),
                subagent_policy: params.subagent_policy.as_ref(),
                tool_servers: params.tool_servers.as_deref(),
                provider_account_id: params.provider_account_id.as_ref(),
            })
            .await?;
        let execution_posture = require_execution_posture(params.execution_posture.as_ref())?;
        let service = self
            .start_service(params.provider_account_id.as_ref())
            .await?;
        service.check_takes_new_work(THREAD_START_METHOD)?;
        if let Some(larger_window) = params.larger_window {
            confirm_larger_window(&service, &settings.model, larger_window.get()).await?;
        }
        let connection = service.connection()?;
        // Before the service is asked, so a level the model does not list reaches no conversation.
        let output_speed = resolve_codex_output_speed_level(
            || read_codex_service_model_catalog(&connection),
            &settings.model,
            params
                .output_speed
                .as_ref()
                .map(|level| level.as_str().to_owned()),
        )
        .await
        .map_err(CodexError::Driver)?;
        let claim = service.begin_thread_claim();
        let mut start =
            compose_codex_thread_start_params(&settings, self.tool_server_route().as_deref());
        start.service_tier =
            compose_codex_service_tier(output_speed.as_deref()).map(CodexServiceTierChange);
        let reply = connection.request(THREAD_START_METHOD, &start).await?;
        let thread = read_thread(&reply, THREAD_START_METHOD)?;
        // A conversation that started under the wrong level is let go before the fault surfaces.
        if let Err(error) = assert_codex_thread_profile(&reply, &settings, THREAD_START_METHOD) {
            let_go_codex_thread(&service, &thread.id).await;
            return Err(error);
        }
        let Some(version) = service.version_reading() else {
            let_go_codex_thread(&service, &thread.id).await;
            return Err(CodexError::Transport {
                detail: "The Codex service reported no version for the new session's binding."
                    .to_owned(),
                cause: None,
            });
        };
        let (inbound, receiver) = codex_session_inbound(params.session_id);
        let record = CodexSessionRecord::new(CodexEstablishedConversation {
            session_id: params.session_id,
            service,
            inbound,
            thread_id: thread.id.clone(),
            // Named by the session's first run.
            binding_id: None,
            provider_account_id: params.provider_account_id.clone(),
            turn_boundaries: Vec::new(),
            thread_settings: settings,
            execution_posture,
            // Every turn names its mode, so the first carries the one the session stores.
            session_mode: params.mode,
            output_speed_request: params
                .output_speed
                .as_ref()
                .map(|level| level.as_str().to_owned()),
            declared_output_speed: read_codex_declared_tier(params.session_id, &reply),
            reasoning_effort: read_thread_reasoning_effort(&reply),
        });
        // `id` is the resume key; `sessionId` groups a thread tree, so the two differ.
        let handle = ProviderSessionHandle {
            provider_session_id: thread.session_id,
            resume_handle: thread.id,
            spawned_version: to_binding_version_carriers(&version),
        };
        Ok((
            handle,
            CodexEstablishedSession {
                record,
                receiver,
                claim,
                is_resumed: false,
            },
        ))
    }

    /// Reopens a conversation from its handle on the account's service by forking it there with
    /// every setting the session holds, since its config reaches a conversation only through a
    /// start, resume or fork, and a resume of one another client holds applies none of it. The
    /// session runs on the fork, which the result names under a binding minted here. Every
    /// failure answers `Failed`, nothing left behind.
    pub(crate) async fn resume_as_fork(&self, params: &ResumeSessionParams) -> CodexForkedResume {
        let mut service = None;
        match self.fork_for_resume(params, &mut service).await {
            Ok((result, established)) => CodexForkedResume {
                result,
                established: Some(established),
            },
            Err(error) => CodexForkedResume {
                result: compose_failed_resume(service.as_deref(), &error).await,
                established: None,
            },
        }
    }

    async fn fork_for_resume(
        &self,
        params: &ResumeSessionParams,
        started: &mut Option<Arc<CodexService>>,
    ) -> Result<(DriverResumeResult, CodexEstablishedSession), CodexError> {
        let settings = self
            .compose_thread_settings(compose_resume_settings_request(params))
            .await?;
        let execution_posture = require_execution_posture(params.execution_posture.as_ref())?;
        let service = Arc::clone(
            started.insert(
                self.start_service(params.provider_account_id.as_ref())
                    .await?,
            ),
        );
        let connection = service.connection()?;
        let output_speed_request = params
            .output_speed
            .as_ref()
            .map(|level| level.as_str().to_owned());
        let claim = service.begin_thread_claim();
        let forked = request_codex_fork(
            CodexForkSource {
                settings: &settings,
                output_speed_request: output_speed_request.clone(),
                thread_id: params.resume_handle.clone(),
            },
            &self.dependencies.tool_server_route,
            &connection,
            CodexForkBoundary::Whole,
        )
        .await?;
        let turn_ids =
            read_codex_fork_or_let_go(&settings, params.mode, &service, &connection, &forked)
                .await?;
        let Some(version) = service.version_reading() else {
            let_go_codex_thread(&service, &forked.thread_id).await;
            return Err(CodexError::Transport {
                detail: "The Codex service reported no version for the resumed session's binding."
                    .to_owned(),
                cause: None,
            });
        };
        let binding_id = mint_runtime_binding_id();
        let result = DriverResumeResult::Resumed {
            binding_id: binding_id.clone(),
            session_position: count_turns(turn_ids.len()),
            resume_handle: NonEmptyText::new(forked.thread_id.clone())
                .expect("a forked conversation's id is never empty"),
            spawned_version: to_binding_version_carriers(&version),
        };
        let (inbound, receiver) = codex_session_inbound(params.session_id);
        let record = CodexSessionRecord::new(CodexEstablishedConversation {
            session_id: params.session_id,
            service,
            inbound,
            thread_id: forked.thread_id.clone(),
            binding_id: Some(binding_id),
            provider_account_id: params.provider_account_id.clone(),
            turn_boundaries: turn_ids,
            thread_settings: settings,
            execution_posture,
            session_mode: params.mode,
            output_speed_request,
            declared_output_speed: read_codex_declared_tier(params.session_id, &forked.reply),
            reasoning_effort: read_thread_reasoning_effort(&forked.reply),
        });
        Ok((
            result,
            CodexEstablishedSession {
                record,
                receiver,
                claim,
                is_resumed: true,
            },
        ))
    }

    /// The account's service, started, and the settings a resting session's stored conversation
    /// runs under, composed from its resume material as a resume composes them. Fails as the
    /// composition or the service's start fails.
    pub(crate) async fn compose_resting_conversation(
        &self,
        params: &ResumeSessionParams,
    ) -> Result<(Arc<CodexService>, CodexThreadSettings), CodexError> {
        let settings = self
            .compose_thread_settings(compose_resume_settings_request(params))
            .await?;
        let service = self
            .start_service(params.provider_account_id.as_ref())
            .await?;
        Ok((service, settings))
    }

    /// Opens an established conversation on its service: its routing band binds it, its usage
    /// based at zero for a fresh one and at `prior_emitted` for a resumed one, since the provider's
    /// counter survives a resume; the session's queue is attached, the conversation registered and
    /// its held frames delivered, and the claim let go.
    pub(crate) async fn open(
        &self,
        established: CodexEstablishedSession,
        prior_emitted: Option<UsageAxisCounts>,
    ) -> CodexOpenedSession {
        let CodexEstablishedSession {
            mut record,
            receiver,
            claim,
            is_resumed,
        } = established;
        let base = if is_resumed {
            // The list read before the resume is stale; a fresh read follows the next request.
            self.dependencies
                .provider_commands
                .discard_listing(record.session_id);
            ThreadBaseEstablishment::Resume {
                prior_emitted_cumulative: prior_emitted.unwrap_or_default(),
            }
        } else {
            ThreadBaseEstablishment::Fresh
        };
        let mut routing = CodexSessionRouting::new(self.dependencies.pending_compactions.clone());
        let thread_id = record.thread_id.clone();
        let routed = routing
            .bind_session_thread(&self.dependencies.delivery, &mut record, thread_id, base)
            .await;
        record.service.attach_session(record.inbound.clone());
        record
            .service
            .register_thread(record.thread_id.clone(), record.session_id);
        self.record_service_process(record.session_id, &record.service);
        drop(claim);
        CodexOpenedSession {
            record,
            receiver,
            routing,
            routed,
        }
    }

    /// Resumes the session's conversation on `service` in place, on the session's task: after its
    /// service crashed or its connection came back, or once it left the old service for a new
    /// build. The resume carries the settings the record holds now, under `binding_id`, which the
    /// caller minted and opened, and the conversation's turns come back with the result, so a
    /// caller can end the ones that ended unseen. A resume refused while another runtime still
    /// writes the conversation is tried again each time `writer_left` answers `true`. Every
    /// failure answers `Failed`, reported.
    pub(crate) async fn resume_in_place<WriterLeft>(
        &self,
        task: &mut CodexSessionTask<'_>,
        service: Arc<CodexService>,
        binding_id: RuntimeBindingId,
        mut writer_left: impl FnMut() -> WriterLeft,
    ) -> CodexInPlaceResume
    where
        WriterLeft: Future<Output = bool>,
    {
        // Asked for before the resume, so no report of it can arrive ahead of the record knowing.
        task.record.permission_profiles =
            CodexThreadPermissionProfiles::established(&task.record.thread_settings);
        let resumed = loop {
            match self.resume_thread(task.record, &service).await {
                Err(error) if error.is_active_writer_refusal() && writer_left().await => {}
                resumed => break resumed,
            }
        };
        match self
            .adopt_resumed_thread(task, Arc::clone(&service), binding_id, resumed)
            .await
        {
            Ok(resumed) => resumed,
            Err(error) => {
                let result = compose_failed_resume(Some(&service), &error).await;
                CodexTransportDiagnostic::ConversationResumeFailed {
                    thread_id: task.record.thread_id.clone(),
                    error: Box::new(error),
                }
                .report();
                CodexInPlaceResume {
                    result,
                    listed_turns: Vec::new(),
                    routed: CodexRoutedFrames::default(),
                }
            }
        }
    }

    // Moves the record onto the resumed conversation: its service, binding, turns, tier and
    // effort, its mode sent again, and its routing band rebound on the sum already metered. The
    // record changes only once every step that can fail is done; a failure releases the
    // conversation's registration on `service` when the resume made it.
    async fn adopt_resumed_thread(
        &self,
        task: &mut CodexSessionTask<'_>,
        service: Arc<CodexService>,
        binding_id: RuntimeBindingId,
        resumed: Result<CodexResumedThread, CodexError>,
    ) -> Result<CodexInPlaceResume, CodexError> {
        let resumed = resumed?;
        let adopted = prepare_adoption(task.record, &service, &resumed, &binding_id).await;
        let result = match adopted {
            Ok(adopted) => adopted,
            Err(error) => {
                if !resumed.was_held {
                    service.release_thread(&task.record.thread_id);
                }
                return Err(error);
            }
        };
        let record = &mut *task.record;
        record.service = service;
        record.binding_id = Some(binding_id);
        record.turn_boundaries = resumed
            .listed_turns
            .iter()
            .map(|listed| listed.id.clone())
            .collect();
        record.declared_output_speed = resumed.declared_output_speed;
        record.reasoning_effort = resumed.reasoning_effort;
        self.record_service_process(record.session_id, &record.service);
        self.dependencies
            .provider_commands
            .discard_listing(record.session_id);
        let thread_id = record.thread_id.clone();
        let routed = task
            .routing
            .rebind_session_thread(&self.dependencies.delivery, task.record, thread_id)
            .await;
        Ok(CodexInPlaceResume {
            result,
            listed_turns: resumed.listed_turns,
            routed,
        })
    }

    // `thread/resume` with every setting the record holds, then the turn history read back page
    // by page. A reply naming another conversation fails: Codex started a replacement.
    async fn resume_thread(
        &self,
        record: &CodexSessionRecord,
        service: &CodexService,
    ) -> Result<CodexResumedThread, CodexError> {
        let connection = service.connection()?;
        let settings = &record.thread_settings;
        // The level rebuilt from the record; one the model no longer lists resumes at standard.
        let output_speed = resolve_codex_output_speed_level(
            || read_codex_service_model_catalog(&connection),
            &settings.model,
            record.output_speed_request.clone(),
        )
        .await
        .map_err(CodexError::Driver)?;
        let _claim = service.begin_thread_claim();
        let mut resume = compose_codex_thread_resume_params(
            settings,
            self.tool_server_route().as_deref(),
            record.thread_id.clone(),
        );
        // The history is paged afterwards instead of arriving on one reply.
        resume.exclude_turns = Some(true);
        resume.service_tier =
            compose_codex_service_tier(output_speed.as_deref()).map(CodexServiceTierChange);
        let reply = connection.request(THREAD_RESUME_METHOD, &resume).await?;
        let thread = read_thread(&reply, THREAD_RESUME_METHOD)?;
        if thread.id != record.thread_id {
            return Err(CodexError::Transport {
                detail: format!(
                    "Resume handle {} was answered by thread {}; the provider started a \
                     replacement conversation rather than resuming.",
                    record.thread_id, thread.id
                ),
                cause: None,
            });
        }
        assert_codex_thread_profile(&reply, settings, THREAD_RESUME_METHOD)?;
        let was_held = service
            .threads_of(&record.session_id)
            .contains(&record.thread_id);
        // Registered before the history read, so the thread's frames reach the session from now.
        service.register_thread(record.thread_id.clone(), record.session_id);
        match read_codex_turns(&connection, &record.thread_id).await {
            Ok(listed_turns) => Ok(CodexResumedThread {
                listed_turns,
                was_held,
                declared_output_speed: read_codex_declared_tier(record.session_id, &reply),
                reasoning_effort: read_thread_reasoning_effort(&reply),
            }),
            Err(error) => {
                if !was_held {
                    service.release_thread(&record.thread_id);
                }
                Err(error)
            }
        }
    }

    // The settings a session's conversation runs with, resolved afresh at every start and resume,
    // with its helpers' role files written again. Fails with `CodexError::DriverConfig` with no
    // posture, since every conversation runs at a level, and as the context, the credential list,
    // the environment or the role files fail.
    async fn compose_thread_settings(
        &self,
        request: CodexSettingsRequest<'_>,
    ) -> Result<CodexThreadSettings, CodexError> {
        let posture = require_execution_posture(request.execution_posture)?;
        let dependencies = &self.dependencies;
        let spawn_contexts = &dependencies.spawn_contexts;
        let context = spawn_contexts
            .require_port()
            .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))?
            .resolve_spawn_context(request.session_id, request.provider_account_id.cloned())
            .await
            .map_err(|cause| CodexError::PortFailed {
                port: spawn_contexts.port_name(),
                cause,
            })?;
        let credential_policy = dependencies
            .execution_postures
            .resolve_credential_policy(posture.credential_policy_ref().as_str())
            .await
            .map_err(|error| config_error("credentialPolicy", "the credential list", error))?;
        // An account's own Codex home is the commands' too; the person's own sign-in sets none.
        let credential_homes: Vec<(String, String)> = context
            .account_folders
            .iter()
            .flat_map(|folders| {
                DESCRIPTOR
                    .credential_home_environment_names
                    .iter()
                    .map(|name| {
                        (
                            (*name).to_owned(),
                            folders.configuration_folder.to_string_lossy().into_owned(),
                        )
                    })
            })
            .collect();
        let command_environment =
            build_conversation_command_environment(&ProviderEnvironmentRequest {
                session: SessionEnvironment {
                    base: &dependencies.base_environment,
                    every_project_rows: &context.every_project_rows,
                    project_rows: &context.project_rows,
                    reserved_names: &dependencies.reserved_names,
                    rules: PathRules::NATIVE,
                },
                descriptor: &DESCRIPTOR,
                deny_env_vars: credential_policy.deny_env_vars,
                credential_homes: &credential_homes,
            })
            .map_err(|error| config_error("environment", "the commands' environment", error))?;
        let definitions = match request.subagent_policy {
            Some(SubagentPolicy::Enabled { definitions, .. }) => definitions.as_slice(),
            Some(SubagentPolicy::Disabled {}) | None => &[],
        };
        let helper_roles = write_codex_helper_roles(
            &dependencies.helper_roles_folder,
            request.session_id,
            definitions,
        )
        .await
        .map_err(CodexError::Driver)?;
        report_withheld_definition_fields(definitions, request.provider_account_id);
        Ok(CodexThreadSettings {
            session_id: request.session_id,
            working_directory: context.working_directory.clone(),
            model: request.model.to_owned(),
            // A resume sends the recorded figure whatever the catalog offers now; Codex refuses
            // one it cannot run, and that failure surfaces like any other.
            model_context_window: request.larger_window.map(SafeInt::get),
            level: posture.permission_level(),
            profile_folders: CodexProfileFolders {
                working_directory: context.working_directory,
                git_common_folder: context.git_common_folder,
                // Codex denies a folder's whole tree and a file alike by its path.
                deny_paths: credential_policy
                    .deny_paths
                    .into_iter()
                    .map(|denied| denied.path)
                    .collect(),
            },
            command_environment,
            subagent_policy: request.subagent_policy.cloned(),
            helper_roles,
            tool_servers: request.tool_servers.map(<[_]>::to_vec).unwrap_or_default(),
            // The daemon's spawn context carries no instructions for a conversation.
            base_instructions: None,
        })
    }

    // The account's service, started or joined. Fails as the home's resolve or the start does.
    async fn start_service(
        &self,
        provider_account_id: Option<&ProviderAccountId>,
    ) -> Result<Arc<CodexService>, CodexError> {
        let service = self
            .dependencies
            .services
            .service_for(provider_account_id)
            .await
            .map_err(CodexError::Driver)?;
        service
            .ensure_started(service.dependencies().startup_timeout)
            .await?;
        Ok(service)
    }

    fn tool_server_route(&self) -> Option<Arc<dyn ToolServerRoute>> {
        self.dependencies.tool_server_route.port().cloned()
    }

    // Records `service`'s process as the one running `session_id`, under the identity the
    // service drew when it pinned that process; a service the daemon did not start, which has no
    // process of the daemon's, records none.
    fn record_service_process(&self, session_id: SessionId, service: &CodexService) {
        let Some(identity) = service.process_identity() else {
            self.let_go_service_process(session_id);
            return;
        };
        self.dependencies.processes.record(session_id, identity);
    }

    /// Takes `session_id` out of the daemon's provider processes, as its record is let go.
    pub(crate) fn let_go_service_process(&self, session_id: SessionId) {
        let processes = &self.dependencies.processes;
        if let Some(identity) = processes.process_identity(&session_id) {
            processes.remove_exited(session_id, identity);
        }
    }

    /// Takes every session on `service` out of the daemon's provider processes once its process
    /// ended.
    pub(crate) fn forget_service_process(&self, service: &CodexService) {
        for inbound in service.attached_sessions() {
            self.let_go_service_process(inbound.session_id());
        }
    }
}

/// What a resume reads back: the conversation's turns, whether the session held the conversation
/// on the service before it, its declared tier and its effort.
struct CodexResumedThread {
    listed_turns: Vec<CodexListedTurn>,
    was_held: bool,
    declared_output_speed: Option<ProviderOutputSpeedState>,
    reasoning_effort: Option<String>,
}

// The steps of an adoption that can fail, run before the record changes: the binding's version
// read, and the session's mode sent on `service`'s connection with the resumed effort. Answers
// the result under `binding_id`.
async fn prepare_adoption(
    record: &CodexSessionRecord,
    service: &CodexService,
    resumed: &CodexResumedThread,
    binding_id: &RuntimeBindingId,
) -> Result<DriverResumeResult, CodexError> {
    let Some(version) = service.version_reading() else {
        return Err(CodexError::Transport {
            detail: "The Codex service reported no version for the resumed session's binding."
                .to_owned(),
            cause: None,
        });
    };
    let connection = service.connection()?;
    update_codex_session_mode(
        &connection,
        &record.thread_id,
        record.session_mode,
        &record.thread_settings.model,
        resumed.reasoning_effort.as_deref(),
    )
    .await?;
    Ok(DriverResumeResult::Resumed {
        binding_id: binding_id.clone(),
        session_position: count_turns(resumed.listed_turns.len()),
        resume_handle: NonEmptyText::new(record.thread_id.clone())
            .expect("a resumed conversation's id is never empty"),
        spawned_version: to_binding_version_carriers(&version),
    })
}

// What a resume composes its conversation's settings from.
fn compose_resume_settings_request(params: &ResumeSessionParams) -> CodexSettingsRequest<'_> {
    CodexSettingsRequest {
        session_id: params.session_id,
        model: params.model.as_str(),
        larger_window: params.larger_window,
        execution_posture: params.execution_posture.as_ref(),
        subagent_policy: params.subagent_policy.as_ref(),
        tool_servers: params.tool_servers.as_deref(),
        provider_account_id: params.provider_account_id.as_ref(),
    }
}

/// Refuses a create whose larger window the service's catalog does not offer `model` at that
/// figure now, so a picker row read before the catalog changed starts no conversation. A failed
/// catalog read, or an unreadable row for the model, fails as itself.
async fn confirm_larger_window(
    service: &CodexService,
    model: &str,
    larger_window: u64,
) -> Result<(), CodexError> {
    let dump = read_codex_model_catalog_dump(service).await?;
    let offered = read_codex_larger_window(&dump, model).map_err(|unreadable| {
        CodexError::Driver(DriverError::ModelCatalogUnreadable(unreadable))
    })?;
    if offered == Some(larger_window) {
        return Ok(());
    }
    Err(CodexError::LargerWindowUnavailable {
        model: model.to_owned(),
        requested: larger_window,
        offered,
    })
}

// The session's posture. Fails with `CodexError::DriverConfig` with none: every conversation
// runs at a level.
fn require_execution_posture(
    posture: Option<&ExecutionPosture>,
) -> Result<ExecutionPosture, CodexError> {
    posture.cloned().ok_or_else(|| CodexError::DriverConfig {
        field: "executionPosture".to_owned(),
        detail: "a Codex conversation always runs at a permission level, so the session needs an \
                 execution posture"
            .to_owned(),
        cause: None,
    })
}

fn config_error(
    field: &str,
    what: &str,
    error: impl std::error::Error + Send + Sync + 'static,
) -> CodexError {
    CodexError::DriverConfig {
        field: field.to_owned(),
        detail: format!("{what} could not be composed"),
        cause: Some(Box::new(error)),
    }
}

// Reports each field of a helper definition its role file cannot carry, so the helper is known
// to run without it.
fn report_withheld_definition_fields(
    definitions: &[SubagentDefinition],
    provider_account_id: Option<&ProviderAccountId>,
) {
    for definition in definitions {
        for field in read_codex_role_file_withheld_fields(definition) {
            CodexTransportDiagnostic::SubagentDefinitionFieldWithheld {
                provider_account_id: provider_account_id.cloned(),
                definition_name: definition.name.clone(),
                field,
            }
            .report();
        }
    }
}

/// A failed resume's result: the recovery its failure needs, read from the service where one was
/// reached, and its words bounded.
pub(crate) async fn compose_failed_resume(
    service: Option<&CodexService>,
    error: &CodexError,
) -> DriverResumeResult {
    let recovery_condition = match service {
        Some(service) => classify_codex_resume_recovery_condition(service, error).await,
        None => RecoveryCondition::RecoveryNeeded,
    };
    DriverResumeResult::Failed {
        recovery_condition,
        provider_failure_detail: bound_failure_detail(
            &error.to_string(),
            UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
        ),
    }
}

// A conversation's turn count as a session position; no conversation holds 2^53 turns.
fn count_turns(turns: usize) -> SafeInt<0> {
    u64::try_from(turns)
        .ok()
        .and_then(SafeInt::new)
        .expect("a conversation's turn count is a safe integer")
}

#[cfg(test)]
mod tests;
