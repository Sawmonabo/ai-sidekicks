//! The operations every provider driver carries out for the daemon, so the session engine never
//! sees a provider's own types: the `ProviderDriver` trait, the params and results only the daemon
//! reads, and the driver's error. Params are built by the daemon and trusted; results are built
//! by the driver from provider output, and a text member bounded by its type was checked where the
//! driver built it. Nothing here hands a driver remote authority: a driver may call a remote
//! provider service behind these operations while the authority to run stays local.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ObservedProviderOptions, ProviderDeclarationId, ProviderOptionSetting, ProviderRow,
    ProviderSessionOption, ProviderValue,
};
use sidekicks_contracts::provider::driver::capabilities::{
    ExecutionPosture, ProviderMode, ProviderModel,
};
use sidekicks_contracts::provider::driver::commands::ProviderCommandListResponse;
use sidekicks_contracts::provider::driver::compaction::AgentRunContextCompactResponse;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_FAILURE_DETAIL_MAX_LEN, PROVIDER_FALLBACK_ACTION_MAX_LEN,
};
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::{ProviderToolMetadata, SessionCallbackTool};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText, is_ecmascript_whitespace};

use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::provider::capability::probe::CapabilityProbeError;
use crate::provider::driver::callback_tool::CallbackToolDispatcher;
use crate::provider::driver::capabilities::{DriverCapabilities, DriverCapabilityFlag};
use crate::provider::driver::mcp_server_status::McpServerStatusProducer;
use crate::provider::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::provider::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ApplyInterventionParams,
    ApplyInterventionResponse, FasterModelRetryOutcome, FasterModelRetryParams,
    InterruptRunRequest, OverrideDenialParams, PauseRunParams, ResumeRunParams,
    SteerTurnEndedError, WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::provider::driver::session_control::{
    AnswerSessionCommandParams, AskSideQuestionParams, ProviderBuildChange,
    ProviderCommandsListener, PurgeSessionParams, RevokeRuleParams, SessionCommandAnswer,
    StartReviewParams, SubscribeProviderCommandsParams, UpdatePermissionLevelParams,
    UpdateSessionModeParams,
};
use crate::provider::port::session_inbox_address::SessionInboxAddresser;
use crate::text_cut::cut_to_code_points;

/// The fixed sentence every `provider.capability.unsupported` refusal carries.
pub(crate) const PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE: &str =
    "Requested capability is not supported by the driver";

/// The longest account or plan descriptor an authentication probe keeps, in code points; a longer
/// one is cut, and dropping it loses only words, never the probe's status.
const PROVIDER_AUTH_DETAIL_MAX_LEN: usize = 512;

