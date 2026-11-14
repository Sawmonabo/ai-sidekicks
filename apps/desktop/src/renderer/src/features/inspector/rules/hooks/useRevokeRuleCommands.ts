// Retiring one standing permission from the palette: rows stay contributed while the list is
// mounted, and each enters the same two-step confirmation.
//
// Contributed by the list, not the pane: the arming state and the offer reading are the
// list's, and the pane's own rows sit beside these under a different owner.

import { useMemo } from "react";

import { useRegisterCommands } from "#renderer/registries/commands/hooks/useRegisterCommands.js";
import { type CommandDefinition } from "#renderer/registries/commands/definition.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { APPROVAL_COMMAND_GROUP } from "#renderer/lib/approval-vocabulary.js";
import { WHEN_SESSION_ACTIVE } from "#renderer/registries/commands/when-clause/vocabulary.js";
import {
  REVOKE_RULE_COMMAND_OWNER,
  askToRevokeFromCommand,
  revokeRuleCommandRows,
  type RevokeRuleCommandInput,
  type RevokeRuleCommandRow,
} from "../contributions/commands.js";

/** Contribute a row per revocable rule for as long as the list is mounted. */
export function useRevokeRuleCommands(input: RevokeRuleCommandInput): void {
  const rows = revokeRuleCommandRows(input);
  // Refreshed by each committed render, never in the render body: a discarded concurrent
  // pass must not leave a row arming what it saw.
  const inputRef = useLatestRef(input);

  const signature = rows.map((row) => `${row.ruleId} ${row.title}`).join("|");
  // Keyed on what the rows say, since the list re-renders on every approvals read and
  // re-registering would re-run the palette's search for nothing.
  const commands = useMemo(
    () => rows.map((row) => buildRevokeCommand(row, inputRef)),
    [signature, inputRef],
  );

  useRegisterCommands(REVOKE_RULE_COMMAND_OWNER, commands);
}

/** One command, reading everything that moves through the ref at invoke time. */
function buildRevokeCommand(
  row: RevokeRuleCommandRow,
  inputRef: React.RefObject<RevokeRuleCommandInput>,
): CommandDefinition {
  return {
    id: `approvals.ruleRevoke.${row.ruleId}`,
    title: row.title,
    group: APPROVAL_COMMAND_GROUP,
    when: WHEN_SESSION_ACTIVE,
    keywords: ["revoke", "permission", "grant"],
    run: () => {
      askToRevokeFromCommand(row, inputRef.current);
    },
  };
}
