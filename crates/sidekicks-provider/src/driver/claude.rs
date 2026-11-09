//! The Claude Code driver.

use std::path::PathBuf;
use std::sync::Arc;

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
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::command::running_set::takes_no_input;
use crate::driver::claude::attachments::CLAUDE_PICTURE_BASE64_LIMIT;
use crate::driver::claude::delivery::turn_readings::read_claude_task_list_change;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::config::compose_claude_mcp_entry;
use crate::driver::claude::mcp::{read_claude_mcp_servers, reread_claude_live_mcp_statuses};
use crate::driver::claude::session::establishment::context::{
    CLAUDE_ADVISOR_ROW_ID, read_claude_row_choice,
};
use crate::driver::claude::spawn::settings::private_file::{
    compose_claude_settings_folder, remove_left_claude_settings_files,
};
use crate::driver::contract::ProviderDriver;
use crate::driver::contract::account::{HelperModeAccountLegs, ProviderAccountLegs};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{
    ApplyRowValueParams, CompactContextParams, GetCapabilitiesResult, LeadBindingCheckParams,
    ListModelsParams, ListModesParams, ListProviderCommandsParams, ProviderCommandsSubscription,
    ProviderReportedLevel, RespondToRequestParams, SessionProcessState, StartRunParams,
};
use crate::driver::contract::plan_verdict::{AnswerPlanParams, PlanVerdictAnswer};
use crate::driver::contract::sign_in::{ProviderSignInTakeover, ProviderSignInTakeoverRequest};
use crate::driver::daemon_stop::DaemonStopIntent;
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
    OverrideDenialParams, PauseRunParams, PickedSkill, ResumeRunOutcome, ResumeRunParams,
    TakenMessages, WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, ClearSessionGoalParams, CloseSessionParams,
    CreateSessionParams, DriverAuthProbeResult, DriverGoalResult, DriverHandoverBriefResult,
    DriverResumeResult, EndKeptTurnsParams, ExportHandoverBriefParams, KeptTurnsEnding,
    MoveSessionToForkParams, MoveSessionToForkResult, NameSessionParams, ProviderBuildChange,
    ProviderCommandsListener, ProviderSessionHandle, PurgeSessionParams, ResumeSessionParams,
    RevokeRuleParams, SessionCommandAnswer, SessionToolServer, SetSessionGoalParams,
    SettleHeldToolCallsParams, StartingLevel, StartingLevelParams, SubscribeProviderCommandsParams,
    UpdatePermissionLevelParams, UpdateSessionModeParams,
};
use crate::driver::task_list::{TaskListChange, ToolCallRecord};
use crate::driver::{DriverServices, HelperModeServices};
use crate::port::running_command_publisher::{RunningCommandParams, WriteCommandInputParams};
use crate::port::session_inbox_address::SessionInboxAddresser;
use crate::pricing::rule::RequestPricer;

mod account;
mod attachments;
mod capabilities;
mod capability_probe;
mod command_shape;
mod compaction;
mod delivery;
mod descriptor;
mod event_normalizer;
mod frame_routing;
mod goals;
mod hand_over;
mod handshake_register;
mod hooks;
pub(crate) mod inbox;
mod intervention;
mod lifecycle;
mod live_sessions;
mod mcp;
mod output_speed;
mod pricing;
mod rate_limit_windows;
mod release_notes;
mod run;
mod self_update;
mod session;
mod settings_rows;
mod spawn;
mod spent_retries_signal;
mod switch_variable;
mod tools;
mod turn_evidence;
mod version;
mod written_names;

pub(super) use self::descriptor::DESCRIPTOR;

/// Builds the Claude Code driver over the shared services; it stores handles and does no I/O.
pub(super) fn build(services: &DriverServices) -> Arc<dyn ProviderDriver> {
    Arc::new(ClaudeDriver::new(services))
}

/// Builds Claude Code's helper-mode account legs over `services`; they hold handles and do no I/O.
pub(super) fn helper_mode_account_legs(
    services: &HelperModeServices,
) -> Arc<dyn HelperModeAccountLegs> {
    Arc::new(account::helper_mode::ClaudeHelperModeLegs::new(services))
}

/// Claude Code takes a message at once into its own queue, reads a priority one at its turn's next
/// step, can give back one it has not read, and keeps one past the run for a turn of its own.
const CLAUDE_MESSAGE_HANDING: MessageHanding = MessageHanding {
    hands_at: HandMoment::AtOnce,
    can_withdraw: true,
    kept_by_process: true,
    reads_priority_message: true,
};

/// What a retry on a faster model answers on Claude Code, which holds no turn for a safety check.
const NO_HELD_TURN_REASON: &str = "Claude Code holds no turn for a safety check.";

impl ProviderDriver for ClaudeDriver {
    fn request_pricer(&self) -> Option<Arc<dyn RequestPricer>> {
        Some(Arc::new(pricing::ClaudeRequestPricer))
    }

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

