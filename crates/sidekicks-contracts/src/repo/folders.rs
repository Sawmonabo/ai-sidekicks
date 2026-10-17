//! The folders the service can reach and where each came from (`repo.mountList`), browsing the
//! machine's folders from another device (`repo.folderList`), one folder's attach, read, detach
//! and re-attach, and the details of their refusals.
//!
//! Attach is the only way a path enters the machine's trust envelope. A mount belongs to the
//! machine, not to a session: the daemon stamps its own node id on the row, and a session reaches
//! the mount by binding a workspace to it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::place::{Place, WslPlace};
use crate::project::{ProjectId, ProjectName};
use crate::repo::mount::{RepoMountHealth, RepoMountId, RepoMountState, VcsType, WorkspaceId};
use crate::runtime_node::id::NodeId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::{BoundedVec, ListKey, UniqueList};
use crate::wire::text::FreeFormText;
use crate::wire::{Never, NullableSchema, True, nullable};
use crate::worktree::lifecycle::WorktreeId;

/// Where a folder the service can reach came from, carrying the ids its removal act takes: a
/// project's folder the person attached (removed by the project's detach); a chat's own workspace,
/// which goes only when that session is purged; or a worktree the app made (removed by its
/// retire).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepoMountOrigin {
    /// A project's folder.
    Attached {
        /// The mount.
        repo_mount_id: RepoMountId,
        /// Its project.
        project_id: ProjectId,
    },
    /// A chat's own workspace, which the daemon made and registered as a mount.
    Managed {
        /// The mount.
        repo_mount_id: RepoMountId,
        /// The one chat that owns it.
        session_id: SessionId,
    },
    /// A worktree the app made, listed under its project.
    Worktree {
        /// The worktree.
        worktree_id: WorktreeId,
        /// Its project.
        project_id: ProjectId,
    },
}

/// One folder the service can reach, with how many sessions use it and, on a Windows computer,
/// where it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoMountListEntry {
    /// The folder.
    pub path: FilesystemPath,
    /// Where it came from.
    pub origin: RepoMountOrigin,
    /// How many sessions use it.
    pub using_session_count: SafeInt<0>,
    /// Where it is; absent on macOS and Linux.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
}

/// The `repo.mountList` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoMountListResponse {
    /// Every folder.
    pub mounts: Vec<RepoMountListEntry>,
}

/// `repo.folderList` for one folder: where to browse (Windows itself when absent, or a WSL 2
/// distribution), the folder to show there (that place's home folder when absent), the text that
/// narrows its folders, and whether hidden folders are listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RepoFolderListFolderRequest {
    /// Never present: this asks for a folder.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub top: Option<Never>,
    /// The distribution to browse; absent on macOS and Linux and for Windows itself.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WslPlace")]
    pub place: Option<WslPlace>,
    /// The folder to show, in that place's own form.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub path: Option<FilesystemPath>,
    /// The text that narrows its folders.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<FILE_PATH_MAX_LEN>")]
    pub filter: Option<FreeFormText<FILE_PATH_MAX_LEN>>,
    /// Whether hidden folders are listed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub show_hidden: Option<bool>,
}

/// `repo.folderList` for the top level of a Windows computer: its drives and its WSL 2
/// distributions. Listing it starts no distribution; macOS and Linux refuse it with
/// `repo.top_level_unavailable`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RepoFolderListTopRequest {
    /// Always `true`.
    pub top: True,
}

/// What `repo.folderList` takes: one folder, or the top level of a Windows computer. macOS and
/// Linux have no top level and refuse it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum RepoFolderListRequest {
    /// One folder.
    Folder(RepoFolderListFolderRequest),
    /// The top level.
    Top(RepoFolderListTopRequest),
}

/// One folder in a listing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoFolderListEntry {
    /// Its name.
    pub name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// Its path.
    pub path: FilesystemPath,
    /// Whether it is a git repository.
    pub is_repository: bool,
}

/// One step of the path to the folder in view, pressable to go back to it: on Windows the first is
/// the top level, so the device can go back up and change drive or distribution; every other step
/// is a folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepoFolderPathSegment {
    /// The top level of a Windows computer.
    Top {},
    /// A folder.
    Folder {
        /// Its name.
        name: FreeFormText<FILE_PATH_MAX_LEN>,
        /// Its path.
        path: FilesystemPath,
    },
}

/// One entry of a Windows computer's top level: a drive, or a WSL 2 distribution, which opens on
/// its home folder through `repo.folderList` with its place.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepoFolderTopEntry {
    /// A drive, by its root folder (`C:\`).
    Drive {
        /// Its root folder.
        path: FilesystemPath,
    },
    /// A WSL 2 distribution.
    Distribution {
        /// Its place.
        place: WslPlace,
    },
}

