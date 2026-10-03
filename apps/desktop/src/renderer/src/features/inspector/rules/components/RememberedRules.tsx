// Every rule in force on the session: what it does, to what, and how far, each revocable.
//
// Revoke is two-step and only the confirming click mutates. The palette reaches the same act
// by entering the confirmation (`../hooks/useRevokeRuleCommands.ts`), and `offersRevoke` is
// read by both, so the row and the button are offered on one reading.
//
// No per-row "remembered today" marker: the provider applies its rule before any ask reaches
// the daemon, so no event carries the match.
//
// An unreadable count is read before the empty arm: rows this build could not read are of
// unknown existence, so "No rules yet" may be said only for a fully readable, empty reply.

import type { RememberedRule } from "@ai-sidekicks/contracts";
import { useState } from "react";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { RULE_SCOPE_LABELS, RULE_SENSE_LABELS } from "@renderer/lib/approval-vocabulary.js";
import { RevokeRuleControl } from "./RevokeRuleControl.js";
import { offersRevoke } from "../contributions/revoke-rule-commands.js";
import { useRevokeRuleCommands } from "../hooks/useRevokeRuleCommands.js";

import "./RememberedRules.css";

/** The rules in force, how many rows failed to parse, and the revoke wiring. */
export interface RememberedRulesProps {
  readonly rules: readonly RememberedRule[];
  readonly unreadableCount: number;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly onRevoke: (ruleId: string) => void;
}

/** The standing permissions this session has granted, each with its revoke control. */
export function RememberedRules(props: RememberedRulesProps): React.JSX.Element {
  const [confirmingRuleId, setConfirmingRuleId] = useState<string | undefined>(undefined);
  // Ahead of the empty-state arms because a hook may not run behind a branch; with no readable
  // rule the contribution is empty, which is what those arms show.
  useRevokeRuleCommands({
    rules: props.rules,
    revokingRuleIds: props.revokingRuleIds,
    onAskToRevoke: setConfirmingRuleId,
  });

  if (props.rules.length === 0) {
    return props.unreadableCount > 0 ? (
      <Nothing
        kind="error"
        placement="block"
        title="Standing permissions could not be read."
        detail={`The background service answered, and all ${formatCount(props.unreadableCount)} of the rows it carried were shaped in a way this build cannot read. Whether any permission is in force is unknown from here — it is not known to be none.`}
      />
    ) : (
      <Nothing kind="empty" placement="block" title="No rules yet" />
    );
  }

  return (
    <div className="meridian-remembered-rules">
      {props.unreadableCount > 0 ? (
        <p className="meridian-remembered-rules__unreadable">
          The reply carried rows this build could not read, so this list is shorter than what the
          background service holds.
        </p>
      ) : null}
      <ul className="meridian-remembered-rules__list">
        {props.rules.map((rule) => (
          <li className="meridian-remembered-rules__row" key={rule.ruleId}>
            <div className="meridian-remembered-rules__line">
              <span>
                {RULE_SENSE_LABELS[rule.scope.sense]} <WireFigure value={rule.scope.pattern} /> ·{" "}
                {RULE_SCOPE_LABELS[rule.scope.kind]}
              </span>
            </div>
            <RevokeRuleControl
              isConfirming={confirmingRuleId === rule.ruleId}
              // "Not offered" is exactly "a revocation is already settling".
              isRevoking={!offersRevoke(rule, props.revokingRuleIds)}
              onAsk={() => {
                setConfirmingRuleId(rule.ruleId);
              }}
              onCancel={() => {
                setConfirmingRuleId(undefined);
              }}
              onConfirm={() => {
                setConfirmingRuleId(undefined);
                props.onRevoke(rule.ruleId);
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
