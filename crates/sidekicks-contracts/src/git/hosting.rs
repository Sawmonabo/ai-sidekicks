//! What the hosting service answers: the self-hosted git hosts, the change requests on a branch
//! (live, at the header's depth or at Review's), the reviewer and label candidates, posting a
//! review, answering a thread and reading a failing check's log.
//!
//! The hosting service is GitHub or GitLab, each reached through its own installed, signed-in
//! command-line tool. "Change request" is the host-neutral word for a pull request (GitHub) or a
//! merge request (GitLab); the screen prints the host's own word, which follows from the host kind.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::git::shared::{ChangeRequestNumber, HostHandle, HostingAddress};
use crate::repo::git_reads::GitObjectId;
use crate::review_note::ReviewNoteId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::literal;
use crate::wire::text::{BoundedText, FreeFormText, NonEmptyText};

ts_constants! {
    /// The longest host name DNS allows.
    pub const GIT_HOST_NAME_MAX_LEN: usize = 253;
}

/// The hosting services served. A host is kept with the kind whose tool answered for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitHostKind {
    /// GitHub, through `gh`.
    Github,
    /// GitLab, through `glab`.
    Gitlab,
}

/// Where a change request stands on its host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangeRequestState {
    /// Open.
    Open,
    /// Merged.
    Merged,
    /// Closed unmerged.
    Closed,
}

/// Whether the host can merge a change request. While the host is still working it out the member
/// is absent: an unsettled answer is never a conflict and never an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangeRequestMergeability {
    /// It can be merged.
    Mergeable,
    /// It conflicts with its base.
    Conflicting,
}

/// The change request's own review decision. Absent means the host has recorded no decision, which
/// is not a rejection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangeRequestReviewDecision {
    /// Approved.
    Approved,
    /// Changes were requested.
    ChangesRequested,
    /// A review is required.
    ReviewRequired,
}

/// One reviewer's latest verdict, kept apart from the request's decision: a reviewer can comment
/// without deciding, and a request can need a review nobody has given.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewerVerdict {
    /// Approved.
    Approved,
    /// Requested changes.
    ChangesRequested,
    /// Commented.
    Commented,
}

/// The verdict the person posts a review under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewSubmitVerdict {
    /// A comment.
    Comment,
    /// An approval.
    Approve,
    /// A request for changes.
    RequestChanges,
}

/// One check's outcome on the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangeRequestCheckStatus {
    /// Still running.
    Pending,
    /// Passed.
    Success,
    /// Failed.
    Failure,
}

/// A review thread's state; an outdated thread's line no longer exists in the diff.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewThreadState {
    /// Open.
    Open,
    /// Resolved.
    Resolved,
    /// Its line is gone.
    Outdated,
}

/// Which side of a diff a line belongs to: before the change or after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    /// Before the change.
    Old,
    /// After the change.
    New,
}

/// How much a change-request subscription carries: the header's facts, or Review's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangeRequestReadDepth {
    /// The header's facts.
    Summary,
    /// Review's.
    Full,
}

/// Why a host was refused `git.host.invalid`; nothing is saved either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitHostInvalidReason {
    /// The name does not parse.
    NotAHostName,
    /// Neither `gh` nor `glab`, installed and signed in, answers for it.
    NotAnswered,
}

/// The details of a `git.host.invalid` refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHostInvalidDetails {
    /// Why.
    pub reason: GitHostInvalidReason,
}

/// A host as the person typed it, only bounded, so an empty or unparsable name reaches the daemon,
/// which refuses it with `git.host.invalid`.
pub type GitHostNameInput = BoundedText<0, GIT_HOST_NAME_MAX_LEN>;

/// A host the daemon parsed and saved.
pub type GitHostName = FreeFormText<GIT_HOST_NAME_MAX_LEN>;

/// One registered self-hosted git host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitHost {
    /// The host.
    pub host: GitHostName,
    /// The kind whose tool answered for it.
    pub kind: GitHostKind,
    /// When it was added.
    #[garde(dive)]
    pub added_at: WireInstant,
}

