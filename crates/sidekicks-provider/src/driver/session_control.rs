//! The params and results of the driver operations that act on a whole session rather than one
//! run, and the refusal of a level a provider cannot run: the session's opening and its handle, its
//! resume, close and naming, the helper policy and tool servers it opens with, the level and mode a
//! new session starts at, the live permission-level and mode moves, a revoked rule's removal, the
//! session's goal, the commands the daemon answers itself, the side question and the review, the
//! live command list, the move onto a fork or a new provider build, the sign-in probe, and the
//! purge of the provider's own copy of its conversations.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::ProviderOptionSetting;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::commands::ProviderCommandListResponse;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_FAILURE_DETAIL_MAX_LEN, PROVIDER_FALLBACK_ACTION_MAX_LEN,
};
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SessionReviewTarget, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_std::text_cut::cut_to_code_points;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::driver::contract::SpawnedVersionBindingCarriers;
use crate::driver::mcp_server_status::McpServerStatusProducer;

/// The longest account or plan descriptor an authentication probe keeps, in code points; a longer
/// one is cut, and dropping it loses only words, never the probe's status.
const PROVIDER_AUTH_DETAIL_MAX_LEN: usize = 512;

/// What the daemon hands a driver to open a session: its config, its spawn-bound legs and the
/// daemon's callbacks. A spawn-bound leg that gets nothing here launches without it; per-run
/// carriers are on [`StartRunParams`](super::contract::StartRunParams).
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
    /// The larger window chosen for the model, in tokens, as recorded when it was picked; `None`
    /// runs the model's default window. A provider whose model id names the window refuses one.
    pub larger_window: Option<SafeInt<1>>,
    /// How the session may touch the machine.
    pub execution_posture: Option<ExecutionPosture>,
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
    /// on `structuredOutput`); one that binds it per turn reads
    /// [`StartRunParams::output_schema`](super::contract::StartRunParams::output_schema).
    pub output_schema: Option<Map<String, Value>>,
    /// The account the leg is admitted against, resolved by the daemon; `None` spawns on the
    /// machine's default for the provider. The spawn path pins the account's credential home, so
    /// the driver only carries it.
    pub provider_account_id: Option<ProviderAccountId>,
    /// The MCP server-status sink, bound to this leg's session and binding at spawn, so a driver
    /// cannot report for another leg and needs no id for the census it reports while opening.
    pub on_mcp_server_status: Option<McpServerStatusProducer>,
}

/// What the daemon hands a driver to resume a session in a fresh process. A resume is a fresh
/// spawn, so it repeats every spawn-bound leg of [`CreateSessionParams`], rebuilt from the stored
/// spawn record and never from the original request; a leg left out would be shed silently.
#[derive(Clone)]
pub struct ResumeSessionParams {
    /// The session.
    pub session_id: SessionId,
    /// The session's lead, which a refusal of the session's model at its start names.
    pub agent_id: AgentId,
    /// The provider's own handle of the conversation.
    pub resume_handle: String,
    /// The session's current model, given by the caller since a later switch moves the session.
    pub model: ProviderToken,
    /// The recorded larger window, sent as recorded whatever the catalog offers now.
    pub larger_window: Option<SafeInt<1>>,
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
    pub provider_account_id: Option<ProviderAccountId>,
    /// The status sink, bound to the resumed leg, through which it reports its census again.
    pub on_mcp_server_status: Option<McpServerStatusProducer>,
}

/// Asks a driver to close one session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseSessionParams {
    /// The session.
    pub session_id: SessionId,
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
    /// The account the session runs on; `None` on the person's own sign-in.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

/// The level and mode a new session starts at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartingLevel {
    /// The level.
    pub(crate) level: PermissionLevel,
    /// Plan where the provider itself would start planning, else Build.
    pub(crate) session_mode: SessionMode,
}

/// What a goal operation did: the provider took it, or the driver took a fallback instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DriverGoalResult {
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
pub struct SetSessionGoalParams {
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
pub struct ClearSessionGoalParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The live binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The run, for context.
    pub(crate) run_id: RunId,
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

/// One provider conversation a session opened, by the handle it was resumed from, and the account
/// home it ran in; `provider_account_id` is `None` for one that ran on the machine's default home.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurgedConversation {
    /// The handle the conversation was resumed from.
    pub resume_handle: String,
    /// The account whose home it ran in.
    pub provider_account_id: Option<ProviderAccountId>,
}

/// Params of `purge_session`: every conversation the session's own bindings opened, newest first,
/// so a fork comes before the conversation it was forked from. A conversation the person started
/// in a terminal is never one of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurgeSessionParams {
    /// The session.
    pub session_id: SessionId,
    /// Its conversations, newest first.
    pub conversations: Vec<PurgedConversation>,
}

/// Params of `update_session_mode`: Build or Plan, applied by the provider from the next turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateSessionModeParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The mode it moves to.
    pub(crate) mode: SessionMode,
}

/// Params of `ask_side_question`: a question asked on a throwaway copy of the conversation,
/// leaving the session's own conversation and permissions as they were. Its answer is appended as
/// `session.sideQuestion.answered` under `side_question_id`.
#[derive(Clone)]
pub struct AskSideQuestionParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The id the answer carries.
    pub(crate) side_question_id: SideQuestionId,
    /// The question.
    pub(crate) question: String,
    /// The session's resume material when it has no live process, composed as a resume's is, which
    /// the copy is forked from; `None` while a process runs it.
    pub(crate) resume: Option<ResumeSessionParams>,
}

/// Params of `start_review`: the provider's own review of `target`, bracketed by the
/// `reviewStarted` and `reviewFinished` notices.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartReviewParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// What the review covers.
    pub(crate) target: SessionReviewTarget,
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
    pub(crate) session_id: SessionId,
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
    },
    /// The resume failed.
    Failed {
        /// What recovery the run needs.
        recovery_condition: RecoveryCondition,
        /// The provider's failure, fitted by
        /// [`bound_failure_detail`](super::contract::bound_failure_detail).
        provider_failure_detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
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
pub enum SubagentPolicy {
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
pub struct SubagentDefinition {
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
pub struct SessionToolServer {
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// Whether the person switched it on.
    pub(crate) is_enabled: bool,
}
