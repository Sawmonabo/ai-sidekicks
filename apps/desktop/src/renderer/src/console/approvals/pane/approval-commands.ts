// The approvals pane's acts, contributed to the command palette.
//
// `Spec-023 §Console Design (Meridian)` requires every operator action to be
// palette-reachable, and this pane holds three: approve a pending request, reject
// it, and clear the session's goal. Each dispatches the SAME call its on-screen
// control does, through the same reader and the same mutation hook, so a palette
// press goes in-flight on the card and settles into the card's own refusal.
//
// APPROVE AND REJECT CARRY WHAT THE CARD CARRIES AND NOTHING MORE. The request is
// `{ approvalRequestId, decision, effectiveScope: record.requestedScope }`, which
// is the card's own payload with the remembered-rule member deliberately absent:
// a remembered grant is a policy the participant has to SEE before it is minted,
// and a palette row shows no policy. The scope is the requested one, never wider.
//
// WHY THERE IS NO "SET THE GOAL" ROW. Setting a goal needs text, and a palette row
// has nowhere to type it; the card and the sidebar line both open an editor. Clear
// is a different act on the wire (`session.goalClear`, never an empty update) and
// needs no body, so it is the one goal act that can be an act rather than a
// navigation.
//
// EVERY ROW MIRRORS ITS CONTROL'S OWN OFFER RULE. A record whose resolve is in
// flight has its two buttons disabled, so it contributes no rows; a role that may
// not mutate the goal has no clear control, so it contributes none either. The
// mirror is read from the same values the surface renders from, so the palette
// cannot offer an act the pane has withdrawn.

import { useMemo, useRef } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "../../palette/index.js";
import { type ApprovalRecord, type SessionGoalProjection } from "../../bridge/index.js";
import { type ApprovalResolveRequest } from "./approvals-wire.js";

/** The owner these rows are contributed under. One per family, one live at a time. */
export const APPROVAL_COMMAND_OWNER = "approvals-family";

/** The palette category these sit under. */
const APPROVAL_COMMAND_GROUP = "Approvals";

/**
 * The clause these commands are offered under.
 *
 * `sessionActive`, the same key the run controls use: an approval belongs to a
 * session, and whether there is anything to approve is answered by whether a row
 * was contributed rather than by a clause the frame recomputes per route.
 */
const APPROVAL_COMMAND_WHEN = "sessionActive";

/** One contributed row: which act, against which record. */
export interface ApprovalCommandRow {
  readonly kind: "approve" | "reject" | "clear-goal";
  /** The record answered, or `undefined` on the goal row. */
  readonly record: ApprovalRecord | undefined;
  readonly title: string;
}

/** What the rows act on, read at invoke time rather than captured. */
export interface ApprovalCommandInput {
  /** The records waiting on a decision, exactly as the pending list renders them. */
  readonly pending: readonly ApprovalRecord[];
  /** Records with a resolve in flight. Their controls are disabled, so no row. */
  readonly resolvingApprovalIds: ReadonlySet<string>;
  readonly resolve: (request: ApprovalResolveRequest) => void;
  readonly goal: SessionGoalProjection;
  /** Whether this window's role may mutate the goal, as the card resolved it. */
  readonly canMutateGoal: boolean;
  /** Whether a goal mutation is already settling. One at a time, never queued. */
  readonly isMutatingGoal: boolean;
  readonly clearGoal: () => void;
}

/** Contribute this pane's acts for as long as it is mounted. */
export function useApprovalCommands(input: ApprovalCommandInput): void {
  const rows = approvalCommandRows(input);
  // Assigned during render, before the memo below reads it, so a rebuild triggered
  // by a changed signature sees this render's rows. The shape
  // `frame/frame-commands.ts` uses for its when-context.
  const rowsRef = useRef<readonly ApprovalCommandRow[]>(rows);
  rowsRef.current = rows;
  const inputRef = useRef<ApprovalCommandInput>(input);
  inputRef.current = input;

  const signature = rows
    .map((row) => `${row.kind} ${row.record?.approvalRequestId ?? ""} ${row.title}`)
    .join("|");
  const commands = useMemo(
    () => rowsRef.current.map((row) => buildApprovalCommand(row, inputRef)),
    [signature],
  );

  useConsoleCommandSeat(APPROVAL_COMMAND_OWNER, commands);
}

/**
 * The rows this pane offers right now.
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
    if (input.resolvingApprovalIds.has(record.approvalRequestId)) {
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
  if (input.goal.status === "set" && input.canMutateGoal && !input.isMutatingGoal) {
    rows.push({ kind: "clear-goal", record: undefined, title: "Clear the session goal" });
  }
  return rows;
}

/** One command, reading everything that moves through the ref at invoke time. */
function buildApprovalCommand(
  row: ApprovalCommandRow,
  inputRef: React.RefObject<ApprovalCommandInput>,
): ConsoleCommand {
  const recordId = row.record?.approvalRequestId;
  return {
    id: recordId === undefined ? `approvals.${row.kind}` : `approvals.${row.kind}.${recordId}`,
    title: row.title,
    group: APPROVAL_COMMAND_GROUP,
    when: APPROVAL_COMMAND_WHEN,
    keywords:
      row.record === undefined
        ? ["goal"]
        : [row.record.category, row.record.requestedBy, "approval"],
    run: () => {
      performApprovalCommand(row, inputRef.current);
    },
  };
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
  if (row.kind === "clear-goal") {
    if (input.canMutateGoal) {
      input.clearGoal();
    }
    return;
  }
  const recordId = row.record?.approvalRequestId;
  const live = input.pending.find((candidate) => candidate.approvalRequestId === recordId);
  if (live === undefined || input.resolvingApprovalIds.has(live.approvalRequestId)) {
    return;
  }
  input.resolve({
    approvalRequestId: live.approvalRequestId,
    decision: row.kind === "approve" ? "approved" : "rejected",
    effectiveScope: live.requestedScope,
  });
}
