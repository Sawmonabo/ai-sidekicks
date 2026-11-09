//! The params and results of the driver operations that act on a whole session rather than one
//! run, and the refusal of a level a provider cannot run: the session's opening and its handle, its
//! resume, close and naming, the helper policy and tool servers it opens with, the level and mode a
//! new session starts at, the live permission-level and mode moves, a revoked rule's removal, the
//! session's goal, the commands the daemon answers itself, the side question and the review, the
//! hand-over brief's summary, the live command list, the move onto a fork or a new provider build,
//! the sign-in probe, and the purge of the provider's own copy of its conversations.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::ProviderOptionSetting;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::commands::ProviderCommandListResponse;
use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_FAILURE_DETAIL_MAX_LEN, PROVIDER_FALLBACK_ACTION_MAX_LEN,
};
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_std::text_cut::cut_to_code_points;
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::driver::contract::params_and_results::SpawnedVersionBindingCarriers;
use crate::driver::idle_sleep::KeptSchedule;
use crate::driver::mcp_server::status::McpServerStatusProducer;
use crate::driver::session_control::held_run_continue::HeldRunContinue;

pub mod held_run_continue;
mod subagent_policy;

pub use self::subagent_policy::{SubagentDefinition, SubagentPolicy};

/// The longest account or plan descriptor an authentication probe keeps, in code points; a longer
/// one is cut, and dropping it loses only words, never the probe's status.
const PROVIDER_AUTH_DETAIL_MAX_LEN: usize = 512;

/// What the daemon hands a driver to open a session: its config, its spawn-bound legs and the
/// daemon's callbacks. A spawn-bound leg that gets nothing here launches without it; per-run
/// carriers are on [`StartRunParams`](super::contract::params_and_results::StartRunParams).
#[derive(Clone)]
pub struct CreateSessionParams {
    /// The session.
    pub session_id: SessionId,
    /// The session's lead, which a refusal of the session's model at its start names.
    pub agent_id: AgentId,
    /// The session's config.
    pub config: Map<String, Value>,
    /// The session's model. A provider that takes it at process start applies a usage-credits
    /// prompt's `switchDefault` to this session alone, never to the account's saved default.
    pub model: ProviderToken,
    /// The lead's reasoning effort, which the start refuses `agent.providerAxisInvalid` on the
    /// effort axis when the provider lists the model without that level; `None` checks none.
    pub effort: Option<ProviderToken>,
    /// The larger window chosen for the model, in tokens, as recorded when it was picked; `None`
    /// runs the model's default window. A provider whose model id names the window refuses one.
    pub larger_window: Option<SafeInt<1>>,
    /// How the session may touch the machine.
    pub execution_posture: Option<ExecutionPosture>,
    /// Build or Plan, as the session stores it, which the new provider runs in from its first
    /// turn.
    pub mode: SessionMode,
    /// The agent's accepted output-speed level (gated on `outputSpeed`), sent when the process
    /// starts and never refused: a level the model does not list runs at standard. The provider's
    /// declared state is read through `observed_output_speed_for`, never written back here.
    pub output_speed: Option<ProviderToken>,
    /// The agent's values of the session options its driver declares, sent when the process starts;
    /// an option left out keeps the provider's default. What the provider reports is read through
    /// `observed_options_for`.
    pub options: Vec<ProviderOptionSetting>,
    /// The values set in the app on the rows the driver declares, passed to the process through
    /// the provider's own command-line layer; a row left out follows the provider's own settings.
    pub row_values: ProviderRowValues,
    /// The daemon's callback tools (gated on `callbackTools`); a driver may host them as an
    /// ephemeral tool server, under whose name they then surface.
    pub callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The provider-native subagent policy (gated on `subagents`).
    pub subagent_policy: Option<SubagentPolicy>,
    /// Every tool server the session can reach, each switched on or off by the person (gated on
    /// `mcp`); the driver hands each to the provider as an entry on the daemon's route.
    pub tool_servers: Option<Vec<SessionToolServer>>,
    /// A JSON Schema the final output must meet, for a provider that binds it per session (gated
    /// on `structuredOutput`); one that binds it per turn reads [`StartRunParams::output_schema`].
    ///
    /// [`StartRunParams::output_schema`]:
    ///     super::contract::params_and_results::StartRunParams::output_schema
    pub output_schema: Option<Map<String, Value>>,
    /// The account the leg is admitted against, resolved by the daemon before the spawn. The spawn
    /// path pins the account's credential home, so the driver only carries it.
    pub provider_account_id: ProviderAccountId,
    /// Whether the session follows its provider's current account, `provider_account_id` now, or
    /// stays on that account whatever becomes current.
    pub account_pin: SessionAccountPin,
    /// The MCP server-status sink, bound to this leg's session and binding at spawn, so a driver
    /// cannot report for another leg and needs no id for the census it reports while opening.
    pub on_mcp_server_status: Option<McpServerStatusProducer>,
}

