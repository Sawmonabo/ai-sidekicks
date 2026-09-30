// What the hosting service answers, for the git-flow contract: the self-hosted git
// hosts, the change requests on a branch (live, at the header's depth or at Review's),
// the reviewer and label candidates, posting a review, answering a thread and reading
// a failing check's log.
//
// The hosting service is either GitHub or GitLab, each reached through its own
// installed, signed-in command-line tool. "Change request" is the host-neutral word
// for a pull request (GitHub) or a merge request (GitLab); the screen prints the
// host's own word, which follows from the host kind this contract reports.
import { z } from "zod";

import { countSchema } from "../internal/wire-scalars.js";
import { GitObjectIdSchema, type GitObjectId } from "../repo-git-reads.js";
import {
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
} from "../session.js";
import {
  ChangeRequestNumberSchema,
  HostHandleSchema,
  HostingAddressSchema,
  timestampSchema,
} from "./shared.js";

// --------------------------------------------------------------------------
// Closed sets
// --------------------------------------------------------------------------

/** The hosting services served. A host is kept with the kind whose tool answered for it. */
export const GIT_HOST_KINDS = ["github", "gitlab"] as const;
/** One hosting service. */
export type GitHostKind = (typeof GIT_HOST_KINDS)[number];
const GitHostKindSchema = z.enum(GIT_HOST_KINDS);

/** Where a change request stands on its host. */
export const CHANGE_REQUEST_STATES = ["open", "merged", "closed"] as const;
/** One change-request state. */
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];
const ChangeRequestStateSchema = z.enum(CHANGE_REQUEST_STATES);

/**
 * Whether the host can merge a change request. While the host is still working it
 * out the member is absent: an unsettled answer is never a conflict and never an error.
 */
export const CHANGE_REQUEST_MERGEABILITIES = ["mergeable", "conflicting"] as const;
/** One mergeability answer. */
export type ChangeRequestMergeability = (typeof CHANGE_REQUEST_MERGEABILITIES)[number];
const ChangeRequestMergeabilitySchema = z.enum(CHANGE_REQUEST_MERGEABILITIES);

/**
 * The change request's own review decision. Absent means the host has recorded no
 * decision, which is not a rejection.
 */
export const CHANGE_REQUEST_REVIEW_DECISIONS = [
  "approved",
  "changes_requested",
  "review_required",
] as const;
/** One review decision on the whole change request. */
export type ChangeRequestReviewDecision = (typeof CHANGE_REQUEST_REVIEW_DECISIONS)[number];
const ChangeRequestReviewDecisionSchema = z.enum(CHANGE_REQUEST_REVIEW_DECISIONS);

/**
 * One reviewer's latest verdict. Kept apart from the request's decision: a reviewer
 * can comment without deciding, and a request can need a review nobody has given.
 */
export const REVIEWER_VERDICTS = ["approved", "changes_requested", "commented"] as const;
/** One reviewer's verdict. */
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number];
const ReviewerVerdictSchema = z.enum(REVIEWER_VERDICTS);

/** The verdict the person posts a review under. */
export const REVIEW_SUBMIT_VERDICTS = ["comment", "approve", "request_changes"] as const;
/** One verdict a review is posted under. */
export type ReviewSubmitVerdict = (typeof REVIEW_SUBMIT_VERDICTS)[number];
const ReviewSubmitVerdictSchema = z.enum(REVIEW_SUBMIT_VERDICTS);

/** One check's outcome on the host. */
export const CHANGE_REQUEST_CHECK_STATUSES = ["pending", "success", "failure"] as const;
/** One check status. */
export type ChangeRequestCheckStatus = (typeof CHANGE_REQUEST_CHECK_STATUSES)[number];
const ChangeRequestCheckStatusSchema = z.enum(CHANGE_REQUEST_CHECK_STATUSES);

/** A review thread's state; an outdated thread's line no longer exists in the diff. */
export const REVIEW_THREAD_STATES = ["open", "resolved", "outdated"] as const;
/** One review-thread state. */
export type ReviewThreadState = (typeof REVIEW_THREAD_STATES)[number];
const ReviewThreadStateSchema = z.enum(REVIEW_THREAD_STATES);

/** Which side of a diff a line belongs to: before the change or after it. */
export const DIFF_SIDES = ["old", "new"] as const;
/** One diff side. */
export type DiffSide = (typeof DIFF_SIDES)[number];
const DiffSideSchema = z.enum(DIFF_SIDES);