/// The `git.host.list` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHostListResponse {
    /// The hosts.
    #[garde(dive)]
    pub hosts: Vec<GitHost>,
}

/// `git.host.add`: one host name and no kind, because the daemon keeps the kind of whichever
/// installed tool answers for it. Adding a host already listed answers with that host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitHostAddRequest {
    /// The host as typed.
    pub host: GitHostNameInput,
}

/// The `git.host.add` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHostAddResponse {
    /// The host.
    #[garde(dive)]
    pub host: GitHost,
}

/// `git.host.remove`: the host to forget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitHostRemoveRequest {
    /// The host as typed.
    pub host: GitHostNameInput,
}

/// The `git.host.remove` result; `removed` is false when the host was not listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitHostRemoveResponse {
    /// Whether it was listed.
    pub removed: bool,
}

/// A request keyed by the session alone; the daemon maps it to the session's folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitSessionRequest {
    /// The session.
    pub session_id: SessionId,
}

/// Declares a change-request type: the members a summary carries, then the type's own.
macro_rules! change_request {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// Its number on the host.
            pub number: ChangeRequestNumber,
            /// Its address on the host.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "HostingAddress")]
            pub url: Option<HostingAddress>,
            /// Where it stands.
            pub state: ChangeRequestState,
            /// Whether it is a draft.
            pub is_draft: bool,
            /// Whether the host can merge it; absent while the host works it out.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ChangeRequestMergeability")]
            pub mergeable: Option<ChangeRequestMergeability>,
            /// Its review decision; absent when the host recorded none.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ChangeRequestReviewDecision")]
            pub review_decision: Option<ChangeRequestReviewDecision>,
            $($own)*
        }
    };
}

change_request! {
    /// A change request as the header and the ship strip read it.
    pub struct ChangeRequestSummary {}
}

/// `git.changeRequest.subscribe`: the session's branch and the depth to read at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitChangeRequestSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
    /// The depth.
    pub depth: ChangeRequestReadDepth,
}

/// One comment in a review thread; the first is the note that opened it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ReviewThreadComment {
    /// The comment.
    pub comment_id: HostHandle,
    /// Its author.
    pub author: NonEmptyText,
    /// Its text.
    pub body: String,
    /// When it was written.
    #[garde(dive)]
    pub created_at: WireInstant,
}

/// One review thread, at the line it is about where it has one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ReviewThread {
    /// The thread.
    pub thread_id: HostHandle,
    /// Its file.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub path: Option<FilesystemPath>,
    /// Its line, from 1.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub line: Option<SafeInt<1>>,
    /// The line's side.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DiffSide")]
    pub side: Option<DiffSide>,
    /// Its state.
    pub state: ReviewThreadState,
    /// Its comments, at least the one that opened it.
    #[garde(dive)]
    pub comments: BoundedVec<ReviewThreadComment, 1, { usize::MAX }>,
}

/// One reviewer's latest verdict on a change request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeRequestReview {
    /// The reviewer.
    pub reviewer: NonEmptyText,
    /// Their verdict.
    pub verdict: ReviewerVerdict,
}

/// One check on the change request's head, with the address of its run on the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeRequestCheck {
    /// The check.
    pub check_id: HostHandle,
    /// Its name.
    pub name: NonEmptyText,
    /// Its outcome.
    pub status: ChangeRequestCheckStatus,
    /// Its run's address.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "HostingAddress")]
    pub run_url: Option<HostingAddress>,
}

