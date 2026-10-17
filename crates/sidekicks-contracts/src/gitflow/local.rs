//! What local git answers: a branch's ship facts, the review pane's diff (a session's changes, its
//! branch, one change request, or a workflow run between two snapshot points), the ship acts with
//! their preview and progress, Generate, and the payload of `git.settled`, the one event that
//! records a commit, a push, a pull, an opened change request or a posted review.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::free_form_string::FilesystemPath;
use crate::gitflow::hosting::{ChangeRequestSummary, GitHostKind, ReviewSubmitVerdict};
use crate::gitflow::shared::{ChangeRequestNumber, GitRefName, GitShortObjectId, HostingAddress};
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::repo::git_reads::GitObjectId;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::{FreeFormText, NonEmptyText, branded_text};
use crate::workflow::definition::document::WorkflowNodeId;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::snapshot::{WorkflowRunEpoch, WorkflowRunPauseNumber};

branded_text! {
    /// The id of one running or finished git act, which the daemon mints.
    pub struct GitActId(1..=usize::MAX);
}

/// The half-finished git operations that stop a commit until they are ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PendingGitOperationKind {
    /// A merge.
    Merge,
    /// A rebase.
    Rebase,
    /// A bisect.
    Bisect,
}

/// Where one command of a running act stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GitActCommandState {
    /// Not run yet.
    Pending,
    /// Running.
    Running,
    /// Done.
    Done,
    /// Failed.
    Failed,
}

/// Why a changed file's contents cannot be shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiffFileUnreadableReason {
    /// The daemon may not read it.
    PermissionDenied,
    /// It is not a regular file.
    NotRegularFile,
}

/// The details of a `gitflow.generate_failed` refusal: the provider's own words; nothing falls
/// back to another provider, model or account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitflowGenerateFailedDetails {
    /// The provider's words.
    pub provider_failure_detail: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
}

/// A half-finished merge, rebase or bisect, with the command that ends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingGitOperation {
    /// The operation.
    pub kind: PendingGitOperationKind,
    /// The command that ends it.
    pub end_command: NonEmptyText,
}

/// The `gitflow.branchContextRead` result: the branch's ship facts, which also carry what the
/// change-request form opens with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitflowBranchContextReadResponse {
    /// The session's branch.
    pub head_branch: GitRefName,
    /// The branch it ships to.
    pub base_branch: GitRefName,
    /// The repository's default branch.
    pub default_branch: GitRefName,
    /// Its upstream.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "GitRefName")]
    pub upstream_ref: Option<GitRefName>,
    /// Uncommitted files.
    pub uncommitted_file_count: SafeInt<0>,
    /// Commits ahead of the base.
    pub ahead_of_base: SafeInt<0>,
    /// Commits behind the base.
    pub behind_base: SafeInt<0>,
    /// Commits not pushed.
    pub unpushed_commit_count: SafeInt<0>,
    /// The branch was never pushed, so opening a change request pushes it first.
    pub never_left_machine: bool,
    /// A half-finished operation.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PendingGitOperation")]
    pub pending_operation: Option<PendingGitOperation>,
    /// The branch's change requests, newest first.
    #[garde(dive)]
    pub change_requests: Vec<ChangeRequestSummary>,
    /// The hosting service; absent where the daemon cannot say which service the remote is.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "GitHostKind")]
    pub host_kind: Option<GitHostKind>,
    /// When the background fetch `behindBase` comes from last succeeded.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub counts_as_of: Option<WireInstant>,
}

/// One of a workflow run's snapshot points: its start, an approval pause, or its end, within one
/// execution of the run (each re-execution opens the next epoch, counted from 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "point",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowRunSnapshotPoint {
    /// The run's start.
    Start {
        /// The execution.
        epoch: WorkflowRunEpoch,
    },
    /// An approval pause.
    Pause {
        /// The execution.
        epoch: WorkflowRunEpoch,
        /// The pause.
        pause_number: WorkflowRunPauseNumber,
    },
    /// The run's end.
    End {
        /// The execution.
        epoch: WorkflowRunEpoch,
    },
}

