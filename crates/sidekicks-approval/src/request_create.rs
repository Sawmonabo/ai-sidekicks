//! The daemon's own call that raises an ask: what the permission-ask intake, a daemon-hosted tool
//! and a workflow's command step hand the approval service. No client calls it and no method
//! registers it, so its types are the daemon's alone. The request carries no deadline, since an
//! ask waits until it is answered, and no provider ask id, which only the daemon mints, so a forged
//! pairing cannot route another ask's answer.

use serde::{Deserialize, Serialize};
use sidekicks_contracts::approval::{ApprovalCategory, ApprovalScope};
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};

use sidekicks_provider::port::permission_ask::ProviderAskAction;

/// What an ask is about, kept as the request row's descriptor and drawn by the card; it holds only
/// these members. `subject` is the words the standing allow names, derived when the ask is raised:
/// a command's program and first subcommand, a network request's host, a written file's name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalResourceDescriptor {
    /// The words the standing allow names.
    pub(crate) subject: FreeFormText<FILE_PATH_MAX_LEN>,
    /// False on an ask that may not carry a standing allow, such as input to a running command.
    pub(crate) standing_allow_offered: bool,
    /// False where the provider keeps no project rule for the ask; the project scope is offered
    /// only where this and the standing allow both are.
    pub(crate) project_scope_offered: bool,
    /// Whether the person may correct the command or path before approving it.
    pub(crate) editable: bool,
    /// What the provider's held call would do, whole, which the card shows and a rule names the
    /// kind of.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) action: Option<ProviderAskAction>,
    /// The tool the ask holds a call of.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) tool_name: Option<NonEmptyText>,
    /// The provider's own line saying why it stopped.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) prompt: Option<NonEmptyText>,
}

impl ApprovalResourceDescriptor {
    /// The descriptor as the `approval.requested` event and the card carry it, a record of its
    /// members.
    pub(crate) fn to_record(&self) -> JsonRecord {
        let members = serde_json::to_value(self)
            .expect("a descriptor of text, flags and string-keyed members always serializes");
        serde_json::from_value(members)
            .expect("a descriptor serializes to an object with no member __proto__")
    }
}

impl TryFrom<&JsonRecord> for ApprovalResourceDescriptor {
    type Error = serde_json::Error;

    /// Reads the descriptor back from the record an `approval.requested` event carries; fails for
    /// a record that holds another member or breaks a member's rule.
    fn try_from(record: &JsonRecord) -> Result<Self, Self::Error> {
        serde_json::to_value(record).and_then(serde_json::from_value)
    }
}

/// One ask to raise for a person's answer; the approval service's create takes it and answers the
/// new ask's `ApprovalRequestId`, pending until it is answered or canceled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApprovalRequestCreateRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// The agent's actor id, or the device a person's request came from.
    pub(crate) requested_by: NonEmptyText,
    /// What the ask is about.
    pub(crate) category: ApprovalCategory,
    /// The target as free text, such as a command or a path.
    pub(crate) scope: ApprovalScope,
    /// What the card draws.
    pub(crate) resource_descriptor: ApprovalResourceDescriptor,
}

/// What only the daemon knows about where an ask came from, passed beside the request and never in
/// it: the daemon's own id of the provider ask it was minted for, and the tool call the ask holds,
/// whose row draws its held mark. A card the daemon raises itself carries neither.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ApprovalRequestOrigin {
    /// The daemon's own id of the provider ask.
    pub(crate) ask_id: Option<NonEmptyText>,
    /// The tool call the ask holds.
    pub(crate) tool_call_id: Option<ToolCallId>,
}