change_request! {
    /// A change request as Review's pull-request tab reads it. `viewerIsAuthor` is true on the
    /// person's own request, where the host refuses an approval; `requestedReviewers` have been
    /// asked and have not answered; `headCommitId` is what the host holds now, so a request that
    /// moved past the loaded diff can be told apart.
    pub struct ChangeRequestDetail {
        /// Whether the person wrote it.
        pub viewer_is_author: bool,
        /// Its description.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "NonEmptyText")]
        pub description: Option<NonEmptyText>,
        /// Each reviewer's latest verdict.
        pub reviews: Vec<ChangeRequestReview>,
        /// The reviewers asked who have not answered.
        pub requested_reviewers: Vec<NonEmptyText>,
        /// Its review threads.
        #[garde(dive)]
        pub threads: Vec<ReviewThread>,
        /// Its checks.
        pub checks: Vec<ChangeRequestCheck>,
        /// The head commit the host holds now.
        pub head_commit_id: GitObjectId,
    }
}

/// One frame of `git.changeRequest.subscribe`: the branch's change requests, newest first, at
/// the depth asked for. `readAt` is the last successful read; a read that failed since keeps the
/// last state and sets `lastReadFailedAt`, so the tab never blanks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "depth",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChangeRequestFrame {
    /// The header's facts.
    Summary {
        /// The change requests.
        #[garde(dive)]
        requests: Vec<ChangeRequestSummary>,
        /// The last successful read.
        #[garde(dive)]
        read_at: WireInstant,
        /// The last failed read since.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        last_read_failed_at: Option<WireInstant>,
    },
    /// Review's.
    Full {
        /// The change requests.
        #[garde(dive)]
        requests: Vec<ChangeRequestDetail>,
        /// The last successful read.
        #[garde(dive)]
        read_at: WireInstant,
        /// The last failed read since.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        last_read_failed_at: Option<WireInstant>,
    },
}

/// `git.reviewer.list`; `query` narrows the candidates by what was typed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewerListRequest {
    /// The session.
    pub session_id: SessionId,
    /// What was typed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub query: Option<NonEmptyText>,
}

/// One reviewer candidate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewerCandidate {
    /// Their login.
    pub login: NonEmptyText,
    /// Their name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub name: Option<NonEmptyText>,
}

/// The `git.reviewer.list` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewerListResponse {
    /// The candidates.
    pub reviewers: Vec<ReviewerCandidate>,
}

/// One label candidate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelCandidate {
    /// Its name.
    pub name: NonEmptyText,
    /// Its description.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub description: Option<NonEmptyText>,
}

/// The `git.label.list` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitLabelListResponse {
    /// The candidates.
    pub labels: Vec<LabelCandidate>,
}

/// `git.review.submit`. The notes are the session's held notes, read from the daemon's own
/// store, so no note text crosses the wire; `body` is the verdict's one free-standing summary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewSubmitRequest {
    /// The session.
    pub session_id: SessionId,
    /// The change request.
    pub change_request_number: ChangeRequestNumber,
    /// The verdict.
    pub verdict: ReviewSubmitVerdict,
    /// The summary.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub body: Option<NonEmptyText>,
}

/// A note the host refused to post, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNoteFailure {
    /// The note.
    pub note_id: ReviewNoteId,
    /// The host's reason.
    pub reason: NonEmptyText,
}

/// The `git.review.submit` result. A review that fails part way says which notes posted and,
/// for each that did not, the host's reason; notes behind a failure stay held, so a second press
/// posts only what is still held.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewSubmitResponse {
    /// The review's address.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "HostingAddress")]
    pub review_url: Option<HostingAddress>,
    /// The notes posted.
    pub posted_note_ids: Vec<ReviewNoteId>,
    /// The notes refused.
    pub failures: Vec<ReviewNoteFailure>,
}

/// `git.reviewThread.resolve`: one thread of one change request; resolving a resolved thread
/// succeeds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewThreadResolveRequest {
    /// The session.
    pub session_id: SessionId,
    /// The change request.
    pub change_request_number: ChangeRequestNumber,
    /// The thread.
    pub thread_id: HostHandle,
}

literal! {
    /// The state a resolved thread reads.
    pub enum ResolvedThreadState = "resolved";
}

/// The `git.reviewThread.resolve` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewThreadResolveResponse {
    /// The thread.
    pub thread_id: HostHandle,
    /// Its state.
    pub state: ResolvedThreadState,
}