/// Why a driver operation did not answer: a refusal a client reads by its code, a steer whose turn
/// ended before it was sent (the message waits for the next turn), a provider command that names
/// no runnable build, or a failure inside the driver, keeping its cause.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DriverError {
    /// A refusal a client reads by its code.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The turn a steer was handed for ended before it was sent.
    #[error(transparent)]
    SteerTurnEnded(#[from] SteerTurnEndedError),
    /// The capability probe could not read the provider, so nothing is declared from it.
    #[error("the provider's capability probe failed")]
    CapabilityProbe(#[source] CapabilityProbeError),
    /// The configured provider command names no runnable build.
    #[error(transparent)]
    ExecutableUnresolvable(ExecutableUnresolvable),
    /// The driver or its provider failed.
    #[error("the provider driver failed")]
    Internal(#[source] Box<dyn Error + Send + Sync>),
}

/// The configured provider command names no runnable build, or one whose real path cannot be
/// read. It carries the command as the person configured it, never a path they did not type.
#[derive(Debug, thiserror::Error)]
#[error("the provider command {requested_command:?} names no runnable build")]
pub(crate) struct ExecutableUnresolvable {
    /// The provider.
    pub(crate) provider: ProviderId,
    /// The command as configured: a bare name or a path.
    pub(crate) requested_command: String,
    /// Why it resolves to no build: none was found, or its real path could not be read.
    #[source]
    pub(crate) cause: io::Error,
}

impl From<DriverError> for HandlerError {
    /// A driver's refusal answers the call by its code; a failed capability probe and a command
    /// that names no runnable build answer `provider.unavailable`, the latter naming the command
    /// as configured; a steer whose turn ended, reaching a handler, is a fault in the daemon, as is
    /// the driver's own failure.
    fn from(error: DriverError) -> Self {
        match error {
            DriverError::Refused(refusal) => Self::Refused(refusal),
            DriverError::CapabilityProbe(probe) => Self::Refused(
                DomainError::new(
                    "The provider's capabilities could not be read",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({ "providerFailureDetail": probe.to_string() }))
                .with_source(probe),
            ),
            DriverError::ExecutableUnresolvable(unresolvable) => Self::Refused(
                DomainError::new(
                    "The provider's command names no runnable build",
                    RefusalCode::ProviderUnavailable,
                )
                .with_detail(json!({
                    "providerId": unresolvable.provider.as_str(),
                    "requestedCommand": unresolvable.requested_command,
                }))
                .with_source(unresolvable),
            ),
            DriverError::SteerTurnEnded(steer) => Self::Internal(Box::new(steer)),
            DriverError::Internal(fault) => Self::Internal(fault),
        }
    }
}

/// The operations every provider driver carries out for the daemon. Each refusal comes back as
/// [`DriverError::Refused`]; an operation gated on a capability flag the driver does not declare
/// is refused as `provider.capability.unsupported` before it reaches the driver.
#[cfg_attr(test, mockall::automock)]
pub(crate) trait ProviderDriver: Send + Sync {
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

    /// Takes back a steer the provider has not read yet (gated on `steer`); an edit is a withdraw
    /// and a new send.
    fn withdraw_queued_message(
        &self,
        params: WithdrawQueuedMessageParams,
    ) -> BoxFuture<'_, Result<WithdrawQueuedMessageResult, DriverError>>;

    /// How the provider takes the messages the run queue hands a running turn: a fixed fact of
    /// the driver, which the queue reads instead of naming the provider.
    fn message_handing(&self) -> MessageHanding;

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

    /// The provider's models.
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ProviderModel>, DriverError>>;

    /// The provider's modes.
    fn list_modes(&self) -> BoxFuture<'_, Result<Vec<ProviderMode>, DriverError>>;

    /// The driver's capability flags, tool declarations and provider version, read live.
    fn get_capabilities(&self) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>>;

    /// A zero-turn authentication probe; no flag exists for it, so no driver opts out.
    fn probe_auth(&self) -> BoxFuture<'_, Result<DriverAuthProbeResult, DriverError>>;

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
    /// `providerCommands`), held with the session and never stored; every entry carries the
    /// driver and account it was read under.
    fn list_provider_commands(
        &self,
        params: ListProviderCommandsParams,
    ) -> BoxFuture<'_, Result<ProviderCommandListResponse, DriverError>>;

    /// The output-speed state the provider last declared for the session's live binding, as sent;
    /// `None` with no live binding or no declaration yet, which means unread, never off. A read of
    /// state the driver holds, never a request, and never the requested level.
    fn observed_output_speed_for(&self, session_id: &SessionId)
    -> Option<ProviderOutputSpeedState>;

    /// The rows the driver declares on its provider's settings, each with its live value in every
    /// place, as `provider.list` serves them; read again after each change.
    fn read_rows(&self) -> BoxFuture<'_, Result<Vec<ProviderRow>, DriverError>>;

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

    /// Asks a side question on a throwaway copy of the conversation; resolves once it is asked.
    fn ask_side_question(
        &self,
        params: AskSideQuestionParams,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Starts the provider's own review; resolves once it has started.
    fn start_review(&self, params: StartReviewParams) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Follows the session's live command list (gated on `providerCommands`): `listener` gets the
    /// current list and each change until the returned subscription drops.
    fn subscribe_provider_commands(
        &self,
        params: SubscribeProviderCommandsParams,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription;

    /// Stops every provider process and service this driver started, as a deliberate stop; the
    /// daemon calls it once while it stops. A service the person runs themselves is never stopped.
    fn shutdown(&self) -> BoxFuture<'_, Result<(), DriverError>>;

    /// The inbox addresses the daemon holds for every session, where this provider's sessions
    /// must answer them; `None` for a provider whose sessions answer no inbox.
    fn session_inbox_addresser(&self) -> Option<Arc<dyn SessionInboxAddresser>>;
}

/// A follow of a session's live command list, ended when this drops.
#[must_use = "the command list is followed only while the subscription lives"]
pub(crate) struct ProviderCommandsSubscription {
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

/// How a provider takes a message sent while its run's turn runs; each fact drives one path of
/// the run queue on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MessageHanding {
    /// When the queue hands a waiting message to the running turn.
    pub(crate) hands_at: HandMoment,
    /// Whether a handed message the provider has not read can be withdrawn ahead of a change.
    pub(crate) can_withdraw: bool,
    /// Whether the provider's process keeps a handed message past its run's end, for a turn it
    /// starts with it.
    pub(crate) kept_by_process: bool,
}

/// When the run queue hands a waiting message to a running turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each driver's answer to how its provider takes a message"
    )
)]
pub(crate) enum HandMoment {
    /// At once, the provider holding it to its own next step.
    AtOnce,
    /// At the turn's next tool boundary, the daemon holding it until then.
    AtToolBoundary,
}

/// What the daemon hands a driver to open a session: its config, its spawn-bound legs and the
/// daemon's callbacks. A spawn-bound leg that gets nothing here launches without it; per-run
/// carriers are on [`StartRunParams`].
#[derive(Clone)]
pub(crate) struct CreateSessionParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's config.
    pub(crate) config: Map<String, Value>,
    /// The session's model. A provider that takes it at process start applies a usage-credits
    /// prompt's `switchDefault` to this session alone, never to the account's saved default.
    pub(crate) model: ProviderToken,
    /// The larger window chosen for the model, in tokens, as recorded when it was picked; `None`
    /// runs the model's default window. A provider whose model id names the window refuses one.
    pub(crate) larger_window: Option<SafeInt<1>>,
    /// How the session may touch the machine.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The agent's accepted output-speed level (gated on `outputSpeed`), sent when the process
    /// starts and never refused: a level the model does not list runs at standard. The provider's
    /// declared state is read through `observed_output_speed_for`, never written back here.
    pub(crate) output_speed: Option<ProviderToken>,
    /// The agent's values of the session options its driver declares, sent when the process starts;
    /// an option left out keeps the provider's default. What the provider reports is read through
    /// `observed_options_for`.
    pub(crate) options: Vec<ProviderOptionSetting>,
    /// The values set in the app on the rows the driver declares, passed to the process through
    /// the provider's own command-line layer; a row left out follows the provider's own settings.
    pub(crate) row_values: ProviderRowValues,
    /// The daemon's callback tools (gated on `callbackTools`); a driver may host them as an
    /// ephemeral tool server, under whose name they then surface.
    pub(crate) callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The provider-native subagent policy (gated on `subagents`).
    pub(crate) subagent_policy: Option<SubagentPolicy>,
    /// Every tool server the session can reach, each switched on or off by the person (gated on
    /// `mcp`); the driver hands each to the provider as an entry on the daemon's route.
    pub(crate) tool_servers: Option<Vec<SessionToolServer>>,
    /// A JSON Schema the final output must meet, for a provider that binds it per session (gated
    /// on `structuredOutput`); one that binds it per turn reads [`StartRunParams::output_schema`].
    pub(crate) output_schema: Option<Map<String, Value>>,
    /// The account the leg is admitted against, resolved by the daemon; `None` spawns on the
    /// machine's default for the provider. The spawn path pins the account's credential home, so
    /// the driver only carries it.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The daemon's callback-tool dispatcher (gated on `callbackTools`); its presence tells the
    /// driver the registry is served, and the driver never calls it.
    pub(crate) on_callback_tool_call: Option<CallbackToolDispatcher>,
    /// The MCP server-status sink, bound to this leg's session and binding at spawn, so a driver
    /// cannot report for another leg and needs no id for the census it reports while opening.
    pub(crate) on_mcp_server_status: Option<McpServerStatusProducer>,
}

