// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Every git method.

import type { SchemaCheck } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import {
  type ChangeRequestFrame,
  type GitChangeRequestSubscribeRequest,
  type GitCheckLogReadRequest,
  type GitCheckLogReadResponse,
  type GitHostAddRequest,
  type GitHostAddResponse,
  type GitHostListResponse,
  type GitHostRemoveRequest,
  type GitHostRemoveResponse,
  type GitLabelListResponse,
  type GitReviewSubmitRequest,
  type GitReviewSubmitResponse,
  type GitReviewThreadReplyRequest,
  type GitReviewThreadReplyResponse,
  type GitReviewThreadResolveRequest,
  type GitReviewThreadResolveResponse,
  type GitReviewerListRequest,
  type GitReviewerListResponse,
  type GitSessionRequest,
  validateChangeRequestFrame,
  validateGitChangeRequestSubscribeRequest,
  validateGitCheckLogReadRequest,
  validateGitCheckLogReadResponse,
  validateGitHostAddRequest,
  validateGitHostAddResponse,
  validateGitHostListResponse,
  validateGitHostRemoveRequest,
  validateGitHostRemoveResponse,
  validateGitLabelListResponse,
  validateGitReviewSubmitRequest,
  validateGitReviewSubmitResponse,
  validateGitReviewThreadReplyRequest,
  validateGitReviewThreadReplyResponse,
  validateGitReviewThreadResolveRequest,
  validateGitReviewThreadResolveResponse,
  validateGitReviewerListRequest,
  validateGitReviewerListResponse,
  validateGitSessionRequest,
} from "./hosting.js";
import {
  type GitActFrame,
  type GitActionExecuteRequest,
  type GitActionExecuteResponse,
  type GitActionPreviewRequest,
  type GitActionPreviewResponse,
  type GitActionSubscribeRequest,
  type GitBranchContextReadResponse,
  type GitChangeRequestTextGenerateResponse,
  type GitCommitMessageGenerateResponse,
  type GitDiffReadRequest,
  type GitDiffReadResponse,
  validateGitActFrame,
  validateGitActionExecuteRequest,
  validateGitActionExecuteResponse,
  validateGitActionPreviewRequest,
  validateGitActionPreviewResponse,
  validateGitActionSubscribeRequest,
  validateGitBranchContextReadResponse,
  validateGitChangeRequestTextGenerateResponse,
  validateGitCommitMessageGenerateResponse,
  validateGitDiffReadRequest,
  validateGitDiffReadResponse,
} from "./local.js";