/// Whether a session moves with its provider's current account or stays on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionAccountPin {
    /// It runs on the provider's current account and moves onto each account made current.
    FollowsCurrent,
    /// It stays on the account it was started on, as its agent definition or workflow step names.
    Pinned,
}

/// What the daemon hands a driver to resume a session in a fresh process. A resume is a fresh
/// spawn, so it repeats every spawn-bound leg of [`CreateSessionParams`], rebuilt from the stored
/// spawn record and never from the original request; a leg left out would be shed silently.
#[derive(Clone)]
pub struct ResumeSessionParams {
    /// The session.
    pub session_id: SessionId,
    /// The binding the resumed process runs under, minted by the caller through the binding
    /// store's mint, so its cursor can open before the process delivers.
    pub binding_id: RuntimeBindingId,
    /// The session's lead, which a refusal of the session's model at its start names.
    pub agent_id: AgentId,
    /// The provider's own handle of the conversation.
    pub resume_handle: String,
    /// The session's current model, given by the caller since a later switch moves the session.
    pub model: ProviderToken,
    /// The recorded larger window, sent as recorded whatever the catalog offers now.
    pub larger_window: Option<SafeInt<1>>,
    /// The provider's own recovery data its binding kept, handed back as stored.
    pub runtime_metadata: Map<String, Value>,
    /// Build or Plan, which the resumed provider runs in from its first turn.
    pub mode: SessionMode,
    /// How the session may touch the machine; left out, the leg would relaunch unsandboxed.
    pub execution_posture: Option<ExecutionPosture>,
    /// The agent's accepted output-speed level; left out, the leg would relaunch at the
    /// provider's default.
    pub output_speed: Option<ProviderToken>,
    /// The agent's session option values; an option left out would relaunch at the provider's
    /// default.
    pub options: Vec<ProviderOptionSetting>,
    /// The values set in the app on the driver's rows as they stand now, which a resumed process
    /// starts with.
    pub row_values: ProviderRowValues,
    /// The daemon's callback tools.
    pub callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The provider-native subagent policy.
    pub subagent_policy: Option<SubagentPolicy>,
    /// Every tool server the session can reach.
    pub tool_servers: Option<Vec<SessionToolServer>>,
    /// A JSON Schema the final output must meet.
    pub output_schema: Option<Map<String, Value>>,
    /// The account read back from the stored spawn record, never resolved again, so a live run's
    /// spend never moves onto an account it was not admitted against.
    pub provider_account_id: ProviderAccountId,
    /// The status sink, bound to the resumed leg, through which it reports its census again.
    pub on_mcp_server_status: Option<McpServerStatusProducer>,
    /// The timed fires the idle sleep stored for the session, its wake-ups and session-only
    /// scheduled jobs, which a fresh process does not keep; the resumed process takes them back.
    pub kept_schedules: Vec<KeptSchedule>,
    /// Every run of the session not yet ended, lead and children alike, which the driver answers
    /// for in [`DriverResumeResult::Resumed`]'s `runs`.
    pub live_runs: Vec<LiveRunResume>,
    /// The person's answers a lead the restart held on them now continues with, its continue
    /// claimed for this resume; `None` where nothing is owed. A driver that answers `Resumed` sends
    /// them on the lead's turn and answers that lead `StillRunning`; a lead answered otherwise
    /// has its answers given back for the next resume.
    pub held_run_continue: Option<HeldRunContinue>,
}

