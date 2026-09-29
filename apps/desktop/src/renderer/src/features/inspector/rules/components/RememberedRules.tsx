// Every standing permission: listable, attributable, revocable, and never mysterious.
//
// FOUR PROPERTIES THIS LIST KEEPS, EACH ONE ITS OWN because no committed document
// states them — the corpus registers the `approval.ruleList` / `approval.ruleRevoke`
// pair and the `RememberedScope` shape, and settles nothing about how they read:
//
//   • **Only rules in force are drawn.** A rule carrying `revokedAt` has ended and
//     draws no row, so every row on screen offers `Revoke`.
//   • **The grantor is a grantor.** `userId` is an audit key, never a match key —
//     the copy says whose grant it is and never implies it covers anyone else's
//     direction.
//   • **Revoke is two-step, and only the confirming click mutates.** Cancelling
//     returns to idle with zero mutations, which is a property of this component
//     rather than a promise about it: the mutation call sits on one handler. The
//     palette reaches the same act by ENTERING that confirmation — `revoke-commands.ts`
//     contributes a row per revocable rule, arming the control rather than replacing
//     it, so there is no second path to a mutation this surface made deliberately
//     hard. Which rules offer it is that module's `offersRevoke`, read here too, so
//     the row and the button are offered on one reading rather than two that agree.
//   • **No per-row "remembered today" chip.** The auto-approval resolves inside the
//     daemon-internal permission gate before any request exists, so no `approval.*`
//     event carries the match and no per-row carrier exists. The list shows the
//     grant and the revocation moments and says nothing about individual matched
//     rows, because saying anything would be inventing the carrier.
//
// The scope-kind is rendered from the ratified enum and never as free text; a value
// outside it renders verbatim under an unrecognized treatment rather than being
// asserted into a member.
//
// AND AN EMPTY LIST IS TWO DIFFERENT FACTS, WHICH IS WHY THE ARMS ARE ORDERED. A
// reply whose rows all failed the parse produces the same `rules: []` a session with
// no standing permission produces, and the reassuring sentence — that every request
// is answered one at a time — is the SAFEST possible claim, so a list that reached
// it while grants were in force would hide the one thing a person opens this panel
// to check. The unreadable count is therefore read FIRST: rows this build could not
// read are rows whose existence is unknown, never rows known to be absent, and only
// a reply that was fully readable and carried nothing may say nothing is in force.

import { useState } from "react";
import { Chip, Nothing, WireFigure, formatCount } from "@renderer/console/primitives/index.js";
import { type RememberedRule } from "@renderer/services/approvals/approval-records.js";
import {
  asRememberedScopeKind,
  rememberedScopeKindPhrase,
} from "@renderer/console/bridge/approvals/approval-vocabulary.js";
import { RevokeControl } from "./RevokeRuleControl.js";
import {
  offersRevoke,
  useRevokeCommands,
} from "@renderer/console/approvals/pane/grants/revoke-commands.js";

import "./RememberedRules.css";

export interface RememberedGrantsProps {
  readonly rules: readonly RememberedRule[];
  readonly unreadableCount: number;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly onRevoke: (ruleId: string) => void;
}

/** The standing permissions this session has granted, each with its revoke control. */
export function RememberedGrants(props: RememberedGrantsProps): React.JSX.Element {
  const [confirmingRuleId, setConfirmingRuleId] = useState<string | undefined>(undefined);
  // Ahead of the two absence arms below, because a hook may not run behind a branch.
  // With no readable rule there is nothing revocable and the contribution is empty,
  // which is the same answer the arms give on screen.
  const rulesInForce = props.rules.filter((rule) => rule.revokedAt === undefined);
  useRevokeCommands({
    rules: rulesInForce,
    revokingRuleIds: props.revokingRuleIds,
    onAskToRevoke: setConfirmingRuleId,
  });

  if (rulesInForce.length === 0) {
    return props.unreadableCount > 0 ? (
      <Nothing
        kind="error"
        placement="surface"
        title="Standing permissions could not be read."
        detail={`The daemon answered, and all ${formatCount(props.unreadableCount)} of the rows it carried were shaped in a way this build cannot read. Whether any permission is in force is unknown from here — it is not known to be none.`}
      />
    ) : (
      <Nothing
        kind="empty"
        placement="surface"
        title="No standing permission is in force."
        detail="Every request is answered one at a time, which is the safest state this list can be in. A permission appears here only after someone approves a request and asks for it to be remembered."
      />
    );
  }

  return (
    <div className="meridian-grants">
      {props.unreadableCount > 0 ? (
        <p className="meridian-grants__unreadable">
          The reply carried rows this build could not read, so this list is shorter than what the
          daemon holds.
        </p>
      ) : null}
      <ul className="meridian-grants__list">
        {rulesInForce.map((rule) => (
          <li className="meridian-grants__row" key={rule.ruleId}>
            <div className="meridian-grants__line">
              <Chip mono label={rule.category} />
              <Chip
                label={rememberedScopeKindPhrase(rule.scope.kind)}
                tone={asRememberedScopeKind(rule.scope.kind) === undefined ? "failure" : "neutral"}
              />
              <span className="meridian-grants__grantor">
                granted by <WireFigure value={rule.userId} />
              </span>
              <WireFigure value={rule.grantedAt} />
            </div>
            <div className="meridian-grants__detail">
              {rule.scope.pattern === undefined ? (
                <span className="meridian-grants__pattern">
                  No pattern, so this covers the whole category inside that boundary.
                </span>
              ) : (
                <span className="meridian-grants__pattern">
                  Pattern <WireFigure value={rule.scope.pattern} />
                </span>
              )}
              {rule.runId === undefined ? null : (
                <span className="meridian-grants__run">
                  Run <WireFigure value={rule.runId} />
                </span>
              )}
              <span className="meridian-grants__node">
                Node <WireFigure value={rule.nodeId} />
              </span>
            </div>
            <RevokeControl
              isConfirming={confirmingRuleId === rule.ruleId}
              // The palette's own reading, read from the same function: every drawn
              // rule is live, so "not offered" is exactly "a revocation is already
              // settling" — which is what the control says instead of offering a
              // second press.
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