/// What the daemon hands a driver to resume a session in a fresh process. A resume is a fresh
/// spawn, so it repeats every spawn-bound leg of [`CreateSessionParams`], rebuilt from the stored
/// spawn record and never from the original request; a leg left out would be shed silently.
#[derive(Clone)]
pub(crate) struct ResumeSessionParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The provider's own handle of the conversation.
    pub(crate) resume_handle: String,
    /// The session's current model, given by the caller since a later switch moves the session.
    pub(crate) model: ProviderToken,
    /// The recorded larger window, sent as recorded whatever the catalog offers now.
    pub(crate) larger_window: Option<SafeInt<1>>,
    /// Build or Plan, which the resumed provider runs in from its first turn.
    pub(crate) mode: SessionMode,
    /// How the session may touch the machine; left out, the leg would relaunch unsandboxed.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The agent's accepted output-speed level; left out, the leg would relaunch at the
    /// provider's default.
    pub(crate) output_speed: Option<ProviderToken>,
    /// The agent's session option values; an option left out would relaunch at the provider's
    /// default.
    pub(crate) options: Vec<ProviderOptionSetting>,
    /// The values set in the app on the driver's rows as they stand now, which a resumed process
    /// starts with.
    pub(crate) row_values: ProviderRowValues,
    /// The daemon's callback tools.
    pub(crate) callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The provider-native subagent policy.
    pub(crate) subagent_policy: Option<SubagentPolicy>,
    /// Every tool server the session can reach.
    pub(crate) tool_servers: Option<Vec<SessionToolServer>>,
    /// A JSON Schema the final output must meet.
    pub(crate) output_schema: Option<Map<String, Value>>,
    /// The account read back from the stored spawn record, never resolved again, so a live run's
    /// spend never moves onto an account it was not admitted against.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The callback-tool dispatcher, injected again at every spawn; its presence tells the resumed
    /// leg the registry is served, and the driver never calls it.
    pub(crate) on_callback_tool_call: Option<CallbackToolDispatcher>,
    /// The status sink, bound to the resumed leg, through which it reports its census again.
    pub(crate) on_mcp_server_status: Option<McpServerStatusProducer>,
}

