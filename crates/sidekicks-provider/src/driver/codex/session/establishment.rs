//! A Codex session's establishment: its conversation started on its account's service, adopted
//! in place by its handle (`adoption`), or resumed in place after its service came back or moved
//! (`resume`); then its record composed, its routing band bound and its conversation registered on
//! the service. A failed resume never becomes a new conversation: it answers the failure.

mod adoption;
pub(crate) mod answer_steer;
pub(crate) mod continuation;
pub(crate) mod helpers;
pub(super) mod mcp_read;
mod resume;
mod settings;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::value::RawValue;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_std::port_registration::PortRegistration;

use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::SessionSpawnContextResolver;
use crate::driver::codex::app_server_protocol::ThreadResumeParams;
use crate::driver::codex::auth_status::classify_codex_resume_recovery_condition;
use crate::driver::codex::capabilities::{find_codex_model_row, read_codex_service_model_catalog};
use crate::driver::codex::commands::CodexProviderCommandCache;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::model_windows::read_codex_larger_window;
use crate::driver::codex::notification_routing::{CodexRoutedFrames, CodexSessionRouting};
use crate::driver::codex::output_speed::{
    compose_codex_service_tier, read_codex_declared_tier, resolve_codex_output_speed_level,
};
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::service::command::read_codex_model_catalog_dump;
use crate::driver::codex::service::home::CodexConversationHome;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::threads::ThreadClaim;
use crate::driver::codex::session::context_reading::CodexFixedStart;
use crate::driver::codex::session::controls::update_codex_session_mode;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::answer_steer::CodexAnswerSteer;
use crate::driver::codex::session::establishment::mcp_read::{
    compose_codex_call_table, send_with_stale_name_resend,
};
use crate::driver::codex::session::history::{
    CodexListedTurn, compose_codex_newest_turn_page, read_codex_resumed_newest_turn,
    read_codex_turns,
};
use crate::driver::codex::session::inbound::{CodexSessionInboundReceiver, codex_session_inbound};
use crate::driver::codex::session::owed_turn_ends::{
    end_owed_codex_helper_turn, end_owed_codex_turns,
};
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::codex::session::state::{CodexEstablishedConversation, CodexSessionRecord};
use crate::driver::codex::thread::settings::{
    CodexServiceTierChange, CodexThreadSettings, compose_codex_thread_resume_params,
    compose_codex_thread_start_params,
};
use crate::driver::codex::thread::view::{
    CodexThreadStatus, THREAD_RESUME_METHOD, THREAD_START_METHOD, assert_codex_thread_profile,
    read_thread, read_thread_reasoning_effort,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::error::{DriverError, bound_failure_detail};
use crate::driver::error_causes::{ProviderAxisInvalid, UNSPECIFIED_PROVIDER_FAILURE_DETAIL};
use crate::driver::session_control::{
    CreateSessionParams, DriverResumeResult, ProviderSessionHandle, ResumeSessionParams,
    ResumedRunAnswer, SessionAccountPin,
};
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::port::tool_server_route::ToolServerRoute;
use crate::process_identity::ProviderProcessIds as _;
use crate::process_registry::ProviderProcessRegistry;
use crate::run::posture::ExecutionPostureService;
use crate::spawn_environment::ReservedEnvironmentNames;
use crate::spawned_version::to_binding_version_carriers;
use crate::usage_delta_accountant::{ThreadBaseEstablishment, UsageAxisCounts};

use crate::driver::codex::session::establishment::adoption::CodexRestoredHelper;
use crate::driver::codex::session::establishment::settings::{
    CodexSettingsRequest, compose_resume_settings_request, require_execution_posture,
};

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
    /// The driver's run routes, which an adopted conversation's live turns are bound on again.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The compaction waits each session's routing band settles.
    pub(crate) pending_compactions: PendingCompactionRegistry,
    /// The provider command lists, whose list read before a resume is dropped.
    pub(crate) provider_commands: Arc<CodexProviderCommandCache>,
    /// Which provider process runs each session, where each session's service process is kept.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// The approval pipeline's reviewer blocks, whose held presses a retired binding lets go.
    pub(crate) reviewer_denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>,
    /// The folder each session's command channel folder sits in, named by the session.
    pub(crate) command_channel_root: PathBuf,
}

