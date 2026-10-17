//! The `git.*` method table: the self-hosted hosts, the branch's facts and diff, the ship acts,
//! Generate, and the hosting service's change requests, reviews, threads and check logs.

use crate::git::hosting::{
    ChangeRequestFrame, GitChangeRequestSubscribeRequest, GitCheckLogReadRequest,
    GitCheckLogReadResponse, GitHostAddRequest, GitHostAddResponse, GitHostListResponse,
    GitHostRemoveRequest, GitHostRemoveResponse, GitLabelListResponse, GitReviewSubmitRequest,
    GitReviewSubmitResponse, GitReviewThreadReplyRequest, GitReviewThreadReplyResponse,
    GitReviewThreadResolveRequest, GitReviewThreadResolveResponse, GitReviewerListRequest,
    GitReviewerListResponse, GitSessionRequest,
};
use crate::git::local::{
    GitActFrame, GitActionExecuteRequest, GitActionExecuteResponse, GitActionPreviewRequest,
    GitActionPreviewResponse, GitActionSubscribeRequest, GitBranchContextReadResponse,
    GitChangeRequestTextGenerateResponse, GitCommitMessageGenerateResponse, GitDiffReadRequest,
    GitDiffReadResponse,
};
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::TypeScriptModule;

methods! {
    /// Every `git.*` method.
    pub const GIT_METHOD_DESCRIPTORS = [
        /// The machine's self-hosted git hosts.
        GitHostList = query "git.host.list" {
            mutating: false,
            params: EmptyPayload,
            result: GitHostListResponse,
            refusals: [],
        },
        /// Adds a self-hosted git host.
        GitHostAdd = mutation "git.host.add" {
            mutating: true,
            params: GitHostAddRequest,
            result: GitHostAddResponse,
            refusals: [GitHostInvalid],
        },
        /// Forgets a self-hosted git host.
        GitHostRemove = mutation "git.host.remove" {
            mutating: true,
            params: GitHostRemoveRequest,
            result: GitHostRemoveResponse,
            refusals: [],
        },
        /// The session branch's ship facts.
        GitBranchContextRead = query "git.branchContext.read" {
            mutating: false,
            params: GitSessionRequest,
            result: GitBranchContextReadResponse,
            refusals: [SessionNotFound, GitReadFailed],
        },
        /// One comparison's whole diff.
        GitDiffRead = query "git.diff.read" {
            mutating: false,
            params: GitDiffReadRequest,
            result: GitDiffReadResponse,
            refusals: [SessionNotFound, GitReadFailed],
        },
        /// The exact commands a ship act will run.
        GitActionPreview = query "git.action.preview" {
            mutating: false,
            params: GitActionPreviewRequest,
            result: GitActionPreviewResponse,
            refusals: [SessionNotFound],
        },
        /// Runs a ship act, or resumes one at its failed command.
        GitActionExecute = mutation "git.action.execute" {
            mutating: true,
            params: GitActionExecuteRequest,
            result: GitActionExecuteResponse,
            refusals: [SessionNotFound],
        },
        /// Follows a ship act's commands.
        GitActionSubscribe = subscription "git.action.subscribe" {
            mutating: false,
            params: GitActionSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: GitActFrame,
            refusals: [],
        },
        /// Generates a commit message.
        GitCommitMessageGenerate = mutation "git.commitMessage.generate" {
            mutating: false,
            params: GitSessionRequest,
            result: GitCommitMessageGenerateResponse,
            refusals: [
                SessionNotFound,
                GitGenerateFailed,
                GitGenerateRefused,
                ProviderAccountNotAuthenticated,
                ProviderAccountAllowanceExhausted,
                ProviderTimeout,
                ProviderNotInstalled,
                SystemInternalError,
            ],
        },
        /// Generates a change request's title and description.
        GitChangeRequestTextGenerate = mutation "git.changeRequest.text.generate" {
            mutating: false,
            params: GitSessionRequest,
            result: GitChangeRequestTextGenerateResponse,
            refusals: [
                SessionNotFound,
                GitGenerateFailed,
                GitGenerateRefused,
                ProviderAccountNotAuthenticated,
                ProviderAccountAllowanceExhausted,
                ProviderTimeout,
                ProviderNotInstalled,
                SystemInternalError,
            ],
        },
        /// Follows the branch's change requests at one depth.
        GitChangeRequestSubscribe = subscription "git.changeRequest.subscribe" {
            mutating: false,
            params: GitChangeRequestSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: ChangeRequestFrame,
            refusals: [SessionNotFound],
        },
        /// The reviewer candidates.
        GitReviewerList = query "git.reviewer.list" {
            mutating: false,
            params: GitReviewerListRequest,
            result: GitReviewerListResponse,
            refusals: [SessionNotFound, GitReadFailed],
        },
        /// The label candidates.
        GitLabelList = query "git.label.list" {
            mutating: false,
            params: GitSessionRequest,
            result: GitLabelListResponse,
            refusals: [SessionNotFound, GitReadFailed],
        },
        /// Posts the session's held notes as one review.
        GitReviewSubmit = mutation "git.review.submit" {
            mutating: true,
            params: GitReviewSubmitRequest,
            result: GitReviewSubmitResponse,
            refusals: [SessionNotFound],
        },
        /// Resolves a review thread.
        GitReviewThreadResolve = mutation "git.reviewThread.resolve" {
            mutating: true,
            params: GitReviewThreadResolveRequest,
            result: GitReviewThreadResolveResponse,
            refusals: [SessionNotFound],
        },
        /// Replies to a review thread.
        GitReviewThreadReply = mutation "git.reviewThread.reply" {
            mutating: true,
            params: GitReviewThreadReplyRequest,
            result: GitReviewThreadReplyResponse,
            refusals: [SessionNotFound],
        },
        /// The end of a check's log.
        GitCheckLogRead = query "git.checkLog.read" {
            mutating: false,
            params: GitCheckLogReadRequest,
            result: GitCheckLogReadResponse,
            refusals: [SessionNotFound, GitReadFailed],
        },
    ];
}

/// The TypeScript module of the `git.*` method table.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "git/methods",
    doc: "Every git method.",
    definitions: &[],
    constants: &[],
    method_tables: &[&GIT_METHOD_DESCRIPTORS],
};