/// `git.reviewThread.reply`: a reply to one thread of one change request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewThreadReplyRequest {
    /// The session.
    pub session_id: SessionId,
    /// The change request.
    pub change_request_number: ChangeRequestNumber,
    /// The thread.
    pub thread_id: HostHandle,
    /// The reply.
    pub body: NonEmptyText,
}

/// The `git.reviewThread.reply` result: the posted comment and its address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitReviewThreadReplyResponse {
    /// The comment.
    pub comment_id: HostHandle,
    /// Its address.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "HostingAddress")]
    pub url: Option<HostingAddress>,
}

/// `git.checkLog.read`: one check of one change request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitCheckLogReadRequest {
    /// The session.
    pub session_id: SessionId,
    /// The change request.
    pub change_request_number: ChangeRequestNumber,
    /// The check.
    pub check_id: HostHandle,
}

/// The `git.checkLog.read` result: the end of the check's log, because the useful part of a
/// build log is the last of it. `truncated` says the start was left out and `totalBytes` how long
/// the whole log is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct GitCheckLogReadResponse {
    /// The log's tail.
    pub text: String,
    /// Whether the start was left out.
    pub truncated: bool,
    /// The whole log's size in bytes.
    pub total_bytes: SafeInt<0>,
    /// The run's address.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "HostingAddress")]
    pub run_url: Option<HostingAddress>,
}

/// The TypeScript module of what the hosting service answers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "git/hosting",
    doc: "What the hosting service answers: the self-hosted git hosts, the change requests on a \
          branch, the reviewer and label candidates, posting a review, answering a thread and \
          reading a failing check's log.",
    definitions: &[
        Definition::read::<GitHostKind>(),
        Definition::read::<ChangeRequestState>(),
        Definition::read::<ChangeRequestMergeability>(),
        Definition::read::<ChangeRequestReviewDecision>(),
        Definition::read::<ReviewerVerdict>(),
        Definition::read::<ReviewSubmitVerdict>(),
        Definition::read::<ChangeRequestCheckStatus>(),
        Definition::read::<ReviewThreadState>(),
        Definition::read::<DiffSide>(),
        Definition::read::<ChangeRequestReadDepth>(),
        Definition::read::<GitHostInvalidReason>(),
        Definition::read::<GitHostInvalidDetails>(),
        Definition::read::<GitHost>(),
        Definition::read::<GitHostListResponse>(),
        Definition::read::<GitHostAddRequest>(),
        Definition::read::<GitHostAddResponse>(),
        Definition::read::<GitHostRemoveRequest>(),
        Definition::read::<GitHostRemoveResponse>(),
        Definition::read::<GitSessionRequest>(),
        Definition::read::<ChangeRequestSummary>().checked(),
        Definition::read::<GitChangeRequestSubscribeRequest>(),
        Definition::read::<ReviewThreadComment>(),
        Definition::read::<ReviewThread>(),
        Definition::read::<ChangeRequestReview>(),
        Definition::read::<ChangeRequestCheck>(),
        Definition::read::<ChangeRequestDetail>(),
        Definition::read::<ChangeRequestFrame>().checked(),
        Definition::read::<GitReviewerListRequest>(),
        Definition::read::<ReviewerCandidate>(),
        Definition::read::<GitReviewerListResponse>(),
        Definition::read::<LabelCandidate>(),
        Definition::read::<GitLabelListResponse>(),
        Definition::read::<GitReviewSubmitRequest>(),
        Definition::read::<ReviewNoteFailure>(),
        Definition::read::<GitReviewSubmitResponse>(),
        Definition::read::<GitReviewThreadResolveRequest>(),
        Definition::read::<GitReviewThreadResolveResponse>(),
        Definition::read::<GitReviewThreadReplyRequest>(),
        Definition::read::<GitReviewThreadReplyResponse>(),
        Definition::read::<GitCheckLogReadRequest>(),
        Definition::read::<GitCheckLogReadResponse>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
