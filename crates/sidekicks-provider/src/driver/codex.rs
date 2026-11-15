//! The Codex driver, over the one shared Codex app-server every session reaches by its socket.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(any(test, feature = "test-support"))]
use std::sync::Mutex;
use std::time::SystemTime;

use futures::FutureExt;
use futures::future::{BoxFuture, ready};
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::mcp::server::config::McpServerConfigInput;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpWritableBindingRef};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ObservedProviderOptions, ProviderRow, ProviderSessionOption,
};
use sidekicks_contracts::provider::driver::capabilities::{ProviderMode, ProviderModel};
use sidekicks_contracts::provider::driver::commands::ProviderCommandBindingGroup;
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::session::controls::methods::TerminalProviderSession;
use sidekicks_contracts::session::id::SessionId;
#[cfg(any(test, feature = "test-support"))]
use sidekicks_std::mutex_lock::lock;

use crate::command::channel::stop::StoppedCommandParties;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::mcp::compose_codex_mcp_entry;
use crate::driver::codex::mcp::sign_in::read_codex_server_addresses;
use crate::driver::codex::permission_level::list_codex_modes;
#[cfg(any(test, feature = "test-support"))]
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::start::kept_records::{
    KeptServicesStop, stop_kept_services,
};
use crate::driver::contract::ProviderDriver;
use crate::driver::contract::account::{HelperModeAccountLegs, ProviderAccountLegs};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::known_names::{KnownNamesParams, ProviderKnownNames};
use crate::driver::contract::params_and_results::{
    ApplyRowValueParams, CompactContextParams, GetCapabilitiesResult, LeadBindingCheckParams,
    ListModelsParams, ListModesParams, ListProviderCommandsParams, ProviderCommandsSubscription,
    ProviderReportedLevel, RespondToRequestParams, SessionProcessState, StartRunParams,
};
use crate::driver::contract::plan_verdict::{
    AnswerPlanParams, PlanVerdictAnswer, answer_plan_holding_no_request,
};
use crate::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};
use crate::driver::daemon_stop::{DaemonStopIntent, RecordedServicesStopError};
use crate::driver::error_causes::ProviderAxisInvalid;
use crate::driver::idle_sleep::{IdleSleepHolds, SessionSleepState};
use crate::driver::mcp_server::read::{McpServersReadRequest, ProviderMcpServersReading};
use crate::driver::mcp_server::resources::McpResourceSource;
use crate::driver::mcp_server::session_switch::McpSessionSwitch;
use crate::driver::mcp_server::write::{
    McpServerEntry, McpServerObserved, McpServerWrite, McpServerWriteOutcome, McpServerWriteRefusal,
};
use crate::driver::message_handing::{HandMoment, MessageHanding};
use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ApplyInterventionParams,
    ApplyInterventionResponse, FasterModelRetryOutcome, FasterModelRetryParams,
    FindTakenMessagesParams, HelperStopOutcome, HelperStopParams, InterruptRunRequest,
    OverrideDenialParams, PauseRunParams, PickedSkill, ReattachHelpersParams, ResumeRunOutcome,
    ResumeRunParams, TakenMessages, WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, ClearSessionGoalParams, CloseSessionParams,
    CreateSessionParams, DriverAuthProbeResult, DriverGoalResult, DriverHandoverBriefResult,
    DriverResumeResult, EndKeptTurnsParams, ExportHandoverBriefParams, MoveSessionToForkParams,
    MoveSessionToForkResult, NameSessionParams, ProviderBuildChange, ProviderCommandsListener,
    ProviderSessionHandle, PurgeSessionParams, ResumeSessionParams, RevokeRuleParams,
    SessionCommandAnswer, SessionToolServer, SetSessionGoalParams, SettleHeldToolCallsParams,
    StartingLevel, StartingLevelParams, SubscribeProviderCommandsParams,
    UpdatePermissionLevelParams, UpdateSessionModeParams,
};
use crate::driver::task_list::{TaskListChange, ToolCallRecord};
use crate::driver::{DriverServices, HelperModeServices};
use crate::port::running_command_publisher::{
    RunningCommandParams, StopCommandParams, WriteCommandInputParams, command_act_unsupported,
};
use crate::port::session_inbox_address::SessionInboxAddresser;
use crate::pricing::receiver::TelemetryExportReader;
use crate::pricing::rule::RequestPricer;

