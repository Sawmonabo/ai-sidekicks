// The approval card's acts as palette rows. Each row sends the same answer its on-screen control
// does, without the remembered-rule member (a rule must be seen before it is minted), and reads
// the card's own offer rule, so the palette cannot offer an act the card has withdrawn. A record
// with a resolve in flight contributes no rows.

import type {
  ApprovalProjectionRow,
  ApprovalResolveRequest,
} from "@ai-sidekicks/contracts/approval";

import { type Refusal } from "#renderer/lib/refusal/refusal.js";
import { approvalAnswer, isApprovalAnswerable } from "../offer.js";

/** The owner these rows are contributed under. */
export const APPROVAL_COMMAND_OWNER = "approval-card";

/** One contributed row: which act, against which record. */
export interface ApprovalCommandRow {
  readonly kind: "approve" | "reject";
  /** The record answered. */
  readonly record: ApprovalProjectionRow;
  readonly title: string;
}

/** What the rows act on, read at invoke time rather than captured. */
export interface ApprovalCommandInput {
  /** The records waiting on a decision, exactly as the pending list renders them. */
  readonly pending: readonly ApprovalProjectionRow[];
  /** Records with a resolve in flight. Their controls are disabled, so no row. */
  readonly resolvingApprovalIds: ReadonlySet<string>;
  /**
   * The refusal each record's own resolve last answered with, as the card list receives it. A
   * settled refusal takes the card's buttons off, so its rows go with them.
   */
  readonly resolveRefusalByApprovalId: ReadonlyMap<string, Refusal>;
  readonly resolve: (request: ApprovalResolveRequest) => void;
}

/**
 * The rows the card offers right now. The record id is in the title only when more than one is
 * waiting; category and requester ride the keywords so a row is findable by what the card says.
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
      title: namesTheRecord ? `Approve request ${record.id}` : "Approve the pending request",
    });
    rows.push({
      kind: "reject",
      record,
      title: namesTheRecord ? `Reject request ${record.id}` : "Reject the pending request",
    });
  }
  return rows;
}

/**
 * Performs one contributed act. A record the read does not return as pending is not answered,
 * so a press that lands before the row leaves the palette does nothing.
 */
export function performApprovalCommand(row: ApprovalCommandRow, input: ApprovalCommandInput): void {
  const recordId = row.record.id;
  const live = input.pending.find((candidate) => candidate.id === recordId);
  // Re-read at invoke time: a settled refusal can land between contribution and the key press.
  if (live === undefined || !offersAnAnswer(live, input)) {
    return;
  }
  input.resolve(approvalAnswer(live, row.kind === "approve" ? "approved" : "rejected", undefined));
}

/**
 * Whether this record's two answers are offered on the card and in the palette. A resolve in
 * flight disables the card's buttons, so it offers no row; the rest is the card's own reading.
 */
function offersAnAnswer(record: ApprovalProjectionRow, input: ApprovalCommandInput): boolean {
  if (input.resolvingApprovalIds.has(record.id)) {
    return false;
  }
  return isApprovalAnswerable(record, input.resolveRefusalByApprovalId.get(record.id));
}
