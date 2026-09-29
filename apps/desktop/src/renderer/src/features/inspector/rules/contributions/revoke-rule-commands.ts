// The palette rows the inspector's Rules section contributes: which rules may be
// revoked from the palette, and what a row does when it is chosen.
//
// A row ENTERS the revoke confirmation — the same thing the list's own Revoke button does
// — and never reaches the wire. The act is deliberately two-step and irreversible, and a
// row that mutated on one press would be a second, weaker path to it.

import { type RememberedRule } from "@renderer/services/approvals/approval-records.js";

/** The owner these rows are contributed under. One per rules list, one live at a time. */
export const REVOKE_RULE_COMMAND_OWNER = "inspector-rules";

/** One contributed row: which rule, under what title. */
export interface RevokeRuleCommandRow {
  readonly ruleId: string;
  readonly title: string;
}

/** What the rows act on, read at invoke time rather than captured. */
export interface RevokeRuleCommandInput {
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

/**
 * Whether this rule's revoke act is offered right now — on the row and in the palette.
 *
 * One predicate for the row and the palette rather than two expressions that agree today. A
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
export function revokeRuleCommandRows(
  input: RevokeRuleCommandInput,
): readonly RevokeRuleCommandRow[] {
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
export function askToRevokeFromCommand(
  row: RevokeRuleCommandRow,
  input: RevokeRuleCommandInput,
): void {
  const live = input.rules.find((candidate) => candidate.ruleId === row.ruleId);
  if (live === undefined || !offersRevoke(live, input.revokingRuleIds)) {
    return;
  }
  input.onAskToRevoke(live.ruleId);
}