mod account;
mod account_home_logs;
mod app_server_protocol;
mod attachments;
mod auth_status;
pub(super) mod calibration;
mod capabilities;
mod capability_probe;
mod commands;
mod compaction;
mod config_read;
mod delivery;
mod descriptor;
mod event_normalizer;
mod exec_relay;
mod exec_turn;
mod goals;
mod hand_over;
mod hooks;
mod input_limit;
mod intervention;
mod lifecycle;
mod mcp;
mod messages;
mod model_windows;
mod native_program;
mod notification_routing;
mod output_speed;
mod permission_level;
mod pricing;
mod privacy;
mod rate_limits;
mod release_notes;
mod rules;
mod run;
mod self_update;
mod server_requests;
mod service;
mod session;
mod shells;
mod telemetry;
mod thread;
mod token_usage;
mod tools;
mod transport;
mod turn_evidence;
mod usage_limit_signal;
#[cfg(test)]
mod vendored_schema;
mod version;
mod web_search;
mod written_names;

pub(super) use self::descriptor::DESCRIPTOR;

#[cfg(any(test, feature = "test-support"))]
pub use service::supervisor::test_service::{
    CodexServiceScript, CodexServiceStandIn, CodexServicesBeside, RESUMED_TURN_NAME,
    ScriptedCodexService, serve_as_codex_service_stand_in, stand_in_codex_service,
    start_scripted_codex_service, write_codex_service_script,
};

/// Builds the Codex driver over the shared services; it stores handles and does no I/O.
pub(super) fn build(services: &DriverServices) -> Arc<dyn ProviderDriver> {
    Arc::new(CodexDriver::new(services))
}

/// Ends, with no daemon running, every lasting Codex service a record under `data_folder` still
/// names, the terminal service's, each account home's and the switching home's, a draining one
/// too, and removes each record. Fails with every failure met, every other record still settled.
pub(super) fn stop_recorded_services(
    data_folder: &Path,
) -> BoxFuture<'static, Result<(), RecordedServicesStopError>> {
    let data_folder = data_folder.to_owned();
    async move {
        // No daemon runs, so no live service holds a record.
        let failures = stop_kept_services(data_folder, KeptServicesStop::Erase, &[]).await;
        if failures.is_empty() {
            return Ok(());
        }
        Err(RecordedServicesStopError {
            failures: failures.into_iter().map(DriverError::from).collect(),
        })
    }
    .boxed()
}

/// Builds Codex's helper-mode account legs over `services`; they hold handles and do no I/O.
pub(super) fn helper_mode_account_legs(
    services: &HelperModeServices,
) -> Arc<dyn HelperModeAccountLegs> {
    Arc::new(account::helper_mode::CodexHelperModeLegs::new(services))
}

/// The service registry the next driver [`build_over_scripted_service`] builds holds.
#[cfg(any(test, feature = "test-support"))]
static NEXT_SCRIPTED_REGISTRY: Mutex<Option<Arc<CodexServiceRegistry>>> = Mutex::new(None);

/// Holds `scripted`'s service for the next driver [`build_over_scripted_service`] builds, every
/// account resolving to its home.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn hold_scripted_service(scripted: &ScriptedCodexService) {
    *lock(&NEXT_SCRIPTED_REGISTRY) = Some(CodexServiceRegistry::holding(scripted));
}

/// Builds the Codex driver as [`build`] does, its registry holding the service
/// [`hold_scripted_service`] last held, which it takes. Panics when no service is held.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn build_over_scripted_service(services: &DriverServices) -> Arc<dyn ProviderDriver> {
    let mut driver = CodexDriver::new(services);
    driver.registry = lock(&NEXT_SCRIPTED_REGISTRY)
        .take()
        .expect("a scripted service is held before its driver is built");
    Arc::new(driver)
}