/// A run of a resumed session not yet ended, as its log names it to the provider: the run it was
/// started beneath, its open turns, for a provider's helper the helper's own id, whether a pending
/// stop wins over its resume, and the state it stands in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRunResume {
    /// The run.
    pub run_id: RunId,
    /// The run it was started beneath; `None` for a run started on its own.
    pub parent_run_id: Option<RunId>,
    /// Its turns started with no end, in turn order.
    pub open_turns: Vec<OpenTurnResume>,
    /// The provider's own id of the helper the run is, as its `agent.subagent.started` recorded
    /// it; `None` for a lead or any run no helper's start names.
    pub subagent_id: Option<SubagentId>,
    /// The model the helper's start named, as its node keeps it; `None` for a lead or a start
    /// that named none.
    pub model_id: Option<ProviderToken>,
    /// Whether a stop the run waits on, its own or that of the run whose helper it is, wins over
    /// the resume, so no turn of it is continued.
    pub is_stopping: bool,
    /// The state the run stands in as the start reads it.
    pub run_state: RunState,
}

impl LiveRunResume {
    /// Whether the run is a lead: started on its own, and no provider's helper.
    pub fn is_lead(&self) -> bool {
        self.subagent_id.is_none() && self.parent_run_id.is_none()
    }

    /// Whether the run is held on the person, its own ask or question or a helper's beneath it
    /// in `live_runs`, so a resume leaves it waiting; a run with a stop that wins is never held.
    pub fn is_held(&self, live_runs: &[LiveRunResume]) -> bool {
        if self.is_stopping {
            return false;
        }
        match self.run_state {
            RunState::WaitingForApproval | RunState::WaitingForInput => true,
            // A lead's own pause wins over the resume; only a provider's helper waits paused.
            RunState::Pausing | RunState::Paused => self.subagent_id.is_some(),
            RunState::Starting | RunState::Running => live_runs.iter().any(|run| {
                run.subagent_id.is_some()
                    && !run.is_stopping
                    && matches!(
                        run.run_state,
                        RunState::WaitingForApproval
                            | RunState::WaitingForInput
                            | RunState::Pausing
                            | RunState::Paused
                    )
                    && self.is_above(run, live_runs)
            }),
            RunState::Queued
            | RunState::Completed
            | RunState::Interrupted
            | RunState::Stopped
            | RunState::Failed => false,
        }
    }

    /// Whether `run`'s chain of parents through `live_runs` reaches this run, walking at most
    /// once per run so a parent cycle ends the walk.
    pub fn is_above(&self, run: &LiveRunResume, live_runs: &[LiveRunResume]) -> bool {
        let mut parent_run_id = run.parent_run_id;
        for _ in 0..live_runs.len() {
            let Some(parent) = parent_run_id else {
                return false;
            };
            if parent == self.run_id {
                return true;
            }
            parent_run_id = live_runs
                .iter()
                .find(|live_run| live_run.run_id == parent)
                .and_then(|live_run| live_run.parent_run_id);
        }
        false
    }
}

/// A turn of a live run started with no end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenTurnResume {
    /// The turn's number within its run.
    pub turn_number: SafeInt<1>,
    /// The provider's own id of the turn as its `agent.turn.started` recorded it; `None` where
    /// the provider reported none.
    pub provider_turn_id: Option<ProviderTurnId>,
    /// The id of the event that started it, which a flag about the whole turn points at.
    pub started_event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
}

/// A run's turns a restart kept running on the provider, in a session the start does not resume,
/// so the driver ends them there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptRunTurns {
    /// The run.
    pub run_id: RunId,
    /// The provider's own id of the helper the run is, as its `agent.subagent.started` recorded
    /// it; `None` for a lead or any run no helper's start names.
    pub subagent_id: Option<SubagentId>,
    /// The provider's ids of its turns started with no end, in turn order.
    pub turn_ids: Vec<ProviderTurnId>,
    /// Whether a stop of the run's own ends it, so a turn the provider continued under another id
    /// is ended too.
    pub is_for_stop: bool,
}

