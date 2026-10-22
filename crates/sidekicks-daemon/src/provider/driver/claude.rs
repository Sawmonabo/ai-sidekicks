//! The Claude Code driver.

use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, ready};
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::mcp::server::config::McpTransport;
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
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::{
    LinuxSystemFolder, MacosSystemFolder, PerSystem, SystemFolder, SystemFolders,
    WindowsSystemFolder,
};

use crate::provider::driver::claude::lifecycle::ClaudeDriver;
use crate::provider::driver::contract::{
    ApplyRowValueParams, CompactContextParams, DriverError, GetCapabilitiesResult,
    ListModelsParams, ListProviderCommandsParams, ProviderCommandsSubscription, ProviderDriver,
    RespondToRequestParams, StartRunParams,
};
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::message_handing::{HandMoment, MessageHanding};
use crate::provider::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::provider::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ApplyInterventionParams,
    ApplyInterventionResponse, FasterModelRetryOutcome, FasterModelRetryParams,
    FindTakenMessagesParams, InterruptRunRequest, OverrideDenialParams, PauseRunParams,
    PickedSkill, ResumeRunParams, TakenMessages, WithdrawQueuedMessageParams,
    WithdrawQueuedMessageResult,
};
use crate::provider::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, ClearSessionGoalParams, CloseSessionParams,
    CreateSessionParams, DriverAuthProbeResult, DriverGoalResult, DriverResumeResult,
    MoveSessionToForkParams, MoveSessionToForkResult, NameSessionParams, ProviderBuildChange,
    ProviderCommandsListener, ProviderSessionHandle, PurgeSessionParams, ResumeSessionParams,
    RevokeRuleParams, SessionCommandAnswer, SetSessionGoalParams, StartReviewParams, StartingLevel,
    StartingLevelParams, SubscribeProviderCommandsParams, UpdatePermissionLevelParams,
    UpdateSessionModeParams,
};
use crate::provider::driver::{
    BackgroundWork, CommandSandboxNeeds, DriverServices, InstallFolder, InstallFolderBase,
    ProviderCommand, ProviderCommandLookup, ProviderDescriptor, ProviderMemoryEstimates,
};
use crate::provider::port::session_inbox_address::SessionInboxAddresser;

mod attachments;
mod capabilities;
mod capability_probe;
mod compaction;
mod delivery;
mod event_normalizer;
mod frame_routing;
mod goals;
mod handshake_register;
mod hooks;
pub(crate) mod inbox_address;
mod intervention;
mod lifecycle;
mod output_speed;
mod run;
mod session;
mod settings_rows;
mod spawn;
mod spent_retries_signal;
mod tools;
mod turn_evidence;
mod version;

