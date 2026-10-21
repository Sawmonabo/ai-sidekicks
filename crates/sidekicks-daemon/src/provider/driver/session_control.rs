//! The params of the driver operations that act on a whole session rather than one run, and the
//! refusal of a level a provider cannot run: the session's opening, resume, close and naming, the
//! level and mode a new session starts at, the live permission-level and mode moves, a revoked
//! rule's removal, the session's goal, the commands the daemon answers itself, the side question
//! and the review, the live command list, the move onto a new provider build, and the purge of the
//! provider's own copy of its conversations.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::ProviderOptionSetting;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::commands::ProviderCommandListResponse;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FALLBACK_ACTION_MAX_LEN;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SessionReviewTarget, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio_util::sync::CancellationToken;

use crate::ipc::domain_error::DomainError;
use crate::provider::driver::callback_tool::CallbackToolDispatcher;
use crate::provider::driver::contract::{SessionToolServer, SubagentPolicy};
use crate::provider::driver::mcp_server_status::McpServerStatusProducer;
use crate::provider::port::permission_ask::ProviderAskRule;

/// What the daemon hands a driver to open a session: its config, its spawn-bound legs and the
/// daemon's callbacks. A spawn-bound leg that gets nothing here launches without it; per-run
/// carriers are on [`StartRunParams`](super::contract::StartRunParams).
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
    /// on `structuredOutput`); one that binds it per turn reads
    /// [`StartRunParams::output_schema`](super::contract::StartRunParams::output_schema).
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

/// Asks a driver to close one session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CloseSessionParams {
    /// The session.
    pub(crate) session_id: SessionId,
}

/// Params of `name_session`: the session, where it runs, and its first exchange, the reply cut
/// to [`NAME_SESSION_REPLY_MAX_BYTES`] at a character boundary.
#[derive(Clone, Debug)]
pub(crate) struct NameSessionParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Where the session runs: `None` on macOS and Linux, Windows itself or a WSL 2 distribution
    /// on Windows.
    pub(crate) place: Option<Place>,
    /// The person's first message.
    pub(crate) first_message: String,
    /// The text of the first completed run's reply, cut.
    pub(crate) first_reply: String,
    /// Fires when the pass is no longer wanted: the session was renamed, or the daemon stops.
    pub(crate) cancel: CancellationToken,
}

/// The most of the first reply a naming pass reads, in UTF-8 bytes, as much as a short title
/// needs.
pub(crate) const NAME_SESSION_REPLY_MAX_BYTES: usize = 960;

/// Params of `update_permission_level`: the level the session moves to and the roots it opens to
/// writes, applied by the provider from its next request without a relaunch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UpdatePermissionLevelParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The level it moves to.
    pub(crate) level: PermissionLevel,
    /// The roots the level opens to writes.
    pub(crate) writable_roots: Vec<PathBuf>,
}

/// Params of `revoke_rule`: a revoked rule taken out of force at one session's provider, out of
/// the project's rule file in `project_folder` when one is given, else out of the session's own
/// rules, which the provider reads again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RevokeRuleParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The revoked rule.
    pub(crate) rule: ProviderAskRule,
    /// The working folder whose project rule file holds it, for a project rule.
    pub(crate) project_folder: Option<PathBuf>,
}

/// What a new session's starting level is read for: the folder it starts in, and the model and
/// account it runs on, which may not run every level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StartingLevelParams {
    /// The folder the session starts in, its worktree's root or the project's checkout, absolute.
    pub(crate) working_folder: PathBuf,
    /// The session's model.
    pub(crate) model: ProviderToken,
    /// The account the session runs on; `None` on the person's own sign-in.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

/// The level and mode a new session starts at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StartingLevel {
    /// The level.
    pub(crate) level: PermissionLevel,
    /// Plan where the provider itself would start planning, else Build.
    pub(crate) session_mode: SessionMode,
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
pub(crate) struct ProviderBuildChange {
    /// The version the sessions ran on.
    pub(crate) from_version: String,
    /// The version they move to.
    pub(crate) to_version: String,
}

/// One provider conversation a session opened, by the handle it was resumed from, and the account
/// home it ran in; `provider_account_id` is `None` for one that ran on the machine's default home.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PurgedConversation {
    /// The handle the conversation was resumed from.
    pub(crate) resume_handle: String,
    /// The account whose home it ran in.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

/// Params of `purge_session`: every conversation the session's own bindings opened, newest first,
/// so a fork comes before the conversation it was forked from. A conversation the person started
/// in a terminal is never one of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PurgeSessionParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Its conversations, newest first.
    pub(crate) conversations: Vec<PurgedConversation>,
}

/// Params of `update_session_mode`: Build or Plan, applied by the provider from the next turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UpdateSessionModeParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The mode it moves to.
    pub(crate) mode: SessionMode,
}

/// Params of `ask_side_question`: a question asked on a throwaway copy of the conversation,
/// leaving the session's own conversation and permissions as they were. Its answer is appended as
/// `session.sideQuestion.answered` under `side_question_id`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AskSideQuestionParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The id the answer carries.
    pub(crate) side_question_id: SideQuestionId,
    /// The question.
    pub(crate) question: String,
}

/// Params of `start_review`: the provider's own review of `target`, bracketed by the
/// `reviewStarted` and `reviewFinished` notices.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StartReviewParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// What the review covers.
    pub(crate) target: SessionReviewTarget,
}

/// Params of `answer_session_command`: the text the person sent, before any run is made for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AnswerSessionCommandParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The text as typed.
    pub(crate) text: String,
}

/// What `answer_session_command` did with the text: it goes to the provider as typed, or the
/// daemon answered it for the session alone, with no run and no row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionCommandAnswer {
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
pub(crate) struct SubscribeProviderCommandsParams {
    /// The session.
    pub(crate) session_id: SessionId,
}

/// Receives each new command list a session's provider and its tool servers offer.
pub(crate) type ProviderCommandsListener = Arc<dyn Fn(ProviderCommandListResponse) + Send + Sync>;