/// What the daemon hands a driver to end the turns a restart kept in one session the start does
/// not resume.
#[derive(Clone, Debug)]
pub struct EndKeptTurnsParams {
    /// The session.
    pub session_id: SessionId,
    /// The account the session's leg ran on, read back from its stored spawn record.
    pub provider_account_id: ProviderAccountId,
    /// The provider's own handle of the leg's conversation, which a lead's turns run on.
    pub conversation: String,
    /// The provider's own recovery data the leg's binding kept, handed back as stored.
    pub runtime_metadata: Map<String, Value>,
    /// The runs whose turns are ended, each with at least one turn.
    pub runs: Vec<KeptRunTurns>,
    /// The recovery pass's stop, which ends the work where it stands.
    pub stop: CancellationToken,
}

/// The end of the work a driver took to end a session's kept turns, which the daemon waits on
/// before it forgets that the session's turns were left to end.
#[derive(Debug)]
pub struct KeptTurnsEnding(oneshot::Receiver<()>);

impl KeptTurnsEnding {
    /// An ending whose work goes on, with the sender the driver sends on once the work has ended;
    /// a sender dropped unsent reads as the work cut short.
    pub fn waiting() -> (Self, oneshot::Sender<()>) {
        let (sender, receiver) = oneshot::channel();
        (Self(receiver), sender)
    }

    /// An ending with nothing to wait on: the turns ended with the process that ran them.
    pub fn ended_now() -> Self {
        let (ending, sender) = Self::waiting();
        sender
            .send(())
            .expect("the ending holds the receiver it was made with");
        ending
    }

    /// Waits for the work to end: `true` once each interrupt has answered, failed or passed its
    /// deadline, `false` when the stop cut the work first.
    pub async fn ended(self) -> bool {
        self.0.await.is_ok()
    }
}

/// What the provider holds of one run's turn after a resume.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderTurnAnswer {
    /// The turn still runs in the provider's process, which delivers the rest of it.
    StillRunning,
    /// The provider ended the turn; its own end frame arrives through the ordinary dispatch.
    EndedByProvider,
    /// The provider holds no turn of the run.
    Gone,
    /// The run waits on the person: an ask or a question its provider's process no longer holds,
    /// its own or a helper's beneath it; the person's answer continues it.
    Waiting,
}

/// The provider's answer for one run a resume named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumedRunAnswer {
    /// The run.
    pub run_id: RunId,
    /// What the provider holds of its turn.
    pub turn: ProviderTurnAnswer,
}

/// The answer of a resume whose provider runs no turn of any of `live_runs`: every one gone.
pub fn answer_every_run_gone(live_runs: &[LiveRunResume]) -> Vec<ResumedRunAnswer> {
    live_runs
        .iter()
        .map(|run| ResumedRunAnswer {
            run_id: run.run_id,
            turn: ProviderTurnAnswer::Gone,
        })
        .collect()
}

/// Who or what began a session's close, which decides what the close does besides ending the
/// session's process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionCloseCause {
    /// The person closed the session, so it never runs again: the provider's background work
    /// still running for it is stopped first.
    Person,
    /// The daemon closes the process it opened for the session but could not record, so none
    /// runs under a binding with no row.
    UnrecordedOpening,
    /// The daemon stops, and closes every session as it goes.
    DaemonStop,
}

/// Asks a driver to close one session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseSessionParams {
    /// The session.
    pub session_id: SessionId,
    /// Who or what began the close.
    pub cause: SessionCloseCause,
}

/// Asks a driver to settle the tool calls one session held in the background, after a restart of
/// the daemon, while no process of the session runs.
#[derive(Clone, Debug)]
pub struct SettleHeldToolCallsParams {
    /// The session.
    pub session_id: SessionId,
    /// The account the session's leg ran on, read back from its stored spawn record.
    pub provider_account_id: ProviderAccountId,
    /// The provider's own handle of the leg's conversation, which keeps the held calls.
    pub conversation: String,
    /// The provider's own recovery data the leg's binding kept, handed back as stored.
    pub runtime_metadata: Map<String, Value>,
    /// How the session's held calls are settled.
    pub settle: HeldCallsSettle,
}

/// How a session's held tool calls are settled after the daemon's restart or stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeldCallsSettle {
    /// The session is closed: no later resume restores a call, so every one ends, a task still
    /// running on its server stopped first.
    Closed,
    /// The daemon restarted: a later resume may restore a call its record keeps, and one kept
    /// nowhere ends with the restart.
    Restarted,
    /// The person stopped the service: a call kept nowhere ends with the Stop, and one its record
    /// keeps waits for the next resume.
    Stopped,
}