/// One declared row's new value, already checked against its declaration and stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApplyRowValueParams {
    /// The row.
    pub(crate) row_id: ProviderDeclarationId,
    /// The place of a per-place switch; `None` on a computer without a WSL 2 distribution or for a
    /// row that is not per place.
    pub(crate) place: Option<Place>,
    /// The value, or `None` for a choice's none.
    pub(crate) value: Option<ProviderValue>,
}

/// What the daemon hands a driver to start one run: its id, the agent's config and the run's own
/// options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StartRunParams {
    /// The run.
    pub(crate) run_id: RunId,
    /// The agent's config.
    pub(crate) agent_config: Map<String, Value>,
    /// The conversation so far, for a provider that takes it per run.
    pub(crate) conversation_history: Option<Vec<Value>>,
    /// The agent's accepted output-speed level, resolved as on [`CreateSessionParams`]. A provider
    /// that applies it between turns sends it before this run's turn only when it differs from
    /// the level the process last applied; one that takes it per turn sends it with this turn.
    /// `None` keeps the level the process holds.
    pub(crate) output_speed: Option<ProviderToken>,
    /// The session option values to apply between turns before this run's turn, like
    /// `outputSpeed`; an option left out keeps what the process holds.
    pub(crate) options: Vec<ProviderOptionSetting>,
    /// A level for this run's turn alone; the next run carries the agent's own level again.
    pub(crate) output_speed_for_turn: Option<ProviderToken>,
    /// The run's effective posture. A provider that binds posture at spawn meets a change by
    /// relaunching the session, never by applying part of it.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// A JSON Schema this turn's final output must meet (gated on `structuredOutput`), for a
    /// provider that binds it per turn.
    pub(crate) output_schema: Option<Map<String, Value>>,
}

/// Answers one interactive request a driver raised on a run; `response` is in the provider's own
/// shape, relayed unchanged.
#[derive(Debug)]
pub(crate) struct RespondToRequestParams {
    /// The run.
    pub(crate) run_id: RunId,
    /// The request.
    pub(crate) request_id: String,
    /// The answer, in the provider's shape.
    pub(crate) response: Box<RawValue>,
}

/// Asks a driver to close one session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CloseSessionParams {
    /// The session.
    pub(crate) session_id: SessionId,
}

