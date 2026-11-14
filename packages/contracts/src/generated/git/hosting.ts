// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the hosting service answers: the self-hosted git hosts, the change requests on a branch, the reviewer and label candidates, posting a review, answering a thread and reading a failing check's log.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { GitObjectId } from "../repo/git-reads.js";
import type { ReviewNoteId } from "../review-note.js";
import type { SessionId } from "../session/id.js";
import type { ChangeRequestNumber, HostHandle, HostingAddress } from "./shared.js";

/** The longest host name DNS allows. */
export const GIT_HOST_NAME_MAX_LEN = 253 as const;

/**
 * The hosting services served. A host is kept with the kind whose tool answered for it.
 */
export type GitHostKind = "github" | "gitlab";
/**
 * Where a change request stands on its host.
 */
export type ChangeRequestState = "open" | "merged" | "closed";
/**
 * Whether the host can merge a change request. While the host is still working it out the member
 * is absent: an unsettled answer is never a conflict and never an error.
 */
export type ChangeRequestMergeability = "mergeable" | "conflicting";
/**
 * The change request's own review decision. Absent means the host has recorded no decision, which
 * is not a rejection.
 */
export type ChangeRequestReviewDecision = "approved" | "changesRequested" | "reviewRequired";
/**
 * One reviewer's latest verdict, kept apart from the request's decision: a reviewer can comment
 * without deciding, and a request can need a review nobody has given.
 */
export type ReviewerVerdict = "approved" | "changesRequested" | "commented";
/**
 * The verdict the person posts a review under.
 */
export type ReviewSubmitVerdict = "comment" | "approve" | "requestChanges";
/**
 * One check's outcome on the host.
 */
export type ChangeRequestCheckStatus = "pending" | "success" | "failure";
/**
 * A review thread's state; an outdated thread's line no longer exists in the diff.
 */
export type ReviewThreadState = "open" | "resolved" | "outdated";
/**
 * Which side of a diff a line belongs to: before the change or after it.
 */
export type DiffSide = "old" | "new";
/**
 * How much a change-request subscription carries: the header's facts, or Review's.
 */
export type ChangeRequestReadDepth = "summary" | "full";
/**
 * Why a host was refused `git.host.invalid`; nothing is saved either way.
 */
export type GitHostInvalidReason = "notAHostName" | "notAnswered";
/**
 * One frame of `git.changeRequest.subscribe`: the branch's change requests, newest first, at
 * the depth asked for. `readAt` is the last successful read; a read that failed since keeps the
 * last state and sets `lastReadFailedAt`, so the tab never blanks.
 */
export type ChangeRequestFrame =
  | {
      depth: "summary";
      /**
       * The change requests.
       */
      requests: ChangeRequestSummary[];
      /**
       * The last successful read.
       */
      readAt: WireInstant;
      /**
       * The last failed read since.
       */
      lastReadFailedAt?: WireInstant;
    }
  | {
      depth: "full";
      /**
       * The change requests.
       */
      requests: ChangeRequestDetail[];
      /**
       * The last successful read.
       */
      readAt: WireInstant;
      /**
       * The last failed read since.
       */
      lastReadFailedAt?: WireInstant;
    };

/**
 * The details of a `git.host.invalid` refusal.
 */
export interface GitHostInvalidDetails {
  /**
   * Why.
   */
  reason: GitHostInvalidReason;
}
/**
 * One registered self-hosted git host.
 */
export interface GitHost {
  /**
   * The host.
   */
  host: string;
  /**
   * The kind whose tool answered for it.
   */
  kind: GitHostKind;
  /**
   * When it was added.
   */
  addedAt: WireInstant;
}
/**
 * The `git.host.list` result.
 */
export interface GitHostListResponse {
  /**
   * The hosts.
   */
  hosts: GitHost[];
}
/**
 * `git.host.add`: one host name and no kind, because the daemon keeps the kind of whichever
 * installed tool answers for it. Adding a host already listed answers with that host.
 */
export interface GitHostAddRequest {
  /**
   * The host as typed.
   */
  host: string;
}
/**
 * The `git.host.add` result.
 */
export interface GitHostAddResponse {
  /**
   * The host.
   */
  host: GitHost;
}
/**
 * `git.host.remove`: the host to forget.
 */
export interface GitHostRemoveRequest {
  /**
   * The host as typed.
   */
  host: string;
}
/**
 * The `git.host.remove` result; `removed` is false when the host was not listed.
 */