/// Claude Code's fixed facts. Its plan ids read as their own words, and it reads no tool-server
/// declaration member beyond the shared ones.
pub(super) const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "claude",
    name: "Claude Code",
    plan_words: &[],
    built_in_tools: &tools::CLAUDE_BUILT_IN_TOOLS,
    command: ProviderCommand {
        windows: Some(ProviderCommandLookup {
            names: &["claude"],
            install_folders: &[InstallFolder {
                base: InstallFolderBase::Home,
                components: &[".local", "bin"],
            }],
        }),
        unix: Some(ProviderCommandLookup {
            names: &["claude"],
            install_folders: &[
                InstallFolder {
                    base: InstallFolderBase::Home,
                    components: &[".local", "bin"],
                },
                // Claude Code's own local install.
                InstallFolder {
                    base: InstallFolderBase::Home,
                    components: &[".claude", "local"],
                },
            ],
        }),
    },
    // Where `managed-settings.json`, `managed-settings.d/` and `managed-mcp.json` sit.
    managed_settings_folders: SystemFolders {
        macos: Some(SystemFolder {
            base: MacosSystemFolder::ApplicationSupport,
            components: &["ClaudeCode"],
        }),
        linux: Some(SystemFolder {
            base: LinuxSystemFolder::Etc,
            components: &["claude-code"],
        }),
        windows: Some(SystemFolder {
            base: WindowsSystemFolder::ProgramFiles,
            components: &["ClaudeCode"],
        }),
    },
    // Seatbelt on macOS and bubblewrap on Linux; on Windows it runs commands unsandboxed.
    command_sandbox: PerSystem {
        macos: true,
        linux: true,
        windows: false,
    },
    // On Linux its sandbox runs the system's bubblewrap and socat in a user namespace; macOS
    // ships Seatbelt.
    command_sandbox_needs: PerSystem {
        macos: CommandSandboxNeeds::NOTHING,
        linux: CommandSandboxNeeds {
            programs: &["bwrap", "socat"],
            user_namespace: true,
            service_readiness: false,
        },
        windows: CommandSandboxNeeds::NOTHING,
    },
    // Each conversation is a process of its own, measured at a peak of 182 MB.
    memory: ProviderMemoryEstimates {
        process_bytes: 182_000_000,
        conversation_bytes: None,
    },
    standard_output_speed: "off",
    // Its declared state has a third value, which the provider enters after a rate limit and no
    // request asks for.
    output_speed_levels: Some(&["off", "on"]),
    process_environment: &[
        // Its two update switches, so the build recorded at start is the one that runs.
        ("DISABLE_AUTOUPDATER", "1"),
        ("DISABLE_UPDATES", "1"),
        // A tool-server call or a helper still running after 120 s moves to the background.
        ("CLAUDE_AUTO_BACKGROUND_TASKS", "1"),
        // A waiting dialog arms no deadline.
        ("CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS", "0"),
        // A background command's `timeout` is honored up to Claude Code's own cap.
        ("BASH_MAX_TIMEOUT_MS", "2147483647"),
    ],
    launch_environment_names: &[],
    // The account's configuration home, its credential store, and the scratch folder the daemon
    // keeps per account home, so a session's temporary files sit where its purge finds them.
    credential_home_environment_names: &[
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        "CLAUDE_CODE_TMPDIR",
    ],
    withheld_environment_names: &[
        // Forces the permission mode to `default`.
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
        // Ends a process that holds a pending wake-up.
        "CLAUDE_CODE_EXIT_AFTER_STOP_DELAY",
        // Hands a flagged removal to the auto-mode classifier.
        "CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT",
        // Joins the per-session memories the daemon keeps apart.
        "CLAUDE_CODE_REMOTE_MEMORY_DIR",
    ],
    screen_reader_environment_names: &["CLAUDE_AX_SCREEN_READER"],
    voice_kinds: &[VoiceKind::Dictation],
    mcp_transports: &[McpTransport::Stdio, McpTransport::Http, McpTransport::Sse],
    mcp_config_members: &[],
    skill_name_max_length: None,
    background_work: Some(BackgroundWork {
        // Background sessions and their supervisor, a restart of them, and every form that serves
        // or runs a session from elsewhere: Remote Control, a self-hosted runner, the gateway.
        subcommands: &[
            "agents",
            "daemon",
            "respawn",
            "remote-control",
            "self-hosted-runner",
            "gateway",
        ],
        // A prompt sent to the background (`--exec` runs only beside `--bg`), to Remote Control,
        // to the cloud, or taken over from it.
        flags: &[
            "--bg",
            "--background",
            "--remote-control",
            "--rc",
            "--cloud",
            "--remote",
            "--teleport",
        ],
        refusal: "`claude agents`, `claude daemon`, `claude --bg` and every other `claude` form \
                  that starts or serves work outside this session are refused inside it: their \
                  work would run outside the session's agents, outside Stop and Interrupt, and \
                  off its receipt.",
        // Turns off `claude agents`, `--bg`, `/background` and the on-demand supervisor; no
        // setting turns them back on.
        off_switch: ("CLAUDE_CODE_DISABLE_AGENT_VIEW", "1"),
    }),
};

/// Builds the Claude Code driver over the shared services; it stores handles and does no I/O.
#[expect(
    dead_code,
    reason = "the daemon's start registers the driver through it"
)]
pub(super) fn build(services: &DriverServices) -> Arc<dyn ProviderDriver> {
    Arc::new(ClaudeDriver::new(services))
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
        ready(self.pause_run(&params)).boxed()
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

    fn starts_process(&self, session_id: SessionId) -> BoxFuture<'_, bool> {
        ready(self.starts_process(session_id)).boxed()
    }

    // Claude Code takes a skill pick as the text that opens the turn, so each pick is answered as
    // `skill.list` gave it, by its name and folder, with nothing read.
    fn resolve_skill_picks(
        &self,
        _session_id: SessionId,
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
        self.list_modes().boxed()
    }

    fn get_capabilities(&self) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>> {
        self.get_capabilities().boxed()
    }

    fn probe_auth(&self) -> BoxFuture<'_, Result<DriverAuthProbeResult, DriverError>> {
        self.probe_auth().boxed()
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
        ready(self.list_provider_commands(params)).boxed()
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
        self.read_rows(app_values).boxed()
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
        ready(self.ask_side_question(params)).boxed()
    }

    fn start_review(&self, params: StartReviewParams) -> BoxFuture<'_, Result<(), DriverError>> {
        self.start_review(params).boxed()
    }

    fn subscribe_provider_commands(
        &self,
        params: SubscribeProviderCommandsParams,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        self.subscribe_provider_commands(&params, listener)
    }

    fn shutdown(&self, intent: DaemonStopIntent) -> BoxFuture<'_, Result<(), DriverError>> {
        self.shutdown(intent).boxed()
    }

    fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>> {
        self.session_inbox_addresser()
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
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};

    use crate::provider::driver::claude::lifecycle::ClaudeDriver;
    use crate::provider::driver::contract::ProviderDriver;
    use crate::provider::driver::run_control::PickedSkill;
    use crate::provider::driver::test_registry::test_driver_services;

    // Killed by answering no skill, which drops every pick from the stored message.
    #[tokio::test]
    async fn each_skill_pick_is_answered_in_order_by_its_name_and_folder() {
        let driver = ClaudeDriver::new(&test_driver_services());
        let session_id =
            SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d").expect("a valid session id");
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
