// The `gitflow.*` descriptor table: each method's name, procedure type, whether it
// changes state, and the schemas the registry validates its request, its result and
// (for a subscription) each emission against. A descriptor registers nothing.
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "../method-descriptor.js";

import {
  ChangeRequestFrameSchema,
  GitflowChangeRequestSubscribeRequestSchema,
  GitflowCheckLogReadRequestSchema,
  GitflowCheckLogReadResponseSchema,
  GitflowHostAddRequestSchema,
  GitflowHostAddResponseSchema,
  GitflowHostListRequestSchema,
  GitflowHostListResponseSchema,
  GitflowHostRemoveRequestSchema,
  GitflowHostRemoveResponseSchema,
  GitflowLabelListResponseSchema,
  GitflowReviewSubmitRequestSchema,
  GitflowReviewSubmitResponseSchema,
  GitflowReviewerListRequestSchema,
  GitflowReviewerListResponseSchema,
  GitflowSessionRequestSchema,
  GitflowThreadReplyRequestSchema,
  GitflowThreadReplyResponseSchema,
  GitflowThreadResolveRequestSchema,
  GitflowThreadResolveResponseSchema,
  type ChangeRequestFrame,
  type GitflowChangeRequestSubscribeRequest,
  type GitflowCheckLogReadRequest,
  type GitflowCheckLogReadResponse,
  type GitflowHostAddRequest,
  type GitflowHostAddResponse,
  type GitflowHostListRequest,
  type GitflowHostListResponse,
  type GitflowHostRemoveRequest,
  type GitflowHostRemoveResponse,
  type GitflowLabelListResponse,
  type GitflowReviewSubmitRequest,
  type GitflowReviewSubmitResponse,
  type GitflowReviewerListRequest,
  type GitflowReviewerListResponse,
  type GitflowSessionRequest,
  type GitflowThreadReplyRequest,
  type GitflowThreadReplyResponse,
  type GitflowThreadRequest,
  type GitflowThreadResolveResponse,
} from "./hosting.js";
import {
  GitActFrameSchema,
  GitflowBranchContextReadResponseSchema,
  GitflowChangeRequestTextGenerateResponseSchema,
  GitflowCommitMessageGenerateResponseSchema,
  GitflowDiffReadRequestSchema,
  GitflowDiffReadResponseSchema,
  GitflowGitActionExecuteRequestSchema,
  GitflowGitActionExecuteResponseSchema,
  GitflowGitActionPreviewRequestSchema,
  GitflowGitActionPreviewResponseSchema,
  GitflowGitActionSubscribeRequestSchema,
  type GitActFrame,
  type GitflowBranchContextReadResponse,
  type GitflowChangeRequestTextGenerateResponse,
  type GitflowCommitMessageGenerateResponse,
  type GitflowDiffReadRequest,
  type GitflowDiffReadResponse,
  type GitflowGitActionExecuteRequest,
  type GitflowGitActionExecuteResponse,
  type GitflowGitActionPreviewRequest,
  type GitflowGitActionPreviewResponse,
  type GitflowGitActionSubscribeRequest,
} from "./local.js";

/** Every `gitflow.*` method, keyed by name. */
export interface GitflowMethodDescriptors {
  readonly "gitflow.hostList": MethodDescriptor<
    "gitflow.hostList",
    GitflowHostListRequest,
    GitflowHostListResponse
  >;
  readonly "gitflow.hostAdd": MethodDescriptor<
    "gitflow.hostAdd",
    GitflowHostAddRequest,
    GitflowHostAddResponse
  >;
  readonly "gitflow.hostRemove": MethodDescriptor<
    "gitflow.hostRemove",
    GitflowHostRemoveRequest,
    GitflowHostRemoveResponse
  >;
  readonly "gitflow.branchContextRead": MethodDescriptor<
    "gitflow.branchContextRead",
    GitflowSessionRequest,
    GitflowBranchContextReadResponse
  >;
  readonly "gitflow.diffRead": MethodDescriptor<
    "gitflow.diffRead",
    GitflowDiffReadRequest,
    GitflowDiffReadResponse
  >;
  readonly "gitflow.gitActionPreview": MethodDescriptor<
    "gitflow.gitActionPreview",
    GitflowGitActionPreviewRequest,
    GitflowGitActionPreviewResponse
  >;
  readonly "gitflow.gitActionExecute": MethodDescriptor<
    "gitflow.gitActionExecute",
    GitflowGitActionExecuteRequest,
    GitflowGitActionExecuteResponse
  >;
  readonly "gitflow.gitActionSubscribe": SubscriptionMethodDescriptor<
    "gitflow.gitActionSubscribe",
    GitflowGitActionSubscribeRequest,
    SubscribeAckResponse,
    GitActFrame
  >;
  readonly "gitflow.commitMessageGenerate": MethodDescriptor<
    "gitflow.commitMessageGenerate",
    GitflowSessionRequest,
    GitflowCommitMessageGenerateResponse
  >;
  readonly "gitflow.changeRequestTextGenerate": MethodDescriptor<
    "gitflow.changeRequestTextGenerate",
    GitflowSessionRequest,
    GitflowChangeRequestTextGenerateResponse
  >;
  readonly "gitflow.changeRequestSubscribe": SubscriptionMethodDescriptor<
    "gitflow.changeRequestSubscribe",
    GitflowChangeRequestSubscribeRequest,
    SubscribeAckResponse,
    ChangeRequestFrame
  >;
  readonly "gitflow.reviewerList": MethodDescriptor<
    "gitflow.reviewerList",
    GitflowReviewerListRequest,
    GitflowReviewerListResponse
  >;
  readonly "gitflow.labelList": MethodDescriptor<
    "gitflow.labelList",
    GitflowSessionRequest,
    GitflowLabelListResponse
  >;
  readonly "gitflow.reviewSubmit": MethodDescriptor<
    "gitflow.reviewSubmit",
    GitflowReviewSubmitRequest,
    GitflowReviewSubmitResponse
  >;
  readonly "gitflow.threadResolve": MethodDescriptor<
    "gitflow.threadResolve",
    GitflowThreadRequest,
    GitflowThreadResolveResponse
  >;
  readonly "gitflow.threadReply": MethodDescriptor<
    "gitflow.threadReply",
    GitflowThreadReplyRequest,
    GitflowThreadReplyResponse
  >;
  readonly "gitflow.checkLogRead": MethodDescriptor<
    "gitflow.checkLogRead",
    GitflowCheckLogReadRequest,
    GitflowCheckLogReadResponse
  >;
}