/** How much a change-request subscription carries: the header's facts, or Review's. */
export const CHANGE_REQUEST_READ_DEPTHS = ["summary", "full"] as const;
/** One subscription depth. */
export type ChangeRequestReadDepth = (typeof CHANGE_REQUEST_READ_DEPTHS)[number];

// --------------------------------------------------------------------------
// Refusal codes
// --------------------------------------------------------------------------

/**
 * A host the person tried to add was not added. `not_a_host_name` is a name that
 * does not parse; `not_answered` is a host neither `gh` nor `glab`, installed and
 * signed in, answers for. Nothing is saved either way.
 */
export const GITFLOW_HOST_INVALID_CODE = "gitflow.host_invalid" as const;
/** The code string of {@link GITFLOW_HOST_INVALID_CODE}. */
export type GitflowHostInvalidCode = typeof GITFLOW_HOST_INVALID_CODE;
/** Why a host was refused. */
export const GITFLOW_HOST_INVALID_REASONS = ["not_a_host_name", "not_answered"] as const;
/** One reason a host was refused. */
export type GitflowHostInvalidReason = (typeof GITFLOW_HOST_INVALID_REASONS)[number];
/** The details of a {@link GITFLOW_HOST_INVALID_CODE} refusal. */
export interface GitflowHostInvalidDetails {
  reason: GitflowHostInvalidReason;
}
/** Wire schema for {@link GitflowHostInvalidDetails}. */
export const GitflowHostInvalidDetailsSchema: z.ZodType<GitflowHostInvalidDetails> = z
  .object({ reason: z.enum(GITFLOW_HOST_INVALID_REASONS) })
  .strict();

// --------------------------------------------------------------------------
// Self-hosted git hosts
// --------------------------------------------------------------------------

/** The longest host name DNS allows. */
export const GIT_HOST_NAME_MAX_LEN = 253;

/**
 * A host as the person typed it. The schema only bounds it, so an empty or unparsable
 * name reaches the daemon, which refuses it with {@link GITFLOW_HOST_INVALID_CODE}.
 */
const GitHostNameInputSchema: z.ZodType<string, string> = z.string().max(GIT_HOST_NAME_MAX_LEN);

/** A host the daemon parsed and saved. */
const GitHostNameSchema: z.ZodType<string, string> = wireFreeFormString(
  GIT_HOST_NAME_MAX_LEN,
  "host",
);

/** One registered self-hosted git host. */
export interface GitHost {
  host: string;
  kind: GitHostKind;
  addedAt: string;
}
const GitHostSchema: z.ZodType<GitHost> = z
  .object({ host: GitHostNameSchema, kind: GitHostKindSchema, addedAt: timestampSchema })
  .strict();

/** The `gitflow.hostList` input: the machine's hosts, so nothing names a session. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GitflowHostListRequest {}
/** Wire schema for {@link GitflowHostListRequest}. */
export const GitflowHostListRequestSchema: z.ZodType<
  GitflowHostListRequest,
  GitflowHostListRequest
> = z.object({}).strict();

/** The `gitflow.hostList` result. */
export interface GitflowHostListResponse {
  hosts: GitHost[];
}
/** Wire schema for {@link GitflowHostListResponse}. */
export const GitflowHostListResponseSchema: z.ZodType<GitflowHostListResponse> = z
  .object({ hosts: z.array(GitHostSchema) })
  .strict();

/**
 * The `gitflow.hostAdd` input: one host name and no kind, because the daemon keeps
 * the kind of whichever installed tool answers for it. Adding a host already listed
 * answers with that host.
 */
export interface GitflowHostAddRequest {
  host: string;
}
/** Wire schema for {@link GitflowHostAddRequest}. */
export const GitflowHostAddRequestSchema: z.ZodType<GitflowHostAddRequest, GitflowHostAddRequest> =
  z.object({ host: GitHostNameInputSchema }).strict();

/** The `gitflow.hostAdd` result. */
export interface GitflowHostAddResponse {
  host: GitHost;
}
/** Wire schema for {@link GitflowHostAddResponse}. */
export const GitflowHostAddResponseSchema: z.ZodType<GitflowHostAddResponse> = z
  .object({ host: GitHostSchema })
  .strict();