/** The methods of {@link GIT_METHOD_DESCRIPTORS}, each with its checks. */
export interface GitMethodDescriptors {
  readonly "git.host.list": {
    readonly method: "git.host.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<GitHostListResponse>;
  };
  readonly "git.host.add": {
    readonly method: "git.host.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<GitHostAddRequest>;
    readonly responseCheck: SchemaCheck<GitHostAddResponse>;
  };
  readonly "git.host.remove": {
    readonly method: "git.host.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<GitHostRemoveRequest>;
    readonly responseCheck: SchemaCheck<GitHostRemoveResponse>;
  };
  readonly "git.branchContext.read": {
    readonly method: "git.branchContext.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitSessionRequest>;
    readonly responseCheck: SchemaCheck<GitBranchContextReadResponse>;
  };
  readonly "git.diff.read": {
    readonly method: "git.diff.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitDiffReadRequest>;
    readonly responseCheck: SchemaCheck<GitDiffReadResponse>;
  };
  readonly "git.action.preview": {
    readonly method: "git.action.preview";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitActionPreviewRequest>;
    readonly responseCheck: SchemaCheck<GitActionPreviewResponse>;
  };
  readonly "git.action.execute": {
    readonly method: "git.action.execute";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<GitActionExecuteRequest>;
    readonly responseCheck: SchemaCheck<GitActionExecuteResponse>;
  };
  readonly "git.action.subscribe": {
    readonly method: "git.action.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitActionSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<GitActFrame>;
  };
  readonly "git.commitMessage.generate": {
    readonly method: "git.commitMessage.generate";
    readonly procedureType: "mutation";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitSessionRequest>;
    readonly responseCheck: SchemaCheck<GitCommitMessageGenerateResponse>;
  };
  readonly "git.changeRequest.text.generate": {
    readonly method: "git.changeRequest.text.generate";
    readonly procedureType: "mutation";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitSessionRequest>;
    readonly responseCheck: SchemaCheck<GitChangeRequestTextGenerateResponse>;
  };
  readonly "git.changeRequest.subscribe": {
    readonly method: "git.changeRequest.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitChangeRequestSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ChangeRequestFrame>;
  };
  readonly "git.reviewer.list": {
    readonly method: "git.reviewer.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitReviewerListRequest>;
    readonly responseCheck: SchemaCheck<GitReviewerListResponse>;
  };
  readonly "git.label.list": {
    readonly method: "git.label.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitSessionRequest>;
    readonly responseCheck: SchemaCheck<GitLabelListResponse>;
  };
  readonly "git.review.submit": {
    readonly method: "git.review.submit";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<GitReviewSubmitRequest>;
    readonly responseCheck: SchemaCheck<GitReviewSubmitResponse>;
  };
  readonly "git.reviewThread.resolve": {
    readonly method: "git.reviewThread.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<GitReviewThreadResolveRequest>;
    readonly responseCheck: SchemaCheck<GitReviewThreadResolveResponse>;
  };
  readonly "git.reviewThread.reply": {
    readonly method: "git.reviewThread.reply";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<GitReviewThreadReplyRequest>;
    readonly responseCheck: SchemaCheck<GitReviewThreadReplyResponse>;
  };
  readonly "git.checkLog.read": {
    readonly method: "git.checkLog.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<GitCheckLogReadRequest>;
    readonly responseCheck: SchemaCheck<GitCheckLogReadResponse>;
  };
}
/** Every `git.*` method. */
export const GIT_METHOD_DESCRIPTORS: GitMethodDescriptors = Object.freeze({
  "git.host.list": Object.freeze({
    method: "git.host.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateGitHostListResponse,
  }),
  "git.host.add": Object.freeze({
    method: "git.host.add",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateGitHostAddRequest,
    responseCheck: validateGitHostAddResponse,
  }),
  "git.host.remove": Object.freeze({
    method: "git.host.remove",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateGitHostRemoveRequest,
    responseCheck: validateGitHostRemoveResponse,
  }),
  "git.branchContext.read": Object.freeze({
    method: "git.branchContext.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateGitSessionRequest,
    responseCheck: validateGitBranchContextReadResponse,
  }),
  "git.diff.read": Object.freeze({
    method: "git.diff.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateGitDiffReadRequest,
    responseCheck: validateGitDiffReadResponse,
  }),
  "git.action.preview": Object.freeze({
    method: "git.action.preview",
    procedureType: "query",
    mutating: false,
    requestCheck: validateGitActionPreviewRequest,
    responseCheck: validateGitActionPreviewResponse,
  }),
  "git.action.execute": Object.freeze({
    method: "git.action.execute",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateGitActionExecuteRequest,
    responseCheck: validateGitActionExecuteResponse,
  }),
  "git.action.subscribe": Object.freeze({
    method: "git.action.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateGitActionSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateGitActFrame,
  }),
  "git.commitMessage.generate": Object.freeze({
    method: "git.commitMessage.generate",
    procedureType: "mutation",
    mutating: false,
    requestCheck: validateGitSessionRequest,
    responseCheck: validateGitCommitMessageGenerateResponse,
  }),
  "git.changeRequest.text.generate": Object.freeze({
    method: "git.changeRequest.text.generate",
    procedureType: "mutation",
    mutating: false,
    requestCheck: validateGitSessionRequest,
    responseCheck: validateGitChangeRequestTextGenerateResponse,
  }),
  "git.changeRequest.subscribe": Object.freeze({
    method: "git.changeRequest.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateGitChangeRequestSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateChangeRequestFrame,
  }),
  "git.reviewer.list": Object.freeze({
    method: "git.reviewer.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateGitReviewerListRequest,
    responseCheck: validateGitReviewerListResponse,
  }),
  "git.label.list": Object.freeze({
    method: "git.label.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateGitSessionRequest,
    responseCheck: validateGitLabelListResponse,
  }),
  "git.review.submit": Object.freeze({
    method: "git.review.submit",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateGitReviewSubmitRequest,
    responseCheck: validateGitReviewSubmitResponse,
  }),
  "git.reviewThread.resolve": Object.freeze({
    method: "git.reviewThread.resolve",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateGitReviewThreadResolveRequest,
    responseCheck: validateGitReviewThreadResolveResponse,
  }),
  "git.reviewThread.reply": Object.freeze({
    method: "git.reviewThread.reply",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateGitReviewThreadReplyRequest,
    responseCheck: validateGitReviewThreadReplyResponse,
  }),
  "git.checkLog.read": Object.freeze({
    method: "git.checkLog.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateGitCheckLogReadRequest,
    responseCheck: validateGitCheckLogReadResponse,
  }),
});
