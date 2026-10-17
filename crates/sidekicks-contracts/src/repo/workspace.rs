//! Binding a session's workspace to a mount, and listing a session's workspaces. A workspace's
//! `lastError` is present only when it went `stale` from a recorded failure.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId, WorkspaceState};
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest `lastError` a workspace carries: captured git or provisioning output, scrubbed
    /// of credentials before it is cut, since a cut secret is a fragment the scrubber misses.
    pub const WORKSPACE_LAST_ERROR_MAX_LEN: usize = 8192;
}

/// `workspace.bind`: the session, the attached mount and the mode to bind in. `directory` is
/// relative to the mount root, and the daemon keeps it inside the mount once symlinks resolve.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkspaceBindRequest {
    /// The session; the mount belongs to the machine, so the caller names it.
    pub session_id: SessionId,
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// The mode, required so an omitted one never reads as a chosen one.
    pub execution_mode: ExecutionMode,
    /// The folder inside the mount.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub directory: Option<FilesystemPath>,
}

/// The `workspace.bind` result: the new workspace, its bound mode and its state, which may be
/// other than `preparing`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkspaceBindResponse {
    /// The workspace.
    pub workspace_id: WorkspaceId,
    /// Its mode.
    pub execution_mode: ExecutionMode,
    /// Its state.
    pub state: WorkspaceState,
}

/// `workspace.list`: a session's workspaces, narrowed to one mount when it is named.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkspaceListRequest {
    /// The session.
    pub session_id: SessionId,
    /// The mount to narrow to.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RepoMountId")]
    pub repo_mount_id: Option<RepoMountId>,
}

/// One workspace in a `workspace.list` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceListEntry {
    /// The workspace, by a bare `id` as a read names its own row.
    pub id: WorkspaceId,
    /// Its mount.
    pub repo_mount_id: RepoMountId,
    /// Its mode.
    pub execution_mode: ExecutionMode,
    /// Its health, which is its lifecycle state.
    pub state: WorkspaceState,
    /// Its execution root, absent while it is `preparing`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub fs_root: Option<FilesystemPath>,
    /// The failure that made it `stale`, when one did.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<WORKSPACE_LAST_ERROR_MAX_LEN>")]
    pub last_error: Option<FreeFormText<WORKSPACE_LAST_ERROR_MAX_LEN>>,
}

/// The `workspace.list` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkspaceListResponse {
    /// The workspaces.
    pub workspaces: Vec<WorkspaceListEntry>,
}

/// The TypeScript module of workspace binding.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "repo/workspace",
    doc: "Binding a session's workspace to a mount, and listing a session's workspaces.",
    definitions: &[
        Definition::read::<WorkspaceBindRequest>().checked(),
        Definition::read::<WorkspaceBindResponse>(),
        Definition::read::<WorkspaceListRequest>(),
        Definition::read::<WorkspaceListEntry>(),
        Definition::read::<WorkspaceListResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
