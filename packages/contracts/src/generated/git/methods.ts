// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Every git method.

import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type {
  ChangeRequestFrame,
  GitChangeRequestSubscribeRequest,
  GitCheckLogReadRequest,
  GitCheckLogReadResponse,
  GitHostAddRequest,
  GitHostAddResponse,
  GitHostListResponse,
  GitHostRemoveRequest,
  GitHostRemoveResponse,
  GitLabelListResponse,
  GitReviewSubmitRequest,
  GitReviewSubmitResponse,
  GitReviewThreadReplyRequest,
  GitReviewThreadReplyResponse,
  GitReviewThreadResolveRequest,
  GitReviewThreadResolveResponse,
  GitReviewerListRequest,
  GitReviewerListResponse,
  GitSessionRequest,
} from "./hosting.js";
import type {
  GitActFrame,
  GitActionExecuteRequest,
  GitActionExecuteResponse,
  GitActionPreviewRequest,
  GitActionPreviewResponse,
  GitActionSubscribeRequest,
  GitBranchContextReadResponse,
  GitChangeRequestTextGenerateResponse,
  GitCommitMessageGenerateResponse,
  GitDiffReadRequest,
  GitDiffReadResponse,
} from "./local.js";

/** The methods of {@link GIT_METHOD_DESCRIPTORS}, each with its kind. */
export interface GitMethodDescriptors {
  readonly "git.host.list": {
    readonly method: "git.host.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "git.host.add": {
    readonly method: "git.host.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "git.host.remove": {
    readonly method: "git.host.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "git.branchContext.read": {
    readonly method: "git.branchContext.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "git.diff.read": {
    readonly method: "git.diff.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "git.action.preview": {
    readonly method: "git.action.preview";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "git.action.execute": {
    readonly method: "git.action.execute";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "git.action.subscribe": {
    readonly method: "git.action.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "git.commitMessage.generate": {
    readonly method: "git.commitMessage.generate";
    readonly procedureType: "mutation";
    readonly mutating: false;
  };
  readonly "git.changeRequest.text.generate": {
    readonly method: "git.changeRequest.text.generate";
    readonly procedureType: "mutation";
    readonly mutating: false;
  };
  readonly "git.changeRequest.subscribe": {
    readonly method: "git.changeRequest.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "git.reviewer.list": {
    readonly method: "git.reviewer.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "git.label.list": {
    readonly method: "git.label.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "git.review.submit": {
    readonly method: "git.review.submit";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "git.reviewThread.resolve": {
    readonly method: "git.reviewThread.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "git.reviewThread.reply": {
    readonly method: "git.reviewThread.reply";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "git.checkLog.read": {
    readonly method: "git.checkLog.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link GIT_METHOD_DESCRIPTORS}. */
export interface GitMethodTypes {
  readonly "git.host.list": { readonly params: EmptyPayload; readonly result: GitHostListResponse };
  readonly "git.host.add": {
    readonly params: GitHostAddRequest;
    readonly result: GitHostAddResponse;
  };
  readonly "git.host.remove": {
    readonly params: GitHostRemoveRequest;
    readonly result: GitHostRemoveResponse;
  };
  readonly "git.branchContext.read": {
    readonly params: GitSessionRequest;
    readonly result: GitBranchContextReadResponse;
  };
  readonly "git.diff.read": {
    readonly params: GitDiffReadRequest;
    readonly result: GitDiffReadResponse;
  };
  readonly "git.action.preview": {
    readonly params: GitActionPreviewRequest;
    readonly result: GitActionPreviewResponse;
  };
  readonly "git.action.execute": {
    readonly params: GitActionExecuteRequest;
    readonly result: GitActionExecuteResponse;
  };
  readonly "git.action.subscribe": {
    readonly params: GitActionSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: GitActFrame;
  };
  readonly "git.commitMessage.generate": {
    readonly params: GitSessionRequest;
    readonly result: GitCommitMessageGenerateResponse;
  };
  readonly "git.changeRequest.text.generate": {
    readonly params: GitSessionRequest;
    readonly result: GitChangeRequestTextGenerateResponse;
  };
  readonly "git.changeRequest.subscribe": {
    readonly params: GitChangeRequestSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ChangeRequestFrame;
  };
  readonly "git.reviewer.list": {
    readonly params: GitReviewerListRequest;
    readonly result: GitReviewerListResponse;
  };
  readonly "git.label.list": {
    readonly params: GitSessionRequest;
    readonly result: GitLabelListResponse;
  };
  readonly "git.review.submit": {
    readonly params: GitReviewSubmitRequest;
    readonly result: GitReviewSubmitResponse;
  };
  readonly "git.reviewThread.resolve": {
    readonly params: GitReviewThreadResolveRequest;
    readonly result: GitReviewThreadResolveResponse;
  };
  readonly "git.reviewThread.reply": {
    readonly params: GitReviewThreadReplyRequest;
    readonly result: GitReviewThreadReplyResponse;
  };
  readonly "git.checkLog.read": {
    readonly params: GitCheckLogReadRequest;
    readonly result: GitCheckLogReadResponse;
  };
}
/** Every `git.*` method. */
export const GIT_METHOD_DESCRIPTORS: GitMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "git.host.list": /* @__PURE__ */ Object.freeze({
    method: "git.host.list",
    procedureType: "query",
    mutating: false,
  }),
  "git.host.add": /* @__PURE__ */ Object.freeze({
    method: "git.host.add",
    procedureType: "mutation",
    mutating: true,
  }),
  "git.host.remove": /* @__PURE__ */ Object.freeze({
    method: "git.host.remove",
    procedureType: "mutation",
    mutating: true,
  }),
  "git.branchContext.read": /* @__PURE__ */ Object.freeze({
    method: "git.branchContext.read",
    procedureType: "query",
    mutating: false,
  }),
  "git.diff.read": /* @__PURE__ */ Object.freeze({
    method: "git.diff.read",
    procedureType: "query",
    mutating: false,
  }),
  "git.action.preview": /* @__PURE__ */ Object.freeze({
    method: "git.action.preview",
    procedureType: "query",
    mutating: false,
  }),
  "git.action.execute": /* @__PURE__ */ Object.freeze({
    method: "git.action.execute",
    procedureType: "mutation",
    mutating: true,
  }),
  "git.action.subscribe": /* @__PURE__ */ Object.freeze({
    method: "git.action.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "git.commitMessage.generate": /* @__PURE__ */ Object.freeze({
    method: "git.commitMessage.generate",
    procedureType: "mutation",
    mutating: false,
  }),
  "git.changeRequest.text.generate": /* @__PURE__ */ Object.freeze({
    method: "git.changeRequest.text.generate",
    procedureType: "mutation",
    mutating: false,
  }),
  "git.changeRequest.subscribe": /* @__PURE__ */ Object.freeze({
    method: "git.changeRequest.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "git.reviewer.list": /* @__PURE__ */ Object.freeze({
    method: "git.reviewer.list",
    procedureType: "query",
    mutating: false,
  }),
  "git.label.list": /* @__PURE__ */ Object.freeze({
    method: "git.label.list",
    procedureType: "query",
    mutating: false,
  }),
  "git.review.submit": /* @__PURE__ */ Object.freeze({
    method: "git.review.submit",
    procedureType: "mutation",
    mutating: true,
  }),
  "git.reviewThread.resolve": /* @__PURE__ */ Object.freeze({
    method: "git.reviewThread.resolve",
    procedureType: "mutation",
    mutating: true,
  }),
  "git.reviewThread.reply": /* @__PURE__ */ Object.freeze({
    method: "git.reviewThread.reply",
    procedureType: "mutation",
    mutating: true,
  }),
  "git.checkLog.read": /* @__PURE__ */ Object.freeze({
    method: "git.checkLog.read",
    procedureType: "query",
    mutating: false,
  }),
});