/// The provider's own ids of an opened session, built by the driver; the handle is bounded where
/// the daemon stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderSessionHandle {
    /// The provider's session id.
    pub(crate) provider_session_id: String,
    /// The handle a later resume names.
    pub(crate) resume_handle: String,
}

/// The provider version the spawned process printed, never read from a launcher link that may
/// name another build: the text always, and its canonical parse when it parses. Every version
/// runs; nothing refuses on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DriverCliVersionReport {
    /// The version as printed.
    pub(crate) raw_version: String,
    /// Its canonical parse, when it parses.
    pub(crate) parsed_version: Option<String>,
}

/// One spawned-build reading's two binding carriers, read together so a binding row never pairs
/// one install's version with another install's path: what the build reported, and where it ran.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpawnedVersionBindingCarriers {
    /// The version the spawned build reported in-band.
    pub(crate) cli_version: DriverCliVersionReport,
    /// The build's absolute, symlink-resolved path, the one that answered.
    pub(crate) resolved_executable_path: PathBuf,
}

/// How one flag's value was reached on a live reading: probed, or taken from the driver's own
/// table where no probe is admissible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapabilityDetectionSource {
    /// From the driver's own table.
    Static,
    /// By a zero-turn probe whose negative control still refused.
    Probed,
}

/// The driver's capability reading: the flags, the tools as the provider declared them and the
/// version the provider printed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GetCapabilitiesResult {
    /// The flags and contract version.
    pub(crate) capabilities: DriverCapabilities,
    /// The tools as the provider declared them.
    pub(crate) tools: Vec<ProviderToolMetadata>,
    /// The printed provider version; it describes this reading, not a capability, so it is not
    /// part of the stored capability snapshot.
    pub(crate) cli_version: DriverCliVersionReport,
    /// How each flag was reached, for every flag on a live reading; `None` on a reading rebuilt
    /// from the stored cache, which keeps values and not provenance. Never sent to a client.
    pub(crate) detection_source: Option<BTreeMap<DriverCapabilityFlag, CapabilityDetectionSource>>,
    /// The output-speed levels of a driver whose provider lists none per model: present only
    /// when `outputSpeed` is on and the driver declares a fixed set. With neither this nor a
    /// per-model set, a person's request for a level refuses. It survives a cache rebuild.
    pub(crate) output_speed_levels: Option<Vec<ProviderToken>>,
}

/// What a resume did, built by the driver from provider output. A failed resume carries why and
/// no binding, and is never answered by a replacement session under the same run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DriverResumeResult {
    /// The conversation resumed.
    Resumed {
        /// The new binding, stored by the daemon.
        binding_id: RuntimeBindingId,
        /// The driver's monotonic session position (a turn or event ordinal), which the daemon
        /// compares with its recorded one to catch a provider that answered with a fresh session.
        session_position: SafeInt<0>,
        /// The conversation the session runs on now, for the daemon to record: the one it was
        /// given, or a new one where the provider continued the conversation in a new thread.
        resume_handle: NonEmptyText,
        /// The relaunched build's version and path, from the one reading its spawn took; a
        /// relaunch resolves the command again, so the predecessor's build may not be this one.
        spawned_version: SpawnedVersionBindingCarriers,
    },
    /// The resume failed.
    Failed {
        /// What recovery the run needs.
        recovery_condition: RecoveryCondition,
        /// The provider's failure, fitted by [`bound_failure_detail`].
        provider_failure_detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
}

/// Fits failure text to a failure detail: every NUL dropped, ECMAScript whitespace trimmed from
/// both ends, cut to the cap in code points, and `empty_fallback` where nothing is left.
pub(crate) fn bound_failure_detail(
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

/// Params of `move_session_to_fork` (gated on `sessionFork`): fork the conversation at
/// `position` and move the session onto the fork. A run has many bindings, so `binding_id` names
/// the leg, resolved by the daemon at dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MoveSessionToForkParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The driver's monotonic session position to fork at.
    pub(crate) position: SafeInt<0>,
    /// The leg to fork.
    pub(crate) binding_id: RuntimeBindingId,
}

/// What a fork did, built by the driver from provider output. An applied fork has already moved
/// the session's binding onto the new conversation; a fork with no confirmed position cannot be
/// written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MoveSessionToForkResult {
    /// The session moved onto the fork.
    Applied {
        /// The fork's session position.
        session_position: SafeInt<0>,
    },
    /// The driver took a fallback instead.
    Degraded {
        /// The fallback it took.
        fallback_action: Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>,
    },
}

