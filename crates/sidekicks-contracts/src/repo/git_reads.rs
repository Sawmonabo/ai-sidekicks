//! The git reads the panes make: the branch list both base pickers use, reading a file's lines by
//! path or by blob, and the signal that a session's working folder changed.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::gitflow::shared::GitRefName;
use crate::repo::mount::RepoMountId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::{FreeFormText, pattern_text};
use crate::worktree::lifecycle::WorktreeId;

pattern_text! {
    /// A git object name as git prints it: 40 lower-case hex digits for SHA-1, 64 for SHA-256.
    /// Commits and blobs are both named this way.
    pub struct GitObjectId("^(?:[0-9a-f]{40}|[0-9a-f]{64})$") branded;
}

/// `repo.branchList`: the mount whose branches both base pickers list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoBranchListRequest {
    /// The mount.
    pub repo_mount_id: RepoMountId,
}

/// The worktree that has a branch checked out, which the create form's list grays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchHolder {
    /// Present only for a tree the app made; the main checkout and a tree the person made carry a
    /// name alone.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorktreeId")]
    pub worktree_id: Option<WorktreeId>,
    /// The tree's name.
    pub name: FreeFormText<FILE_PATH_MAX_LEN>,
}

/// One branch in a base list. `ahead` and `behind` count commits against the branch's upstream and
/// are absent when it has none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoBranchListEntry {
    /// The branch.
    pub name: GitRefName,
    /// Commits ahead of its upstream.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub ahead: Option<SafeInt<0>>,
    /// Commits behind its upstream.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub behind: Option<SafeInt<0>>,
    /// The worktree that has it checked out.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BranchHolder")]
    pub held_by: Option<BranchHolder>,
}

/// The `repo.branchList` result, in the daemon's one order: the default branch, then the branches
/// this project's last picks came from, most recent first, then the rest by their newest commit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RepoBranchListResponse {
    /// The default branch.
    pub default_branch: GitRefName,
    /// The branches.
    pub branches: Vec<RepoBranchListEntry>,
    /// Present when the last background fetch failed: when the figures were last true.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub counts_as_of: Option<WireInstant>,
}

/// Which side of a comparison a gap read is on: a `committed` side is read from git's object
/// store; a `working-tree` side from disk, and only while the file there still has the blob id the
/// diff was read at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RepoFileSide {
    /// Git's object store.
    Committed,
    /// The file on disk.
    WorkingTree,
}

/// The lines a read narrows to: `count` lines from line `from`, counted from 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoFileLineRange {
    /// The first line, from 1.
    pub from: SafeInt<1>,
    /// How many lines.
    pub count: SafeInt<1>,
}

/// Declares one form of a `repo.fileRead` request: the members both forms share, then the form's
/// own.
macro_rules! file_read_request {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            /// The session whose working folder is read.
            pub session_id: SessionId,
            /// The file, inside the working folder.
            pub path: FilesystemPath,
            $($own)*
            /// The lines to read; absent reads the whole file.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "RepoFileLineRange")]
            pub lines: Option<RepoFileLineRange>,
        }
    };
}

file_read_request! {
    /// A gap read: the blob the diff gave that side, and the side, so its line numbers match the
    /// diff the reader is looking at.
    pub struct RepoGapReadRequest {
        /// The blob the diff gave that side.
        pub blob_id: GitObjectId,
        /// The side.
        pub side: RepoFileSide,
    }
}

file_read_request! {
    /// A read of a file the diff does not hold, by path alone, from the working tree.
    pub struct RepoWorkingFileReadRequest {
        /// Only a gap read names a blob.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub blob_id: Option<Never>,
        /// Only a gap read names a side.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub side: Option<Never>,
    }
}

/// `repo.fileRead`: a file in the session's working folder, or the lines inside a collapsed gap of
/// a diff, which names its blob and its side together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum RepoFileReadRequest {
    /// A gap read.
    Gap(RepoGapReadRequest),
    /// A read by path alone.
    WorkingFile(RepoWorkingFileReadRequest),
}

/// The `repo.fileRead` result: the lines read; `stale` when the working-tree side no longer holds
/// the blob the diff was read at, so the pane shows its reload mark; `binary` when the file is not
/// text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepoFileReadResponse {
    /// The lines read, starting at `firstLine`, with the file's `totalLines`.
    Lines {
        /// The file.
        path: FilesystemPath,
        /// The lines.
        lines: Vec<String>,
        /// The first line's number, from 1.
        first_line: SafeInt<1>,
        /// How many lines the file has.
        total_lines: SafeInt<0>,
    },
    /// The working-tree side no longer holds the blob.
    Stale {},
    /// The file is not text.
    Binary {},
}

/// `repo.workingTreeSubscribe`: the session whose working folder the daemon watches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkingTreeSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
}

/// How the daemon noticed a working folder change: a file watch, or a slow tick for a folder too
/// large for the machine's watch limit, so a late mark is never read as a tree that did not change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkingTreeChangeMode {
    /// A file watch.
    Watch,
    /// A slow tick.
    SlowTick,
}

/// One `repo.workingTreeSubscribe` emission: the working folder changed at `changedAt`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkingTreeChange {
    /// The session.
    pub session_id: SessionId,
    /// When it changed.
    #[garde(dive)]
    pub changed_at: WireInstant,
    /// How the daemon noticed.
    pub mode: WorkingTreeChangeMode,
}

/// The TypeScript module of the git reads the panes make.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "repo/git-reads",
    doc: "The git reads the panes make: the branch list, reading a file's lines by path or by \
          blob, and the signal that a session's working folder changed.",
    definitions: &[
        Definition::read::<GitObjectId>().checked(),
        Definition::read::<RepoBranchListRequest>(),
        Definition::read::<BranchHolder>(),
        Definition::read::<RepoBranchListEntry>(),
        Definition::read::<RepoBranchListResponse>(),
        Definition::read::<RepoFileSide>(),
        Definition::read::<RepoFileLineRange>(),
        Definition::read::<RepoFileReadRequest>().checked(),
        Definition::read::<RepoFileReadResponse>(),
        Definition::read::<WorkingTreeSubscribeRequest>(),
        Definition::read::<WorkingTreeChangeMode>(),
        Definition::read::<WorkingTreeChange>(),
    ],
    constants: &[],
    method_tables: &[],
};
