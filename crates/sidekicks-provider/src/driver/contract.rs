//! The operations every provider driver carries out for the daemon, so the session engine never
//! sees a provider's own types: the `ProviderDriver` trait, the params and results only the daemon
//! reads, and the driver's error. Params are built by the daemon and trusted; results are built
//! by the driver from provider output, and a text member bounded by its type was checked where the
//! driver built it. Nothing here hands a driver remote authority: a driver may call a remote
//! provider service behind these operations while the authority to run stays local.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ObservedProviderOptions, ProviderDeclarationId, ProviderOptionSetting, ProviderRow,
    ProviderSessionOption, ProviderValue,
};
use sidekicks_contracts::provider::driver::capabilities::{
    ExecutionPosture, ProviderMode, ProviderModel,
};
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandBindingGroup,
};
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::ProviderToolMetadata;
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId, QueuedSkillPick};
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SessionReviewTarget,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::text_cut::cut_to_code_points;

use crate::capability::probe::CapabilityProbeError;
use crate::driver::capabilities::{DriverCapabilities, DriverCapabilityFlag};
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::driver::error_causes::{
    ExecutableUnresolvable, ModelCatalogUnreadable, ProviderAxisInvalid, RequestUnanswered,
};
use crate::driver::idle_sleep::{IdleSleepHolds, SessionSleepState};
use crate::driver::message_handing::MessageHanding;
use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ApplyInterventionParams,
    ApplyInterventionResponse, DriverRunRefusal, FasterModelRetryOutcome, FasterModelRetryParams,
    FindTakenMessagesParams, HelperTokenLimitParams, InterruptRunRequest, OverrideDenialParams,
    PauseRunParams, PickedSkill, ResumeRunParams, SteerTurnEndedError, TakenMessages,
    WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
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
use crate::port::permission_ask::{ProviderPermissionAnswer, ProviderRuleNotKeptError};
use crate::port::running_command_publisher::{RunningCommandParams, WriteCommandInputParams};
use crate::port::session_inbox_address::SessionInboxAddresser;
use crate::runtime_binding::store::RuntimeBindingStoreError;

/// The fixed sentence every `provider.capability.unsupported` refusal carries.
pub(crate) const PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE: &str =
    "Requested capability is not supported by the driver";

