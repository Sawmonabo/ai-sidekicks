// Retiring one standing permission from the palette: the rows stay contributed for as
// long as the list is mounted, and each one enters the same two-step confirmation.
//
// CONTRIBUTED BY THE LIST AND NOT BY THE PANE, for two reasons that point the same
// way. The arming state is the list's own — which rule is confirming is not a fact
// the pane holds — and the offer reading is the list's too: which rules are live and
// which have a revoke in flight is what its rows are drawn from, so a contribution
// composed a level up would be a SECOND reading of the same reply. The pane's own
// rows are contributed under a different owner, and the palette register is
// per-owner, so the two sets sit beside each other rather than replacing each other.

import { useMemo } from "react";

import { useRegisterCommands } from "@renderer/registries/commands/hooks/useRegisterCommands.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { useLatestRef } from "@renderer/console/primitives/index.js";
import {
  REVOKE_RULE_COMMAND_OWNER,
  askToRevokeFromCommand,
  revokeRuleCommandRows,
  type RevokeRuleCommandInput,
  type RevokeRuleCommandRow,
} from "../contributions/revoke-rule-commands.js";

/** The palette category these sit under, beside the pane's own approval rows. */
const REVOKE_COMMAND_GROUP = "Approvals";

/**
 * The clause these rows are offered under.
 *
 * `sessionActive`, the key every session-scoped act uses: a standing permission
 * belongs to a session, and WHICH rules can be revoked is answered by whether a row
 * was contributed rather than by a clause the frame recomputes per route.
 */
const REVOKE_COMMAND_WHEN = "sessionActive";

/** Contribute a row per revocable rule for as long as the list is mounted. */
export function useRevokeRuleCommands(input: RevokeRuleCommandInput): void {
  const rows = revokeRuleCommandRows(input);
  // Refreshed by every COMMITTED render and never in the render body: a registered
  // row reads the rules and the arming callback through this at invoke time, and a
  // render-body write would let a concurrent pass React throws away — one composed
  // against another session's rules — leave the row on screen arming what that
  // discarded pass saw.
  const inputRef = useLatestRef(input);

  const signature = rows.map((row) => `${row.ruleId} ${row.title}`).join("|");
  // Built from THIS render's rows rather than through a ref, and keyed on what the
  // rows SAY: the list re-renders on every approvals read, and re-registering the
  // owner on each one would re-run the palette's search for nothing.
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
    group: REVOKE_COMMAND_GROUP,
    when: REVOKE_COMMAND_WHEN,
    keywords: ["revoke", "permission", "grant"],
    run: () => {
      askToRevokeFromCommand(row, inputRef.current);
    },
  };
}