/** The `gitflow.hostRemove` input. */
export interface GitflowHostRemoveRequest {
  host: string;
}
/** Wire schema for {@link GitflowHostRemoveRequest}. */
export const GitflowHostRemoveRequestSchema: z.ZodType<
  GitflowHostRemoveRequest,
  GitflowHostRemoveRequest
> = z.object({ host: GitHostNameInputSchema }).strict();

/** The `gitflow.hostRemove` result. `removed` is false when the host was not listed. */
export interface GitflowHostRemoveResponse {
  removed: boolean;
}
/** Wire schema for {@link GitflowHostRemoveResponse}. */
export const GitflowHostRemoveResponseSchema: z.ZodType<GitflowHostRemoveResponse> = z
  .object({ removed: z.boolean() })
  .strict();

// --------------------------------------------------------------------------
// Session-keyed requests and a change request at a glance
// --------------------------------------------------------------------------

/** A request keyed by the session alone; the daemon maps it to the session's folder. */
export interface GitflowSessionRequest {
  sessionId: SessionId;
}
/** Wire schema for {@link GitflowSessionRequest}. */
export const GitflowSessionRequestSchema: z.ZodType<GitflowSessionRequest, GitflowSessionRequest> =
  z.object({ sessionId: SessionIdSchema }).strict();

/** A change request as the header and the ship strip read it. */
export interface ChangeRequestSummary {
  number: number;
  url?: string | undefined;
  state: ChangeRequestState;
  isDraft: boolean;
  mergeable?: ChangeRequestMergeability | undefined;
  reviewDecision?: ChangeRequestReviewDecision | undefined;
}
const changeRequestSummaryShape = {
  number: ChangeRequestNumberSchema,
  url: HostingAddressSchema.optional(),
  state: ChangeRequestStateSchema,
  isDraft: z.boolean(),
  mergeable: ChangeRequestMergeabilitySchema.optional(),
  reviewDecision: ChangeRequestReviewDecisionSchema.optional(),
};
/** Wire schema for {@link ChangeRequestSummary}. */
export const ChangeRequestSummarySchema: z.ZodType<ChangeRequestSummary> = z
  .object(changeRequestSummaryShape)
  .strict();

// --------------------------------------------------------------------------
// The change request, live
// --------------------------------------------------------------------------

/** The `gitflow.changeRequestSubscribe` input. */
export interface GitflowChangeRequestSubscribeRequest {
  sessionId: SessionId;
  depth: ChangeRequestReadDepth;
}
/** Wire schema for {@link GitflowChangeRequestSubscribeRequest}. */
export const GitflowChangeRequestSubscribeRequestSchema: z.ZodType<
  GitflowChangeRequestSubscribeRequest,
  GitflowChangeRequestSubscribeRequest
> = z.object({ sessionId: SessionIdSchema, depth: z.enum(CHANGE_REQUEST_READ_DEPTHS) }).strict();

/** One comment in a review thread; the first is the note that opened it. */
export interface ReviewThreadComment {
  commentId: string;
  author: string;
  body: string;
  createdAt: string;
}

