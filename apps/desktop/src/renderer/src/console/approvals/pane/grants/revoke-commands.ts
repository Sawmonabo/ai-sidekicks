// Retiring one standing permission, from the palette — through the same two steps.
//
// `Spec-023 §Console Design (Meridian)` requires every operator action to be
// palette-reachable, and the standing-permission list holds one the approvals pane's
// own contribution does not carry: revoking a remembered grant. That act is
// deliberately two-step and irreversible from this surface, so what a palette row may
// do is ENTER the confirmation — the same thing the list's own Revoke button does —
// and never reach the wire. A row that mutated on one press would be a second, weaker
// path to an act the surface made deliberately hard.
//
// CONTRIBUTED BY THE LIST AND NOT BY THE PANE, for two reasons that point the same
// way. The arming state is the list's own — which rule is confirming is not a fact
// the pane holds — and the offer reading is the list's too: which rules are live and
// which have a revoke in flight is what its rows are drawn from, so a contribution
// composed a level up would be a SECOND reading of the same reply. The pane's own
// rows are contributed under a different owner, and the palette register is
// per-owner, so the two sets sit beside each other rather than replacing each other.

import { useMemo } from "react";

import { type RememberedRule } from "../../../bridge/index.js";
import { useConsoleCommandSeat, type ConsoleCommand } from "../../../palette/index.js";
import { useLatestRef } from "../../../primitives/index.js";

/** The owner these rows are contributed under. One per surface, one live at a time. */
export const REVOKE_COMMAND_OWNER = "approvals-grants";

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

/** One contributed row: which rule, under what title. */
export interface RevokeCommandRow {
  readonly ruleId: string;
  readonly title: string;
}

/** What the rows act on, read at invoke time rather than captured. */
export interface RevokeCommandInput {
  /** The rules the list renders, exactly as it received them. */
  readonly rules: readonly RememberedRule[];
  /** Rules whose revocation is already settling. Their control offers no second press. */
  readonly revokingRuleIds: ReadonlySet<string>;
  /**
   * Arm the confirmation for one rule — the list's own first press.
   *
   * It is the ARMING and not the mutation: the confirming press is the only handler
   * that reaches the wire, and it stays on the control where a person can read what
   * they are about to do.
   */
  readonly onAskToRevoke: (ruleId: string) => void;
}

/** Contribute a row per revocable rule for as long as the list is mounted. */
export function useRevokeCommands(input: RevokeCommandInput): void {
  const rows = revokeCommandRows(input);
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

  useConsoleCommandSeat(REVOKE_COMMAND_OWNER, commands);
}

/**
 * Whether this rule's revoke act is offered right now — on the row and in the palette.
 *
 * One predicate for both surfaces rather than two expressions that agree today. A
 * revoked rule is history and offers nothing, and a rule already settling offers a
 * status rather than a second press; the palette must withdraw its row on exactly
 * those two conditions or it becomes a way to press a button that is not there.
 */
export function offersRevoke(rule: RememberedRule, revokingRuleIds: ReadonlySet<string>): boolean {
  return rule.revokedAt === undefined && !revokingRuleIds.has(rule.ruleId);
}

/**
 * The rows the list offers right now.
 *
 * The rule is named in the title only where more than one is revocable: with one
 * standing permission "Revoke the standing permission" is unambiguous, and with three
 * the id is the only thing that tells them apart. The category and the grantor ride
 * the keywords in both cases, so a person can find a row by typing what the list says
 * rather than by reading an id.
 */
export function revokeCommandRows(input: RevokeCommandInput): readonly RevokeCommandRow[] {
  const revocable = input.rules.filter((rule) => offersRevoke(rule, input.revokingRuleIds));
  const namesTheRule = revocable.length > 1;
  return revocable.map((rule) => ({
    ruleId: rule.ruleId,
    title: namesTheRule
      ? `Revoke standing permission ${rule.ruleId}`
      : "Revoke the standing permission",
  }));
}

/**
 * Arm one rule's confirmation, if the list is still offering to.
 *
 * Re-read at invoke time rather than trusted from contribution time: a rule the reply
 * no longer carries, one somebody else revoked, and one whose own revocation started
 * in the gap all leave the list offering nothing, and arming a confirmation for a rule
 * with no control on screen would leave a person confirming into empty space.
 */
export function askToRevokeFromCommand(row: RevokeCommandRow, input: RevokeCommandInput): void {
  const live = input.rules.find((candidate) => candidate.ruleId === row.ruleId);
  if (live === undefined || !offersRevoke(live, input.revokingRuleIds)) {
    return;
  }
  input.onAskToRevoke(live.ruleId);
}

/** One command, reading everything that moves through the ref at invoke time. */
function buildRevokeCommand(
  row: RevokeCommandRow,
  inputRef: React.RefObject<RevokeCommandInput>,
): ConsoleCommand {
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