/// A conversation established and not yet open: its record and queue, the claim that holds its
/// frames, how its usage is based once its routing band binds it, and, for an adopted one, its
/// turns as Codex listed them and the helpers it holds again.
pub(crate) struct CodexEstablishedSession {
    record: CodexSessionRecord,
    receiver: CodexSessionInboundReceiver,
    claim: ThreadClaim,
    // Kept from the conversation's metadata exactly when it was resumed.
    fixed_start: CodexFixedStart,
    // Oldest first; none for a fresh conversation.
    listed_turns: Vec<CodexListedTurn>,
    helpers: Vec<CodexRestoredHelper>,
    // The steer of the person's answers a held lead's running continuation is owed once the
    // session's task runs; none for a fresh conversation.
    answer_steer: Option<CodexAnswerSteer>,
}

impl CodexEstablishedSession {
    /// Takes the steer of the person's answers the adopted conversation owes its lead, which the
    /// caller sends once the session's task runs.
    pub(crate) fn take_answer_steer(&mut self) -> Option<CodexAnswerSteer> {
        self.answer_steer.take()
    }

    /// The helpers an adopted conversation holds again, each with the spend its usage is based on,
    /// which the caller reads before the session opens.
    pub(crate) fn restored_helpers_mut(&mut self) -> &mut [CodexRestoredHelper] {
        &mut self.helpers
    }
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
    /// Where the conversation takes its fixed start from.
    pub(crate) fixed_start: CodexFixedStart,
}

/// What a resume by a session's handle did: the result to answer, and the session to open once it
/// resumed.
pub(crate) struct CodexHandleResume {
    /// The result.
    pub(crate) result: DriverResumeResult,
    /// The session, `None` when the resume failed.
    pub(crate) established: Option<CodexEstablishedSession>,
}

/// A resume in place's result, and whether it failed because its service went down under it.
pub(crate) struct CodexInPlaceOutcome {
    /// The result.
    pub(crate) result: DriverResumeResult,
    /// Whether the resume failed because its service went down under it: the service held no
    /// connection, or its connection closed before the answer. The service's next recovery
    /// resumes the conversation again; any other failure is the live service's refusal.
    pub(crate) is_service_lost: bool,
}