/// Params of `name_session`: the session, where it runs, and its first exchange, the reply cut
/// to [`NAME_SESSION_REPLY_MAX_BYTES`] at a character boundary.
#[derive(Clone, Debug)]
pub struct NameSessionParams {
    /// The session.
    pub session_id: SessionId,
    /// Where the session runs: `None` on macOS and Linux, Windows itself or a WSL 2 distribution
    /// on Windows.
    pub place: Option<Place>,
    /// The person's first message.
    pub first_message: String,
    /// The text of the first completed run's reply, cut.
    pub first_reply: String,
    /// Fires when the pass is no longer wanted: the session was renamed, or the daemon stops.
    pub cancel: CancellationToken,
}

/// Runs a naming pass, `pass`, under a stop that fires with `cancel` or at `deadline`, and awaits
/// the pass to its end either way, so what it started is stopped as a cancel stops it.
pub(crate) async fn run_naming_pass_until<Pass, Named>(
    cancel: &CancellationToken,
    deadline: Instant,
    pass: impl FnOnce(CancellationToken) -> Pass,
) -> Named
where
    Pass: Future<Output = Named>,
{
    let stop = cancel.child_token();
    let pass = pass(stop.clone());
    tokio::pin!(pass);
    tokio::select! {
        named = &mut pass => named,
        () = tokio::time::sleep_until(deadline) => {
            stop.cancel();
            pass.await
        }
    }
}

/// The most of the first reply a naming pass reads, in UTF-8 bytes, as much as a short title
/// needs.
pub const NAME_SESSION_REPLY_MAX_BYTES: usize = 960;

/// Params of `update_permission_level`: the posture the session moves to, composed by the daemon,
/// whose level and writable roots the provider applies from its next request without a relaunch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdatePermissionLevelParams {
    /// The session.
    pub session_id: SessionId,
    /// The posture it moves to.
    pub execution_posture: ExecutionPosture,
    /// True when the move follows a mode the provider itself reported running, which the
    /// provider runs already.
    pub is_provider_reported: bool,
}

/// Params of `revoke_rule`: a revoked rule taken out of force at one session's provider, out of
/// the project's rule file in `project_folder` when one is given, else out of the session's own
/// rules, which the provider reads again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevokeRuleParams {
    /// The session.
    pub session_id: SessionId,
    /// The revoked rule.
    pub rule: ProviderAskRule,
    /// The working folder whose project rule file holds it, for a project rule.
    pub project_folder: Option<PathBuf>,
}

/// What a new session's starting level is read for: the folder it starts in, and the model and
/// account it runs on, which may not run every level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartingLevelParams {
    /// The folder the session starts in, its worktree's root or the project's checkout, absolute.
    pub(crate) working_folder: PathBuf,
    /// The session's model.
    pub(crate) model: ProviderToken,
    /// The account the session runs on, whose own settings the level is read from.
    pub(crate) provider_account_id: ProviderAccountId,
}

impl StartingLevelParams {
    /// The params of a session starting in `working_folder` on `model`, run on
    /// `provider_account_id`.
    pub fn new(
        working_folder: PathBuf,
        model: ProviderToken,
        provider_account_id: ProviderAccountId,
    ) -> Self {
        Self {
            working_folder,
            model,
            provider_account_id,
        }
    }
}

/// The level and mode a new session starts at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartingLevel {
    /// The level.
    pub(crate) level: PermissionLevel,
    /// Plan where the provider itself would start planning, else Build.
    pub(crate) session_mode: SessionMode,
}

impl StartingLevel {
    /// A session starting at `level` in `session_mode`, as a test's driver answers it.
    #[cfg(any(test, feature = "test-support"))]
    pub fn new(level: PermissionLevel, session_mode: SessionMode) -> Self {
        Self {
            level,
            session_mode,
        }
    }

    /// The level.
    pub fn level(&self) -> PermissionLevel {
        self.level
    }

    /// The mode: Plan where the provider itself would start planning, else Build.
    pub fn session_mode(&self) -> SessionMode {
        self.session_mode
    }
}