// A drive or distribution entry is keyed by its one member, the drive's path or the distribution,
// and carries no rule its read does not hold.
impl ListKey for RepoFolderTopEntry {
    type Key = Self;

    fn list_key(&self) -> Self {
        self.clone()
    }

    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// One folder as `repo.folderList` lists it: where the folder in view is, the folder as that place
/// writes its path, the path's segments from the top down (the last is the folder in view), its
/// folders, and `more` when the filter would narrow further. Every path in it is in that place's
/// own form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RepoFolderListFolderResponse {
    /// Never present: this is a folder.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub top: Option<Never>,
    /// Where the folder in view is; absent on macOS and Linux.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// The folder in view.
    pub path: FilesystemPath,
    /// The path's segments, at least the folder in view.
    pub segments: BoundedVec<RepoFolderPathSegment, 1, { usize::MAX }>,
    /// Its folders.
    pub entries: Vec<RepoFolderListEntry>,
    /// Whether the filter would narrow further.
    pub more: bool,
}

/// The top level of a Windows computer: its drives, then one entry per WSL 2 distribution, none
/// twice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[garde(allow_unvalidated)]
pub struct RepoFolderListTopResponse {
    /// Always `true`.
    pub top: True,
    /// The drives, then the distributions.
    #[garde(dive)]
    pub entries: UniqueList<RepoFolderTopEntry, 0, { usize::MAX }>,
}

/// The `repo.folderList` result: one folder, or the top level of a Windows computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum RepoFolderListResponse {
    /// One folder.
    Folder(RepoFolderListFolderResponse),
    /// The top level.
    Top(#[garde(dive)] RepoFolderListTopResponse),
}

/// `repo.attach`: a path on the machine the service runs on, the folder the platform's chooser
/// returned or, from another device, a folder `repo.folderList` showed. A Linux path comes with the
/// WSL 2 distribution it was given in, since the path alone does not say which one holds it;
/// without a place, the path's own form says where it is (a drive path on Windows, a
/// `\\wsl.localhost\<distro>\` path in that distribution). The folder's own disk sets the
/// mount's place, so a Windows drive reached from a distribution is on Windows. The path is kept as
/// entered; absoluteness, traversal and existence are the resolver's to refuse, a path that is not
/// a git repository is refused, and so is a distribution that runs on WSL 1 or is not on this
/// computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoAttachRequest {
    /// The path as entered.
    pub local_path: FilesystemPath,
    /// The distribution a Linux path was given in; absent on macOS and Linux and wherever the
    /// path's own form says, Windows itself among them.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WslPlace")]
    pub place: Option<WslPlace>,
}

/// The `repo.attach` result: the new mount and the root its path resolved to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoAttachResponse {
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// Its state.
    pub state: RepoMountState,
    /// Its version-control system.
    pub vcs_type: VcsType,
    /// The resolver's absolute, symlink-resolved root, never the entered path, in its place's own
    /// form.
    pub canonical_root: FilesystemPath,
    /// Where the root is, fixed for the mount's life; absent on macOS and Linux.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
}

/// `repo.mountRead`, `repo.detach` and `repo.mountReattach`: the mount to act on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoMountRequest {
    /// The mount.
    pub repo_mount_id: RepoMountId,
}

/// One session using a folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoMountUser {
    /// The session.
    pub session_id: SessionId,
}

/// One mount as `repo.mountRead` reports it, with a freshly probed health verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoMountReadResponse {
    /// The mount.
    pub id: RepoMountId,
    /// The machine's daemon that holds it.
    pub node_id: NodeId,
    /// The path as entered; it differs from `canonicalRoot` when entered inside or via a link.
    pub local_path: FilesystemPath,
    /// The resolved root.
    pub canonical_root: FilesystemPath,
    /// Where both paths are, in that place's own form; absent on macOS and Linux.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// Its version-control system.
    pub vcs_type: VcsType,
    /// Its state.
    pub state: RepoMountState,
    /// Its health, probed for this read.
    #[garde(dive)]
    pub health: RepoMountHealth,
    /// When it was attached.
    #[garde(dive)]
    pub attached_at: WireInstant,
    /// Where it came from.
    pub origin: RepoMountOrigin,
    /// Its project's name, absent on a chat's own workspace, which belongs to no project.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectName")]
    pub display_name: Option<ProjectName>,
    /// The sessions using it.
    pub used_by: Vec<RepoMountUser>,
}