export interface GitHostRemoveResponse {
  /**
   * Whether it was listed.
   */
  removed: boolean;
}
/**
 * A request keyed by the session alone; the daemon maps it to the session's folder.
 */
export interface GitSessionRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * A change request as the header and the ship strip read it.
 */
export interface ChangeRequestSummary {
  /**
   * Its number on the host.
   */
  number: ChangeRequestNumber;
  /**
   * Its address on the host.
   */
  url?: HostingAddress;
  /**
   * Where it stands.
   */
  state: ChangeRequestState;
  /**
   * Whether it is a draft.
   */
  isDraft: boolean;
  /**
   * Whether the host can merge it; absent while the host works it out.
   */
  mergeable?: ChangeRequestMergeability;
  /**
   * Its review decision; absent when the host recorded none.
   */
  reviewDecision?: ChangeRequestReviewDecision;
}
/**
 * `git.changeRequest.subscribe`: the session's branch and the depth to read at.
 */
export interface GitChangeRequestSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The depth.
   */
  depth: ChangeRequestReadDepth;
}
/**
 * One comment in a review thread; the first is the note that opened it.
 */
export interface ReviewThreadComment {
  /**
   * The comment.
   */
  commentId: HostHandle;
  /**
   * Its author.
   */
  author: string;
  /**
   * Its text.
   */
  body: string;
  /**
   * When it was written.
   */
  createdAt: WireInstant;
}
/**
 * One review thread, at the line it is about where it has one.
 */
export interface ReviewThread {
  /**
   * The thread.
   */
  threadId: HostHandle;
  /**
   * Its file.
   */
  path?: string;
  /**
   * Its line, from 1.
   */
  line?: number;
  /**
   * The line's side.
   */
  side?: DiffSide;
  /**
   * Its state.
   */
  state: ReviewThreadState;
  /**
   * Its comments, at least the one that opened it.
   *
   * @minItems 1
   */
  comments: [ReviewThreadComment, ...ReviewThreadComment[]];
}
/**
 * One reviewer's latest verdict on a change request.
 */
export interface ChangeRequestReview {
  /**
   * The reviewer.
   */
  reviewer: string;
  /**
   * Their verdict.
   */
  verdict: ReviewerVerdict;
}
/**
 * One check on the change request's head, with the address of its run on the host.
 */
export interface ChangeRequestCheck {
  /**
   * The check.
   */
  checkId: HostHandle;
  /**
   * Its name.
   */
  name: string;
  /**
   * Its outcome.
   */
  status: ChangeRequestCheckStatus;
  /**
   * Its run's address.
   */
  runUrl?: HostingAddress;
}
/**
 * A change request as Review's pull-request tab reads it. `viewerIsAuthor` is true on the
 * person's own request, where the host refuses an approval; `requestedReviewers` have been
 * asked and have not answered; `headCommitId` is what the host holds now, so a request that
 * moved past the loaded diff can be told apart.
 */
export interface ChangeRequestDetail {
  /**
   * Its number on the host.
   */
  number: ChangeRequestNumber;
  /**
   * Its address on the host.
   */
  url?: HostingAddress;
  /**
   * Where it stands.
   */
  state: ChangeRequestState;
  /**
   * Whether it is a draft.
   */
  isDraft: boolean;
  /**
   * Whether the host can merge it; absent while the host works it out.
   */
  mergeable?: ChangeRequestMergeability;
  /**
   * Its review decision; absent when the host recorded none.
   */
  reviewDecision?: ChangeRequestReviewDecision;
  /**
   * Whether the person wrote it.
   */
  viewerIsAuthor: boolean;
  /**
   * Its description.
   */
  description?: string;
  /**
   * Each reviewer's latest verdict.
   */
  reviews: ChangeRequestReview[];
  /**
   * The reviewers asked who have not answered.
   */
  requestedReviewers: string[];
  /**
   * Its review threads.
   */
  threads: ReviewThread[];
  /**
   * Its checks.
   */
  checks: ChangeRequestCheck[];
  /**
   * The head commit the host holds now.
   */
  headCommitId: GitObjectId;
}
/**
 * `git.reviewer.list`; `query` narrows the candidates by what was typed.
 */
export interface GitReviewerListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * What was typed.
   */
  query?: string;
}
/**
 * One reviewer candidate.
 */
export interface ReviewerCandidate {
  /**
   * Their login.
   */
  login: string;
  /**
   * Their name.
   */
  name?: string;
}
/**
 * The `git.reviewer.list` result.
 */
