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
use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ObservedProviderOptions, ProviderRow, ProviderSessionOption,
};
use sidekicks_contracts::provider::driver::capabilities::{ProviderMode, ProviderModel};
use sidekicks_contracts::provider::driver::commands::ProviderCommandBindingGroup;
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_platforms::{
    LinuxSystemFolder, MacosSystemFolder, PerSystem, SystemFolder, SystemFolders,
    WindowsSystemFolder,
};
#[cfg(any(test, feature = "test-support"))]
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::permission_level::list_codex_modes;
#[cfg(any(test, feature = "test-support"))]
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::contract::ProviderDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{
    ApplyRowValueParams, CompactContextParams, GetCapabilitiesResult, ListModelsParams,
    ListProviderCommandsParams, ProviderCommandsSubscription, RespondToRequestParams,
    SessionProcessState, StartRunParams,
};
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::driver::idle_sleep::{IdleSleepHolds, SessionSleepState};
use crate::driver::message_handing::{HandMoment, MessageHanding};
use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ApplyInterventionParams,
    ApplyInterventionResponse, FasterModelRetryOutcome, FasterModelRetryParams,
    FindTakenMessagesParams, HelperTokenLimitParams, InterruptRunRequest, OverrideDenialParams,
    PauseRunParams, PickedSkill, ResumeRunParams, TakenMessages, WithdrawQueuedMessageParams,
    WithdrawQueuedMessageResult,
};
use crate::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, ClearSessionGoalParams, CloseSessionParams,
    CreateSessionParams, DriverAuthProbeResult, DriverGoalResult, DriverResumeResult,
    MoveSessionToForkParams, MoveSessionToForkResult, NameSessionParams, ProviderBuildChange,
    ProviderCommandsListener, ProviderSessionHandle, PurgeSessionParams, ResumeSessionParams,
    RevokeRuleParams, SessionCommandAnswer, SetSessionGoalParams, StartingLevel,
    StartingLevelParams, SubscribeProviderCommandsParams, UpdatePermissionLevelParams,
    UpdateSessionModeParams,
};
use crate::driver::task_list::{TaskListChange, ToolCallRecord};
use crate::driver::{
    CommandSandboxNeeds, DriverServices, InstallFolder, InstallFolderBase, ProviderCommand,
    ProviderCommandLookup, ProviderDescriptor, ProviderMemoryEstimates,
};
use crate::port::running_command_publisher::{
    RunningCommandParams, WriteCommandInputParams, command_act_unsupported,
};
use crate::port::session_inbox_address::SessionInboxAddresser;

mod account_home_logs;
mod app_server_protocol;
mod attachments;
mod auth_status;
pub(super) mod calibration;
mod capabilities;
mod capability_probe;
mod commands;
mod compaction;
mod delivery;
mod event_normalizer;
mod exec_relay;
mod goals;
mod hooks;
mod input_limit;
mod intervention;
mod lifecycle;
mod model_windows;
mod native_program;
mod notification_routing;
mod output_speed;
mod permission_level;
mod rate_limits;
mod release_notes;
mod rules;
mod run;
mod server_requests;
mod service;
mod session;
mod thread;
mod token_usage;
mod tools;
mod transport;
mod turn_evidence;
mod usage_limit_signal;
#[cfg(test)]
mod vendored_schema;
mod version;

#[cfg(any(test, feature = "test-support"))]
pub use service::supervisor::test_service::{ScriptedCodexService, start_scripted_codex_service};