/// What a goal operation did: the provider took it for the target agent, or it did not and the
/// goal stays as it was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DriverGoalResult {
    /// The provider took the change for the target agent; for a set, a turn works on the goal too:
    /// the one running, or the one the goal starts.
    Applied {},
    /// The provider did not take it, as when Codex answers a set whose turn then never starts
    /// within the turn-start deadline.
    Degraded {
        /// What happened instead, in words, where the driver has any.
        fallback_action: Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>,
    },
}

/// Params of `set_session_goal` (gated on `sessionGoals`): the condition the person typed after
/// `/goal`, carried by the session's lead conversation whether or not its process is live. The goal
/// events are the durable truth, so neither goal operation returns the goal, and a resume never
/// sets it again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetSessionGoalParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The condition as typed.
    pub(crate) goal_text: String,
}

impl SetSessionGoalParams {
    /// The params of setting `goal_text` on `session_id`'s lead conversation.
    pub fn new(session_id: SessionId, goal_text: String) -> Self {
        Self {
            session_id,
            goal_text,
        }
    }
}

/// Params of `clear_session_goal` (gated on `sessionGoals`): the session whose lead conversation
/// drops its goal, whether or not its process is live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClearSessionGoalParams {
    /// The session.
    pub(crate) session_id: SessionId,
}

impl ClearSessionGoalParams {
    /// The params of clearing the goal on `session_id`'s lead conversation.
    pub fn new(session_id: SessionId) -> Self {
        Self { session_id }
    }
}

/// `session.permissionLevel.notOffered`: the session's provider, its account or its model cannot
/// run at `level`, so nothing was changed. The level goes out as the refusal's detail.
pub(crate) fn permission_level_not_offered(level: PermissionLevel) -> DomainError {
    DomainError::new(
        "The session's provider cannot run at that permission level.",
        RefusalCode::SessionPermissionLevelNotOffered,
    )
    .with_detail(json!({ "level": level }))
}

/// The provider build a driver's sessions move from and to, as each build printed its version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderBuildChange {
    /// The version the sessions ran on.
    pub(crate) from_version: String,
    /// The version they move to.
    pub(crate) to_version: String,
}

/// One provider conversation a session opened, by handle and account, and the recovery data kept
/// with it, which names the home holding it where the provider keeps that apart from the account's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionConversation {
    /// The handle the conversation was resumed from.
    pub resume_handle: String,
    /// The account it ran on.
    pub provider_account_id: ProviderAccountId,
    /// The provider's own recovery data, its binding's or, for a conversation the session left, the
    /// leg's it was left from, handed over as stored.
    pub runtime_metadata: Map<String, Value>,
}

/// Params of `purge_session`: every conversation the session ran on, its bindings' and the ones it
/// left, newest first, so a fork comes before the one it was forked from. A conversation the
/// person started in a terminal is never one of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurgeSessionParams {
    /// The session.
    pub session_id: SessionId,
    /// Its conversations, newest first.
    pub conversations: Vec<SessionConversation>,
}

/// Params of `update_session_mode`: Build or Plan, applied by the provider from the next turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateSessionModeParams {
    /// The session.
    pub session_id: SessionId,
    /// The mode it moves to.
    pub mode: SessionMode,
    /// True when the move follows a mode the provider itself reported running, which the
    /// provider runs already.
    pub is_provider_reported: bool,
}

/// Params of `ask_side_question`: a question asked on a throwaway copy of the conversation,
/// leaving the session's own conversation and permissions as they were. Its answer is appended as
/// `session.sideQuestion.answered` under `side_question_id`.
#[derive(Clone)]
pub struct AskSideQuestionParams {
    /// The session.
    pub session_id: SessionId,
    /// The session's binding, which the side question's usage is recorded on.
    pub binding_id: RuntimeBindingId,
    /// The id the answer carries.
    pub side_question_id: SideQuestionId,
    /// The question.
    pub question: String,
    /// The session's newest resume material, composed as a resume's is, which the copy is forked
    /// from when no live process runs the session; `None` for a session with no conversation yet.
    pub resume: Option<ResumeSessionParams>,
}