export interface GitReviewerListResponse {
  /**
   * The candidates.
   */
  reviewers: ReviewerCandidate[];
}
/**
 * One label candidate.
 */
export interface LabelCandidate {
  /**
   * Its name.
   */
  name: string;
  /**
   * Its description.
   */
  description?: string;
}
/**
 * The `git.label.list` result.
 */
export interface GitLabelListResponse {
  /**
   * The candidates.
   */
  labels: LabelCandidate[];
}
/**
 * `git.review.submit`. The notes are the session's held notes, read from the daemon's own
 * store, so no note text crosses the wire; `body` is the verdict's one free-standing summary.
 */
export interface GitReviewSubmitRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The change request.
   */
  changeRequestNumber: ChangeRequestNumber;
  /**
   * The verdict.
   */
  verdict: ReviewSubmitVerdict;
  /**
   * The summary.
   */
  body?: string;
}
/**
 * A note the host refused to post, and why.
 */
export interface ReviewNoteFailure {
  /**
   * The note.
   */
  noteId: ReviewNoteId;
  /**
   * The host's reason.
   */
  reason: string;
}
/**
 * The `git.review.submit` result. A review that fails part way says which notes posted and,
 * for each that did not, the host's reason; notes behind a failure stay held, so a second press
 * posts only what is still held.
 */
export interface GitReviewSubmitResponse {
  /**
   * The review's address.
   */
  reviewUrl?: HostingAddress;
  /**
   * The notes posted.
   */
  postedNoteIds: ReviewNoteId[];
  /**
   * The notes refused.
   */
  failures: ReviewNoteFailure[];
}
/**
 * `git.reviewThread.resolve`: one thread of one change request; resolving a resolved thread
 * succeeds.
 */
export interface GitReviewThreadResolveRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The change request.
   */
  changeRequestNumber: ChangeRequestNumber;
  /**
   * The thread.
   */
  threadId: HostHandle;
}
/**
 * The `git.reviewThread.resolve` result.
 */
export interface GitReviewThreadResolveResponse {
  /**
   * The thread.
   */
  threadId: HostHandle;
  /**
   * Its state.
   */
  state: "resolved";
}
/**
 * `git.reviewThread.reply`: a reply to one thread of one change request.
 */
export interface GitReviewThreadReplyRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The change request.
   */
  changeRequestNumber: ChangeRequestNumber;
  /**
   * The thread.
   */
  threadId: HostHandle;
  /**
   * The reply.
   */
  body: string;
}
/**
 * The `git.reviewThread.reply` result: the posted comment and its address.
 */
export interface GitReviewThreadReplyResponse {
  /**
   * The comment.
   */
  commentId: HostHandle;
  /**
   * Its address.
   */
  url?: HostingAddress;
}
/**
 * `git.checkLog.read`: one check of one change request.
 */
export interface GitCheckLogReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The change request.
   */
  changeRequestNumber: ChangeRequestNumber;
  /**
   * The check.
   */
  checkId: HostHandle;
}
/**
 * The `git.checkLog.read` result: the end of the check's log, because the useful part of a
 * build log is the last of it. `truncated` says the start was left out and `totalBytes` how long
 * the whole log is.
 */
export interface GitCheckLogReadResponse {
  /**
   * The log's tail.
   */
  text: string;
  /**
   * Whether the start was left out.
   */
  truncated: boolean;
  /**
   * The whole log's size in bytes.
   */
  totalBytes: number;
  /**
   * The run's address.
   */
  runUrl?: HostingAddress;
}

export {
  validateChangeRequestCheck,
  validateChangeRequestCheckStatus,
  validateChangeRequestDetail,
  validateChangeRequestFrame,
  validateChangeRequestMergeability,
  validateChangeRequestReadDepth,
  validateChangeRequestReview,
  validateChangeRequestReviewDecision,
  validateChangeRequestState,
  validateChangeRequestSummary,
  validateDiffSide,
  validateGitChangeRequestSubscribeRequest,
  validateGitCheckLogReadRequest,
  validateGitCheckLogReadResponse,
  validateGitHost,
  validateGitHostAddRequest,
  validateGitHostAddResponse,
  validateGitHostKind,
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
  validateLabelCandidate,
  validateReviewNoteFailure,
  validateReviewSubmitVerdict,
  validateReviewThread,
  validateReviewThreadComment,
  validateReviewThreadState,
  validateReviewerCandidate,
  validateReviewerVerdict,
} from "../checks/git/hosting.js";