/// Codex takes a message the run queue hands a running turn as a steer between its steps, has no
/// verb that takes one back, keeps nothing past its run, and marks no message as priority.
const CODEX_MESSAGE_HANDING: MessageHanding = MessageHanding {
    hands_at: HandMoment::AtToolBoundary,
    can_withdraw: false,
    kept_by_process: false,
    reads_priority_message: false,
};

/// The session options the Codex driver declares: none.
const CODEX_SESSION_OPTIONS: &[ProviderSessionOption] = &[];

impl ProviderDriver for CodexDriver {
    fn create_session(
        &self,
        params: CreateSessionParams,
    ) -> BoxFuture<'_, Result<ProviderSessionHandle, DriverError>> {
        self.create_session(params).boxed()
    }

    fn resume_session(
        &self,
        params: ResumeSessionParams,
    ) -> BoxFuture<'_, Result<DriverResumeResult, DriverError>> {
        self.resume_session(params).boxed()
    }

    fn end_kept_turns(
        &self,
        params: EndKeptTurnsParams,
    ) -> BoxFuture<'_, Result<crate::driver::session_control::KeptTurnsEnding, DriverError>> {
        self.end_kept_turns(params).map(Ok).boxed()
    }

    fn settle_session(&self, session_id: SessionId) -> BoxFuture<'_, Result<(), DriverError>> {
        self.settle_session(session_id).boxed()
    }

    fn start_run(&self, params: StartRunParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.start_run(params).boxed()
    }

    fn interrupt_run(&self, params: InterruptRunRequest) -> BoxFuture<'_, Result<(), DriverError>> {
        self.interrupt_run(params).boxed()
    }

    fn apply_intervention(
        &self,
        params: ApplyInterventionParams,
    ) -> BoxFuture<'_, Result<ApplyInterventionResponse, DriverError>> {
        self.apply_intervention(params).boxed()
    }

    fn move_session_to_fork(
        &self,
        params: MoveSessionToForkParams,
    ) -> BoxFuture<'_, Result<MoveSessionToForkResult, DriverError>> {
        self.move_session_to_fork(params).boxed()
    }

    fn rewind_conversation(
        &self,
        params: RewindConversationParams,
    ) -> BoxFuture<'_, Result<RewindConversationResult, DriverError>> {
        self.rewind_conversation(params).boxed()
    }

    // Codex's `thread/revert` cuts before a whole turn and has no verb that cuts inside one.
    fn can_cut_inside_turn(&self) -> bool {
        false
    }

    fn respond_to_request(
        &self,
        params: RespondToRequestParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.respond_to_request(params).boxed()
    }

    fn answer_plan(
        &self,
        params: AnswerPlanParams,
    ) -> BoxFuture<'_, Result<PlanVerdictAnswer, DriverError>> {
        // Codex holds no request for a plan.
        answer_plan_holding_no_request(self, params).boxed()
    }

    fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.override_denial(params).boxed()
    }

    fn pause_run(&self, params: PauseRunParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.pause_run(params).boxed()
    }

    fn resume_run(
        &self,
        params: ResumeRunParams,
    ) -> BoxFuture<'_, Result<ResumeRunOutcome, DriverError>> {
        self.resume_run(params).boxed()
    }

    fn find_taken_messages(
        &self,
        params: FindTakenMessagesParams,
    ) -> BoxFuture<'_, Result<TakenMessages, DriverError>> {
        self.find_taken_messages(params).boxed()
    }

    // Codex has no verb that takes a steer back once it is sent.
    fn withdraw_queued_message(
        &self,
        _params: WithdrawQueuedMessageParams,
    ) -> BoxFuture<'_, Result<WithdrawQueuedMessageResult, DriverError>> {
        ready(Ok(WithdrawQueuedMessageResult::AlreadyDelivered {})).boxed()
    }

    fn message_handing(&self) -> MessageHanding {
        CODEX_MESSAGE_HANDING
    }

    fn starts_process(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, bool> {
        self.starts_process(session_id, provider_account_id).boxed()
    }

    fn resolve_skill_picks(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
        picks: Vec<QueuedSkillPick>,
    ) -> BoxFuture<'_, Result<Vec<PickedSkill>, DriverError>> {
        self.resolve_skill_picks(session_id, provider_account_id, picks)
            .boxed()
    }

    // Codex holds no run on a refusal or a usage-credits choice.
    fn answer_provider_choice(
        &self,
        _params: AnswerProviderChoiceParams,
    ) -> BoxFuture<'_, Result<AnswerProviderChoiceResult, DriverError>> {
        ready(Ok(AnswerProviderChoiceResult::NotPending {})).boxed()
    }

    fn retry_turn_on_faster_model(
        &self,
        params: FasterModelRetryParams,
    ) -> BoxFuture<'_, Result<FasterModelRetryOutcome, DriverError>> {
        self.retry_turn_on_faster_model(params).boxed()
    }

    fn read_starting_level(
        &self,
        params: StartingLevelParams,
    ) -> BoxFuture<'_, Result<StartingLevel, DriverError>> {
        self.read_starting_level(params).boxed()
    }

    fn update_permission_level(
        &self,
        params: UpdatePermissionLevelParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.update_permission_level(params).boxed()
    }

    fn revoke_rule(&self, params: RevokeRuleParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.revoke_rule(params).boxed()
    }

    fn restart_session(
        &self,
        params: ResumeSessionParams,
    ) -> BoxFuture<'_, Result<DriverResumeResult, DriverError>> {
        self.restart_session(params).boxed()
    }

    fn move_to_provider_build(
        &self,
        change: ProviderBuildChange,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.move_to_provider_build(&change);
        ready(Ok(())).boxed()
    }

    fn purge_session(&self, params: PurgeSessionParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.purge_session(params).boxed()
    }

    fn set_session_goal(
        &self,
        params: SetSessionGoalParams,
    ) -> BoxFuture<'_, Result<DriverGoalResult, DriverError>> {
        self.set_session_goal(params).boxed()
    }

    fn clear_session_goal(
        &self,
        params: ClearSessionGoalParams,
    ) -> BoxFuture<'_, Result<DriverGoalResult, DriverError>> {
        self.clear_session_goal(params).boxed()
    }

    fn close_session(&self, params: CloseSessionParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.close_session(params).boxed()
    }

    fn settle_held_tool_calls(
        &self,
        _params: SettleHeldToolCallsParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        // Codex holds no call in the background; its long calls ride the daemon's route.
        async { Ok(()) }.boxed()
    }

    fn name_session(
        &self,
        params: NameSessionParams,
    ) -> BoxFuture<'_, Result<Option<String>, DriverError>> {
        self.name_session(params).boxed()
    }

    fn tell_session_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.tell_session_name(session_id, name).boxed()
    }

    fn list_models(
        &self,
        params: ListModelsParams,
    ) -> BoxFuture<'_, Result<Vec<ProviderModel>, DriverError>> {
        self.list_models(params).boxed()
    }

    // Codex takes any model id, and the effort levels sit in the catalog its service lists, so the
    // start checks the effort; Codex declares no session option, so any option is refused.
    fn check_lead_binding(&self, params: LeadBindingCheckParams) -> Result<(), DriverError> {
        ProviderAxisInvalid::check_options(
            params.agent_id,
            params.options.as_ref(),
            CODEX_SESSION_OPTIONS,
        )
        .map_err(DriverError::from)
    }

    fn list_modes(
        &self,
        _params: ListModesParams,
    ) -> BoxFuture<'_, Result<Vec<ProviderMode>, DriverError>> {
        ready(Ok(list_codex_modes())).boxed()
    }

    fn get_capabilities(&self) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>> {
        self.get_capabilities().boxed()
    }

    fn probe_auth(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<DriverAuthProbeResult, DriverError>> {
        self.probe_auth(provider_account_id).boxed()
    }

    fn read_mcp_servers(
        &self,
        request: McpServersReadRequest,
    ) -> BoxFuture<'_, Result<ProviderMcpServersReading, DriverError>> {
        self.read_mcp_servers(request).boxed()
    }

    fn observe_mcp_server(
        &self,
        binding: McpServerBindingRef,
    ) -> BoxFuture<'_, Result<McpServerObserved, DriverError>> {
        async move {
            self.observe_mcp_server(&binding)
                .await
                .map_err(DriverError::from)
        }
        .boxed()
    }

    fn compose_mcp_server(
        &self,
        binding: &McpWritableBindingRef,
        config: &McpServerConfigInput,
        before: &McpServerObserved,
    ) -> Result<McpServerEntry, McpServerWriteRefusal> {
        compose_codex_mcp_entry(binding, config, &before.entry)
    }

    fn write_mcp_server(
        &self,
        write: McpServerWrite,
        before: McpServerObserved,
    ) -> BoxFuture<'_, McpServerWriteOutcome> {
        async move { self.write_mcp_server(&write, &before).await }.boxed()
    }

    fn list_mcp_resources(
        &self,
        session_id: SessionId,
        server_name: McpServerName,
    ) -> BoxFuture<'_, Result<McpResourceSource, DriverError>> {
        self.list_mcp_resources(session_id, server_name).boxed()
    }

    fn switch_session_mcp_servers(
        &self,
        session_id: SessionId,
        run_id: RunId,
        tool_servers: Vec<SessionToolServer>,
    ) -> BoxFuture<'_, Result<McpSessionSwitch, DriverError>> {
        self.switch_session_mcp_servers(session_id, run_id, tool_servers)
            .boxed()
    }

    fn compact_context(
        &self,
        params: CompactContextParams,
    ) -> BoxFuture<'_, Result<AgentRunContextCompactResponse, DriverError>> {
        self.compact_context(params).boxed()
    }

    fn list_provider_commands(
        &self,
        params: ListProviderCommandsParams,
    ) -> BoxFuture<'_, Result<ProviderCommandBindingGroup, DriverError>> {
        self.list_provider_commands(params).boxed()
    }

    fn list_known_names(
        &self,
        params: KnownNamesParams,
    ) -> BoxFuture<'_, Result<ProviderKnownNames, DriverError>> {
        self.list_known_names(params).boxed()
    }

    fn stop_command(
        &self,
        params: StopCommandParams,
    ) -> BoxFuture<'_, Result<StoppedCommandParties, DriverError>> {
        self.stop_command(params).boxed()
    }

    fn move_command_to_background(
        &self,
        params: RunningCommandParams,
    ) -> BoxFuture<'_, Result<bool, DriverError>> {
        std::future::ready(Err(command_act_unsupported(&params.command_id).into())).boxed()
    }

    fn write_command_input(
        &self,
        params: WriteCommandInputParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.write_command_input(params).boxed()
    }

    // A Codex session is never slept: its service is shared by every session on the account and
    // holds no process of the session's own, so a sleep would free nothing. It reports no hold and
    // answers every sleep and wake as awake.
    fn idle_sleep_holds(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<IdleSleepHolds, DriverError>> {
        ready(Ok(IdleSleepHolds::default())).boxed()
    }

    fn sleep_session(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, DriverError>> {
        ready(Ok(SessionSleepState::Awake)).boxed()
    }

    fn wake_session(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, DriverError>> {
        ready(Ok(SessionSleepState::Awake)).boxed()
    }

    fn task_list_change(&self, call: &ToolCallRecord<'_>) -> Option<TaskListChange> {
        self.task_list_change(call)
    }

    fn stop_helper_at_token_limit(
        &self,
        params: HelperStopParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.stop_helper_at_token_limit(params).boxed()
    }

    fn stop_child_run(
        &self,
        params: HelperStopParams,
    ) -> BoxFuture<'_, Result<HelperStopOutcome, DriverError>> {
        self.stop_child_run(params).boxed()
    }

    fn reattach_helpers(
        &self,
        params: ReattachHelpersParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.reattach_helpers(params).boxed()
    }

    fn observed_output_speed_for(
        &self,
        session_id: &SessionId,
    ) -> Option<ProviderOutputSpeedState> {
        self.observed_output_speed_for(*session_id)
    }

    // Codex reports no permission mode of its own.
    fn reported_level(&self, _session_id: &SessionId) -> Option<ProviderReportedLevel> {
        None
    }

    fn read_rows(
        &self,
        app_values: ProviderRowValues,
    ) -> BoxFuture<'_, Result<Vec<ProviderRow>, DriverError>> {
        ready(Ok(self.read_rows(&app_values))).boxed()
    }

    fn row_defaults(&self) -> ProviderRowValues {
        CodexDriver::row_defaults()
    }

    fn apply_row_value(
        &self,
        params: ApplyRowValueParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.apply_row_value(params).boxed()
    }

    fn session_options(&self) -> BoxFuture<'_, Result<Vec<ProviderSessionOption>, DriverError>> {
        ready(Ok(CODEX_SESSION_OPTIONS.to_vec())).boxed()
    }

    // With no option declared, there is none to observe.
    fn observed_options_for(&self, _session_id: &SessionId) -> Option<ObservedProviderOptions> {
        None
    }

    fn session_process_state(&self, session_id: &SessionId) -> SessionProcessState {
        self.session_process_state(*session_id)
    }

    fn update_session_mode(
        &self,
        params: UpdateSessionModeParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.update_session_mode(params).boxed()
    }

    // No Codex command changes more than the session it is typed in.
    fn answer_session_command(
        &self,
        _params: AnswerSessionCommandParams,
    ) -> BoxFuture<'_, Result<SessionCommandAnswer, DriverError>> {
        ready(Ok(SessionCommandAnswer::NotAnswered {})).boxed()
    }

    fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.ask_side_question(params).boxed()
    }

    fn export_handover_brief(
        &self,
        params: ExportHandoverBriefParams,
    ) -> BoxFuture<'_, Result<DriverHandoverBriefResult, DriverError>> {
        self.export_handover_brief(params).boxed()
    }

    fn subscribe_provider_commands(
        &self,
        params: SubscribeProviderCommandsParams,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        self.subscribe_provider_commands(&params, listener)
    }

    fn shutdown(
        &self,
        intent: DaemonStopIntent,
        deadline: tokio::time::Instant,
    ) -> BoxFuture<'_, ()> {
        self.shutdown(intent, deadline).boxed()
    }

    // A Codex session takes a message through the daemon's own steer and turn start, never
    // through an inbox of its own.
    fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>> {
        None
    }

    fn account_legs(&self) -> Arc<dyn ProviderAccountLegs> {
        Arc::clone(&self.account_legs) as _
    }

    // The account legs' count of dead renewals and the service on the account's home are all the
    // driver keeps by account; the service stops on the driver's tracked tasks.
    fn forget_account(&self, provider_account_id: &ProviderAccountId) {
        let _stopping = self.account_legs.forget_account(provider_account_id);
    }

    fn expire_account_home_diagnostics(
        &self,
        home: &Path,
        cutoff: SystemTime,
    ) -> Result<u64, Box<dyn Error + Send + Sync>> {
        self.expire_account_home_diagnostics(home, cutoff)
    }

    fn running_service_log_files(&self) -> io::Result<Vec<PathBuf>> {
        self.registry.running_service_log_files()
    }

    fn list_terminal_sessions(
        &self,
    ) -> BoxFuture<'_, Result<Vec<TerminalProviderSession>, DriverError>> {
        async move { Ok(self.registry.list_terminal_sessions().await?) }.boxed()
    }

    fn sign_in_with_own_client(
        &self,
        request: ProviderSignInTakeoverRequest,
    ) -> BoxFuture<'_, Result<ProviderSignInTakeover, DriverError>> {
        self.sign_in_with_own_client(request).boxed()
    }

    fn remove_left_sign_in_folders(&self) -> BoxFuture<'_, Result<(), DriverError>> {
        self.remove_left_sign_in_folders().boxed()
    }

    fn private_file_folders(&self) -> Vec<PathBuf> {
        vec![self.registry.service_record_folder()]
    }

    fn request_pricer(&self) -> Option<Arc<dyn RequestPricer>> {
        Some(Arc::new(pricing::CodexRequestPricer))
    }

    fn telemetry_export_reader(&self) -> Option<Arc<dyn TelemetryExportReader>> {
        Some(Arc::clone(&self.exports) as _)
    }

    fn read_mcp_server_addresses(
        &self,
        requests: Vec<McpServerAddressRead>,
    ) -> BoxFuture<'_, Vec<Result<McpServerAddressReading, DriverError>>> {
        read_codex_server_addresses(&self.registry, &self.project_rules.home_folder, requests)
            .boxed()
    }
}