/// What a goal operation did: the provider took it, or the driver took a fallback instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DriverGoalResult {
    /// The provider took it.
    Applied {},
    /// The provider did not take it.
    Degraded {
        /// The fallback the driver took.
        fallback_action: Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>,
    },
}

/// Params of `set_session_goal` (gated on `sessionGoals`): the condition the person typed after
/// `/goal`, for the target agent's live binding. The goal events are the durable truth, so neither
/// goal operation returns the goal, and a resume never sets it again. `run_id` is context only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SetSessionGoalParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The target agent's live binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The run, for context.
    pub(crate) run_id: RunId,
    /// The condition as typed.
    pub(crate) goal_text: String,
}

/// Params of `clear_session_goal` (gated on `sessionGoals`); addresses one live binding.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
pub(crate) struct ClearSessionGoalParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The live binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The run, for context.
    pub(crate) run_id: RunId,
}

/// What an authentication probe found. An indeterminate probe counts as not signed in for
/// admission, yet stays apart from a signed-out one, so a person can tell probe health from
/// credential state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DriverAuthProbeStatus {
    /// Signed in.
    Authenticated,
    /// Signed out.
    Unauthenticated,
    /// The probe could not be read.
    Indeterminate,
}

/// The answer of the zero-turn authentication probe. Admission reads `status`; a turn mid-run whose
/// credential expired is a recovery condition, not this probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DriverAuthProbeResult {
    /// What the probe found.
    pub(crate) status: DriverAuthProbeStatus,
    /// The provider's account or plan descriptor, which can hold an email address: shown to the
    /// person and never stored or carried on an event.
    pub(crate) detail: Option<FreeFormText<PROVIDER_AUTH_DETAIL_MAX_LEN>>,
}

/// A probe's answer with `detail` cut to its cap, and dropped where it is still not valid text,
/// since `status` alone carries the decision.
pub(crate) fn build_auth_probe_result(
    status: DriverAuthProbeStatus,
    detail: &str,
) -> DriverAuthProbeResult {
    // A blank or NUL-holding descriptor is dropped: it only explains the status.
    let detail =
        FreeFormText::new(cut_to_code_points(detail, PROVIDER_AUTH_DETAIL_MAX_LEN).to_owned()).ok();
    DriverAuthProbeResult { status, detail }
}

/// Params of `compact_context` (gated on `contextCompaction`); addresses one binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CompactContextParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
}

/// Params of `list_provider_commands` (gated on `providerCommands`); addresses one binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ListProviderCommandsParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
}

/// The provider-native subagent policy (gated on `subagents`). Provider subagents run inside the
/// session only, so their usage counts against the run and their tool calls go through the same
/// approval pipeline. A `Helpers at once` setting of 0 is `Disabled`, which withholds the
/// provider's helper tool; nothing bounds how deep helpers nest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "policy",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SubagentPolicy {
    /// No helpers.
    Disabled {},
    /// Helpers run.
    Enabled {
        /// How many run at once, or `None` for no limit.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "sidekicks_contracts::wire::present"
        )]
        helpers_at_once: Option<SafeInt<1>>,
        /// The helpers the lead can hand work to.
        definitions: Vec<SubagentDefinition>,
    },
}

/// One helper as each driver maps it onto its provider's own form; the members past `name`,
/// `prompt` and `description` are mapped where the provider supports them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubagentDefinition {
    /// The helper's name.
    pub(crate) name: String,
    /// The helper's own instructions.
    pub(crate) prompt: String,
    /// When the lead should hand work to it.
    pub(crate) description: String,
    /// Its model.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) model: Option<ProviderToken>,
    /// The tools it may use.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) tools: Option<Vec<String>>,
    /// Its reasoning effort.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) effort: Option<ProviderToken>,
    /// How many turns it may take.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) max_turns: Option<SafeInt<1>>,
}

/// One tool server a session can reach, by its name, and whether the person switched it on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionToolServer {
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// Whether the person switched it on.
    pub(crate) is_enabled: bool,
}