/** One review thread, at the line it is about where it has one. */
export interface ReviewThread {
  threadId: string;
  path?: string | undefined;
  line?: number | undefined;
  side?: DiffSide | undefined;
  state: ReviewThreadState;
  comments: ReviewThreadComment[];
}
const ReviewThreadSchema: z.ZodType<ReviewThread> = z
  .object({
    threadId: HostHandleSchema,
    path: z.string().min(1).max(FILE_PATH_MAX_LEN).optional(),
    line: z.number().int().positive().optional(),
    side: DiffSideSchema.optional(),
    state: ReviewThreadStateSchema,
    comments: z
      .array(
        z
          .object({
            commentId: HostHandleSchema,
            author: z.string().min(1),
            body: z.string(),
            createdAt: timestampSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** One check on the change request's head, with the address of its run on the host. */
export interface ChangeRequestCheck {
  checkId: string;
  name: string;
  status: ChangeRequestCheckStatus;
  runUrl?: string | undefined;
}

/**
 * A change request as Review's pull-request tab reads it. `viewerIsAuthor` is true on
 * the person's own request, where the host refuses an approval. `requestedReviewers`
 * have been asked and have not answered. `headCommitId` is what the host holds now,
 * so a request that moved past the loaded diff can be told apart.
 */
export interface ChangeRequestDetail extends ChangeRequestSummary {
  viewerIsAuthor: boolean;
  description?: string | undefined;
  reviews: { reviewer: string; verdict: ReviewerVerdict }[];
  requestedReviewers: string[];
  threads: ReviewThread[];
  checks: ChangeRequestCheck[];
  headCommitId: GitObjectId;
}
const ChangeRequestDetailSchema: z.ZodType<ChangeRequestDetail> = z
  .object({
    ...changeRequestSummaryShape,
    viewerIsAuthor: z.boolean(),
    description: z.string().min(1).optional(),
    reviews: z.array(
      z.object({ reviewer: z.string().min(1), verdict: ReviewerVerdictSchema }).strict(),
    ),
    requestedReviewers: z.array(z.string().min(1)),
    threads: z.array(ReviewThreadSchema),
    checks: z.array(
      z
        .object({
          checkId: HostHandleSchema,
          name: z.string().min(1),
          status: ChangeRequestCheckStatusSchema,
          runUrl: HostingAddressSchema.optional(),
        })
        .strict(),
    ),
    headCommitId: GitObjectIdSchema,
  })
  .strict();

/**
 * One frame of `gitflow.changeRequestSubscribe`: the branch's change requests, newest
 * first, at the depth asked for. `readAt` is the last successful read; a read that
 * failed since keeps the last state and sets `lastReadFailedAt`, so the tab never blanks.
 */
export type ChangeRequestFrame =
  | {
      depth: "summary";
      requests: ChangeRequestSummary[];
      readAt: string;
      lastReadFailedAt?: string | undefined;
    }
  | {
      depth: "full";
      requests: ChangeRequestDetail[];
      readAt: string;
      lastReadFailedAt?: string | undefined;
    };
/** Wire schema for {@link ChangeRequestFrame}. */
export const ChangeRequestFrameSchema: z.ZodType<ChangeRequestFrame> = z.discriminatedUnion(
  "depth",
  [
    z
      .object({
        depth: z.literal("summary"),
        requests: z.array(ChangeRequestSummarySchema),
        readAt: timestampSchema,
        lastReadFailedAt: timestampSchema.optional(),
      })
      .strict(),
    z
      .object({
        depth: z.literal("full"),
        requests: z.array(ChangeRequestDetailSchema),
        readAt: timestampSchema,
        lastReadFailedAt: timestampSchema.optional(),
      })
      .strict(),
  ],
);

// --------------------------------------------------------------------------
// Change-request form candidates
// --------------------------------------------------------------------------

/** The `gitflow.reviewerList` input. `query` narrows the candidates by what was typed. */
export interface GitflowReviewerListRequest {
  sessionId: SessionId;
  query?: string | undefined;
}
/** Wire schema for {@link GitflowReviewerListRequest}. */
export const GitflowReviewerListRequestSchema: z.ZodType<
  GitflowReviewerListRequest,
  GitflowReviewerListRequest
> = z.object({ sessionId: SessionIdSchema, query: z.string().min(1).optional() }).strict();

/** The `gitflow.reviewerList` result. */
export interface GitflowReviewerListResponse {
  reviewers: { login: string; name?: string | undefined }[];
}
/** Wire schema for {@link GitflowReviewerListResponse}. */
export const GitflowReviewerListResponseSchema: z.ZodType<GitflowReviewerListResponse> = z
  .object({
    reviewers: z.array(
      z.object({ login: z.string().min(1), name: z.string().min(1).optional() }).strict(),
    ),
  })
  .strict();

/** The `gitflow.labelList` result. */
export interface GitflowLabelListResponse {
  labels: { name: string; description?: string | undefined }[];
}
/** Wire schema for {@link GitflowLabelListResponse}. */
export const GitflowLabelListResponseSchema: z.ZodType<GitflowLabelListResponse> = z
  .object({
    labels: z.array(
      z.object({ name: z.string().min(1), description: z.string().min(1).optional() }).strict(),
    ),
  })
  .strict();

// --------------------------------------------------------------------------
// Review, threads and checks
// --------------------------------------------------------------------------

/**
 * The `gitflow.reviewSubmit` input. The notes are the session's held notes, read from
 * the daemon's own store, so no note text crosses the wire; `body` is the verdict's
 * one free-standing summary.
 */
export interface GitflowReviewSubmitRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  verdict: ReviewSubmitVerdict;
  body?: string | undefined;
}
/** Wire schema for {@link GitflowReviewSubmitRequest}. */
export const GitflowReviewSubmitRequestSchema: z.ZodType<
  GitflowReviewSubmitRequest,
  GitflowReviewSubmitRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    changeRequestNumber: ChangeRequestNumberSchema,
    verdict: ReviewSubmitVerdictSchema,
    body: z.string().min(1).optional(),
  })
  .strict();

/**
 * The `gitflow.reviewSubmit` result. A review that fails part way says which notes
 * posted and, for each that did not, the host's reason; notes behind a failure stay
 * held, so a second press posts only what is still held.
 */
export interface GitflowReviewSubmitResponse {
  reviewUrl?: string | undefined;
  postedNoteIds: string[];
  failures: { noteId: string; reason: string }[];
}
/** Wire schema for {@link GitflowReviewSubmitResponse}. */
export const GitflowReviewSubmitResponseSchema: z.ZodType<GitflowReviewSubmitResponse> = z
  .object({
    reviewUrl: HostingAddressSchema.optional(),
    postedNoteIds: z.array(z.string().min(1)),
    failures: z.array(z.object({ noteId: z.string().min(1), reason: z.string().min(1) }).strict()),
  })
  .strict();

/** A request naming one thread of one change request. */
export interface GitflowThreadRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  threadId: string;
}
const threadRequestShape = {
  sessionId: SessionIdSchema,
  changeRequestNumber: ChangeRequestNumberSchema,
  threadId: HostHandleSchema,
};
/** Wire schema for the `gitflow.threadResolve` input. Resolving a resolved thread succeeds. */
export const GitflowThreadResolveRequestSchema: z.ZodType<
  GitflowThreadRequest,
  GitflowThreadRequest
> = z.object(threadRequestShape).strict();

/** The `gitflow.threadResolve` result. */
export interface GitflowThreadResolveResponse {
  threadId: string;
  state: "resolved";
}
/** Wire schema for {@link GitflowThreadResolveResponse}. */
export const GitflowThreadResolveResponseSchema: z.ZodType<GitflowThreadResolveResponse> = z
  .object({ threadId: HostHandleSchema, state: z.literal("resolved") })
  .strict();

/** The `gitflow.threadReply` input. */
export interface GitflowThreadReplyRequest extends GitflowThreadRequest {
  body: string;
}
/** Wire schema for {@link GitflowThreadReplyRequest}. */
export const GitflowThreadReplyRequestSchema: z.ZodType<
  GitflowThreadReplyRequest,
  GitflowThreadReplyRequest
> = z.object({ ...threadRequestShape, body: z.string().min(1) }).strict();

/** The `gitflow.threadReply` result: the posted comment and its address. */
export interface GitflowThreadReplyResponse {
  commentId: string;
  url?: string | undefined;
}
/** Wire schema for {@link GitflowThreadReplyResponse}. */
export const GitflowThreadReplyResponseSchema: z.ZodType<GitflowThreadReplyResponse> = z
  .object({ commentId: HostHandleSchema, url: HostingAddressSchema.optional() })
  .strict();

/** The `gitflow.checkLogRead` input. */
export interface GitflowCheckLogReadRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  checkId: string;
}
/** Wire schema for {@link GitflowCheckLogReadRequest}. */
export const GitflowCheckLogReadRequestSchema: z.ZodType<
  GitflowCheckLogReadRequest,
  GitflowCheckLogReadRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    changeRequestNumber: ChangeRequestNumberSchema,
    checkId: HostHandleSchema,
  })
  .strict();

/**
 * The `gitflow.checkLogRead` result: the end of the check's log, because the useful
 * part of a build log is the last of it. `truncated` says the start was left out and
 * `totalBytes` how long the whole log is; the tail's size comes from the machine.
 */
export interface GitflowCheckLogReadResponse {
  text: string;
  truncated: boolean;
  totalBytes: number;
  runUrl?: string | undefined;
}
/** Wire schema for {@link GitflowCheckLogReadResponse}. */
export const GitflowCheckLogReadResponseSchema: z.ZodType<GitflowCheckLogReadResponse> = z
  .object({
    text: z.string(),
    truncated: z.boolean(),
    totalBytes: countSchema,
    runUrl: HostingAddressSchema.optional(),
  })
  .strict();
