//! The params of the driver operations that act on a whole session rather than one run, and the
//! refusal of a level a provider cannot run: the live permission-level and mode moves, a revoked
//! rule's removal, the commands the daemon answers itself, the side question and the review, the
//! live command list, the move onto a new provider build, and the purge of the provider's own copy
//! of its conversations.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::commands::ProviderCommandListResult;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SessionReviewTarget, SideQuestionId,
};
use sidekicks_contracts::session::id::SessionId;

use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode};
use crate::provider::port::permission_ask::ProviderAskRule;

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

/// `session.permissionLevel.notOffered`: the session's provider, its account or its model cannot
/// run at `level`, so nothing was changed. The level goes out as the refusal's detail.
pub(crate) fn permission_level_unavailable(level: PermissionLevel) -> DomainError {
    DomainError::new(
        "The session's provider cannot run at that permission level.",
        RefusalCode::SessionPermissionLevelUnavailable,
        DomainErrorJsonRpcCode::InvalidParams,
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
/// home it ran in; `provider_account_id` is `None` for one that ran on the node's default home.
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
pub(crate) type ProviderCommandsListener = Arc<dyn Fn(ProviderCommandListResult) + Send + Sync>;
