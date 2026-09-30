// Every rule in force on the session: what it does, to what, and how far, each revocable.
//
// Each row reads the rule the way its label did when it was made — `Allow pnpm test ·
// this session`, `Block api.example.com · this project` — from the `approval.ruleList`
// reply, which holds only rules in force, so every row on screen offers `Revoke`. The
// properties this list keeps:
//
//   • **Revoke is two-step, and only the confirming click mutates.** Canceling
//     returns to idle with zero mutations, which is a property of this component
//     rather than a promise about it: the mutation call sits on one handler. The
//     palette reaches the same act by ENTERING that confirmation — `useRevokeRuleCommands.ts`
//     contributes a row per revocable rule, arming the control rather than replacing
//     it, so there is no second path to a mutation this list made deliberately
//     hard. Which rules offer it is that module's `offersRevoke`, read here too, so
//     the row and the button are offered on one reading rather than two that agree.
//   • **No per-row "remembered today" chip.** The auto-approval resolves inside the
//     daemon-internal permission gate before any request exists, so no `approval.*`
//     event carries the match and no per-row carrier exists. The list says nothing
//     about individual matched asks, because saying anything would be inventing the
//     carrier.
//
// AND AN EMPTY LIST IS TWO DIFFERENT FACTS, WHICH IS WHY THE ARMS ARE ORDERED. A
// reply whose rows all failed the parse produces the same `rules: []` a session with
// no standing permission produces, and `No rules yet` is the reassuring claim, so a
// list that reached it while rules were in force would hide the one thing a person
// opens this panel to check. The unreadable count is therefore read FIRST: rows this build could not
// read are rows whose existence is unknown, never rows known to be absent, and only
// a reply that was fully readable and carried nothing may say nothing is in force.

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

export interface RememberedRulesProps {
  readonly rules: readonly RememberedRule[];
  readonly unreadableCount: number;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly onRevoke: (ruleId: string) => void;
}

/** The standing permissions this session has granted, each with its revoke control. */
export function RememberedRules(props: RememberedRulesProps): React.JSX.Element {
  const [confirmingRuleId, setConfirmingRuleId] = useState<string | undefined>(undefined);
  // Ahead of the two absence arms below, because a hook may not run behind a branch.
  // With no readable rule there is nothing revocable and the contribution is empty,
  // which is the same answer the arms give on screen.
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
              // The palette's own reading, read from the same function: "not offered"
              // is exactly "a revocation is already settling", which is what the
              // control says instead of offering a second press.
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
