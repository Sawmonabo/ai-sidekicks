//! The `gitflow.*` method table: the self-hosted hosts, the branch's facts and diff, the ship acts,
//! Generate, and the hosting service's change requests, reviews, threads and check logs.

use crate::gitflow::hosting::{
    ChangeRequestFrame, GitflowChangeRequestSubscribeRequest, GitflowCheckLogReadRequest,
    GitflowCheckLogReadResponse, GitflowHostAddRequest, GitflowHostAddResponse,
    GitflowHostListResponse, GitflowHostRemoveRequest, GitflowHostRemoveResponse,
    GitflowLabelListResponse, GitflowReviewSubmitRequest, GitflowReviewSubmitResponse,
    GitflowReviewerListRequest, GitflowReviewerListResponse, GitflowSessionRequest,
    GitflowThreadReplyRequest, GitflowThreadReplyResponse, GitflowThreadResolveRequest,
    GitflowThreadResolveResponse,
};
use crate::gitflow::local::{
    GitActFrame, GitflowBranchContextReadResponse, GitflowChangeRequestTextGenerateResponse,
    GitflowCommitMessageGenerateResponse, GitflowDiffReadRequest, GitflowDiffReadResponse,
    GitflowGitActionExecuteRequest, GitflowGitActionExecuteResponse,
    GitflowGitActionPreviewRequest, GitflowGitActionPreviewResponse,
    GitflowGitActionSubscribeRequest,
};
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::TypeScriptModule;

methods! {
    /// Every `gitflow.*` method.
    pub const GITFLOW_METHOD_DESCRIPTORS = [
        /// The machine's self-hosted git hosts.
        GitflowHostList = query "git.host.list" {
            mutating: false,
            params: EmptyPayload,
            result: GitflowHostListResponse,
            refusals: [],
        },
        /// Adds a self-hosted git host.
        GitflowHostAdd = mutation "git.host.add" {
            mutating: true,
            params: GitflowHostAddRequest,
            result: GitflowHostAddResponse,
            refusals: [GitflowHostInvalid],
        },
        /// Forgets a self-hosted git host.
        GitflowHostRemove = mutation "git.host.remove" {
            mutating: true,
            params: GitflowHostRemoveRequest,
            result: GitflowHostRemoveResponse,
            refusals: [],
        },
        /// The session branch's ship facts.
        GitflowBranchContextRead = query "git.branchContext.read" {
            mutating: false,
            params: GitflowSessionRequest,
            result: GitflowBranchContextReadResponse,
            refusals: [SessionNotFound, GitflowReadFailed],
        },
        /// One comparison's whole diff.
        GitflowDiffRead = query "git.diff.read" {
            mutating: false,
            params: GitflowDiffReadRequest,
            result: GitflowDiffReadResponse,
            refusals: [SessionNotFound, GitflowReadFailed],
        },
        /// The exact commands a ship act will run.
        GitflowGitActionPreview = query "git.action.preview" {
            mutating: false,
            params: GitflowGitActionPreviewRequest,
            result: GitflowGitActionPreviewResponse,
            refusals: [SessionNotFound],
        },
        /// Runs a ship act, or resumes one at its failed command.
        GitflowGitActionExecute = mutation "git.action.execute" {
            mutating: true,
            params: GitflowGitActionExecuteRequest,
            result: GitflowGitActionExecuteResponse,
            refusals: [SessionNotFound],
        },
        /// Follows a ship act's commands.
        GitflowGitActionSubscribe = subscription "git.action.subscribe" {
            mutating: false,
            params: GitflowGitActionSubscribeRequest,
            result: SubscribeAckResponse,
            emission: GitActFrame,
            refusals: [],
        },
        /// Generates a commit message.
        GitflowCommitMessageGenerate = mutation "git.commitMessage.generate" {
            mutating: false,
            params: GitflowSessionRequest,
            result: GitflowCommitMessageGenerateResponse,
            refusals: [SessionNotFound, GitflowGenerateFailed],
        },
        /// Generates a change request's title and description.
        GitflowChangeRequestTextGenerate = mutation "git.changeRequest.text.generate" {
            mutating: false,
            params: GitflowSessionRequest,
            result: GitflowChangeRequestTextGenerateResponse,
            refusals: [SessionNotFound, GitflowGenerateFailed],
        },
        /// Follows the branch's change requests at one depth.
        GitflowChangeRequestSubscribe = subscription "git.changeRequest.subscribe" {
            mutating: false,
            params: GitflowChangeRequestSubscribeRequest,
            result: SubscribeAckResponse,
            emission: ChangeRequestFrame,
            refusals: [SessionNotFound],
        },
        /// The reviewer candidates.
        GitflowReviewerList = query "git.reviewer.list" {
            mutating: false,
            params: GitflowReviewerListRequest,
            result: GitflowReviewerListResponse,
            refusals: [SessionNotFound, GitflowReadFailed],
        },
        /// The label candidates.
        GitflowLabelList = query "git.label.list" {
            mutating: false,
            params: GitflowSessionRequest,
            result: GitflowLabelListResponse,
            refusals: [SessionNotFound, GitflowReadFailed],
        },
        /// Posts the session's held notes as one review.
        GitflowReviewSubmit = mutation "git.review.submit" {
            mutating: true,
            params: GitflowReviewSubmitRequest,
            result: GitflowReviewSubmitResponse,
            refusals: [SessionNotFound],
        },
        /// Resolves a review thread.
        GitflowThreadResolve = mutation "git.reviewThread.resolve" {
            mutating: true,
            params: GitflowThreadResolveRequest,
            result: GitflowThreadResolveResponse,
            refusals: [SessionNotFound],
        },
        /// Replies to a review thread.
        GitflowThreadReply = mutation "git.reviewThread.reply" {
            mutating: true,
            params: GitflowThreadReplyRequest,
            result: GitflowThreadReplyResponse,
            refusals: [SessionNotFound],
        },
        /// The end of a check's log.
        GitflowCheckLogRead = query "git.checkLog.read" {
            mutating: false,
            params: GitflowCheckLogReadRequest,
            result: GitflowCheckLogReadResponse,
            refusals: [SessionNotFound, GitflowReadFailed],
        },
    ];
}

/// The TypeScript module of the `gitflow.*` method table.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "gitflow/methods",
    doc: "Every gitflow method.",
    definitions: &[],
    constants: &[],
    method_tables: &[&GITFLOW_METHOD_DESCRIPTORS],
};