/// `gitflow.diffRead`, one arm per comparison.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "scope",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum GitflowDiffReadRequest {
    /// The working folder against its last commit, untracked files included.
    Changes {
        /// The session.
        session_id: SessionId,
    },
    /// The branch against `base` (absent: the default base) or one of its commits.
    Branch {
        /// The session.
        session_id: SessionId,
        /// The base.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "GitRefName")]
        base: Option<GitRefName>,
        /// One commit of the branch.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "GitObjectId")]
        commit_id: Option<GitObjectId>,
    },
    /// One change request.
    ChangeRequest {
        /// The session.
        session_id: SessionId,
        /// The change request.
        change_request_number: ChangeRequestNumber,
    },
    /// What a workflow run changed between two of its snapshot points.
    WorkflowRun {
        /// The session.
        session_id: SessionId,
        /// The run.
        workflow_run_id: WorkflowRunId,
        /// The earlier point.
        from: WorkflowRunSnapshotPoint,
        /// The later point.
        to: WorkflowRunSnapshotPoint,
    },
}

/// The workflow step that changed a file, named as the run's pinned version names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiffFileStep {
    /// The step's node.
    pub node_id: WorkflowNodeId,
    /// Its name.
    pub node_name: NonEmptyText,
}

/// Declares [`DiffFile`]: each kind's own members, then the members every kind repeats.
macro_rules! diff_file {
    ($($(#[doc = $doc:literal])+ $arm:ident { $($own:tt)* })+) => {
        /// One changed path, composed into a single patch however many edits touched it, by what
        /// happened to it between the two sides; a copy reads `added`, and only a rename carries
        /// the old path.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "kind",
            rename_all = "snake_case",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum DiffFile {$(
            $(#[doc = $doc])+
            $arm {
                $($own)*
                /// The path.
                path: FilesystemPath,
                /// Whether its mode changed.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                mode_changed: Option<bool>,
                /// Whether it is binary.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                binary: Option<bool>,
                /// Why its contents cannot be shown.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "DiffFileUnreadableReason")]
                unreadable: Option<DiffFileUnreadableReason>,
                /// Lines added.
                additions: SafeInt<0>,
                /// Lines deleted.
                deletions: SafeInt<0>,
                /// The unified patch, absent when `binary` or `unreadable` says why no lines are
                /// shown.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "String")]
                patch: Option<String>,
                /// The blob before.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "GitObjectId")]
                old_blob_id: Option<GitObjectId>,
                /// The blob after.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "GitObjectId")]
                new_blob_id: Option<GitObjectId>,
                /// The newest turn that touched it; absent for a change made outside a turn.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "SafeInt<1>")]
                newest_turn: Option<SafeInt<1>>,
                /// On a workflow run's diff, the step that changed it; absent for an edit made in
                /// the checkout by anyone else.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "DiffFileStep")]
                step: Option<DiffFileStep>,
            },
        )+}
    };
}

diff_file! {
    /// A file added.
    Added {
        /// Only a rename carries the old path.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        old_path: Option<Never>,
    }
    /// A file deleted.
    Deleted {
        /// Only a rename carries the old path.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        old_path: Option<Never>,
    }
    /// A file renamed.
    Renamed {
        /// The path before the rename.
        old_path: FilesystemPath,
    }
    /// A file modified.
    Modified {
        /// Only a rename carries the old path.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        old_path: Option<Never>,
    }
}

/// The agent whose run made a commit, read from the commit's run trailer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiffCommitAgent {
    /// The agent.
    pub agent_id: AgentId,
    /// Its name.
    pub name: NonEmptyText,
}

/// One commit on the branch comparison; a commit without an agent is the person's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DiffCommit {
    /// The commit.
    pub commit_id: GitObjectId,
    /// Its short id.
    pub short_id: GitShortObjectId,
    /// Its subject.
    pub subject: String,
    /// When it landed.
    #[garde(dive)]
    pub landed_at: WireInstant,
    /// The agent whose run made it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DiffCommitAgent")]
    pub agent: Option<DiffCommitAgent>,
}

/// The `gitflow.diffRead` result, always the whole diff: the daemon never cuts a patch at a size.
/// `head` and `base` name the two ends; `commits` is present on the branch comparison.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitflowDiffReadResponse {
    /// The head end.
    pub head: NonEmptyText,
    /// The base end.
    pub base: NonEmptyText,
    /// The changed files.
    pub files: Vec<DiffFile>,
    /// The branch's commits.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<DiffCommit>")]
    #[garde(dive)]
    pub commits: Option<Vec<DiffCommit>>,
}