/// Codex's fixed facts.
pub(super) const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "codex",
    name: "Codex",
    release_notes_address: release_notes::release_notes_address,
    plan_words: &[
        ("free", "Free"),
        ("go", "Go"),
        ("plus", "Plus"),
        ("prolite", "Pro"),
        ("pro", "Pro (More)"),
        ("promax", "Pro (Max)"),
        ("team", "Business"),
        ("self_serve_business_usage_based", "Business"),
        ("self_serve_business_prolite", "Business Premium"),
        ("business", "Enterprise"),
        ("ent26", "Enterprise"),
        ("enterprise_cbp_usage_based", "Enterprise"),
        ("enterprise", "Enterprise"),
        ("enterprise_cbp_automation", "Enterprise (Automation)"),
        ("edu", "Edu"),
        ("edu_plus", "Edu Plus"),
        ("edu_pro", "Edu Pro"),
    ],
    built_in_tools: &tools::CODEX_BUILT_IN_TOOLS,
    command: ProviderCommand {
        windows: Some(ProviderCommandLookup {
            names: &["codex"],
            install_folders: &[InstallFolder {
                base: InstallFolderBase::UserPrograms,
                components: &["OpenAI", "Codex", "bin"],
            }],
        }),
        unix: Some(ProviderCommandLookup {
            names: &["codex"],
            install_folders: &[InstallFolder {
                base: InstallFolderBase::Home,
                components: &[".local", "bin"],
            }],
        }),
    },
    // Where its system `config.toml` and `requirements.toml` sit; macOS reads the Unix folder.
    managed_settings_folders: SystemFolders {
        macos: Some(SystemFolder {
            base: MacosSystemFolder::Etc,
            components: &["codex"],
        }),
        linux: Some(SystemFolder {
            base: LinuxSystemFolder::Etc,
            components: &["codex"],
        }),
        windows: Some(SystemFolder {
            base: WindowsSystemFolder::ProgramData,
            components: &["OpenAI", "Codex"],
        }),
    },
    // It sandboxes its commands on every system with helpers of its own, its own bubblewrap among
    // them, which on Linux makes a user namespace.
    command_sandbox: PerSystem {
        macos: true,
        linux: true,
        windows: true,
    },
    command_sandbox_needs: PerSystem {
        macos: CommandSandboxNeeds::NOTHING,
        linux: CommandSandboxNeeds {
            programs: &[],
            user_namespace: true,
            service_readiness: false,
        },
        // On Windows its sandbox needs a setup the service reports: the driver asks the service's
        // `windowsSandbox/readiness` over its connection, and offers the sandbox only on `Ready`,
        // never on `NotConfigured` or `UpdateRequired`.
        windows: CommandSandboxNeeds {
            programs: &[],
            user_namespace: false,
            service_readiness: true,
        },
    },
    // The whole service measured at 53 to 61 MB, and each conversation on a running service at
    // 1.8 to 3.0 MB more.
    memory: ProviderMemoryEstimates {
        process_bytes: 61_000_000,
        conversation_bytes: Some(3_000_000),
    },
    // Listed first on every model that publishes a tier, and requested by clearing the thread's.
    standard_output_speed: "default",
    // It lists its service tiers on each model of its catalog.
    output_speed_levels: None,
    // It documents no update switch; the driver runs one exact build path instead.
    process_environment: &[],
    // Carries the app-server binary's path into the launch prelude, which never interpolates it;
    // and opens the shutdown request on the lasting service's control socket, which Codex reads on
    // Windows alone.
    launch_environment_names: &["CODEX_APP_SERVER_BIN", "CODEX_DAEMON_SHUTDOWN_SOCKET"],
    // The account's own `CODEX_HOME`.
    credential_home_environment_names: &["CODEX_HOME"],
    withheld_environment_names: &[],
    screen_reader_environment_names: &[],
    voice_kinds: &[VoiceKind::Call],
    // It reaches no server over server-sent events.
    mcp_transports: &[McpTransport::Stdio, McpTransport::Http],
    mcp_config_members: &[
        McpDeclaredConfigMember::EnvVars,
        McpDeclaredConfigMember::Required,
        McpDeclaredConfigMember::StartupTimeoutSec,
        McpDeclaredConfigMember::ToolTimeoutSec,
        McpDeclaredConfigMember::BearerTokenEnvVar,
        McpDeclaredConfigMember::EnvHttpHeaders,
        McpDeclaredConfigMember::OauthScopes,
        McpDeclaredConfigMember::OauthResource,
    ],
    // Codex's own limit on a skill's name.
    skill_name_max_length: Some(64),
    background_work: None,
    callback_tools_asked: false,
    // Codex's log folder; the rows its service logs into the home's database the driver's own
    // expiry deletes.
    account_home_diagnostic_folders: &[&["log"]],
    // Each thread's rollout, a spawned child thread's under its own id.
    account_home_conversation_folders: &[&["sessions"]],
    shell_prefix_command: None,
};

/// Builds the Codex driver over the shared services; it stores handles and does no I/O.
pub(super) fn build(services: &DriverServices) -> Arc<dyn ProviderDriver> {
    Arc::new(CodexDriver::new(services))
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

    fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.override_denial(params).boxed()
    }

    fn pause_run(&self, params: PauseRunParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.pause_run(params).boxed()
    }

    fn resume_run(&self, params: ResumeRunParams) -> BoxFuture<'_, Result<(), DriverError>> {
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

    fn list_modes(&self) -> BoxFuture<'_, Result<Vec<ProviderMode>, DriverError>> {
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
        params: HelperTokenLimitParams,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.stop_helper_at_token_limit(params).boxed()
    }

    fn observed_output_speed_for(
        &self,
        session_id: &SessionId,
    ) -> Option<ProviderOutputSpeedState> {
        self.observed_output_speed_for(*session_id)
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

    // Codex declares no session option.
    fn session_options(&self) -> BoxFuture<'_, Result<Vec<ProviderSessionOption>, DriverError>> {
        ready(Ok(Vec::new())).boxed()
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

    fn subscribe_provider_commands(
        &self,
        params: SubscribeProviderCommandsParams,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        self.subscribe_provider_commands(&params, listener)
    }

    fn shutdown(&self, intent: DaemonStopIntent) -> BoxFuture<'_, Result<(), DriverError>> {
        self.shutdown(intent).map(Ok).boxed()
    }

    // A Codex session takes a message through the daemon's own steer and turn start, never
    // through an inbox of its own.
    fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>> {
        None
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
}
