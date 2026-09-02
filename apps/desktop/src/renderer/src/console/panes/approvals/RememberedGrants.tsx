// Every standing permission: listable, attributable, revocable, and never mysterious.
//
// `Spec-023 §Console Design (Meridian)` §7.7. Four properties this list keeps:
//
//   • **Revoked rules are labelled, not filtered.** The read carries
//     `includeRevoked: true`, so the audit history IS the default view here, and a
//     dead rule renders beside a live one with the trigger that killed it named.
//   • **The grantor is a grantor.** `participantId` is an audit and
//     membership-invalidation key, never a match key — the copy says whose grant it
//     is and never implies it covers anyone else's direction.
//   • **Revoke is two-step, and only the confirming click mutates.** Cancelling
//     returns to idle with zero mutations, which is a property of this component
//     rather than a promise about it: the mutation call sits on one handler.
//   • **No per-row "remembered today" chip.** The auto-approval resolves inside the
//     daemon-internal permission gate before any request exists, so no `approval.*`
//     event carries the match and no per-row carrier exists. The list shows the
//     grant and the revocation moments and says nothing about individual matched
//     rows, because saying anything would be inventing the carrier.
//
// The scope-kind is rendered from the ratified enum and never as free text; a value
// outside it renders verbatim under an unrecognized treatment rather than being
// asserted into a member.

import { useState } from "react";

import { Chip, InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { type RememberedRule } from "./approval-records.js";
import {
  SCOPE_KIND_PHRASE,
  TRIGGER_PHRASE,
  asInvalidationTrigger,
  asRememberedScopeKind,
} from "./approval-vocabulary.js";

export interface RememberedGrantsProps {
  readonly rules: readonly RememberedRule[];
  readonly unreadableCount: number;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly revokeRefusalByRuleId: ReadonlyMap<string, ConsoleRefusal>;
  readonly onRevoke: (ruleId: string) => void;
}

export function RememberedGrants(props: RememberedGrantsProps): React.JSX.Element {
  const [confirmingRuleId, setConfirmingRuleId] = useState<string | undefined>(undefined);

  if (props.rules.length === 0) {
    return (
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
        {props.rules.map((rule) => {
          const isRevoked = rule.revokedAt !== undefined;
          const trigger =
            rule.invalidationTrigger === undefined
              ? undefined
              : asInvalidationTrigger(rule.invalidationTrigger);
          const refusal = props.revokeRefusalByRuleId.get(rule.ruleId);
          return (
            <li
              className={`meridian-grants__row${isRevoked ? " meridian-grants__row--revoked" : ""}`}
              key={rule.ruleId}
            >
              <div className="meridian-grants__line">
                <Chip mono label={rule.category} />
                <Chip
                  label={scopePhrase(rule.scope.kind)}
                  tone={
                    asRememberedScopeKind(rule.scope.kind) === undefined ? "failure" : "neutral"
                  }
                />
                <span className="meridian-grants__grantor">
                  granted by <WireFigure value={rule.participantId} />
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
              {isRevoked ? (
                <p className="meridian-grants__revoked">
                  Revoked <WireFigure value={rule.revokedAt ?? ""} />
                  {trigger === undefined
                    ? rule.invalidationTrigger === undefined
                      ? " — the reply named no trigger."
                      : ` — ${rule.invalidationTrigger}.`
                    : ` — ${TRIGGER_PHRASE[trigger]}.`}
                </p>
              ) : (
                <RevokeControl
                  isConfirming={confirmingRuleId === rule.ruleId}
                  isRevoking={props.revokingRuleIds.has(rule.ruleId)}
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
              )}
              {refusal === undefined ? null : <InlineRefusal {...refusal} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Idle, confirming, pending — three states on one control.
 *
 * `onConfirm` is the only handler that calls the mutation, which is what makes
 * "cancelling returns to idle with zero mutations" a fact about the code rather
 * than a claim about it.
 */
function RevokeControl(props: {
  readonly isConfirming: boolean;
  readonly isRevoking: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  if (props.isRevoking) {
    return <Nothing kind="computing" placement="inline" title="Revoking this permission." />;
  }
  if (!props.isConfirming) {
    return (
      <button className="meridian-grants__revoke" type="button" onClick={props.onAsk}>
        Revoke
      </button>
    );
  }
  return (
    <div className="meridian-grants__confirm" role="group" aria-label="Confirm the revocation">
      <span className="meridian-grants__confirm-copy">
        Revoke this permission? The next matching request will be asked again.
      </span>
      <button className="meridian-grants__revoke" type="button" onClick={props.onConfirm}>
        Revoke it
      </button>
      <button className="meridian-grants__cancel" type="button" onClick={props.onCancel}>
        Keep it
      </button>
    </div>
  );
}

/**
 * A scope kind's phrase, or the wire string itself where this build does not know
 * the kind — the fail-closed projection, never a guess at which boundary was meant.
 */
function scopePhrase(kind: string): string {
  const known = asRememberedScopeKind(kind);
  return known === undefined ? kind : SCOPE_KIND_PHRASE[known];
}
