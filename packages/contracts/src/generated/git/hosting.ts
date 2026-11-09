/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the hosting service answers: the self-hosted git hosts, the change requests on a branch, the reviewer and label candidates, posting a review, answering a thread and reading a failing check's log.

import { SCHEMA_FORMATS, type SchemaCheck, ucs2length } from "../../schema-check.js";
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

// prettier-ignore
const schema1762: any = {"description":"Where a change request stands on its host.","type":"string","enum":["open","merged","closed"]};
// prettier-ignore
const schema1763: any = {"description":"Whether the host can merge a change request. While the host is still working it out the member\nis absent: an unsettled answer is never a conflict and never an error.","type":"string","enum":["mergeable","conflicting"]};
// prettier-ignore
const schema1764: any = {"description":"The change request's own review decision. Absent means the host has recorded no decision, which\nis not a rejection.","type":"string","enum":["approved","changesRequested","reviewRequired"]};
// prettier-ignore
const formats18 = SCHEMA_FORMATS["web-url"];
// prettier-ignore
const pattern738 = new RegExp("^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://", "u");
// prettier-ignore
function validate930(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate930.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.number === undefined) && (missing0 = "number")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.isDraft === undefined) && (missing0 = "isDraft"))){validate930.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "number") || (key0 === "url")) || (key0 === "state")) || (key0 === "isDraft")) || (key0 === "mergeable")) || (key0 === "reviewDecision"))){validate930.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.number !== undefined){let data0: any = data.number;const _errs2: any = errors;const _errs3: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate930.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate930.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate930.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.url !== undefined){let data1: any = data.url;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(errors === _errs6){if(typeof data1 === "string"){if(!pattern738.test(data1)){validate930.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data1))){validate930.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate930.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs8: any = errors;if(typeof data2 !== "string"){validate930.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChangeRequestState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "open") || (data2 === "merged")) || (data2 === "closed"))){validate930.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChangeRequestState/enum",keyword:"enum",params:{allowedValues: schema1762.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.isDraft !== undefined){const _errs11: any = errors;if(typeof data.isDraft !== "boolean"){validate930.errors = [{instancePath:instancePath+"/isDraft",schemaPath:"#/properties/isDraft/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.mergeable !== undefined){let data4: any = data.mergeable;const _errs13: any = errors;if(typeof data4 !== "string"){validate930.errors = [{instancePath:instancePath+"/mergeable",schemaPath:"#/$defs/ChangeRequestMergeability/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data4 === "mergeable") || (data4 === "conflicting"))){validate930.errors = [{instancePath:instancePath+"/mergeable",schemaPath:"#/$defs/ChangeRequestMergeability/enum",keyword:"enum",params:{allowedValues: schema1763.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.reviewDecision !== undefined){let data5: any = data.reviewDecision;const _errs16: any = errors;if(typeof data5 !== "string"){validate930.errors = [{instancePath:instancePath+"/reviewDecision",schemaPath:"#/$defs/ChangeRequestReviewDecision/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data5 === "approved") || (data5 === "changesRequested")) || (data5 === "reviewRequired"))){validate930.errors = [{instancePath:instancePath+"/reviewDecision",schemaPath:"#/$defs/ChangeRequestReviewDecision/enum",keyword:"enum",params:{allowedValues: schema1764.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate930.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate930.errors = vErrors;return errors === 0;}
// prettier-ignore
validate930.errors = null as any[] | null;
// prettier-ignore
validate930.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1767: any = {"type":"object","additionalProperties":false,"properties":{"number":{"$ref":"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber","description":"Its number on the host."},"url":{"$ref":"sidekicks-contracts:git/shared#/$defs/HostingAddress","description":"Its address on the host."},"state":{"$ref":"#/$defs/ChangeRequestState","description":"Where it stands."},"isDraft":{"type":"boolean","description":"Whether it is a draft."},"mergeable":{"$ref":"#/$defs/ChangeRequestMergeability","description":"Whether the host can merge it; absent while the host works it out."},"reviewDecision":{"$ref":"#/$defs/ChangeRequestReviewDecision","description":"Its review decision; absent when the host recorded none."},"viewerIsAuthor":{"type":"boolean","description":"Whether the person wrote it."},"description":{"type":"string","minLength":1,"description":"Its description."},"reviews":{"type":"array","items":{"$ref":"#/$defs/ChangeRequestReview"},"description":"Each reviewer's latest verdict."},"requestedReviewers":{"type":"array","items":{"type":"string","minLength":1},"description":"The reviewers asked who have not answered."},"threads":{"type":"array","items":{"$ref":"#/$defs/ReviewThread"},"description":"Its review threads."},"checks":{"type":"array","items":{"$ref":"#/$defs/ChangeRequestCheck"},"description":"Its checks."},"headCommitId":{"$ref":"sidekicks-contracts:repo/git-reads#/$defs/GitObjectId","description":"The head commit the host holds now."}},"required":["number","state","isDraft","viewerIsAuthor","reviews","requestedReviewers","threads","checks","headCommitId"],"description":"A change request as Review's pull-request tab reads it. `viewerIsAuthor` is true on the\nperson's own request, where the host refuses an approval; `requestedReviewers` have been\nasked and have not answered; `headCommitId` is what the host holds now, so a request that\nmoved past the loaded diff can be told apart."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern730 = new RegExp("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", "u");
// prettier-ignore
const schema1774: any = {"description":"One reviewer's latest verdict, kept apart from the request's decision: a reviewer can comment\nwithout deciding, and a request can need a review nobody has given.","type":"string","enum":["approved","changesRequested","commented"]};
// prettier-ignore
function validate933(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate933.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.reviewer === undefined) && (missing0 = "reviewer")) || ((data.verdict === undefined) && (missing0 = "verdict"))){validate933.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "reviewer") || (key0 === "verdict"))){validate933.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reviewer !== undefined){let data0: any = data.reviewer;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate933.errors = [{instancePath:instancePath+"/reviewer",schemaPath:"#/properties/reviewer/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate933.errors = [{instancePath:instancePath+"/reviewer",schemaPath:"#/properties/reviewer/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.verdict !== undefined){let data1: any = data.verdict;const _errs4: any = errors;if(typeof data1 !== "string"){validate933.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/$defs/ReviewerVerdict/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "approved") || (data1 === "changesRequested")) || (data1 === "commented"))){validate933.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/$defs/ReviewerVerdict/enum",keyword:"enum",params:{allowedValues: schema1774.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate933.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate933.errors = vErrors;return errors === 0;}
// prettier-ignore
validate933.errors = null as any[] | null;
// prettier-ignore
validate933.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1777: any = {"description":"Which side of a diff a line belongs to: before the change or after it.","type":"string","enum":["old","new"]};
// prettier-ignore
const schema1778: any = {"description":"A review thread's state; an outdated thread's line no longer exists in the diff.","type":"string","enum":["open","resolved","outdated"]};
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate936(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate936.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.commentId === undefined) && (missing0 = "commentId")) || ((data.author === undefined) && (missing0 = "author"))) || ((data.body === undefined) && (missing0 = "body"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validate936.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "commentId") || (key0 === "author")) || (key0 === "body")) || (key0 === "createdAt"))){validate936.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commentId !== undefined){let data0: any = data.commentId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate936.errors = [{instancePath:instancePath+"/commentId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate936.errors = [{instancePath:instancePath+"/commentId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.author !== undefined){let data1: any = data.author;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate936.errors = [{instancePath:instancePath+"/author",schemaPath:"#/properties/author/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate936.errors = [{instancePath:instancePath+"/author",schemaPath:"#/properties/author/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){const _errs8: any = errors;if(typeof data.body !== "string"){validate936.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){let data3: any = data.createdAt;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data3 === "string"){if(!pattern5.test(data3)){validate936.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate936.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate936.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate936.errors = vErrors;return errors === 0;}
// prettier-ignore
validate936.errors = null as any[] | null;
// prettier-ignore
validate936.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate935(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate935.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.threadId === undefined) && (missing0 = "threadId")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.comments === undefined) && (missing0 = "comments"))){validate935.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "threadId") || (key0 === "path")) || (key0 === "line")) || (key0 === "side")) || (key0 === "state")) || (key0 === "comments"))){validate935.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.threadId !== undefined){let data0: any = data.threadId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate935.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate935.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate935.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate935.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate935.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate935.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.line !== undefined){let data2: any = data.line;const _errs8: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate935.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate935.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validate935.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.side !== undefined){let data3: any = data.side;const _errs10: any = errors;if(typeof data3 !== "string"){validate935.errors = [{instancePath:instancePath+"/side",schemaPath:"#/$defs/DiffSide/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data3 === "old") || (data3 === "new"))){validate935.errors = [{instancePath:instancePath+"/side",schemaPath:"#/$defs/DiffSide/enum",keyword:"enum",params:{allowedValues: schema1777.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data4: any = data.state;const _errs13: any = errors;if(typeof data4 !== "string"){validate935.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ReviewThreadState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data4 === "open") || (data4 === "resolved")) || (data4 === "outdated"))){validate935.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ReviewThreadState/enum",keyword:"enum",params:{allowedValues: schema1778.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.comments !== undefined){let data5: any = data.comments;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data5)){if(data5.length < 1){validate935.errors = [{instancePath:instancePath+"/comments",schemaPath:"#/properties/comments/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid4: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){const _errs18: any = errors;if(!(validate936.call(this, data5[i0], {instancePath:instancePath+"/comments/" + i0,parentData:data5,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate936.errors : vErrors.concat(validate936.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;if(!valid4){break;}}}}else {validate935.errors = [{instancePath:instancePath+"/comments",schemaPath:"#/properties/comments/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate935.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate935.errors = vErrors;return errors === 0;}
// prettier-ignore
validate935.errors = null as any[] | null;
// prettier-ignore
validate935.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1784: any = {"description":"One check's outcome on the host.","type":"string","enum":["pending","success","failure"]};
// prettier-ignore
function validate939(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate939.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.checkId === undefined) && (missing0 = "checkId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.status === undefined) && (missing0 = "status"))){validate939.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "checkId") || (key0 === "name")) || (key0 === "status")) || (key0 === "runUrl"))){validate939.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.checkId !== undefined){let data0: any = data.checkId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate939.errors = [{instancePath:instancePath+"/checkId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate939.errors = [{instancePath:instancePath+"/checkId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate939.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate939.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data2: any = data.status;const _errs8: any = errors;if(typeof data2 !== "string"){validate939.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/ChangeRequestCheckStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "pending") || (data2 === "success")) || (data2 === "failure"))){validate939.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/ChangeRequestCheckStatus/enum",keyword:"enum",params:{allowedValues: schema1784.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.runUrl !== undefined){let data3: any = data.runUrl;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(errors === _errs12){if(typeof data3 === "string"){if(!pattern738.test(data3)){validate939.errors = [{instancePath:instancePath+"/runUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data3))){validate939.errors = [{instancePath:instancePath+"/runUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate939.errors = [{instancePath:instancePath+"/runUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate939.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate939.errors = vErrors;return errors === 0;}
// prettier-ignore
validate939.errors = null as any[] | null;
// prettier-ignore
validate939.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate932(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate932.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.number === undefined) && (missing0 = "number")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.isDraft === undefined) && (missing0 = "isDraft"))) || ((data.viewerIsAuthor === undefined) && (missing0 = "viewerIsAuthor"))) || ((data.reviews === undefined) && (missing0 = "reviews"))) || ((data.requestedReviewers === undefined) && (missing0 = "requestedReviewers"))) || ((data.threads === undefined) && (missing0 = "threads"))) || ((data.checks === undefined) && (missing0 = "checks"))) || ((data.headCommitId === undefined) && (missing0 = "headCommitId"))){validate932.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1767.properties, key0))){validate932.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.number !== undefined){let data0: any = data.number;const _errs2: any = errors;const _errs3: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate932.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate932.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate932.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.url !== undefined){let data1: any = data.url;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(errors === _errs6){if(typeof data1 === "string"){if(!pattern738.test(data1)){validate932.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data1))){validate932.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate932.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs8: any = errors;if(typeof data2 !== "string"){validate932.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChangeRequestState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "open") || (data2 === "merged")) || (data2 === "closed"))){validate932.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChangeRequestState/enum",keyword:"enum",params:{allowedValues: schema1762.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.isDraft !== undefined){const _errs11: any = errors;if(typeof data.isDraft !== "boolean"){validate932.errors = [{instancePath:instancePath+"/isDraft",schemaPath:"#/properties/isDraft/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.mergeable !== undefined){let data4: any = data.mergeable;const _errs13: any = errors;if(typeof data4 !== "string"){validate932.errors = [{instancePath:instancePath+"/mergeable",schemaPath:"#/$defs/ChangeRequestMergeability/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data4 === "mergeable") || (data4 === "conflicting"))){validate932.errors = [{instancePath:instancePath+"/mergeable",schemaPath:"#/$defs/ChangeRequestMergeability/enum",keyword:"enum",params:{allowedValues: schema1763.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.reviewDecision !== undefined){let data5: any = data.reviewDecision;const _errs16: any = errors;if(typeof data5 !== "string"){validate932.errors = [{instancePath:instancePath+"/reviewDecision",schemaPath:"#/$defs/ChangeRequestReviewDecision/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data5 === "approved") || (data5 === "changesRequested")) || (data5 === "reviewRequired"))){validate932.errors = [{instancePath:instancePath+"/reviewDecision",schemaPath:"#/$defs/ChangeRequestReviewDecision/enum",keyword:"enum",params:{allowedValues: schema1764.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.viewerIsAuthor !== undefined){const _errs19: any = errors;if(typeof data.viewerIsAuthor !== "boolean"){validate932.errors = [{instancePath:instancePath+"/viewerIsAuthor",schemaPath:"#/properties/viewerIsAuthor/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data7: any = data.description;const _errs21: any = errors;if(errors === _errs21){if(typeof data7 === "string"){if(func1(data7) < 1){validate932.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate932.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.reviews !== undefined){let data8: any = data.reviews;const _errs23: any = errors;if(errors === _errs23){if(Array.isArray(data8)){var valid6: any = true;const len0: any = data8.length;for(let i0=0; i0<len0; i0++){const _errs25: any = errors;if(!(validate933.call(this, data8[i0], {instancePath:instancePath+"/reviews/" + i0,parentData:data8,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate933.errors : vErrors.concat(validate933.errors);errors = vErrors.length;}var valid6: any = _errs25 === errors;if(!valid6){break;}}}else {validate932.errors = [{instancePath:instancePath+"/reviews",schemaPath:"#/properties/reviews/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.requestedReviewers !== undefined){let data10: any = data.requestedReviewers;const _errs26: any = errors;if(errors === _errs26){if(Array.isArray(data10)){var valid7: any = true;const len1: any = data10.length;for(let i1=0; i1<len1; i1++){let data11: any = data10[i1];const _errs28: any = errors;if(errors === _errs28){if(typeof data11 === "string"){if(func1(data11) < 1){validate932.errors = [{instancePath:instancePath+"/requestedReviewers/" + i1,schemaPath:"#/properties/requestedReviewers/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate932.errors = [{instancePath:instancePath+"/requestedReviewers/" + i1,schemaPath:"#/properties/requestedReviewers/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs28 === errors;if(!valid7){break;}}}else {validate932.errors = [{instancePath:instancePath+"/requestedReviewers",schemaPath:"#/properties/requestedReviewers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs26 === errors;}else {var valid0: any = true;}if(valid0){if(data.threads !== undefined){let data12: any = data.threads;const _errs30: any = errors;if(errors === _errs30){if(Array.isArray(data12)){var valid8: any = true;const len2: any = data12.length;for(let i2=0; i2<len2; i2++){const _errs32: any = errors;if(!(validate935.call(this, data12[i2], {instancePath:instancePath+"/threads/" + i2,parentData:data12,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate935.errors : vErrors.concat(validate935.errors);errors = vErrors.length;}var valid8: any = _errs32 === errors;if(!valid8){break;}}}else {validate932.errors = [{instancePath:instancePath+"/threads",schemaPath:"#/properties/threads/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs30 === errors;}else {var valid0: any = true;}if(valid0){if(data.checks !== undefined){let data14: any = data.checks;const _errs33: any = errors;if(errors === _errs33){if(Array.isArray(data14)){var valid9: any = true;const len3: any = data14.length;for(let i3=0; i3<len3; i3++){const _errs35: any = errors;if(!(validate939.call(this, data14[i3], {instancePath:instancePath+"/checks/" + i3,parentData:data14,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate939.errors : vErrors.concat(validate939.errors);errors = vErrors.length;}var valid9: any = _errs35 === errors;if(!valid9){break;}}}else {validate932.errors = [{instancePath:instancePath+"/checks",schemaPath:"#/properties/checks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs33 === errors;}else {var valid0: any = true;}if(valid0){if(data.headCommitId !== undefined){let data16: any = data.headCommitId;const _errs36: any = errors;const _errs37: any = errors;if(errors === _errs37){if(typeof data16 === "string"){if(!pattern730.test(data16)){validate932.errors = [{instancePath:instancePath+"/headCommitId",schemaPath:"sidekicks-contracts:repo/git-reads#/$defs/GitObjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"}}];return false;}}else {validate932.errors = [{instancePath:instancePath+"/headCommitId",schemaPath:"sidekicks-contracts:repo/git-reads#/$defs/GitObjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs36 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}else {validate932.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate932.errors = vErrors;return errors === 0;}
// prettier-ignore
validate932.errors = null as any[] | null;
// prettier-ignore
validate932.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate929(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChangeRequestFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate929.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate929.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.depth;if(typeof tag0 == "string"){if(tag0 === "summary"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.depth === undefined) && (missing0 = "depth")) || ((data.requests === undefined) && (missing0 = "requests"))) || ((data.readAt === undefined) && (missing0 = "readAt"))){validate929.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((((key1 === "depth") || (key1 === "requests")) || (key1 === "readAt")) || (key1 === "lastReadFailedAt"))){validate929.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.depth !== undefined){let data0: any = data.depth;const _errs6: any = errors;if(typeof data0 !== "string"){validate929.errors = [{instancePath:instancePath+"/depth",schemaPath:"#/oneOf/0/properties/depth/type",keyword:"type",params:{type: "string"}}];return false;}if("summary" !== data0){validate929.errors = [{instancePath:instancePath+"/depth",schemaPath:"#/oneOf/0/properties/depth/const",keyword:"const",params:{allowedValue: "summary"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.requests !== undefined){let data1: any = data.requests;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data1)){var valid3: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs10: any = errors;if(!(validate930.call(this, data1[i0], {instancePath:instancePath+"/requests/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate930.errors : vErrors.concat(validate930.errors);errors = vErrors.length;}var valid3: any = _errs10 === errors;if(!valid3){break;}}}else {validate929.errors = [{instancePath:instancePath+"/requests",schemaPath:"#/oneOf/0/properties/requests/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.readAt !== undefined){let data3: any = data.readAt;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(!pattern5.test(data3)){validate929.errors = [{instancePath:instancePath+"/readAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate929.errors = [{instancePath:instancePath+"/readAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.lastReadFailedAt !== undefined){let data4: any = data.lastReadFailedAt;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data4 === "string"){if(!pattern5.test(data4)){validate929.errors = [{instancePath:instancePath+"/lastReadFailedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate929.errors = [{instancePath:instancePath+"/lastReadFailedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}}else {validate929.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "full"){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.depth === undefined) && (missing1 = "depth")) || ((data.requests === undefined) && (missing1 = "requests"))) || ((data.readAt === undefined) && (missing1 = "readAt"))){validate929.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs19: any = errors;for(const key2 in data){if(!((((key2 === "depth") || (key2 === "requests")) || (key2 === "readAt")) || (key2 === "lastReadFailedAt"))){validate929.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs19 === errors){if(data.depth !== undefined){let data5: any = data.depth;const _errs20: any = errors;if(typeof data5 !== "string"){validate929.errors = [{instancePath:instancePath+"/depth",schemaPath:"#/oneOf/1/properties/depth/type",keyword:"type",params:{type: "string"}}];return false;}if("full" !== data5){validate929.errors = [{instancePath:instancePath+"/depth",schemaPath:"#/oneOf/1/properties/depth/const",keyword:"const",params:{allowedValue: "full"}}];return false;}var valid7: any = _errs20 === errors;}else {var valid7: any = true;}if(valid7){if(data.requests !== undefined){let data6: any = data.requests;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data6)){var valid8: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){const _errs24: any = errors;if(!(validate932.call(this, data6[i1], {instancePath:instancePath+"/requests/" + i1,parentData:data6,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate932.errors : vErrors.concat(validate932.errors);errors = vErrors.length;}var valid8: any = _errs24 === errors;if(!valid8){break;}}}else {validate929.errors = [{instancePath:instancePath+"/requests",schemaPath:"#/oneOf/1/properties/requests/type",keyword:"type",params:{type: "array"}}];return false;}}var valid7: any = _errs22 === errors;}else {var valid7: any = true;}if(valid7){if(data.readAt !== undefined){let data8: any = data.readAt;const _errs25: any = errors;const _errs26: any = errors;if(errors === _errs26){if(typeof data8 === "string"){if(!pattern5.test(data8)){validate929.errors = [{instancePath:instancePath+"/readAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate929.errors = [{instancePath:instancePath+"/readAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs25 === errors;}else {var valid7: any = true;}if(valid7){if(data.lastReadFailedAt !== undefined){let data9: any = data.lastReadFailedAt;const _errs28: any = errors;const _errs29: any = errors;if(errors === _errs29){if(typeof data9 === "string"){if(!pattern5.test(data9)){validate929.errors = [{instancePath:instancePath+"/lastReadFailedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate929.errors = [{instancePath:instancePath+"/lastReadFailedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs28 === errors;}else {var valid7: any = true;}}}}}}}else {validate929.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate929.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "depth", tagValue: tag0}}];return false;}}else {validate929.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "depth", tagValue: tag0}}];return false;}}}else {validate929.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate929.errors = vErrors;return errors === 0;}
// prettier-ignore
validate929.errors = null as any[] | null;
// prettier-ignore
validate929.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate942(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChangeRequestSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate942.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.number === undefined) && (missing0 = "number")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.isDraft === undefined) && (missing0 = "isDraft"))){validate942.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "number") || (key0 === "url")) || (key0 === "state")) || (key0 === "isDraft")) || (key0 === "mergeable")) || (key0 === "reviewDecision"))){validate942.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.number !== undefined){let data0: any = data.number;const _errs2: any = errors;const _errs3: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate942.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate942.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate942.errors = [{instancePath:instancePath+"/number",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.url !== undefined){let data1: any = data.url;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(errors === _errs6){if(typeof data1 === "string"){if(!pattern738.test(data1)){validate942.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data1))){validate942.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate942.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs8: any = errors;if(typeof data2 !== "string"){validate942.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChangeRequestState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "open") || (data2 === "merged")) || (data2 === "closed"))){validate942.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ChangeRequestState/enum",keyword:"enum",params:{allowedValues: schema1762.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.isDraft !== undefined){const _errs11: any = errors;if(typeof data.isDraft !== "boolean"){validate942.errors = [{instancePath:instancePath+"/isDraft",schemaPath:"#/properties/isDraft/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.mergeable !== undefined){let data4: any = data.mergeable;const _errs13: any = errors;if(typeof data4 !== "string"){validate942.errors = [{instancePath:instancePath+"/mergeable",schemaPath:"#/$defs/ChangeRequestMergeability/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data4 === "mergeable") || (data4 === "conflicting"))){validate942.errors = [{instancePath:instancePath+"/mergeable",schemaPath:"#/$defs/ChangeRequestMergeability/enum",keyword:"enum",params:{allowedValues: schema1763.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.reviewDecision !== undefined){let data5: any = data.reviewDecision;const _errs16: any = errors;if(typeof data5 !== "string"){validate942.errors = [{instancePath:instancePath+"/reviewDecision",schemaPath:"#/$defs/ChangeRequestReviewDecision/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data5 === "approved") || (data5 === "changesRequested")) || (data5 === "reviewRequired"))){validate942.errors = [{instancePath:instancePath+"/reviewDecision",schemaPath:"#/$defs/ChangeRequestReviewDecision/enum",keyword:"enum",params:{allowedValues: schema1764.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate942.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate942.errors = vErrors;return errors === 0;}
// prettier-ignore
validate942.errors = null as any[] | null;
// prettier-ignore
validate942.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1797: any = {"description":"How much a change-request subscription carries: the header's facts, or Review's.","type":"string","enum":["summary","full"]};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate943(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitChangeRequestSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate943.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.depth === undefined) && (missing0 = "depth"))){validate943.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "depth"))){validate943.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate943.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate943.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.depth !== undefined){let data1: any = data.depth;const _errs6: any = errors;if(typeof data1 !== "string"){validate943.errors = [{instancePath:instancePath+"/depth",schemaPath:"#/$defs/ChangeRequestReadDepth/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "summary") || (data1 === "full"))){validate943.errors = [{instancePath:instancePath+"/depth",schemaPath:"#/$defs/ChangeRequestReadDepth/enum",keyword:"enum",params:{allowedValues: schema1797.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate943.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate943.errors = vErrors;return errors === 0;}
// prettier-ignore
validate943.errors = null as any[] | null;
// prettier-ignore
validate943.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate944(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitCheckLogReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate944.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.changeRequestNumber === undefined) && (missing0 = "changeRequestNumber"))) || ((data.checkId === undefined) && (missing0 = "checkId"))){validate944.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "changeRequestNumber")) || (key0 === "checkId"))){validate944.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate944.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate944.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.changeRequestNumber !== undefined){let data1: any = data.changeRequestNumber;const _errs6: any = errors;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate944.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate944.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate944.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.checkId !== undefined){let data2: any = data.checkId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate944.errors = [{instancePath:instancePath+"/checkId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate944.errors = [{instancePath:instancePath+"/checkId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate944.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate944.errors = vErrors;return errors === 0;}
// prettier-ignore
validate944.errors = null as any[] | null;
// prettier-ignore
validate944.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate945(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitCheckLogReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate945.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.text === undefined) && (missing0 = "text")) || ((data.truncated === undefined) && (missing0 = "truncated"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))){validate945.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "text") || (key0 === "truncated")) || (key0 === "totalBytes")) || (key0 === "runUrl"))){validate945.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){const _errs2: any = errors;if(typeof data.text !== "string"){validate945.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.truncated !== undefined){const _errs4: any = errors;if(typeof data.truncated !== "boolean"){validate945.errors = [{instancePath:instancePath+"/truncated",schemaPath:"#/properties/truncated/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.totalBytes !== undefined){let data2: any = data.totalBytes;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate945.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate945.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate945.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runUrl !== undefined){let data3: any = data.runUrl;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(errors === _errs9){if(typeof data3 === "string"){if(!pattern738.test(data3)){validate945.errors = [{instancePath:instancePath+"/runUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data3))){validate945.errors = [{instancePath:instancePath+"/runUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate945.errors = [{instancePath:instancePath+"/runUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validate945.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate945.errors = vErrors;return errors === 0;}
// prettier-ignore
validate945.errors = null as any[] | null;
// prettier-ignore
validate945.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate946(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitHostAddRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate946.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.host === undefined) && (missing0 = "host")){validate946.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "host")){validate946.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.host !== undefined){let data0: any = data.host;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 253){validate946.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}}else {validate946.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate946.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate946.errors = vErrors;return errors === 0;}
// prettier-ignore
validate946.errors = null as any[] | null;
// prettier-ignore
validate946.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1807: any = {"description":"The hosting services served. A host is kept with the kind whose tool answered for it.","type":"string","enum":["github","gitlab"]};
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate948(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate948.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.host === undefined) && (missing0 = "host")) || ((data.kind === undefined) && (missing0 = "kind"))) || ((data.addedAt === undefined) && (missing0 = "addedAt"))){validate948.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "host") || (key0 === "kind")) || (key0 === "addedAt"))){validate948.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.host !== undefined){let data0: any = data.host;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 253){validate948.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}else {if(func1(data0) < 1){validate948.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate948.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate948.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.kind !== undefined){let data1: any = data.kind;const _errs4: any = errors;if(typeof data1 !== "string"){validate948.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/GitHostKind/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "github") || (data1 === "gitlab"))){validate948.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/GitHostKind/enum",keyword:"enum",params:{allowedValues: schema1807.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.addedAt !== undefined){let data2: any = data.addedAt;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(!pattern5.test(data2)){validate948.errors = [{instancePath:instancePath+"/addedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate948.errors = [{instancePath:instancePath+"/addedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate948.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate948.errors = vErrors;return errors === 0;}
// prettier-ignore
validate948.errors = null as any[] | null;
// prettier-ignore
validate948.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate947(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitHostAddResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate947.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.host === undefined) && (missing0 = "host")){validate947.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "host")){validate947.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.host !== undefined){if(!(validate948.call(this, data.host, {instancePath:instancePath+"/host",parentData:data,parentDataProperty:"host",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate948.errors : vErrors.concat(validate948.errors);errors = vErrors.length;}}}}}else {validate947.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate947.errors = vErrors;return errors === 0;}
// prettier-ignore
validate947.errors = null as any[] | null;
// prettier-ignore
validate947.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate950(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitHostListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate950.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.hosts === undefined) && (missing0 = "hosts")){validate950.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "hosts")){validate950.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.hosts !== undefined){let data0: any = data.hosts;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate948.call(this, data0[i0], {instancePath:instancePath+"/hosts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate948.errors : vErrors.concat(validate948.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate950.errors = [{instancePath:instancePath+"/hosts",schemaPath:"#/properties/hosts/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate950.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate950.errors = vErrors;return errors === 0;}
// prettier-ignore
validate950.errors = null as any[] | null;
// prettier-ignore
validate950.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate952(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitHostRemoveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate952.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.host === undefined) && (missing0 = "host")){validate952.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "host")){validate952.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.host !== undefined){let data0: any = data.host;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 253){validate952.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/maxLength",keyword:"maxLength",params:{limit: 253}}];return false;}}else {validate952.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate952.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate952.errors = vErrors;return errors === 0;}
// prettier-ignore
validate952.errors = null as any[] | null;
// prettier-ignore
validate952.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate953(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitHostRemoveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate953.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.removed === undefined) && (missing0 = "removed")){validate953.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "removed")){validate953.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.removed !== undefined){if(typeof data.removed !== "boolean"){validate953.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/type",keyword:"type",params:{type: "boolean"}}];return false;}}}}}else {validate953.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate953.errors = vErrors;return errors === 0;}
// prettier-ignore
validate953.errors = null as any[] | null;
// prettier-ignore
validate953.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate954(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitLabelListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate954.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.labels === undefined) && (missing0 = "labels")){validate954.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "labels")){validate954.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.labels !== undefined){let data0: any = data.labels;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if((data1.name === undefined) && (missing1 = "name")){validate954.errors = [{instancePath:instancePath+"/labels/" + i0,schemaPath:"#/$defs/LabelCandidate/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs7: any = errors;for(const key1 in data1){if(!((key1 === "name") || (key1 === "description"))){validate954.errors = [{instancePath:instancePath+"/labels/" + i0,schemaPath:"#/$defs/LabelCandidate/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs7 === errors){if(data1.name !== undefined){let data2: any = data1.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate954.errors = [{instancePath:instancePath+"/labels/" + i0+"/name",schemaPath:"#/$defs/LabelCandidate/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate954.errors = [{instancePath:instancePath+"/labels/" + i0+"/name",schemaPath:"#/$defs/LabelCandidate/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs8 === errors;}else {var valid3: any = true;}if(valid3){if(data1.description !== undefined){let data3: any = data1.description;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validate954.errors = [{instancePath:instancePath+"/labels/" + i0+"/description",schemaPath:"#/$defs/LabelCandidate/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate954.errors = [{instancePath:instancePath+"/labels/" + i0+"/description",schemaPath:"#/$defs/LabelCandidate/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}}}}}else {validate954.errors = [{instancePath:instancePath+"/labels/" + i0,schemaPath:"#/$defs/LabelCandidate/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate954.errors = [{instancePath:instancePath+"/labels",schemaPath:"#/properties/labels/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate954.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate954.errors = vErrors;return errors === 0;}
// prettier-ignore
validate954.errors = null as any[] | null;
// prettier-ignore
validate954.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1154: any = {"description":"The verdict the person posts a review under.","type":"string","enum":["comment","approve","requestChanges"]};
// prettier-ignore
function validate955(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewSubmitRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate955.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.changeRequestNumber === undefined) && (missing0 = "changeRequestNumber"))) || ((data.verdict === undefined) && (missing0 = "verdict"))){validate955.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "changeRequestNumber")) || (key0 === "verdict")) || (key0 === "body"))){validate955.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate955.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate955.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.changeRequestNumber !== undefined){let data1: any = data.changeRequestNumber;const _errs6: any = errors;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate955.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate955.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate955.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.verdict !== undefined){let data2: any = data.verdict;const _errs9: any = errors;if(typeof data2 !== "string"){validate955.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/$defs/ReviewSubmitVerdict/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "comment") || (data2 === "approve")) || (data2 === "requestChanges"))){validate955.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/$defs/ReviewSubmitVerdict/enum",keyword:"enum",params:{allowedValues: schema1154.enum}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data3: any = data.body;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) < 1){validate955.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate955.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}else {validate955.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate955.errors = vErrors;return errors === 0;}
// prettier-ignore
validate955.errors = null as any[] | null;
// prettier-ignore
validate955.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate958(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate958.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.noteId === undefined) && (missing0 = "noteId")) || ((data.reason === undefined) && (missing0 = "reason"))){validate958.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "noteId") || (key0 === "reason"))){validate958.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.noteId !== undefined){let data0: any = data.noteId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate958.errors = [{instancePath:instancePath+"/noteId",schemaPath:"sidekicks-contracts:review-note#/$defs/ReviewNoteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate958.errors = [{instancePath:instancePath+"/noteId",schemaPath:"sidekicks-contracts:review-note#/$defs/ReviewNoteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data1: any = data.reason;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate958.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate958.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate958.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate958.errors = vErrors;return errors === 0;}
// prettier-ignore
validate958.errors = null as any[] | null;
// prettier-ignore
validate958.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate956(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewSubmitResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate956.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.postedNoteIds === undefined) && (missing0 = "postedNoteIds")) || ((data.failures === undefined) && (missing0 = "failures"))){validate956.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "reviewUrl") || (key0 === "postedNoteIds")) || (key0 === "failures"))){validate956.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reviewUrl !== undefined){let data0: any = data.reviewUrl;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(errors === _errs3){if(typeof data0 === "string"){if(!pattern738.test(data0)){validate956.errors = [{instancePath:instancePath+"/reviewUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data0))){validate956.errors = [{instancePath:instancePath+"/reviewUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate956.errors = [{instancePath:instancePath+"/reviewUrl",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.postedNoteIds !== undefined){let data1: any = data.postedNoteIds;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate956.errors = [{instancePath:instancePath+"/postedNoteIds/" + i0,schemaPath:"sidekicks-contracts:review-note#/$defs/ReviewNoteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate956.errors = [{instancePath:instancePath+"/postedNoteIds/" + i0,schemaPath:"sidekicks-contracts:review-note#/$defs/ReviewNoteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {validate956.errors = [{instancePath:instancePath+"/postedNoteIds",schemaPath:"#/properties/postedNoteIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.failures !== undefined){let data3: any = data.failures;const _errs11: any = errors;if(errors === _errs11){if(Array.isArray(data3)){var valid4: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){const _errs13: any = errors;if(!(validate958.call(this, data3[i1], {instancePath:instancePath+"/failures/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate958.errors : vErrors.concat(validate958.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;if(!valid4){break;}}}else {validate956.errors = [{instancePath:instancePath+"/failures",schemaPath:"#/properties/failures/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}else {validate956.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate956.errors = vErrors;return errors === 0;}
// prettier-ignore
validate956.errors = null as any[] | null;
// prettier-ignore
validate956.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate960(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewThreadReplyRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate960.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.changeRequestNumber === undefined) && (missing0 = "changeRequestNumber"))) || ((data.threadId === undefined) && (missing0 = "threadId"))) || ((data.body === undefined) && (missing0 = "body"))){validate960.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "changeRequestNumber")) || (key0 === "threadId")) || (key0 === "body"))){validate960.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate960.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate960.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.changeRequestNumber !== undefined){let data1: any = data.changeRequestNumber;const _errs6: any = errors;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate960.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate960.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate960.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.threadId !== undefined){let data2: any = data.threadId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate960.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate960.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){let data3: any = data.body;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(func1(data3) < 1){validate960.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate960.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}else {validate960.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate960.errors = vErrors;return errors === 0;}
// prettier-ignore
validate960.errors = null as any[] | null;
// prettier-ignore
validate960.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate961(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewThreadReplyResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate961.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.commentId === undefined) && (missing0 = "commentId")){validate961.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "commentId") || (key0 === "url"))){validate961.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commentId !== undefined){let data0: any = data.commentId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate961.errors = [{instancePath:instancePath+"/commentId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate961.errors = [{instancePath:instancePath+"/commentId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.url !== undefined){let data1: any = data.url;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(errors === _errs7){if(typeof data1 === "string"){if(!pattern738.test(data1)){validate961.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/pattern",keyword:"pattern",params:{pattern: "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://"}}];return false;}else {if(!(formats18(data1))){validate961.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/format",keyword:"format",params:{format: "web-url"}}];return false;}}}else {validate961.errors = [{instancePath:instancePath+"/url",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostingAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate961.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate961.errors = vErrors;return errors === 0;}
// prettier-ignore
validate961.errors = null as any[] | null;
// prettier-ignore
validate961.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate962(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewThreadResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate962.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.changeRequestNumber === undefined) && (missing0 = "changeRequestNumber"))) || ((data.threadId === undefined) && (missing0 = "threadId"))){validate962.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "changeRequestNumber")) || (key0 === "threadId"))){validate962.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate962.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate962.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.changeRequestNumber !== undefined){let data1: any = data.changeRequestNumber;const _errs6: any = errors;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate962.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate962.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate962.errors = [{instancePath:instancePath+"/changeRequestNumber",schemaPath:"sidekicks-contracts:git/shared#/$defs/ChangeRequestNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.threadId !== undefined){let data2: any = data.threadId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate962.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate962.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate962.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate962.errors = vErrors;return errors === 0;}
// prettier-ignore
validate962.errors = null as any[] | null;
// prettier-ignore
validate962.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1835: any = {"type":"object","additionalProperties":false,"properties":{"threadId":{"$ref":"sidekicks-contracts:git/shared#/$defs/HostHandle","description":"The thread."},"state":{"description":"Its state.","type":"string","enum":["resolved"]}},"required":["threadId","state"],"description":"The `git.reviewThread.resolve` result."};
// prettier-ignore
function validate963(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewThreadResolveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate963.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.threadId === undefined) && (missing0 = "threadId")) || ((data.state === undefined) && (missing0 = "state"))){validate963.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "threadId") || (key0 === "state"))){validate963.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.threadId !== undefined){let data0: any = data.threadId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate963.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate963.errors = [{instancePath:instancePath+"/threadId",schemaPath:"sidekicks-contracts:git/shared#/$defs/HostHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs6: any = errors;if(typeof data1 !== "string"){validate963.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data1 === "resolved")){validate963.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema1835.properties.state.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate963.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate963.errors = vErrors;return errors === 0;}
// prettier-ignore
validate963.errors = null as any[] | null;
// prettier-ignore
validate963.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate964(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewerListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate964.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate964.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "query"))){validate964.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate964.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate964.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.query !== undefined){let data1: any = data.query;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate964.errors = [{instancePath:instancePath+"/query",schemaPath:"#/properties/query/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate964.errors = [{instancePath:instancePath+"/query",schemaPath:"#/properties/query/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate964.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate964.errors = vErrors;return errors === 0;}
// prettier-ignore
validate964.errors = null as any[] | null;
// prettier-ignore
validate964.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate965(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitReviewerListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate965.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reviewers === undefined) && (missing0 = "reviewers")){validate965.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "reviewers")){validate965.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reviewers !== undefined){let data0: any = data.reviewers;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if((data1.login === undefined) && (missing1 = "login")){validate965.errors = [{instancePath:instancePath+"/reviewers/" + i0,schemaPath:"#/$defs/ReviewerCandidate/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs7: any = errors;for(const key1 in data1){if(!((key1 === "login") || (key1 === "name"))){validate965.errors = [{instancePath:instancePath+"/reviewers/" + i0,schemaPath:"#/$defs/ReviewerCandidate/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs7 === errors){if(data1.login !== undefined){let data2: any = data1.login;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate965.errors = [{instancePath:instancePath+"/reviewers/" + i0+"/login",schemaPath:"#/$defs/ReviewerCandidate/properties/login/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate965.errors = [{instancePath:instancePath+"/reviewers/" + i0+"/login",schemaPath:"#/$defs/ReviewerCandidate/properties/login/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs8 === errors;}else {var valid3: any = true;}if(valid3){if(data1.name !== undefined){let data3: any = data1.name;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validate965.errors = [{instancePath:instancePath+"/reviewers/" + i0+"/name",schemaPath:"#/$defs/ReviewerCandidate/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate965.errors = [{instancePath:instancePath+"/reviewers/" + i0+"/name",schemaPath:"#/$defs/ReviewerCandidate/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}}}}}else {validate965.errors = [{instancePath:instancePath+"/reviewers/" + i0,schemaPath:"#/$defs/ReviewerCandidate/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate965.errors = [{instancePath:instancePath+"/reviewers",schemaPath:"#/properties/reviewers/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate965.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate965.errors = vErrors;return errors === 0;}
// prettier-ignore
validate965.errors = null as any[] | null;
// prettier-ignore
validate965.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate966(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitSessionRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate966.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate966.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate966.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate966.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate966.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate966.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate966.errors = vErrors;return errors === 0;}
// prettier-ignore
validate966.errors = null as any[] | null;
// prettier-ignore
validate966.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ChangeRequestFrame}. */
export const validateChangeRequestFrame: SchemaCheck<ChangeRequestFrame> = validate929;
/** Checks that a value is a {@link ChangeRequestSummary}. */
export const validateChangeRequestSummary: SchemaCheck<ChangeRequestSummary> = validate942;
/** Checks that a value is a {@link GitChangeRequestSubscribeRequest}. */
export const validateGitChangeRequestSubscribeRequest: SchemaCheck<GitChangeRequestSubscribeRequest> =
  validate943;
/** Checks that a value is a {@link GitCheckLogReadRequest}. */
export const validateGitCheckLogReadRequest: SchemaCheck<GitCheckLogReadRequest> = validate944;
/** Checks that a value is a {@link GitCheckLogReadResponse}. */
export const validateGitCheckLogReadResponse: SchemaCheck<GitCheckLogReadResponse> = validate945;
/** Checks that a value is a {@link GitHostAddRequest}. */
export const validateGitHostAddRequest: SchemaCheck<GitHostAddRequest> = validate946;
/** Checks that a value is a {@link GitHostAddResponse}. */
export const validateGitHostAddResponse: SchemaCheck<GitHostAddResponse> = validate947;
/** Checks that a value is a {@link GitHostListResponse}. */
export const validateGitHostListResponse: SchemaCheck<GitHostListResponse> = validate950;
/** Checks that a value is a {@link GitHostRemoveRequest}. */
export const validateGitHostRemoveRequest: SchemaCheck<GitHostRemoveRequest> = validate952;
/** Checks that a value is a {@link GitHostRemoveResponse}. */
export const validateGitHostRemoveResponse: SchemaCheck<GitHostRemoveResponse> = validate953;
/** Checks that a value is a {@link GitLabelListResponse}. */
export const validateGitLabelListResponse: SchemaCheck<GitLabelListResponse> = validate954;
/** Checks that a value is a {@link GitReviewSubmitRequest}. */
export const validateGitReviewSubmitRequest: SchemaCheck<GitReviewSubmitRequest> = validate955;
/** Checks that a value is a {@link GitReviewSubmitResponse}. */
export const validateGitReviewSubmitResponse: SchemaCheck<GitReviewSubmitResponse> = validate956;
/** Checks that a value is a {@link GitReviewThreadReplyRequest}. */
export const validateGitReviewThreadReplyRequest: SchemaCheck<GitReviewThreadReplyRequest> =
  validate960;
/** Checks that a value is a {@link GitReviewThreadReplyResponse}. */
export const validateGitReviewThreadReplyResponse: SchemaCheck<GitReviewThreadReplyResponse> =
  validate961;
/** Checks that a value is a {@link GitReviewThreadResolveRequest}. */
export const validateGitReviewThreadResolveRequest: SchemaCheck<GitReviewThreadResolveRequest> =
  validate962;
/** Checks that a value is a {@link GitReviewThreadResolveResponse}. */
export const validateGitReviewThreadResolveResponse: SchemaCheck<GitReviewThreadResolveResponse> =
  validate963;
/** Checks that a value is a {@link GitReviewerListRequest}. */
export const validateGitReviewerListRequest: SchemaCheck<GitReviewerListRequest> = validate964;
/** Checks that a value is a {@link GitReviewerListResponse}. */
export const validateGitReviewerListResponse: SchemaCheck<GitReviewerListResponse> = validate965;
/** Checks that a value is a {@link GitSessionRequest}. */
export const validateGitSessionRequest: SchemaCheck<GitSessionRequest> = validate966;