    // Claude Code runs as the daemon's own child, so its turn ended with the daemon that ran it.
    fn end_kept_turns(
        &self,
        _params: EndKeptTurnsParams,
    ) -> BoxFuture<'_, Result<KeptTurnsEnding, DriverError>> {
        ready(Ok(KeptTurnsEnding::ended_now())).boxed()
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
        self.answer_plan(params).boxed()
    }

    fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.override_denial(params).boxed()
    }

    fn pause_run(&self, params: PauseRunParams) -> BoxFuture<'_, Result<(), DriverError>> {
        ready(self.pause_run(&params)).boxed()
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

    fn withdraw_queued_message(
        &self,
        params: WithdrawQueuedMessageParams,
    ) -> BoxFuture<'_, Result<WithdrawQueuedMessageResult, DriverError>> {
        self.withdraw_queued_message(params).boxed()
    }

    fn message_handing(&self) -> MessageHanding {
        CLAUDE_MESSAGE_HANDING
    }

    // Claude Code takes a pick as its text, so a resolve reads nothing from a process.
    fn skill_resolve_starts_process(&self) -> bool {
        false
    }

    fn picture_base64_size_limit(&self) -> Option<u64> {
        Some(CLAUDE_PICTURE_BASE64_LIMIT)
    }

    fn session_advisor_pick(&self, app_values: &ProviderRowValues) -> Option<Option<String>> {
        read_claude_row_choice(app_values, CLAUDE_ADVISOR_ROW_ID)
    }

    // Each Claude Code session runs a process of its own, so the account weighs nothing here.
    fn starts_process(
        &self,
        session_id: SessionId,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, bool> {
        ready(self.starts_process(session_id)).boxed()
    }

    // Claude Code takes a skill pick as the text that opens the turn, so each pick is answered as
    // `skill.list` gave it, by its name and folder, with nothing read.
    fn resolve_skill_picks(
        &self,
        _session_id: SessionId,
        _provider_account_id: ProviderAccountId,
        picks: Vec<QueuedSkillPick>,
    ) -> BoxFuture<'_, Result<Vec<PickedSkill>, DriverError>> {
        ready(Ok(picks.into_iter().map(picked_skill_of).collect())).boxed()
    }

    fn answer_provider_choice(
        &self,
        params: AnswerProviderChoiceParams,
    ) -> BoxFuture<'_, Result<AnswerProviderChoiceResult, DriverError>> {
        self.answer_provider_choice(params).boxed()
    }

    fn retry_turn_on_faster_model(
        &self,
        _params: FasterModelRetryParams,
    ) -> BoxFuture<'_, Result<FasterModelRetryOutcome, DriverError>> {
        ready(Ok(FasterModelRetryOutcome::Rejected {
            rejection_reason: NO_HELD_TURN_REASON.to_owned(),
        }))
        .boxed()
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
        self.move_to_provider_build(change).boxed()
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
        params: SettleHeldToolCallsParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.settle_held_tool_calls(params).boxed()
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

    // Claude Code's start decides a model its catalog does not list, and the effort levels sit in
    // a catalog only a running process reads, so the start checks both; the session options are
    // the driver's own.
    fn check_lead_binding(&self, params: LeadBindingCheckParams) -> Result<(), DriverError> {
        ProviderAxisInvalid::check_options(
            params.agent_id,
            params.options.as_ref(),
            &Self::session_options(),
        )
        .map_err(DriverError::from)
    }

    fn list_modes(
        &self,
        params: ListModesParams,
    ) -> BoxFuture<'_, Result<Vec<ProviderMode>, DriverError>> {
        self.list_modes(params).boxed()
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
        async move {
            let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
            read_claude_mcp_servers(self, managed_settings_folder.as_deref(), request).await
        }
        .boxed()
    }

    fn reread_live_mcp_statuses(&self) -> BoxFuture<'_, ()> {
        reread_claude_live_mcp_statuses(self).boxed()
    }

    fn observe_mcp_server(
        &self,
        binding: McpServerBindingRef,
    ) -> BoxFuture<'_, Result<McpServerObserved, DriverError>> {
        async move { self.observe_mcp_server(&binding).await }.boxed()
    }

    fn compose_mcp_server(
        &self,
        _binding: &McpWritableBindingRef,
        config: &McpServerConfigInput,
        before: &McpServerObserved,
    ) -> Result<McpServerEntry, McpServerWriteRefusal> {
        compose_claude_mcp_entry(config, &before.entry)
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

    fn stop_command(&self, params: RunningCommandParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.stop_command(params).boxed()
    }

    fn move_command_to_background(
        &self,
        params: RunningCommandParams,
    ) -> BoxFuture<'_, Result<bool, DriverError>> {
        self.move_command_to_background(params).boxed()
    }

    fn write_command_input(
        &self,
        params: WriteCommandInputParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        // Claude Code's commands take no input, so the person's input is refused.
        ready(Err(takes_no_input(&params.command.command_id).into())).boxed()
    }

    fn idle_sleep_holds(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<IdleSleepHolds, DriverError>> {
        ready(Ok(self.idle_sleep_holds(session_id))).boxed()
    }

    fn sleep_session(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, DriverError>> {
        self.sleep_session(session_id).boxed()
    }

    fn wake_session(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, DriverError>> {
        self.wake_session(session_id).boxed()
    }

    fn task_list_change(&self, call: &ToolCallRecord<'_>) -> Option<TaskListChange> {
        read_claude_task_list_change(call)
    }

    fn stop_helper_at_token_limit(
        &self,
        params: HelperStopParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        ready(self.stop_helper_at_token_limit(&params)).boxed()
    }

    fn stop_child_run(
        &self,
        params: HelperStopParams,
    ) -> BoxFuture<'_, Result<HelperStopOutcome, DriverError>> {
        async move { self.stop_child_run(&params).await }.boxed()
    }

    fn observed_output_speed_for(
        &self,
        session_id: &SessionId,
    ) -> Option<ProviderOutputSpeedState> {
        self.observed_output_speed_for(*session_id)
    }

    fn reported_level(&self, session_id: &SessionId) -> Option<ProviderReportedLevel> {
        self.reported_level(*session_id)
    }

    fn read_rows(
        &self,
        app_values: ProviderRowValues,
    ) -> BoxFuture<'_, Result<Vec<ProviderRow>, DriverError>> {
        self.read_rows(app_values).boxed()
    }

    // Both rows follow Claude Code's own values until the app stores one.
    fn row_defaults(&self) -> ProviderRowValues {
        ProviderRowValues::default()
    }

    // Both rows reach sessions started later through the values each start is handed.
    fn apply_row_value(
        &self,
        _params: ApplyRowValueParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        ready(Ok(())).boxed()
    }

    fn session_options(&self) -> BoxFuture<'_, Result<Vec<ProviderSessionOption>, DriverError>> {
        ready(Ok(Self::session_options())).boxed()
    }

    fn observed_options_for(&self, session_id: &SessionId) -> Option<ObservedProviderOptions> {
        self.observed_options_for(*session_id)
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

    fn answer_session_command(
        &self,
        params: AnswerSessionCommandParams,
    ) -> BoxFuture<'_, Result<SessionCommandAnswer, DriverError>> {
        self.answer_session_command(params).boxed()
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

    fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>> {
        self.session_inbox_addresser()
    }

    fn account_legs(&self) -> Arc<dyn ProviderAccountLegs> {
        Arc::clone(&self.account_legs) as _
    }

    fn forget_account(&self, provider_account_id: &ProviderAccountId) {
        self.usage_probe_models.forget(provider_account_id);
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
        vec![compose_claude_settings_folder(&self.sources.data_folder)]
    }

    fn remove_left_settings_files(&self) -> BoxFuture<'_, Result<(), DriverError>> {
        async {
            remove_left_claude_settings_files(&self.sources.data_folder)
                .await
                .map_err(|error| DriverError::Internal(Box::new(error)))
        }
        .boxed()
    }
}

