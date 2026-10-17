//! The payloads of a session's own events: its creation, its lifecycle moves, its renames, its
//! marks, its advisor, its output style and its provider's status.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentDefinitionId;
use crate::agent::methods::AgentListEntry;
use crate::event::envelope::{
    SourceEpoch, SourcePosition, check_epoch_stamp, epoch_stamp_dependent_required,
};
use crate::machine_settings::MACHINE_SETTINGS_NAME_MAX_LEN;
use crate::place::Place;
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::DRIVER_WIRE_TOKEN_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::run::id::RunId;
use crate::session::event_cursor::EventCursor;
use crate::session::id::{SessionId, UserId};
use crate::session::methods::{SessionShape, SessionState};
use crate::session::name::SESSION_NAME_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::text::FreeFormText;

/// The session a fork was taken from, and the message it was taken at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCreatedParent {
    /// The session forked from.
    pub session_id: SessionId,
    /// The message the fork was taken at.
    pub anchor_cursor: EventCursor,
}

/// A session's birth, bringing in its lead as `main_agent`. `parent` is present exactly on a fork,
/// `scratch_for_definition_id` names the saved definition a scratch session tries, and `place` is
/// where the session runs for its whole life.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionCreatedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The session's shape.
    pub shape: SessionShape,
    /// The session's lead.
    #[garde(dive)]
    pub main_agent: AgentListEntry,
    /// The session forked from, on a fork.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionCreatedParent")]
    pub parent: Option<SessionCreatedParent>,
    /// The saved definition a scratch session tries.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentDefinitionId")]
    pub scratch_for_definition_id: Option<AgentDefinitionId>,
    /// The person who created it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UserId")]
    pub actor: Option<UserId>,
    /// Where it runs, written here once and never changed; absent on macOS and Linux.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
}

/// The payload of a lifecycle move (`session.activated`, `session.archived`,
/// `session.reactivated`, `session.closed`), naming the state the session left and the one it is
/// in. `actor` is the person who acted, absent when the daemon moved it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLifecycleChangePayload {
    /// The session.
    pub session_id: SessionId,
    /// The state it left, where it had one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionState")]
    pub previous_state: Option<SessionState>,
    /// The state it is in.
    pub new_state: SessionState,
    /// The person who acted, absent when the daemon moved it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UserId")]
    pub actor: Option<UserId>,
}

/// Who a rename came from: the person (`user`), the provider renaming its own conversation
/// (`provider`), or the daemon's naming pass after the first exchange (`auto`), which writes only
/// while the session is unnamed, so a name the person typed always wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionRenameOrigin {
    /// The person.
    User,
    /// The provider, renaming its own conversation.
    Provider,
    /// The daemon's naming pass.
    Auto,
}

/// The `session.renamed` payload: the new name, `null` when the name was cleared, the name it
/// replaced where there was one, and who renamed it. A rename to the current name writes no event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRenamedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The new name, or `null` when it was cleared.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<FreeFormText<SESSION_NAME_MAX_LEN>>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// The name it replaced, where there was one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub previous_name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Who renamed it.
    pub origin: SessionRenameOrigin,
    /// The person who renamed it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UserId")]
    pub actor: Option<UserId>,
}

/// The payload of a session mark set or cleared (`session.pinned`, `session.unpinned`,
/// `session.muted`, `session.unmuted`) with the time it happened. Pinned rows sit in the order they
/// were pinned, and a mute stands until it is cleared: both are rebuilt from these events.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionMarkChangePayload {
    /// The session.
    pub session_id: SessionId,
    /// When it happened.
    #[garde(dive)]
    pub at: WireInstant,
}

/// The `session.advisor.changed` payload: the session's own advisor, changed by the provider's own
/// advisor command in that session. `advisor_model` is the session's own setting, `null` when the
/// advisor is off; `attached_advisor_model` is the advisor the provider says it attaches after the
/// change, `null` when none attaches, absent where the build does not report it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAdvisorChangedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The session's own advisor setting, or `null` when the advisor is off.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>")]
    pub advisor_model: Option<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>,
    /// The advisor the provider attaches, `null` when none, absent where the build does not say.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[schemars(with = "crate::wire::NullableSchema<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>")]
    pub attached_advisor_model: Option<Option<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>>,
    /// When it happened.
    #[garde(dive)]
    pub at: WireInstant,
}

/// The `session.outputStyle.changed` payload: the session's own output style, changed by the
/// provider's own output-style command in that session, with the time it happened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionOutputStyleChangedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The output style.
    pub output_style: FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>,
    /// When it happened.
    #[garde(dive)]
    pub at: WireInstant,
}

/// The `session.providerStatus.reported` payload: a coarse status the provider reported for its
/// session, normalized, with display text where it sent some. It records what the provider said and
/// never moves the session's own state. It takes the epoch stamp: `source_epoch` and
/// `source_position` come together, and only on a payload naming its run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct SessionProviderStatusPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run, where the status names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The provider.
    pub provider: ProviderId,
    /// The status, normalized.
    pub status: FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>,
    /// The provider's display text, where it sent some.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
    pub detail: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    /// The execution epoch a late row is attributed to; comes with `source_position` and `run_id`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, self.run_id.is_some())
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `source_epoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/events",
    doc: "The payloads of a session's own events: its creation, its lifecycle moves, its renames, \
          its marks, its advisor, its output style and its provider's status.",
    definitions: &[
        Definition::read::<SessionCreatedParent>(),
        Definition::read::<SessionCreatedPayload>().checked(),
        Definition::read::<SessionLifecycleChangePayload>().checked(),
        Definition::read::<SessionRenameOrigin>().checked(),
        Definition::read::<SessionRenamedPayload>().checked(),
        Definition::read::<SessionMarkChangePayload>().checked(),
        Definition::read::<SessionAdvisorChangedPayload>().checked(),
        Definition::read::<SessionOutputStyleChangedPayload>().checked(),
        Definition::read::<SessionProviderStatusPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
