//! The links between sessions as the person reads and changes them: the live related list the
//! inspector shows, adding a `related` link and removing one.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::IntoStaticStr;

use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::session::id::SessionId;
use crate::session::name::SESSION_NAME_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

/// How two sessions are linked. Every kind but `related` is written by the daemon when the event
/// that makes it happens; `related` is added on purpose and is the one a person removes.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum SessionLinkKind {
    /// One session started the other.
    Started,
    /// One session was copied from the other.
    CopiedFrom,
    /// The two traded messages.
    Messaged,
    /// One asked the other.
    Asked,
    /// One mentioned the other.
    Mentioned,
    /// The person linked them.
    Related,
}

/// `session.relatedList`'s input: the session whose related sessions to follow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRelatedListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One session linked to the followed one. `kind` is the strongest link between the two, and
/// `sessionIsSource` is true where the followed session started, copied, messaged, asked or
/// mentioned the other.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRelatedListEntry {
    /// The linked session.
    pub session_id: SessionId,
    /// Its name; absent for an untitled session.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// The strongest link.
    pub kind: SessionLinkKind,
    /// Whether the followed session is the link's source.
    pub session_is_source: bool,
    /// On a `messaged` link, how many messages the two traded.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub message_count: Option<SafeInt<1>>,
    /// Whether the pair carries a `related` link, which `Unlink` removes.
    pub removable: bool,
}

/// Each `session.relatedList` emission: the whole related list, highest relevance first, sent when
/// the stream opens and again each time a link it depends on is re-scored. The list fits the
/// shared page budget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRelatedListUpdate {
    /// The followed session.
    pub session_id: SessionId,
    /// Its related sessions.
    #[garde(custom(fits_one_page))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub related: Vec<SessionRelatedListEntry>,
}

/// Adds or removes a `related` link between two sessions, naming both by id so a rename changes
/// nothing. The two are different sessions: none links to itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionLinkRequest {
    /// One session.
    pub session_id: SessionId,
    /// The other.
    #[garde(custom(|target_session_id: &SessionId, (): &()| {
        if *target_session_id == self.session_id {
            Err(garde::Error::new("a session cannot be linked to itself"))
        } else {
            Ok(())
        }
    }))]
    #[schemars(extend("type" = "string", "not" = { "const": { "$data": "1/sessionId" } }))]
    pub target_session_id: SessionId,
}

methods! {
    /// The session link methods' wire contract: name, procedure type and types.
    pub const SESSION_LINK_METHOD_DESCRIPTORS = [
        /// Follows a session's related list; the acknowledgement carries only the subscription,
        /// and the first emission is the list.
        SessionRelatedList = subscription "session.relatedList" {
            mutating: false,
            params: SessionRelatedListRequest,
            result: SubscribeAckResponse,
            emission: SessionRelatedListUpdate,
            refusals: [SessionNotFound],
        },
        /// Adds a `related` link.
        SessionLinkAdd = mutation "session.linkAdd" {
            mutating: true,
            params: SessionLinkRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound],
        },
        /// Removes a `related` link.
        SessionLinkRemove = mutation "session.linkRemove" {
            mutating: true,
            params: SessionLinkRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, SessionLinkNotRemovable],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/links",
    doc: "The links between sessions as the person reads and changes them.",
    definitions: &[
        Definition::read::<SessionLinkKind>(),
        Definition::read::<SessionRelatedListRequest>().checked(),
        Definition::read::<SessionRelatedListEntry>(),
        Definition::read::<SessionRelatedListUpdate>().checked(),
        Definition::read::<SessionLinkRequest>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_LINK_METHOD_DESCRIPTORS],
};
