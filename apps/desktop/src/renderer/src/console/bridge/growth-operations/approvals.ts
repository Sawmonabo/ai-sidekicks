// The approval plane's ledger rows: the four methods the approvals pane calls.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type ApprovalOperationId = Extract<GrowthOperationId, `approval${string}`>;

/** The approval rows, in the order the single table carried them. */
export const APPROVAL_GROWTH_OPERATIONS: Readonly<
  Record<ApprovalOperationId, GrowthOperationEntry>
> = {
  // approval — the four methods the pane calls. All four method strings ARE
  // registered by the corpus and named here, because what the slate row is about is
  // the missing PAYLOAD pair rather than a missing name; the disjointness test holds
  // these against the registered-method table, so a landing pair is caught the day it
  // lands.
  approvalProjectionRead: op(
    "approvalProjectionRead",
    "approval-method-payloads",
    "method",
    "approval.projectionRead",
  ),
  approvalResolve: op("approvalResolve", "approval-method-payloads", "method", "approval.resolve"),
  approvalRuleList: op(
    "approvalRuleList",
    "approval-method-payloads",
    "method",
    "approval.ruleList",
  ),
  approvalRuleRevoke: op(
    "approvalRuleRevoke",
    "approval-method-payloads",
    "method",
    "approval.ruleRevoke",
  ),
};

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const APPROVAL_GROWTH_OPERATION_SUMMARIES: Readonly<Record<ApprovalOperationId, string>> = {
  approvalProjectionRead:
    "read a session's approval projection unfiltered, so the pane renders every record the daemon holds rather than a state the client chose",
  approvalResolve:
    "answer one approval request, approve or reject, optionally remembering the decision as a standing rule",
  approvalRuleList:
    "read a session's standing permissions with revoked rules included, because this list is the audit and a vanished rule reads as one never granted",
  approvalRuleRevoke:
    "revoke one standing permission, fired only by the confirming click of the two-step control",
};