/// A conversation resumed in place, its turns as Codex listed them, none when it failed, and the
/// frames rebinding it released, which the session's task applies.
pub(crate) struct CodexInPlaceResume {
    /// The result, and why it failed where it did.
    pub(crate) outcome: CodexInPlaceOutcome,
    /// The conversation's turns, oldest first.
    pub(crate) listed_turns: Vec<CodexListedTurn>,
    /// How Codex read the conversation at the resume, `None` when it failed.
    pub(crate) status: Option<CodexThreadStatus>,
    /// The frames that waited for the conversation, delivered.
    pub(crate) routed: CodexRoutedFrames,
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
    /// now), the effort's check (`agent.providerAxisInvalid` for an effort the catalog's row for
    /// the model does not list), the tool servers' reads, the request or the profile's read-back
    /// fails, and when the service reported no version.
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
                provider_account_id: &params.provider_account_id,
            })
            .await?
            .thread_settings;
        let execution_posture = require_execution_posture(params.execution_posture.as_ref())?;
        // A session following the current account runs on the switching service, which moves it
        // with each switch; a pinned one on its account's own.
        let home = match params.account_pin {
            SessionAccountPin::FollowsCurrent => CodexConversationHome::Switching,
            SessionAccountPin::Pinned => CodexConversationHome::Account,
        };
        let service = self
            .start_service(&params.provider_account_id, home)
            .await?;
        // A switch with no session to move left the switching service where it was, so the new
        // session's account is handed to it here, before its conversation starts.
        if matches!(home, CodexConversationHome::Switching) {
            service
                .dependencies()
                .switching
                .carry_for_session(&service, &params.provider_account_id)
                .await?;
        }
        service.check_takes_new_work(THREAD_START_METHOD)?;
        if let Some(larger_window) = params.larger_window {
            confirm_larger_window(&service, &settings.model, larger_window.get()).await?;
        }
        let connection = service.connection()?;
        // Before the service is asked, so an effort the model does not list starts no
        // conversation; Codex takes a model it does not list, whose effort is then unchecked.
        let catalog = match &params.effort {
            Some(effort) => {
                let catalog = read_codex_service_model_catalog(&connection)
                    .await
                    .map_err(CodexError::Driver)?;
                if let Some(row) = find_codex_model_row(&catalog, &settings.model) {
                    ProviderAxisInvalid::check_effort(
                        params.agent_id,
                        effort.as_str(),
                        row.effort_levels.as_deref(),
                    )
                    .map_err(|invalid| CodexError::Driver(invalid.into()))?;
                }
                Some(catalog)
            }
            None => None,
        };
        // Before the service is asked, so a level the model does not list reaches no conversation.
        let output_speed = resolve_codex_output_speed_level(
            || async {
                match catalog {
                    Some(catalog) => Ok(catalog),
                    None => read_codex_service_model_catalog(&connection).await,
                }
            },
            &settings.model,
            params
                .output_speed
                .as_ref()
                .map(|level| level.as_str().to_owned()),
        )
        .await
        .map_err(CodexError::Driver)?;
        let claim = service.begin_thread_claim();
        let service_tier =
            compose_codex_service_tier(output_speed.as_deref()).map(CodexServiceTierChange);
        let route = self.tool_server_route();
        let (services, route) = (&*self.dependencies.services, route.as_deref());
        let (start_settings, start_connection, start_service) =
            (&settings, &*connection, &*service);
        let reply = send_with_stale_name_resend(
            start_connection,
            &settings.working_directory,
            move |loaded| {
                let service_tier = service_tier.clone();
                async move {
                    let table = compose_codex_call_table(
                        services,
                        start_service,
                        start_settings,
                        route,
                        &loaded,
                    )
                    .await?;
                    let mut start = compose_codex_thread_start_params(start_settings, table);
                    start.service_tier = service_tier;
                    start_connection.request(THREAD_START_METHOD, &start).await
                }
            },
        )
        .await?;
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
            lead_agent_id: params.agent_id,
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
            on_mcp_server_status: params.on_mcp_server_status.clone(),
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
                fixed_start: CodexFixedStart::FirstRequest,
                listed_turns: Vec::new(),
                helpers: Vec::new(),
                answer_steer: None,
            },
        ))
    }

    /// The service of the home holding a resting session's stored conversation, started, and the
    /// settings it runs under, composed from its resume material as a resume composes them. Fails
    /// as the composition or the service's start fails.
    pub(crate) async fn compose_resting_conversation(
        &self,
        params: &ResumeSessionParams,
    ) -> Result<(Arc<CodexService>, CodexThreadSettings), CodexError> {
        let settings = self
            .compose_thread_settings(compose_resume_settings_request(params))
            .await?
            .thread_settings;
        let service = self
            .start_service(
                &params.provider_account_id,
                CodexConversationHome::read(&params.runtime_metadata),
            )
            .await?;
        Ok((service, settings))
    }

    /// Opens an established conversation on its service: its routing band binds it, its usage
    /// based at zero for a fresh one, which leaves `prior_emitted` unread, and at `prior_emitted`
    /// for a resumed one, since the provider's counter survives a resume, and binds again each
    /// helper an adoption holds; the session's queue is attached, the conversation and its helpers
    /// registered and its held frames delivered, and the claim let go; last, each turn an adoption
    /// bound that Codex listed as over, and each restored helper's newest turn listed over, is
    /// ended as Codex ended it.
    pub(crate) async fn open(
        &self,
        established: CodexEstablishedSession,
        prior_emitted: UsageAxisCounts,
    ) -> CodexOpenedSession {
        let CodexEstablishedSession {
            mut record,
            receiver,
            claim,
            fixed_start,
            listed_turns,
            helpers,
            answer_steer: _,
        } = established;
        let is_resumed = matches!(fixed_start, CodexFixedStart::Kept(_));
        let base = if is_resumed {
            // The list read before the resume is stale; a fresh read follows the next request.
            self.dependencies
                .provider_commands
                .discard_listing(record.session_id);
            ThreadBaseEstablishment::Resume {
                prior_emitted_cumulative: prior_emitted,
            }
        } else {
            ThreadBaseEstablishment::Fresh
        };
        let mut routing = CodexSessionRouting::new(self.dependencies.pending_compactions.clone());
        let thread_id = record.thread_id.clone();
        let delivery = &self.dependencies.delivery;
        let mut routed = routing
            .bind_session_thread(delivery, &mut record, thread_id, base)
            .await;
        for helper in &helpers {
            let restored = routing
                .restore_helper_thread(
                    delivery,
                    &mut record,
                    helper.thread_id.clone(),
                    helper.prior_emitted,
                    helper.model.clone(),
                )
                .await;
            routed.extend(restored);
        }
        record.service.attach_session(record.inbound.clone());
        record
            .service
            .register_thread(record.thread_id.clone(), record.session_id);
        self.record_service_process(record.session_id, &record.service);
        drop(claim);
        let ended = end_owed_codex_turns(&mut routing, delivery, &mut record, &listed_turns).await;
        routed.extend(ended);
        for helper in &helpers {
            let ended = end_owed_codex_helper_turn(
                &mut routing,
                delivery,
                &mut record,
                &helper.thread_id,
                &helper.newest_turn,
            )
            .await;
            routed.extend(ended);
        }
        CodexOpenedSession {
            record,
            receiver,
            routing,
            routed,
            fixed_start,
        }
    }

    // `thread/resume` of the record's conversation on `service` with every setting the record
    // holds, its output speed rebuilt from the record and its tool servers against the resume's own
    // read, and the reply. Fails as the reads or the request do, and when the reply names another
    // conversation or runs it under another profile.
    async fn request_resume_with_settings(
        &self,
        record: &CodexSessionRecord,
        service: &CodexService,
        connection: &CodexAppServerConnection,
    ) -> Result<Box<RawValue>, CodexError> {
        let settings = &record.thread_settings;
        // The level rebuilt from the record; one the model no longer lists resumes at standard.
        let output_speed = resolve_codex_output_speed_level(
            || read_codex_service_model_catalog(connection),
            &settings.model,
            record.output_speed_request.clone(),
        )
        .await
        .map_err(CodexError::Driver)?;
        let service_tier =
            compose_codex_service_tier(output_speed.as_deref()).map(CodexServiceTierChange);
        let route = self.tool_server_route();
        let (services, route) = (&*self.dependencies.services, route.as_deref());
        let thread_id = record.thread_id.as_str();
        let reply =
            send_with_stale_name_resend(connection, &settings.working_directory, move |loaded| {
                let service_tier = service_tier.clone();
                async move {
                    let table =
                        compose_codex_call_table(services, service, settings, route, &loaded)
                            .await?;
                    let mut resume =
                        compose_codex_thread_resume_params(settings, table, thread_id.to_owned());
                    // The history is paged afterwards instead of arriving on one reply.
                    resume.exclude_turns = Some(true);
                    resume.initial_turns_page = Some(compose_codex_newest_turn_page());
                    resume.service_tier = service_tier;
                    request_thread_resume(connection, thread_id, &resume).await
                }
            })
            .await?;
        assert_codex_thread_profile(&reply, settings, THREAD_RESUME_METHOD)?;
        Ok(reply)
    }

    // The service of `home`, the switching home or `provider_account_id`'s own, started or joined.
    // Fails as the home's resolve or the start does.
    async fn start_service(
        &self,
        provider_account_id: &ProviderAccountId,
        home: CodexConversationHome,
    ) -> Result<Arc<CodexService>, CodexError> {
        let service = self
            .dependencies
            .services
            .service_for_conversation(provider_account_id, home)
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

/// What a resume reads back: the conversation's turns, the newest of them, whether the session
/// held the conversation on the service before it, where the conversation stands, its declared
/// tier and its effort.
struct CodexResumedThread {
    listed_turns: Vec<CodexListedTurn>,
    newest_turn_id: Option<String>,
    was_held: bool,
    status: Option<CodexThreadStatus>,
    declared_output_speed: Option<ProviderOutputSpeedState>,
    reasoning_effort: Option<String>,
}

// `thread/resume` of `thread_id` with `params`, and the reply. Fails as the request does, and
// when the reply names another conversation: Codex started a replacement.
async fn request_thread_resume(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    params: &ThreadResumeParams,
) -> Result<Box<RawValue>, CodexError> {
    let reply = connection.request(THREAD_RESUME_METHOD, params).await?;
    let thread = read_thread(&reply, THREAD_RESUME_METHOD)?;
    if thread.id != thread_id {
        return Err(CodexError::Transport {
            detail: format!(
                "Resume handle {thread_id} was answered by thread {}; the provider started a \
                 replacement conversation rather than resuming.",
                thread.id
            ),
            cause: None,
        });
    }
    Ok(reply)
}

// What the resume `reply` of the record's conversation reads back, its turns read page by page
// on `connection`, with the reply's newest turn, the live one where a turn runs, added where the
// pages lack it. Fails as the turns' read does.
async fn read_resumed_thread(
    record: &CodexSessionRecord,
    connection: &CodexAppServerConnection,
    reply: &RawValue,
    was_held: bool,
) -> Result<CodexResumedThread, CodexError> {
    let mut listed_turns = read_codex_turns(connection, &record.thread_id).await?;
    let newest_turn = read_codex_resumed_newest_turn(reply);
    let newest_turn_id = newest_turn.as_ref().map(|newest| newest.id.clone());
    if let Some(newest) = newest_turn
        && !listed_turns.iter().any(|listed| listed.id == newest.id)
    {
        listed_turns.push(newest);
    }
    Ok(CodexResumedThread {
        listed_turns,
        newest_turn_id,
        was_held,
        status: read_thread(reply, THREAD_RESUME_METHOD)?.status,
        declared_output_speed: read_codex_declared_tier(record.session_id, reply),
        reasoning_effort: read_thread_reasoning_effort(reply),
    })
}

// The steps of an adoption that can fail, run before the record changes: the binding's version
// read, and the session's mode sent on `service`'s connection with the resumed effort. Answers
// the result under `binding_id`, with `runs`, what Codex holds of each run's turns.
async fn prepare_adoption(
    record: &CodexSessionRecord,
    service: &CodexService,
    resumed: &CodexResumedThread,
    binding_id: &RuntimeBindingId,
    runs: Vec<ResumedRunAnswer>,
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
        session_position: SafeInt::from_usize(resumed.listed_turns.len()),
        resume_handle: NonEmptyText::new(record.thread_id.clone())
            .expect("a resumed conversation's id is never empty"),
        spawned_version: to_binding_version_carriers(&version),
        runs,
    })
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
    let offered = read_codex_larger_window(&dump, model)
        .map_err(|unreadable| CodexError::Driver(DriverError::from(unreadable)))?;
    if offered == Some(larger_window) {
        return Ok(());
    }
    Err(CodexError::LargerWindowUnavailable {
        model: model.to_owned(),
        requested: larger_window,
        offered,
    })
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

#[cfg(test)]
mod tests;