/// Params of `export_handover_brief`: the session's summary taken on a throwaway copy of its
/// conversation, leaving the session's own conversation as it was.
#[derive(Clone)]
pub struct ExportHandoverBriefParams {
    /// The session.
    pub session_id: SessionId,
    /// The session's binding, which the copy's usage is recorded on.
    pub binding_id: RuntimeBindingId,
    /// The session's newest resume material, composed as a resume's is, which the copy is forked
    /// from where the driver forks the stored conversation.
    pub resume: ResumeSessionParams,
}

/// Which summary a hand-over brief carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoverSummaryKind {
    /// The provider's own summary of the conversation, its own framing taken out.
    ProviderSummary,
    /// The copy's answer to the fixed template.
    Template,
}

/// What `export_handover_brief` answers: the summary, which kind it is, and what it could not
/// carry. It is never the brief's message, which the daemon composes around it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DriverHandoverBriefResult {
    /// The summary's text, never blank.
    pub summary: String,
    /// Which summary it is.
    pub kind: HandoverSummaryKind,
    /// What the summary could not carry, never empty.
    pub declared_losses: Vec<DeclaredLossKind>,
}

impl DriverHandoverBriefResult {
    /// `summary` as a brief's summary of `kind`, declaring the conversation summarized and the
    /// provider's private reasoning left behind, which no summary carries.
    pub(crate) fn summarized(summary: String, kind: HandoverSummaryKind) -> Self {
        Self {
            summary,
            kind,
            declared_losses: vec![
                DeclaredLossKind::ProviderPrivateReasoning,
                DeclaredLossKind::ConversationHistorySummarized,
            ],
        }
    }
}

/// Params of `answer_session_command`: the text the person sent, before any run is made for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnswerSessionCommandParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The text as typed.
    pub(crate) text: String,
}

/// What `answer_session_command` did with the text: it goes to the provider as typed, or the
/// daemon answered it for the session alone, with no run and no row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionCommandAnswer {
    /// The text goes to the provider as typed.
    NotAnswered {},
    /// The daemon answered it.
    Answered {
        /// The one line shown beside the message box, or `None` for a `/config` key whose console
        /// control the composer presses, which adds no line of its own.
        line: Option<String>,
    },
}

/// Params of `subscribe_provider_commands`: the session whose live command list is followed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubscribeProviderCommandsParams {
    /// The session.
    pub session_id: SessionId,
}

/// Receives each new command list a session's provider and its tool servers offer.
pub(crate) type ProviderCommandsListener = Arc<dyn Fn(ProviderCommandListResponse) + Send + Sync>;

/// The provider's own ids of an opened session, built by the driver; the handle is bounded where
/// the daemon stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSessionHandle {
    /// The provider's session id.
    pub provider_session_id: String,
    /// The handle a later resume names.
    pub resume_handle: String,
    /// The build the session's own process reported when the create started it, which the
    /// binding records.
    pub spawned_version: SpawnedVersionBindingCarriers,
}

/// What a resume did, built by the driver from provider output. A failed resume carries why and
/// no binding, and is never answered by a replacement session under the same run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DriverResumeResult {
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
        /// What the provider holds of each run the resume's `live_runs` named.
        runs: Vec<ResumedRunAnswer>,
    },
    /// The resume failed.
    Failed {
        /// What recovery the run needs.
        recovery_condition: RecoveryCondition,
        /// The provider's failure, fitted by
        /// [`bound_failure_detail`](super::contract::error::bound_failure_detail).
        provider_failure_detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
    /// No process was started, since every run in progress waits on the person, is pausing, or
    /// stops: what the provider answered for each run, with no binding, position or build.
    Deferred {
        /// What the provider holds of each run the resume's `live_runs` named.
        runs: Vec<ResumedRunAnswer>,
    },
}

/// Params of `move_session_to_fork` (gated on `sessionFork`): fork the conversation at
/// `position` and move the session onto the fork. A run has many bindings, so `binding_id` names
/// the leg, resolved by the daemon at dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MoveSessionToForkParams {
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
pub enum MoveSessionToForkResult {
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
pub struct DriverAuthProbeResult {
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

/// One tool server a session can reach, by its binding, and whether the person switched it on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionToolServer {
    /// The server's scope-qualified binding.
    pub binding: McpServerBindingRef,
    /// Whether the person switched it on.
    pub is_enabled: bool,
}