/// A pick as Claude Code takes it: the name and folder `skill.list` gave, both checked non-empty.
fn picked_skill_of(pick: QueuedSkillPick) -> PickedSkill {
    let non_empty = |text: String| NonEmptyText::new(text).expect("a checked pick is never empty");
    PickedSkill {
        name: non_empty(pick.name.into_string()),
        path: non_empty(pick.folder_path.as_str().to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::run::queue::QueuedSkillPick;
    use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};

    use crate::driver::claude::lifecycle::ClaudeDriver;
    use crate::driver::contract::ProviderDriver;
    use crate::driver::run_control::PickedSkill;
    use crate::driver::test_registry::{fixed_session_id, test_driver_services};
    use crate::runtime_binding::test_store::test_provider_account_id;

    // Killed by answering no skill, which drops every pick from the stored message.
    #[tokio::test]
    async fn each_skill_pick_is_answered_in_order_by_its_name_and_folder() {
        let driver = ClaudeDriver::new(&test_driver_services());
        let session_id = fixed_session_id();
        let pick = |name: &str, folder: &str| QueuedSkillPick {
            name: FreeFormText::new(name.to_owned()).expect("a valid name"),
            folder_path: FilesystemPath::new(folder.to_owned()).expect("a valid folder"),
        };
        let picked = |name: &str, folder: &str| PickedSkill {
            name: NonEmptyText::new(name.to_owned()).expect("a name"),
            path: NonEmptyText::new(folder.to_owned()).expect("a folder"),
        };

        let skills = driver
            .resolve_skill_picks(
                session_id,
                test_provider_account_id(),
                vec![
                    pick("review", "/skills/review"),
                    pick("deploy", "/skills/deploy"),
                ],
            )
            .await
            .expect("Claude Code resolves every pick");

        assert_eq!(
            skills,
            [
                picked("review", "/skills/review"),
                picked("deploy", "/skills/deploy")
            ]
        );
    }
}