/// The `repo.detach` result. Detaching is a project's `Delete`: the mount turns `detached` for
/// good, every dependent workspace is archived, the project record is forgotten with its setup
/// steps, and the project's sessions are archived and stay readable. Nothing on disk is touched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoDetachResponse {
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// Its state.
    pub state: RepoMountState,
    /// The workspaces archived.
    pub archived_workspace_ids: Vec<WorkspaceId>,
    /// The sessions archived.
    pub archived_session_ids: Vec<SessionId>,
    /// The project this call forgot, `null` when the mount was already detached.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<ProjectId>")]
    pub forgotten_project_id: Option<ProjectId>,
}

/// Why a folder was refused `repo.outside_trust_envelope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RepoOutsideTrustEnvelopeReason {
    /// No admitted root of the project.
    OutsideProject,
    /// A tree whose removal is committed while its folder still waits for deletion.
    WorktreeRemoved,
}

/// The details of a `repo.outside_trust_envelope` refusal: its reason and no path, since the caller
/// already holds the folder it sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoOutsideTrustEnvelopeDetails {
    /// Why.
    pub reason: RepoOutsideTrustEnvelopeReason,
}

/// Why a path's canonical repository root could not be resolved: the path is missing, unreadable
/// or not absolute, git could not answer for it, its working tree is not one git names for the
/// repository, or git reports a folder with no visible `.git` entry is not a repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RepoRootResolutionReason {
    /// The path does not exist.
    PathNotFound,
    /// The path or its root cannot be read.
    NotReadable,
    /// Git could not answer for the path, or its repository metadata is damaged.
    VcsError,
    /// The path does not name one complete location.
    NotAbsolute,
    /// The working tree is neither the main one git names nor one git lists for the repository.
    RootMismatch,
    /// Git reports the folder is not a repository and no `.git` entry contradicts it.
    NotARepository,
}

/// The details of a `repo.root_resolution_failed` refusal: its reason and no path, since the
/// message never echoes the path tried.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoRootResolutionFailedDetails {
    /// Why.
    pub reason: RepoRootResolutionReason,
}

/// The details of a `repo.already_attached` refusal: the mount that holds the repository and its
/// project, `null` when the holder is a chat's own workspace. No path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoAlreadyAttachedDetails {
    /// The mount holding the repository.
    pub conflicting_repo_mount_id: RepoMountId,
    /// Its project.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<ProjectId>")]
    pub conflicting_project_id: Option<ProjectId>,
}

/// The `repo.mountReattach` result: the new mount. The old one turns `detached` and the folder is
/// attached fresh under the same project record, keeping its sessions and their workspaces.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoMountReattachResponse {
    /// The new mount.
    pub repo_mount_id: RepoMountId,
}

/// Why a re-attach was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RepoReattachRefusedReason {
    /// The mount does not read `identity_mismatch` at the call.
    IdentityMatches,
}

/// The details of a `repo.reattach_refused` refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoReattachRefusedDetails {
    /// Why.
    pub reason: RepoReattachRefusedReason,
}

/// The details of a `repo.reattach_conflict` refusal: the running agent and its session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoReattachConflictDetails {
    /// The session running there.
    pub running_session_id: SessionId,
    /// The agent running.
    pub running_agent_id: AgentId,
}

/// The TypeScript module of the folders the service can reach.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "repo/folders",
    doc: "The folders the service can reach and where each came from, browsing the machine's \
          folders, one folder's attach, read, detach and re-attach, and the details of their \
          refusals.",
    definitions: &[
        Definition::read::<RepoMountOrigin>().checked(),
        Definition::read::<RepoMountListEntry>(),
        Definition::read::<RepoMountListResponse>(),
        Definition::read::<RepoFolderListRequest>(),
        Definition::read::<RepoFolderListEntry>(),
        Definition::read::<RepoFolderPathSegment>(),
        Definition::read::<RepoFolderTopEntry>(),
        Definition::read::<RepoFolderListResponse>().checked(),
        Definition::read::<RepoAttachRequest>().checked(),
        Definition::read::<RepoAttachResponse>().checked(),
        Definition::read::<RepoMountRequest>(),
        Definition::read::<RepoMountUser>(),
        Definition::read::<RepoMountReadResponse>().checked(),
        Definition::read::<RepoDetachResponse>().checked(),
        Definition::read::<RepoOutsideTrustEnvelopeReason>(),
        Definition::read::<RepoOutsideTrustEnvelopeDetails>(),
        Definition::read::<RepoRootResolutionReason>(),
        Definition::read::<RepoRootResolutionFailedDetails>(),
        Definition::read::<RepoAlreadyAttachedDetails>(),
        Definition::read::<RepoMountReattachResponse>(),
        Definition::read::<RepoReattachRefusedReason>(),
        Definition::read::<RepoReattachRefusedDetails>(),
        Definition::read::<RepoReattachConflictDetails>(),
    ],
    constants: &[],
    method_tables: &[],
};