/// The commit form. The subject has no length limit: its counter past 72 is a reading, never a
/// refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitFormValues {
    /// The subject.
    pub subject: NonEmptyText,
    /// The body.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub body: Option<String>,
}

/// The change-request form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeRequestFormValues {
    /// The base branch.
    pub base: GitRefName,
    /// The title.
    pub title: NonEmptyText,
    /// The description.
    pub description: String,
    /// Whether it opens as a draft.
    pub draft: bool,
    /// The reviewers asked.
    pub reviewers: Vec<NonEmptyText>,
    /// The labels.
    pub labels: Vec<NonEmptyText>,
}

/// The failed command of an earlier act that a retry runs again from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitActRetryPoint {
    /// The earlier act.
    pub act_id: GitActId,
    /// Its failed command, from 0.
    pub command_index: SafeInt<0>,
}

/// Declares a ship-act request: one arm per act with the values of its form (push and pull have
/// none), each followed by the request's own members.
macro_rules! git_act_request {
    ($(#[doc = $doc:literal])+ pub enum $name:ident { $($own:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "act",
            rename_all = "snake_case",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {
            /// A commit.
            Commit {
                /// The session.
                session_id: SessionId,
                /// The commit form.
                form_values: CommitFormValues,
                $($own)*
            },
            /// A push.
            Push {
                /// The session.
                session_id: SessionId,
                $($own)*
            },
            /// A pull.
            Pull {
                /// The session.
                session_id: SessionId,
                $($own)*
            },
            /// Opening a change request.
            OpenChangeRequest {
                /// The session.
                session_id: SessionId,
                /// The change-request form.
                form_values: ChangeRequestFormValues,
                $($own)*
            },
        }
    };
}

git_act_request! {
    /// `gitflow.gitActionPreview`: one ship act with the values of its form. The preview and the
    /// execution take this one shape, so the commands shown before the press are built by the code
    /// that runs them.
    pub enum GitflowGitActionPreviewRequest {}
}

git_act_request! {
    /// `gitflow.gitActionExecute`: the act, and with `retryFromCommand` the earlier act's failed
    /// command it resumes at instead of starting over.
    pub enum GitflowGitActionExecuteRequest {
        /// The failed command to resume at.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "GitActRetryPoint")]
        retry_from_command: Option<GitActRetryPoint>,
    }
}

/// The `gitflow.gitActionPreview` result: the exact commands the act will run, in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitflowGitActionPreviewResponse {
    /// The commands.
    pub commands: BoundedVec<NonEmptyText, 1, { usize::MAX }>,
}

/// The `gitflow.gitActionExecute` result: the act's id, whose progress `gitflow.gitActionSubscribe`
/// streams, and the commands it runs. A failed command is a failed command on that stream, not an
/// error reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitflowGitActionExecuteResponse {
    /// The act.
    pub act_id: GitActId,
    /// The commands.
    pub commands: BoundedVec<NonEmptyText, 1, { usize::MAX }>,
}

/// `gitflow.gitActionSubscribe`: the act to follow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitflowGitActionSubscribeRequest {
    /// The act.
    pub act_id: GitActId,
}

/// One command of a running act; `output` is its credential-scrubbed output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitActCommand {
    /// Its place, from 0.
    pub index: SafeInt<0>,
    /// The command.
    pub text: NonEmptyText,
    /// Where it stands.
    pub state: GitActCommandState,
    /// Its output.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub output: Option<String>,
}