/**
 * The `gitflow.*` descriptor table. Generating text is a `mutation` because each press
 * writes anew, yet it changes no stored state, so it is not `mutating`.
 */
export const GITFLOW_METHOD_DESCRIPTORS: GitflowMethodDescriptors = defineMethodDescriptors({
  "gitflow.hostList": {
    method: "gitflow.hostList",
    procedureType: "query",
    mutating: false,
    requestSchema: GitflowHostListRequestSchema,
    responseSchema: GitflowHostListResponseSchema,
  },
  "gitflow.hostAdd": {
    method: "gitflow.hostAdd",
    procedureType: "mutation",
    mutating: true,
    requestSchema: GitflowHostAddRequestSchema,
    responseSchema: GitflowHostAddResponseSchema,
  },
  "gitflow.hostRemove": {
    method: "gitflow.hostRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: GitflowHostRemoveRequestSchema,
    responseSchema: GitflowHostRemoveResponseSchema,
  },
  "gitflow.branchContextRead": {
    method: "gitflow.branchContextRead",
    procedureType: "query",
    mutating: false,
    requestSchema: GitflowSessionRequestSchema,
    responseSchema: GitflowBranchContextReadResponseSchema,
  },
  "gitflow.diffRead": {
    method: "gitflow.diffRead",
    procedureType: "query",
    mutating: false,
    requestSchema: GitflowDiffReadRequestSchema,
    responseSchema: GitflowDiffReadResponseSchema,
  },
  "gitflow.gitActionPreview": {
    method: "gitflow.gitActionPreview",
    procedureType: "query",
    mutating: false,
    requestSchema: GitflowGitActionPreviewRequestSchema,
    responseSchema: GitflowGitActionPreviewResponseSchema,
  },
  "gitflow.gitActionExecute": {
    method: "gitflow.gitActionExecute",
    procedureType: "mutation",
    mutating: true,
    requestSchema: GitflowGitActionExecuteRequestSchema,
    responseSchema: GitflowGitActionExecuteResponseSchema,
  },
  "gitflow.gitActionSubscribe": {
    method: "gitflow.gitActionSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: GitflowGitActionSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: GitActFrameSchema,
  },
  "gitflow.commitMessageGenerate": {
    method: "gitflow.commitMessageGenerate",
    procedureType: "mutation",
    mutating: false,
    requestSchema: GitflowSessionRequestSchema,
    responseSchema: GitflowCommitMessageGenerateResponseSchema,
  },
  "gitflow.changeRequestTextGenerate": {
    method: "gitflow.changeRequestTextGenerate",
    procedureType: "mutation",
    mutating: false,
    requestSchema: GitflowSessionRequestSchema,
    responseSchema: GitflowChangeRequestTextGenerateResponseSchema,
  },
  "gitflow.changeRequestSubscribe": {
    method: "gitflow.changeRequestSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: GitflowChangeRequestSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: ChangeRequestFrameSchema,
  },
  "gitflow.reviewerList": {
    method: "gitflow.reviewerList",
    procedureType: "query",
    mutating: false,
    requestSchema: GitflowReviewerListRequestSchema,
    responseSchema: GitflowReviewerListResponseSchema,
  },
  "gitflow.labelList": {
    method: "gitflow.labelList",
    procedureType: "query",
    mutating: false,
    requestSchema: GitflowSessionRequestSchema,
    responseSchema: GitflowLabelListResponseSchema,
  },
  "gitflow.reviewSubmit": {
    method: "gitflow.reviewSubmit",
    procedureType: "mutation",
    mutating: true,
    requestSchema: GitflowReviewSubmitRequestSchema,
    responseSchema: GitflowReviewSubmitResponseSchema,
  },
  "gitflow.threadResolve": {
    method: "gitflow.threadResolve",
    procedureType: "mutation",
    mutating: true,
    requestSchema: GitflowThreadResolveRequestSchema,
    responseSchema: GitflowThreadResolveResponseSchema,
  },
  "gitflow.threadReply": {
    method: "gitflow.threadReply",
    procedureType: "mutation",
    mutating: true,
    requestSchema: GitflowThreadReplyRequestSchema,
    responseSchema: GitflowThreadReplyResponseSchema,
  },
  "gitflow.checkLogRead": {
    method: "gitflow.checkLogRead",
    procedureType: "query",
    mutating: false,
    requestSchema: GitflowCheckLogReadRequestSchema,
    responseSchema: GitflowCheckLogReadResponseSchema,
  },
});
