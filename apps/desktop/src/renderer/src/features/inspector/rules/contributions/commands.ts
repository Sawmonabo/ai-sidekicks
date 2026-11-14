// The palette rows the inspector's Rules section contributes: which rules may be revoked
// from the palette, and what a row does when chosen. A row enters the revoke confirmation and
// never reaches the wire, so it is no weaker path to a two-step, irreversible act.

import type { RememberedRule } from "@ai-sidekicks/contracts/approval";

/** The owner these rows are contributed under; one live set at a time. */
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
  /** Rules whose revocation is already settling; their control offers no second press. */
  readonly revokingRuleIds: ReadonlySet<string>;
  /**
   * Arm the confirmation for one rule: the list's own first press.
   *
   * Arming, not the mutation; the confirming press stays on the control.
   */
  readonly onAskToRevoke: (ruleId: string) => void;
}

/**
 * Whether this rule's revoke act is offered right now, on the row and in the palette.
 *
 * One predicate for both. The only condition is a revocation already settling; the palette
 * must withdraw its row then, or it presses a button that is not there.
 */
export function offersRevoke(rule: RememberedRule, revokingRuleIds: ReadonlySet<string>): boolean {
  return !revokingRuleIds.has(rule.ruleId);
}

/** The rows the list offers right now, one per revocable rule; no row draws the rule's id. */
export function revokeRuleCommandRows(
  input: RevokeRuleCommandInput,
): readonly RevokeRuleCommandRow[] {
  return input.rules
    .filter((rule) => offersRevoke(rule, input.revokingRuleIds))
    .map((rule) => ({ ruleId: rule.ruleId, title: REVOKE_RULE_TITLE }));
}

/**
 * Arm one rule's confirmation, if the list is still offering to.
 *
 * Re-read at invoke time: a rule since revoked elsewhere, or one whose revocation just
 * started, has no control on screen to confirm.
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

/** What every revoke row reads. */
const REVOKE_RULE_TITLE = "Revoke the standing permission";
