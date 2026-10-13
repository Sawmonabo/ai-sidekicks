//! A project's session groups as the person places sessions in them: making a group with a session
//! in it, moving a session in or out, renaming a group and ungrouping it. A client reads every
//! change from the live `session.list`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::internal::branded::branded_uuid_id;
use crate::method::methods;
use crate::session::id::SessionId;
use crate::session::methods::SessionVerbResponse;
use crate::session::name::SESSION_NAME_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::FreeFormText;

branded_uuid_id! {
    /// Identifies one session group of a project; the daemon mints it.
    SessionGroupId
}

/// Makes a group in the session's project with this session in it, so no group is ever empty. A
/// name another group of the project holds, ignoring case, is refused; a chat sits in no group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGroupCreateRequest {
    /// The session the group starts with.
    pub session_id: SessionId,
    /// The group's name.
    pub name: FreeFormText<SESSION_NAME_MAX_LEN>,
}

/// The group `session.groupCreate` made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGroupCreateResponse {
    /// The group.
    pub group_id: SessionGroupId,
}

/// Moves the session into a group of its own project, leaving any group it was in; `groupId`
/// `null` takes it out among the project's loose sessions. A group left with no session is removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGroupMoveRequest {
    /// The session.
    pub session_id: SessionId,
    /// The group, or `null` for none.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SessionGroupId>")]
    pub group_id: Option<SessionGroupId>,
}

/// Renames a group, held to the same uniqueness in its project as a new group's name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGroupRenameRequest {
    /// The group.
    pub group_id: SessionGroupId,
    /// Its new name.
    pub name: FreeFormText<SESSION_NAME_MAX_LEN>,
}

/// Ungroups a group: its sessions go back loose, and nothing is archived or closed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGroupUngroupRequest {
    /// The group.
    pub group_id: SessionGroupId,
}

methods! {
    /// The session group methods' wire contract: name, procedure type and types.
    pub const SESSION_GROUP_METHOD_DESCRIPTORS = [
        /// Makes a group with one session in it.
        SessionGroupCreate = mutation "session.groupCreate" {
            mutating: true,
            params: SessionGroupCreateRequest,
            result: SessionGroupCreateResponse,
            refusals: [SessionGroupNameTaken, SessionGroupRefused],
        },
        /// Moves a session into a group, or out of every group.
        SessionGroupMove = mutation "session.groupMove" {
            mutating: true,
            params: SessionGroupMoveRequest,
            result: SessionVerbResponse,
            refusals: [SessionGroupRefused],
        },
        /// Renames a group.
        SessionGroupRename = mutation "session.groupRename" {
            mutating: true,
            params: SessionGroupRenameRequest,
            result: SessionVerbResponse,
            refusals: [SessionGroupNameTaken],
        },
        /// Ungroups a group.
        SessionGroupUngroup = mutation "session.groupUngroup" {
            mutating: true,
            params: SessionGroupUngroupRequest,
            result: SessionVerbResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/groups",
    doc: "A project's session groups as the person places sessions in them.",
    definitions: &[
        Definition::read::<SessionGroupId>().checked(),
        Definition::read::<SessionGroupCreateRequest>().checked(),
        Definition::read::<SessionGroupCreateResponse>().checked(),
        Definition::read::<SessionGroupMoveRequest>().checked(),
        Definition::read::<SessionGroupRenameRequest>().checked(),
        Definition::read::<SessionGroupUngroupRequest>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_GROUP_METHOD_DESCRIPTORS],
};
