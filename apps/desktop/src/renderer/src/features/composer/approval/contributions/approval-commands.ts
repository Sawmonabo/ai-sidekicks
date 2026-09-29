// The approval card's acts as palette rows: which rows exist, and what answering sends.
//
// Every operator action is palette-reachable, and the card holds two: approve a
// pending request and reject it. Each dispatches the SAME call its on-screen control
// does, through the same reader and the same mutation hook, so a palette press goes
// in-flight on the card and settles into the card's own refusal.
//
// APPROVE AND REJECT CARRY WHAT THE CARD CARRIES AND NOTHING MORE. The request is
// `{ approvalRequestId, decision, effectiveScope: record.requestedScope }`, which
// is the card's own payload with the remembered-rule member deliberately absent: a
// remembered grant is a policy the user has to SEE before it is minted, and a palette
// row shows no policy. The scope is the requested one, never wider.
//
// EVERY ROW READS ITS CONTROL'S OWN OFFER RULE — the same function, never a mirror
// of it. `isApprovalAnswerable` decides whether a record's two answers are offered
// and `approval-offer.ts` says why it is one function. A record whose resolve is in
// flight has its buttons disabled, so it contributes no rows either. What this buys
// over "written twice and agreeing" is that the palette CANNOT offer an act the card
// has withdrawn: a settled refusal takes the two buttons off the card and the two rows
// out of the palette in one reading, and there is no second expression to drift.

import { type Refusal } from "@renderer/lib/refusal.js";
import {
  type ApprovalRecord,
  type ApprovalResolveRequest,
} from "@renderer/services/approvals/approval-records.js";
import { isApprovalAnswerable } from "../approval-offer.js";

/** The owner these rows are contributed under. One live at a time. */
export const APPROVAL_COMMAND_OWNER = "approval-card";

/** One contributed row: which act, against which record. */
export interface ApprovalCommandRow {
  readonly kind: "approve" | "reject";
  /** The record answered. */
  readonly record: ApprovalRecord;
  readonly title: string;
}

/** What the rows act on, read at invoke time rather than captured. */
export interface ApprovalCommandInput {
  /** The records waiting on a decision, exactly as the pending list renders them. */
  readonly pending: readonly ApprovalRecord[];
  /** Records with a resolve in flight. Their controls are disabled, so no row. */
  readonly resolvingApprovalIds: ReadonlySet<string>;
  /**
   * The refusal each record's own resolve last answered with, exactly as the card
   * list receives it. A SETTLED refusal takes the card's two buttons off, so the two
   * rows go with them; withholding this map is what let the palette keep offering a
   * decision about a request somebody else had already answered.
   */
  readonly resolveRefusalByApprovalId: ReadonlyMap<string, Refusal>;
  readonly resolve: (request: ApprovalResolveRequest) => void;
}

/**
 * The rows the card offers right now.
 *
 * The record is named in the title only where there is more than one waiting: with
 * one pending request "Approve the pending request" is unambiguous, and with three
 * the id is the only thing that tells them apart. The category and the requester
 * ride the keywords in both cases, so a person can find a row by typing what the
 * card says rather than by reading an id.
 */
export function approvalCommandRows(input: ApprovalCommandInput): readonly ApprovalCommandRow[] {
  const rows: ApprovalCommandRow[] = [];
  const namesTheRecord = input.pending.length > 1;
  for (const record of input.pending) {
    if (!offersAnAnswer(record, input)) {
      continue;
    }
    rows.push({
      kind: "approve",
      record,
      title: namesTheRecord
        ? `Approve request ${record.approvalRequestId}`
        : "Approve the pending request",
    });
    rows.push({
      kind: "reject",
      record,
      title: namesTheRecord
        ? `Reject request ${record.approvalRequestId}`
        : "Reject the pending request",
    });
  }
  return rows;
}

/**
 * Perform one contributed act.
 *
 * A record the read no longer returns as pending is not answered: it has been
 * resolved, expired, or canceled since the row was contributed, and answering it
 * would send a decision about a request that is no longer waiting. The row leaves
 * the palette on the next contribution; a press that lands in the gap does nothing.
 */
export function performApprovalCommand(row: ApprovalCommandRow, input: ApprovalCommandInput): void {
  const recordId = row.record.approvalRequestId;
  const live = input.pending.find((candidate) => candidate.approvalRequestId === recordId);
  // Re-read at invoke time and not trusted from contribution time: the same
  // reading the row was built from, because a settled refusal can land in the gap
  // between the row being contributed and the key being pressed.
  if (live === undefined || !offersAnAnswer(live, input)) {
    return;
  }
  input.resolve({
    approvalRequestId: live.approvalRequestId,
    decision: row.kind === "approve" ? "approved" : "rejected",
    effectiveScope: live.requestedScope,
  });
}

/**
 * Whether this record's two answers are offered right now, on both surfaces.
 *
 * The in-flight test is this palette's own — a card mid-resolve has its buttons
 * disabled rather than absent, and a row for a disabled button is a row that does
 * nothing — and the rest is the card's own reading, called rather than restated.
 */
function offersAnAnswer(record: ApprovalRecord, input: ApprovalCommandInput): boolean {
  if (input.resolvingApprovalIds.has(record.approvalRequestId)) {
    return false;
  }
  return isApprovalAnswerable(
    record,
    input.resolveRefusalByApprovalId.get(record.approvalRequestId),
  );
}