/// Why a driver operation did not answer: a refusal a client reads by its code, a request the
/// provider got with no answer back, a steer whose turn ended before it was sent (the message
/// waits for the next turn), a run start the driver refused, a provider command that names no
/// runnable build, or a failure inside the driver, keeping its cause.
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    /// A refusal a client reads by its code.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The request went out and no answer came, so the provider may still act on it.
    #[error(transparent)]
    Unanswered(RequestUnanswered),
    /// The turn a steer or a waiting continue was handed for ended before the message was sent.
    #[error(transparent)]
    SteerTurnEnded(#[from] SteerTurnEndedError),
    /// The driver refused a run's start before its provider saw it; the run fails as that refusal.
    #[error("the driver refused the run")]
    RunRefused(#[source] DriverRunRefusal),
    /// The capability probe could not read the provider, so nothing is declared from it.
    #[error("the provider's capability probe failed")]
    CapabilityProbe(#[source] CapabilityProbeError),
    /// The configured provider command names no runnable build.
    #[error(transparent)]
    ExecutableUnresolvable(ExecutableUnresolvable),
    /// The provider's model catalog reply could not be read, so no catalog is declared from it.
    #[error(transparent)]
    ModelCatalogUnreadable(ModelCatalogUnreadable),
    /// A provider axis the request set holds a value the provider does not offer now.
    #[error(transparent)]
    ProviderAxisInvalid(ProviderAxisInvalid),
    /// The answer reached the provider, which could not keep the rule it made.
    #[error(transparent)]
    RuleNotKept(#[from] ProviderRuleNotKeptError),
    /// A skill pick the provider's own list does not name in its folder; the run queue refuses
    /// the send for it.
    #[error("the provider does not list skill {} in {}", .0.name.as_str(), .0.folder_path.as_str())]
    SkillNotListed(QueuedSkillPick),
    /// The driver or its provider failed.
    #[error("the provider driver failed")]
    Internal(#[source] Box<dyn Error + Send + Sync>),
}

impl From<RuntimeBindingStoreError> for DriverError {
    /// A driver's read of the daemon's stored bindings that failed is the driver's own failure.
    fn from(error: RuntimeBindingStoreError) -> Self {
        Self::Internal(Box::new(error))
    }
}

impl From<DriverError> for HandlerError {
    /// A driver's refusal, and a request that got no answer, answer the call by the refusal's
    /// code; a failed capability probe and an unreadable model catalog answer
    /// `provider.unavailable`, the catalog's bounded fault as the provider failure's detail, and a
    /// command that names no runnable build as `ExecutableUnresolvable::into_refusal` says; a
    /// provider axis the provider does not offer answers `agent.providerAxisInvalid` naming the
    /// agent, the axis and the value; a steer whose turn ended, a refused run start, a rule the
    /// provider could not keep or a skill pick it does not list, reaching a handler, is a fault in
    /// the daemon, as is the driver's own failure.
    fn from(error: DriverError) -> Self {
        match error {
            DriverError::Refused(refusal)
            | DriverError::Unanswered(RequestUnanswered { refusal }) => Self::Refused(refusal),
            DriverError::CapabilityProbe(probe) => Self::Refused(
                DomainError::new(
                    "The provider's capabilities could not be read",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({ "providerFailureDetail": probe.to_string() }))
                .with_source(probe),
            ),
            DriverError::ExecutableUnresolvable(unresolvable) => {
                Self::Refused(unresolvable.into_refusal())
            }
            DriverError::ModelCatalogUnreadable(unreadable) => Self::Refused(
                DomainError::new(
                    "The provider's model catalog could not be read",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({
                    "providerId": unreadable.provider.as_str(),
                    "providerFailureDetail": unreadable.detail.as_str(),
                }))
                .with_source(unreadable),
            ),
            DriverError::ProviderAxisInvalid(invalid) => Self::Refused(
                DomainError::new(
                    "The provider does not offer this value now",
                    RefusalCode::AgentProviderAxisInvalid,
                )
                .with_detail(json!({
                    "agentId": invalid.agent_id,
                    "axis": <&str>::from(invalid.axis),
                    "value": invalid.value,
                })),
            ),
            DriverError::SteerTurnEnded(steer) => Self::Internal(Box::new(steer)),
            DriverError::RuleNotKept(not_kept) => Self::Internal(Box::new(not_kept)),
            DriverError::RunRefused(refusal) => Self::Internal(Box::new(refusal)),
            error @ DriverError::SkillNotListed(_) => Self::Internal(Box::new(error)),
            DriverError::Internal(fault) => Self::Internal(fault),
        }
    }
}

/// The operations every provider driver carries out for the daemon. Each refusal comes back as
/// [`DriverError::Refused`]; an operation gated on a capability flag the driver does not declare
/// is refused as `provider.capability.unsupported` before it reaches the driver.
#[cfg_attr(any(test, feature = "test-support"), mockall::automock)]
pub trait ProviderDriver: Send + Sync {
    /// Opens a provider session and binds its spawn-time legs.
    fn create_session(
        &self,
        params: CreateSessionParams,
    ) -> BoxFuture<'_, Result<ProviderSessionHandle, DriverError>>;

    /// Resumes a session in a fresh process; a resume that fails answers the `Failed` arm, never
    /// a replacement session.
    fn resume_session(
        &self,
        params: ResumeSessionParams,
    ) -> BoxFuture<'_, Result<DriverResumeResult, DriverError>>;

    /// Waits until the session's process no longer comes back on its own, so a run's binding is
    /// opened on the leg it settles on: answers once the process is live, and fails
    /// `provider.unavailable` once it reads down. Has no bound of its own; the caller bounds it.
    fn settle_session(&self, session_id: SessionId) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Starts one run's turn.
    fn start_run(&self, params: StartRunParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Interrupts one run.
    fn interrupt_run(&self, params: InterruptRunRequest) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Delivers a steer or carries out an interrupt on a live run; `degraded` answers a kind the
    /// driver cannot deliver at all. An interrupt that finds no turn in flight answers `Ok` with
    /// status `applied`, which the service records as applied and ends the run.
    fn apply_intervention(
        &self,
        params: ApplyInterventionParams,
    ) -> BoxFuture<'_, Result<ApplyInterventionResponse, DriverError>>;

    /// Forks the provider conversation at a recorded position and moves the session onto the
    /// fork, touching no files (gated on `sessionFork`); `Degraded` reports the fallback a driver
    /// took instead.
    fn move_session_to_fork(
        &self,
        params: MoveSessionToForkParams,
    ) -> BoxFuture<'_, Result<MoveSessionToForkResult, DriverError>>;

    /// Cuts the bound conversation in place, never touching files; a running turn is stopped
    /// first (gated on `rollback`).
    fn rewind_conversation(
        &self,
        params: RewindConversationParams,
    ) -> BoxFuture<'_, Result<RewindConversationResult, DriverError>>;

    /// Answers one interactive request the driver raised on a run.
    fn respond_to_request(
        &self,
        params: RespondToRequestParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// `Allow once` on a block the provider's own reviewer made, carried by the provider's own
    /// means: it reaches a running turn at once and starts a turn when none runs, and retries
    /// nothing itself. Called only for a block the driver reported as one a person may overrule.
    fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Stops the lead run or a provider subagent's child run after the step in flight, by the
    /// provider's own hooks or a boundary interrupt where it has none; resolves once the provider
    /// has the request. The driver reports `paused` only once its hold took effect, never
    /// `running`, and a continue before then drops the pause.
    fn pause_run(&self, params: PauseRunParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Continues a paused or pausing run from where it stopped, with nothing repeated, delivering
    /// the waiting messages; resolves once the provider has the request.
    fn resume_run(&self, params: ResumeRunParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Looks messages a resume sent with no answer back up in the provider's own record of the
    /// conversation by their ids, answering the ones it holds; called only once no live provider
    /// process still holds them for a turn of its own, at the run's end for a provider whose
    /// process keeps nothing past it and at the process's end otherwise. Fails when the record is
    /// unreadable, or with [`DriverError::Unanswered`] when the read got no answer back, which the
    /// next settle retries.
    fn find_taken_messages(
        &self,
        params: FindTakenMessagesParams,
    ) -> BoxFuture<'_, Result<TakenMessages, DriverError>>;

    /// Takes back a steer the provider has not read yet (gated on `steer`); an edit is a withdraw
    /// and a new send.
    fn withdraw_queued_message(
        &self,
        params: WithdrawQueuedMessageParams,
    ) -> BoxFuture<'_, Result<WithdrawQueuedMessageResult, DriverError>>;

    /// How the provider takes the messages the run queue hands a running turn: a fixed fact of
    /// the driver, which the queue reads instead of naming the provider.
    fn message_handing(&self) -> MessageHanding;

    /// Whether resolving a message's skill picks starts a provider process where none runs the
    /// session, which the memory gate then weighs: a fixed fact of the driver, like
    /// [`message_handing`](Self::message_handing). A driver that reads its picks from the
    /// provider's own list does.
    fn skill_resolve_starts_process(&self) -> bool {
        true
    }

    /// The largest picture the provider takes, as the bytes of its base64 text, which the staging
    /// of a message's files checks each picture against: a fixed fact of the driver, like
    /// [`message_handing`](Self::message_handing); `None` where the provider sets no limit.
    fn picture_base64_size_limit(&self) -> Option<u64> {
        None
    }

    /// Whether a run started on `session_id` now brings a provider process up, which the memory
    /// gate weighs before the start; `false` when one already serves the session. A session with
    /// no live process is weighed on `provider_account_id`, the account the run is admitted
    /// against, since it may not have run yet.
    fn starts_process(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, bool>;

    /// The skills `picks` names as the provider loads them for `session_id`, in the order picked,
    /// read on `provider_account_id`'s account (as [`starts_process`](Self::starts_process) takes
    /// it) where no live process serves the session; a provider that takes a pick as its text
    /// answers each by its name and folder. Fails with [`DriverError::SkillNotListed`] for a pick
    /// the provider's own list does not name in that folder.
    fn resolve_skill_picks(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
        picks: Vec<QueuedSkillPick>,
    ) -> BoxFuture<'_, Result<Vec<PickedSkill>, DriverError>>;

    /// Answers a choice the provider holds the run on; a provider that never asks one answers
    /// `NotPending`.
    fn answer_provider_choice(
        &self,
        params: AnswerProviderChoiceParams,
    ) -> BoxFuture<'_, Result<AnswerProviderChoiceResult, DriverError>>;

    /// Stops the held turn and sends its message again on the named model, adding no row; a
    /// provider that never holds a turn for a safety check answers `Rejected`.
    fn retry_turn_on_faster_model(
        &self,
        params: FasterModelRetryParams,
    ) -> BoxFuture<'_, Result<FasterModelRetryOutcome, DriverError>>;

    /// The level and mode a new session starts at, as its provider's own settings for the folder
    /// set them, moved to the nearest more careful level it runs; fails when a settings file that
    /// may set them cannot be read.
    fn read_starting_level(
        &self,
        params: StartingLevelParams,
    ) -> BoxFuture<'_, Result<StartingLevel, DriverError>>;

    /// Moves the live session to another permission level from its next request, never by
    /// relaunch.
    fn update_permission_level(
        &self,
        params: UpdatePermissionLevelParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Takes a revoked rule out of force where its provider keeps it, before it resolves; a
    /// session that is not live reads its rules again when it opens.
    fn revoke_rule(&self, params: RevokeRuleParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Starts a session whose provider process ended and stayed down and resumes it as
    /// `resume_session` does; where one process serves several sessions, it restarts that process
    /// and resumes every conversation it held (gated on `resume`).
    fn restart_session(
        &self,
        params: ResumeSessionParams,
    ) -> BoxFuture<'_, Result<DriverResumeResult, DriverError>>;

    /// Moves every live session onto the provider build that replaced the running one, each when
    /// its running reply ends or at once while idle.
    fn move_to_provider_build(
        &self,
        change: ProviderBuildChange,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Deletes the provider's own copy of each conversation the session opened, from every account
    /// home it ran in; a conversation that fails to delete fails the call after the rest were
    /// tried.
    fn purge_session(&self, params: PurgeSessionParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Sets the session goal on the target agent's live binding (gated on `sessionGoals`); a
    /// provider that did not take it answers `Degraded`.
    fn set_session_goal(
        &self,
        params: SetSessionGoalParams,
    ) -> BoxFuture<'_, Result<DriverGoalResult, DriverError>>;

    /// Clears the session goal on one live binding (gated on `sessionGoals`); a provider that did
    /// not clear it answers `Degraded`.
    fn clear_session_goal(
        &self,
        params: ClearSessionGoalParams,
    ) -> BoxFuture<'_, Result<DriverGoalResult, DriverError>>;

    /// Closes one session.
    fn close_session(&self, params: CloseSessionParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Names a session from its first exchange in one short pass of the provider's own: through
    /// the provider's naming verb on the session's live leg when it has one and the verb answers
    /// with a name, else, when no leg is live or the verb fails or returns no name, in a one-shot
    /// pass of the provider's program on the account the session's leg runs on. `None` only when
    /// both returned no name, or the session never ran. A pass whose `cancel` fires ends at once
    /// and returns `None`, and so does one that runs past the driver's own bound on the whole pass,
    /// which stops what it started as a cancel does.
    fn name_session(
        &self,
        params: NameSessionParams,
    ) -> BoxFuture<'_, Result<Option<String>, DriverError>>;

    /// Tells the provider the name the session now goes by, so its own session list shows that
    /// name: through the provider's rename verb on the session's live leg when it has one, else
    /// on the provider's stored session, on the account its stored leg ran on, where the provider
    /// renames one at rest; a session that never ran has nothing to rename and answers `Ok`.
    /// Fails with the driver's error when the provider did not take it, a session it cannot
    /// rename at rest among them.
    fn tell_session_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// The provider's models for a session's model control, read against the account the params
    /// name, or the provider's current account where they name none.
    fn list_models(
        &self,
        params: ListModelsParams,
    ) -> BoxFuture<'_, Result<Vec<ProviderModel>, DriverError>>;

    /// The provider's modes.
    fn list_modes(&self) -> BoxFuture<'_, Result<Vec<ProviderMode>, DriverError>>;

    /// The driver's capability flags, tool declarations and provider version, read live.
    fn get_capabilities(&self) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>>;

    /// A zero-turn authentication probe of `provider_account_id`'s account, run in that account's
    /// own home; no flag exists for it, so no driver opts out.
    fn probe_auth(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<DriverAuthProbeResult, DriverError>>;

    /// Compacts the bound session's provider-side context on the person's request (gated on
    /// `contextCompaction`), settling on the provider's own compaction evidence, never on the
    /// request being accepted. The wait has no time limit of the driver's own: it settles on the
    /// provider's compaction frame, `notCompacted` when the provider ends the compaction's turn
    /// without one, or `bindingLost` when the binding stops being live; a later frame normalizes
    /// as an unrequested one.
    fn compact_context(
        &self,
        params: CompactContextParams,
    ) -> BoxFuture<'_, Result<AgentRunContextCompactResponse, DriverError>>;

    /// A live read of the provider's own commands and skills for the bound session (gated on
    /// `providerCommands`), held with the session and never stored: one group carrying the
    /// params' run and binding, every entry stamped with that binding.
    fn list_provider_commands(
        &self,
        params: ListProviderCommandsParams,
    ) -> BoxFuture<'_, Result<ProviderCommandBindingGroup, DriverError>>;

    /// Stops the agent's running command `params` names, answering once the provider acknowledged
    /// the stop; refused `provider.capability.unsupported` where the provider relays no stop.
    fn stop_command(&self, params: RunningCommandParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Moves the agent's running command to the background, answering whether the provider moved
    /// it, `false` when the agent no longer waited on it; refused `provider.capability.unsupported`
    /// where the provider moves none.
    fn move_command_to_background(
        &self,
        params: RunningCommandParams,
    ) -> BoxFuture<'_, Result<bool, DriverError>>;

    /// Writes the person's input to the agent's running command, then ends its input where asked;
    /// refused `provider.capability.unsupported` where the provider takes none.
    fn write_command_input(
        &self,
        params: WriteCommandInputParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// The holds the provider keeps on `session_id` that keep its process up: the requests it
    /// holds open, a side question and its timed fires. A provider whose sessions never sleep
    /// answers none. Fails when the provider's state cannot be read.
    fn idle_sleep_holds(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<IdleSleepHolds, DriverError>>;

    /// Stops `session_id`'s idle process, keeping its conversation, account, settings and inbox
    /// for its wake, and answers where that left it once the process exited; a provider whose
    /// sessions never sleep leaves it awake. The idle sleep calls it under the session's lock,
    /// once it found no hold.
    fn sleep_session(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, DriverError>>;

    /// Resumes a sleeping `session_id` on the same conversation, account, folder, settings and
    /// permission level, reads its command list and tool servers again, and answers once it is
    /// up; a session that is awake answers at once. Fails with the driver's own start refusal
    /// when the resume fails, leaving it asleep.
    fn wake_session(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, DriverError>>;

    /// What `call`, one of the provider's tool calls, does to the agent's task list; `None` for a
    /// call that is not a task-list call, which the transcript shows as a row.
    fn task_list_change<'call>(&self, call: &ToolCallRecord<'call>) -> Option<TaskListChange>;

    /// Stops a helper whose own run passed its token limit, alone, while its lead goes on: the
    /// provider refuses the helper's next tool use with [`HELPER_TOKEN_LIMIT_REASON`], or ends
    /// the helper's own turn where it cannot refuse one. Resolves once the provider has the
    /// request.
    ///
    /// [`HELPER_TOKEN_LIMIT_REASON`]: crate::driver::run_control::HELPER_TOKEN_LIMIT_REASON
    fn stop_helper_at_token_limit(
        &self,
        params: HelperTokenLimitParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// The output-speed state the provider last declared for the session's live binding, as sent;
    /// `None` with no live binding or no declaration yet, which means unread, never off. A read of
    /// state the driver holds, never a request, and never the requested level.
    fn observed_output_speed_for(&self, session_id: &SessionId)
    -> Option<ProviderOutputSpeedState>;

    /// The level and session mode the provider itself moved the session's live process to, read
    /// from its newest report; `None` with no live process, no report, or a report the daemon's
    /// own move caused. A read of state the driver holds, never a request.
    fn reported_level(&self, session_id: &SessionId) -> Option<ProviderReportedLevel>;

    /// The rows the driver declares on its provider's settings, each with its live value in every
    /// place, as `provider.list` serves them, `app_values` being the values the app stored for
    /// them; read again after each change.
    fn read_rows(
        &self,
        app_values: ProviderRowValues,
    ) -> BoxFuture<'_, Result<Vec<ProviderRow>, DriverError>>;

    /// The values the driver's Settings rows take where the app stored none, each in the shape a
    /// stored value takes; the daemon's start applies each through [`Self::apply_row_value`],
    /// a stored value in its place. Empty for a driver whose rows follow the provider's own values.
    fn row_defaults(&self) -> ProviderRowValues;

    /// Applies a value the daemon checked against the row's declaration and stored: a setting
    /// reaches sessions started later, and a per-place switch that runs something starts or stops
    /// it in that place.
    fn apply_row_value(
        &self,
        params: ApplyRowValueParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// The session options the driver declares for its installed build, each drawn where its
    /// placement says; the composer and `agent.config.update` check a value against them.
    fn session_options(&self) -> BoxFuture<'_, Result<Vec<ProviderSessionOption>, DriverError>>;

    /// The session options the provider last reported for the session's live binding, each with
    /// whether the session can run it; `None` with no live binding or no report yet, which means
    /// unread, never off. A read of state the driver holds, never a request.
    fn observed_options_for(&self, session_id: &SessionId) -> Option<ObservedProviderOptions>;

    /// Whether a provider process serves the session now, the driver brings one back itself, or
    /// none runs until the daemon opens or resumes it: a read of state the driver holds, never a
    /// request, which the daemon reads under the session's transition lock.
    fn session_process_state(&self, session_id: &SessionId) -> SessionProcessState;

    /// Moves the session between Build and Plan from its next turn.
    fn update_session_mode(
        &self,
        params: UpdateSessionModeParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Answers, before any run is made, a command whose provider command would change more than
    /// this session, applying it to the session alone; a driver with no such command answers
    /// `NotAnswered` for every text.
    fn answer_session_command(
        &self,
        params: AnswerSessionCommandParams,
    ) -> BoxFuture<'_, Result<SessionCommandAnswer, DriverError>>;

    /// Asks a side question on a throwaway copy of the conversation; resolves once it is answered,
    /// is refused `session.sideQuestion.refused` when the model refuses it, and fails as the
    /// question's turn fails.
    fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Follows the session's live command list (gated on `providerCommands`): `listener` gets the
    /// current list and each change until the returned subscription drops.
    fn subscribe_provider_commands(
        &self,
        params: SubscribeProviderCommandsParams,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription;

    /// Stops every provider process this driver started; under `Restart` a service that outlives
    /// the daemon is only disconnected. The daemon calls it once while it stops; a service the
    /// person runs themselves is never stopped.
    fn shutdown(&self, intent: DaemonStopIntent) -> BoxFuture<'_, Result<(), DriverError>>;

    /// The inbox addresses the daemon holds for every session, where this provider's sessions
    /// must answer them; `None` for a provider whose sessions answer no inbox.
    fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>>;

    /// Deletes what the provider keeps for its own diagnosis in account home `home` from before
    /// `cutoff`, beyond the descriptor's folders, which the expiry deletes itself, and answers the
    /// rows it deleted; blocking. Does nothing unless the provider keeps more; fails when that
    /// store cannot be read or written.
    #[expect(
        unused_variables,
        reason = "the default expires nothing; the generated mock reads both"
    )]
    fn expire_account_home_diagnostics(
        &self,
        home: &Path,
        cutoff: SystemTime,
    ) -> Result<u64, Box<dyn Error + Send + Sync>> {
        Ok(0)
    }

    /// The logs in the daemon's `logs/` folder that the provider's services running now write,
    /// which the diagnostic-log expiry never deletes; blocking. Empty for a provider that runs no
    /// service writing one. Fails when a log of a service that may run cannot be named.
    fn running_service_log_files(&self) -> io::Result<Vec<PathBuf>> {
        Ok(Vec::new())
    }
}

/// Where a session's provider process stands, as its driver holds it: the one predicate the
/// session controls choose their arm by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionProcessState {
    /// A process serves the session now; a control reaches it at once.
    Live,
    /// No process serves the session now, and the driver itself brings one back from the state it
    /// holds, with no open or resume by the daemon. A level or mode move the driver accepts in
    /// this window reaches the process it brings back; the daemon stores it as on a live session.
    Restarting,
    /// No process serves the session, and none starts until the daemon's open or resume, which
    /// reads the stored mode and level: never opened in this daemon, asleep, closed, or stopped
    /// restarting after a crash loop.
    Down,
}

/// The level and session mode a provider reported its process moved to on its own: no level where
/// the reported mode runs none, as a planning mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderReportedLevel {
    /// The level the reported mode runs, if it runs one.
    pub level: Option<PermissionLevel>,
    /// Plan where the reported mode plans, else Build.
    pub session_mode: SessionMode,
}

/// A follow of a session's live command list, ended when this drops.
#[must_use = "the command list is followed only while the subscription lives"]
pub struct ProviderCommandsSubscription {
    /// Ends the follow; taken once, on drop.
    end: Option<Box<dyn FnOnce() + Send>>,
}

impl ProviderCommandsSubscription {
    /// A subscription that runs `end` once when it drops.
    pub(crate) fn new(end: impl FnOnce() + Send + 'static) -> Self {
        Self {
            end: Some(Box::new(end)),
        }
    }
}

impl Drop for ProviderCommandsSubscription {
    fn drop(&mut self) {
        if let Some(end) = self.end.take() {
            end();
        }
    }
}

/// One declared row's new value, already checked against its declaration and stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyRowValueParams {
    /// The row.
    pub row_id: ProviderDeclarationId,
    /// The place of a per-place switch; `None` on a computer without a WSL 2 distribution or for a
    /// row that is not per place.
    pub place: Option<Place>,
    /// The value, or `None` for a choice's none.
    pub value: Option<ProviderValue>,
}

/// What the daemon hands a driver to start one run: its id, the message that opens it and the
/// run's own options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartRunParams {
    /// The run.
    pub run_id: RunId,
    /// The queued message the run opens with, on the binding the daemon opened for it.
    pub opening: RunOpening,
    /// The conversation so far, for a provider that takes it per run.
    pub conversation_history: Option<Vec<Value>>,
    /// The agent's accepted output-speed level, resolved as on [`CreateSessionParams`]. A provider
    /// that applies it between turns sends it before this run's turn only when it differs from
    /// the level the process last applied; one that takes it per turn sends it with this turn.
    /// `None` keeps the level the process holds.
    pub output_speed: Option<ProviderToken>,
    /// The session option values to apply between turns before this run's turn, like
    /// `outputSpeed`; an option left out keeps what the process holds.
    pub options: Vec<ProviderOptionSetting>,
    /// A level for this run's turn alone; the next run carries the agent's own level again.
    pub output_speed_for_turn: Option<ProviderToken>,
    /// The run's effective posture. A provider that binds posture at spawn meets a change by
    /// relaunching the session, never by applying part of it.
    pub execution_posture: Option<ExecutionPosture>,
    /// A JSON Schema this turn's final output must meet (gated on `structuredOutput`), for a
    /// provider that binds it per turn.
    pub output_schema: Option<Map<String, Value>>,
    /// The session's own bound on the steps one turn may take, read as the run starts; `None`
    /// where the person set none.
    pub step_bound: Option<SafeInt<1>>,
}

/// The queued item a run the queue admitted opens with, and where it runs: the session, the
/// binding its deliveries are attributed on and the agent whose run it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOpening {
    /// The session.
    pub session_id: SessionId,
    /// The runtime binding the run's deliveries are attributed on, opened by the daemon.
    pub binding_id: RuntimeBindingId,
    /// The agent whose run it is.
    pub agent_id: AgentId,
    /// The queued item's id, stamped on the provider's user message so a later cut can name it.
    pub message_id: QueueItemId,
    /// What the run's turn opens with.
    pub item: RunOpeningItem,
}

/// What a run the queue admitted opens its turn with: a message the person sent, or the
/// provider's own review of the session's changes, which runs as the run's turn and whose report
/// lands as the agent's reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunOpeningItem {
    /// A message.
    Message {
        /// The message's words.
        content: MessageContent,
        /// The message's files, in staging order.
        attachments: Vec<ArtifactId>,
        /// The skills picked for the message, in the order picked.
        skills: Vec<PickedSkill>,
    },
    /// The provider's own review.
    Review {
        /// What the review covers.
        target: SessionReviewTarget,
    },
}

/// Answers one interactive request a driver raised on a run with the daemon's answer, which the
/// driver composes into its provider's own answer shape.
#[derive(Debug)]
pub struct RespondToRequestParams {
    /// The run.
    pub run_id: RunId,
    /// The request.
    pub request_id: String,
    /// The daemon's answer.
    pub response: ProviderRequestAnswer,
}

/// The daemon's answer to one request a driver raised: the person's answers to a question, one per
/// question in the request's own order, or the approval pipeline's answer to a permission ask. A
/// secret answer's value reaches only the driver.
#[derive(Debug)]
pub enum ProviderRequestAnswer {
    /// The answers to a question.
    Question {
        /// One answer per question, in the request's order.
        answers: Vec<QuestionAnswer>,
    },
    /// The answer to a permission ask.
    Permission(ProviderPermissionAnswer),
}

/// The provider version the spawned process printed, never read from a launcher link that may
/// name another build: the text always, and its canonical parse when it parses. Every version
/// runs; nothing refuses on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DriverCliVersionReport {
    /// The version as printed.
    pub raw_version: String,
    /// Its canonical parse, when it parses.
    pub parsed_version: Option<String>,
}

/// One spawned-build reading's two binding carriers, read together so a binding row never pairs
/// one install's version with another install's path: what the build reported, and where it ran.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnedVersionBindingCarriers {
    /// The version the spawned build reported in-band.
    pub cli_version: DriverCliVersionReport,
    /// The build's absolute, symlink-resolved path, the one that answered.
    pub resolved_executable_path: PathBuf,
}

/// How one flag's value was reached on a live reading: probed, or taken from the driver's own
/// table where no probe is admissible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityDetectionSource {
    /// From the driver's own table.
    Static,
    /// By a zero-turn probe whose negative control still refused.
    Probed,
}

/// The driver's capability reading: the flags, the tools as the provider declared them and the
/// version the provider printed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GetCapabilitiesResult {
    /// The flags and contract version.
    pub capabilities: DriverCapabilities,
    /// The tools as the provider declared them.
    pub tools: Vec<ProviderToolMetadata>,
    /// The printed provider version; it describes this reading, not a capability, so it is not
    /// part of the stored capability snapshot.
    pub cli_version: DriverCliVersionReport,
    /// How each flag was reached, for every flag on a live reading; `None` on a reading rebuilt
    /// from the stored cache, which keeps values and not provenance. Never sent to a client.
    pub detection_source: Option<BTreeMap<DriverCapabilityFlag, CapabilityDetectionSource>>,
    /// The output-speed levels of a driver whose provider lists none per model: present only
    /// when `outputSpeed` is on and the driver declares a fixed set. With neither this nor a
    /// per-model set, a person's request for a level refuses. It survives a cache rebuild.
    pub output_speed_levels: Option<Vec<ProviderToken>>,
}

/// Fits failure text to a failure detail: every NUL dropped, ECMAScript whitespace trimmed from
/// both ends, cut to the cap in code points, and `empty_fallback` where nothing is left.
pub fn bound_failure_detail(
    detail: &str,
    empty_fallback: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
) -> FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN> {
    let without_nuls = detail.replace('\0', "");
    let trimmed = without_nuls.trim_matches(is_ecmascript_whitespace);
    if trimmed.is_empty() {
        return empty_fallback;
    }
    FreeFormText::new(cut_to_code_points(trimmed, PROVIDER_FAILURE_DETAIL_MAX_LEN).to_owned())
        .expect("trimmed, NUL-free text cut to the cap is non-blank and within it")
}

/// Params of `compact_context` (gated on `contextCompaction`); addresses one binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactContextParams {
    /// The session.
    pub session_id: SessionId,
    /// The binding.
    pub binding_id: RuntimeBindingId,
}

/// Params of `list_provider_commands` (gated on `providerCommands`); addresses one binding, with
/// the driver and account the daemon resolved it to and its one live run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListProviderCommandsParams {
    /// The session.
    pub session_id: SessionId,
    /// The binding.
    pub binding_id: RuntimeBindingId,
    /// The driver and account the binding runs on, which the group and each entry carry.
    pub binding: ProviderCommandBinding,
    /// The one live run on the binding; `None` when several are live.
    pub run_id: Option<RunId>,
}

/// Params of `list_models`: the session whose model control reads the catalog, and the account
/// to read it against, `None` for the provider's current account, which the driver resolves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListModelsParams {
    /// The session, only where this is the session's own provider; `None` for any other.
    pub session_id: Option<SessionId>,
    /// The account: the session's own bound account for its own provider; `None` for the
    /// provider's current account, refused as no account is registered or none is current.
    pub provider_account_id: Option<ProviderAccountId>,
}
