// The approval card's rows, contributed to the command palette for as long as it is mounted.
//
// Which rows exist and what each sends are `contributions/approval-commands.ts`'s; this
// hook registers them and keeps what they read current.

import { useMemo } from "react";

import { useConsoleCommandSeat, type ConsoleCommand } from "@renderer/console/palette/index.js";
import { useLatestRef } from "@renderer/console/primitives/index.js";
import {
  APPROVAL_COMMAND_OWNER,
  approvalCommandRows,
  performApprovalCommand,
  type ApprovalCommandInput,
  type ApprovalCommandRow,
} from "../contributions/approval-commands.js";

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

/** Contribute the card's acts for as long as it is mounted. */
export function useApprovalCommands(input: ApprovalCommandInput): void {
  const rows = approvalCommandRows(input);
  // Refreshed by every COMMITTED render and never in the render body: a registered
  // row reads its records and its two dispatchers through this at invoke time, and a
  // render-body write would let a concurrent pass React throws away — one composed
  // against another session's records, another bridge's `resolve` — leave the row on
  // screen invoking what that discarded pass saw.
  const inputRef = useLatestRef(input);

  const signature = rows
    .map((row) => `${row.kind} ${row.record.approvalRequestId} ${row.title}`)
    .join("|");
  // Built from THIS render's rows rather than through a ref. The memo runs during the
  // render whose signature changed, which is before that render's layout effect has
  // refreshed anything, so a ref read here would build this render's commands out of
  // the previous pass's rows. The signature is the dependency because it is what the
  // rows SAY: keying on the array's identity would re-register on every event.
  const commands = useMemo(
    () => rows.map((row) => buildApprovalCommand(row, inputRef)),
    [signature, inputRef],
  );

  useConsoleCommandSeat(APPROVAL_COMMAND_OWNER, commands);
}

/** One command, reading everything that moves through the ref at invoke time. */
function buildApprovalCommand(
  row: ApprovalCommandRow,
  inputRef: React.RefObject<ApprovalCommandInput>,
): ConsoleCommand {
  const recordId = row.record.approvalRequestId;
  return {
    id: `approvals.${row.kind}.${recordId}`,
    title: row.title,
    group: APPROVAL_COMMAND_GROUP,
    when: APPROVAL_COMMAND_WHEN,
    keywords: [row.record.category, row.record.requestedBy, "approval"],
    run: () => {
      performApprovalCommand(row, inputRef.current);
    },
  };
}
