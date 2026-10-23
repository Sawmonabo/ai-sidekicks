//! Where a driver hands a provider's permission ask once the run engine admitted it, so the
//! approval pipeline asks the person and answers through the driver's `respond_to_request`.

use std::error::Error;
use std::path::PathBuf;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sidekicks_contracts::approval::{ApprovalRequestId, RememberedRuleSense, RememberedScopeKind};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use strum::{EnumDiscriminants, IntoStaticStr};

/// What the held call would do, read by the driver from its provider's own ask: run a command,
/// send input to the running command the ask's tool call names, change files, read one file or
/// folder, reach a host, or call a tool none of those covers. Its kind without the subject, as a
/// standing rule names it, is [`ProviderAskActionKind`], spelled as the approval store writes it;
/// the store keeps the whole action as JSON tagged by its `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, EnumDiscriminants)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[strum_discriminants(
    name(ProviderAskActionKind),
    doc = "The kind of action a held call would take, without its subject, as a standing rule \
           names it.",
    derive(IntoStaticStr, Hash),
    strum(serialize_all = "camelCase")
)]
pub(crate) enum ProviderAskAction {
    /// Run a command.
    Command {
        /// The command line.
        command: String,
    },
    /// Send input to the running command the ask's tool call names.
    CommandInput {
        /// The input.
        input: String,
    },
    /// Change files.
    FileChange {
        /// The files changed.
        paths: Vec<String>,
    },
    /// Read one file or folder.
    FileRead {
        /// The file or folder.
        path: String,
    },
    /// Reach a host.
    Network {
        /// The host.
        host: String,
    },
    /// Call a tool none of the others covers.
    Tool {
        /// The tool's name.
        tool_name: String,
    },
}

impl ProviderAskAction {
    /// The line a command action runs, which is read before a rule's subject is derived from it;
    /// `None` for any other action.
    pub(crate) fn command_line(&self) -> Option<&str> {
        match self {
            Self::Command { command } => Some(command),
            Self::CommandInput { .. }
            | Self::FileChange { .. }
            | Self::FileRead { .. }
            | Self::Network { .. }
            | Self::Tool { .. } => None,
        }
    }

    /// The command or path a person may correct before approving the action, and which an ask
    /// carrying out a correction must name exactly: a command, a read's path, or a change's one
    /// path; `None` for any other action, which takes no correction.
    pub(crate) fn corrected_subject(&self) -> Option<&str> {
        match self {
            Self::Command { command } => Some(command),
            Self::FileRead { path } => Some(path),
            Self::FileChange { paths } => match paths.as_slice() {
                [only] => Some(only),
                [] | [_, _, ..] => None,
            },
            Self::CommandInput { .. } | Self::Network { .. } | Self::Tool { .. } => None,
        }
    }
}

/// One ask a provider holds a tool call on: the tool, its input as the provider sent it, the
/// provider's own request id the answer goes back under, and its prompt where it sent one.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderPermissionAsk {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run that asks.
    pub(crate) run_id: RunId,
    /// The provider's own request id.
    pub(crate) request_id: String,
    /// The tool the call is to.
    pub(crate) tool_name: String,
    /// The call's input as the provider sent it.
    pub(crate) input: Value,
    /// What the call would do, which the card shows and a rule names.
    pub(crate) action: ProviderAskAction,
    /// The scopes a standing rule on this ask may take, none where the provider keeps no rule for
    /// it (a running command's input) and no `project` where it has no project rule file for its
    /// kind.
    pub(crate) rule_scopes: Vec<RememberedScopeKind>,
    /// Whether the provider's own safety check flagged the call and offers no standing allow on
    /// it, so no rule in force answers it.
    pub(crate) is_provider_flagged: bool,
    /// Whether an ask rule the session's level adds sent the ask rather than the provider's own
    /// check or the person's rules (a removal command at Reviewed its check did not flag); the
    /// level answers such an ask itself.
    pub(crate) is_sent_by_level_rule: bool,
    /// The held tool call's id, where the provider sent one.
    pub(crate) tool_call_id: Option<String>,
    /// The provider's prompt, where it sent one.
    pub(crate) prompt: Option<String>,
    /// The approved card whose corrected command or path this ask carries out, named by a driver
    /// whose provider takes no corrected input back and asks for the corrected one instead.
    pub(crate) correction_of: Option<ApprovalRequestId>,
}

/// An ask the provider withdrew before anyone answered it, by the request id it was taken under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderPermissionAskWithdrawal {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The provider's own request id.
    pub(crate) request_id: String,
}

/// A standing rule the provider keeps: an allow made on an approval or a host's block made on a
/// network decline, for the session or in the project's own rule file. `subject` is the words the
/// card named, of the kind of action the ask was: a command's program and first subcommand, a
/// file's path, a host, or a tool's name.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ProviderAskRule {
    /// The rule's reach.
    pub(crate) kind: RememberedScopeKind,
    /// Whether it allows or blocks.
    pub(crate) sense: RememberedRuleSense,
    /// The kind of action it covers.
    pub(crate) action: ProviderAskActionKind,
    /// The words the card named.
    pub(crate) subject: String,
}

/// The rule an answer made, with the folders a project rule is written into: every live working
/// folder of the project, each worktree's own; none for a session rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderAnswerRule {
    /// The rule.
    pub(crate) rule: ProviderAskRule,
    /// The folders a project rule is written into.
    pub(crate) project_folders: Vec<PathBuf>,
}

/// The command or path as the person corrected it, and the card they approved it on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderAnswerCorrection {
    /// The corrected command or path.
    pub(crate) edited_action: String,
    /// The card it was approved on.
    pub(crate) approval_request_id: ApprovalRequestId,
}

/// The approval pipeline's answer to one permission ask, which each driver turns into its
/// provider's own: an allow, with the command or path as the person corrected it, or a refusal,
/// with the decline's typed reason. Either may carry the rule its answer made, and an allow the
/// rule in force that answered it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProviderPermissionAnswer {
    /// The call may go on.
    Allow {
        /// The command or path as the person corrected it.
        correction: Option<ProviderAnswerCorrection>,
        /// The rule the answer made.
        made_rule: Option<ProviderAnswerRule>,
        /// The rule in force that answered the ask.
        answered_by_rule: Option<ProviderAskRule>,
    },
    /// The call is refused.
    Refuse {
        /// The decline's reason.
        reason: Option<String>,
        /// The rule the answer made.
        made_rule: Option<ProviderAnswerRule>,
    },
}

/// A driver's failure once the decision reached its provider but the rule the answer made could
/// not be kept there; the call is answered and nothing is held.
#[derive(Debug, thiserror::Error)]
#[error("the answer reached the provider, but the rule it made could not be kept there")]
pub(crate) struct ProviderRuleNotKeptError {
    /// Why the rule could not be kept.
    #[source]
    pub(crate) source: Box<dyn Error + Send + Sync>,
}

/// The approval pipeline's intake of admitted asks, registered through a `PortRegistration`. The
/// answer comes later, through the driver's `respond_to_request` with a
/// [`ProviderPermissionAnswer`]. Until it is registered, an admitted ask stays pending at the
/// provider: nothing answers it.
pub(crate) trait PermissionAskPort: Send + Sync {
    /// Records `ask`. An error when it could not be recorded.
    fn take_ask(
        &self,
        ask: ProviderPermissionAsk,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Settles a withdrawn ask's card canceled; an answered one keeps its answer. An error when it
    /// could not be settled.
    fn withdraw_ask(
        &self,
        withdrawal: ProviderPermissionAskWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