/// One frame of `gitflow.gitActionSubscribe`: every command of the act and where it stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitActFrame {
    /// The act.
    pub act_id: GitActId,
    /// Its commands.
    pub commands: BoundedVec<GitActCommand, 1, { usize::MAX }>,
}

/// The `gitflow.commitMessageGenerate` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitflowCommitMessageGenerateResponse {
    /// The subject.
    pub subject: NonEmptyText,
    /// The body.
    pub body: String,
    /// Each changed file no pass could read, which the text does not cover; empty when every file
    /// was read.
    pub unread_paths: Vec<FilesystemPath>,
}

/// The `gitflow.changeRequestTextGenerate` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitflowChangeRequestTextGenerateResponse {
    /// The title.
    pub title: NonEmptyText,
    /// The description.
    pub description: String,
    /// Each changed file no pass could read, which the text does not cover; empty when every file
    /// was read.
    pub unread_paths: Vec<FilesystemPath>,
}

/// The `git.settled` payload: one record per act that left or changed the session's branch, so its
/// conversation row survives a reload. `runId` marks an agent's commit (from its run trailer) or
/// opened request; a push carries none, because its row names the act and not the actor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "cause",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitSettledPayload {
    /// A commit.
    Committed {
        /// The session.
        session_id: SessionId,
        /// The commit.
        commit_id: GitObjectId,
        /// The agent's run that made it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RunId")]
        run_id: Option<RunId>,
    },
    /// A push.
    Pushed {
        /// The session.
        session_id: SessionId,
        /// The branch pushed.
        branch: GitRefName,
    },
    /// A pull.
    Pulled {
        /// The session.
        session_id: SessionId,
        /// The branch pulled.
        branch: GitRefName,
        /// The commit it pulled to.
        commit_id: GitObjectId,
    },
    /// An opened change request.
    PullRequestOpened {
        /// The session.
        session_id: SessionId,
        /// Its number.
        request_number: ChangeRequestNumber,
        /// Its address.
        request_url: HostingAddress,
        /// The agent's run that opened it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RunId")]
        run_id: Option<RunId>,
    },
    /// A posted review.
    ReviewPosted {
        /// The session.
        session_id: SessionId,
        /// The change request.
        request_number: ChangeRequestNumber,
        /// The verdict.
        verdict: ReviewSubmitVerdict,
    },
}

/// The TypeScript module of what local git answers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "gitflow/local",
    doc: "What local git answers: a branch's ship facts, the review pane's diff, the ship acts \
          with their preview and progress, Generate, and the git.settled payload.",
    definitions: &[
        Definition::read::<GitActId>(),
        Definition::read::<PendingGitOperationKind>(),
        Definition::read::<GitActCommandState>(),
        Definition::read::<DiffFileUnreadableReason>(),
        Definition::read::<GitflowGenerateFailedDetails>(),
        Definition::read::<PendingGitOperation>(),
        Definition::read::<GitflowBranchContextReadResponse>(),
        Definition::read::<WorkflowRunSnapshotPoint>(),
        Definition::read::<GitflowDiffReadRequest>().checked(),
        Definition::read::<DiffFileStep>(),
        Definition::read::<DiffFile>(),
        Definition::read::<DiffCommitAgent>(),
        Definition::read::<DiffCommit>(),
        Definition::read::<GitflowDiffReadResponse>().checked(),
        Definition::read::<CommitFormValues>(),
        Definition::read::<ChangeRequestFormValues>(),
        Definition::read::<GitActRetryPoint>(),
        Definition::read::<GitflowGitActionPreviewRequest>(),
        Definition::read::<GitflowGitActionExecuteRequest>(),
        Definition::read::<GitflowGitActionPreviewResponse>(),
        Definition::read::<GitflowGitActionExecuteResponse>(),
        Definition::read::<GitflowGitActionSubscribeRequest>(),
        Definition::read::<GitActCommand>(),
        Definition::read::<GitActFrame>(),
        Definition::read::<GitflowCommitMessageGenerateResponse>(),
        Definition::read::<GitflowChangeRequestTextGenerateResponse>(),
        Definition::read::<GitSettledPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
