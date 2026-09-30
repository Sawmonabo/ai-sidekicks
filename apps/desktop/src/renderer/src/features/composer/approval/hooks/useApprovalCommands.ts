// The approval card's rows, contributed to the command palette for as long as it is mounted.
//
// Which rows exist and what each sends are `contributions/approval-commands.ts`'s; this
// hook registers them and keeps what they read current.

import { useMemo } from "react";

import { useRegisterCommands } from "@renderer/registries/commands/hooks/useRegisterCommands.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
import {
  APPROVAL_COMMAND_OWNER,
  approvalCommandRows,
  performApprovalCommand,
  type ApprovalCommandInput,
  type ApprovalCommandRow,
} from "../contributions/approval-commands.js";

/** The palette category these sit under. */
const APPROVAL_COMMAND_GROUP = "Approvals";

/** The clause these commands are offered under, the same key the run controls use. */
const APPROVAL_COMMAND_WHEN = "sessionActive";

/** Contribute the card's acts for as long as it is mounted. */
export function useApprovalCommands(input: ApprovalCommandInput): void {
  const rows = approvalCommandRows(input);
  // Refreshed by every committed render, never in the render body: a discarded concurrent pass
  // would otherwise leave the on-screen row invoking what that pass saw.
  const inputRef = useLatestRef(input);

  const signature = rows.map((row) => `${row.kind} ${row.record.id} ${row.title}`).join("|");
  // Built from this render's rows, not through the ref, which is refreshed only after this memo
  // runs. Keyed on the signature because keying on the array identity would re-register on
  // every event.
  const commands = useMemo(
    () => rows.map((row) => buildApprovalCommand(row, inputRef)),
    [signature, inputRef],
  );

  useRegisterCommands(APPROVAL_COMMAND_OWNER, commands);
}

/** One command, reading everything that moves through the ref at invoke time. */
function buildApprovalCommand(
  row: ApprovalCommandRow,
  inputRef: React.RefObject<ApprovalCommandInput>,
): CommandDefinition {
  const recordId = row.record.id;
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
