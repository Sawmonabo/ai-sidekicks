// The act row group: what a gate arm offers, and the confirmation that stands between
// a press and the wire.
//
// Split out of `ProposalGate.tsx` on this family's own seam — one file per job, and
// this is the only part of the gate that HOLDS anything. Everything else there renders
// the arm it was handed; this component owns the pending confirmation, which is state,
// and a file carrying both was carrying the gate's composition and its one piece of
// interaction memory at once.
//
// IT SITS IN A DIRECTORY WITH THE MODEL IT READS rather than flat in `proposals/`:
// the group and `proposal-confirmation-scope.ts` are one concern — what an approval is
// an approval OF — and the door next door is what the gate imports.

import { useState } from "react";

import { InlineRefusal } from "../../../primitives/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import { PROPOSAL_ACTION_PRESENTATION, type ProposalAction } from "../proposal-actions.js";

/**
 * The acts this arm offers, in the order the gate enforces.
 *
 * THE LIST ARRIVES; IT IS NOT DERIVED HERE. `offeredProposalActions` decides which acts
 * a gate arm may offer, so this component cannot draw a remote act the preparation gate
 * withholds. Two conditions leave no row to draw — a mount that cannot honour an act at
 * all, and an arm the rule offers none for — and both draw nothing rather than an empty
 * group, because the arm above has already said what this gate is looking at and a
 * labelled group holding no control would be a second, wordless answer to that.
 *
 * A WITHHELD ACT STILL SAYS WHY. Where the model withholds the remote act because the
 * proposal on screen is not ready to send, its sentence renders at the head of this
 * group — so the missing row is an absence with a reason rather than a control a
 * participant hunts for. The sentence is the model's; this file neither composes it nor
 * knows which act it is about.
 *
 * `isBlocked` is not an eligibility derivation: it is the presence of an unanswered
 * blocking choice on this very surface, which `Spec-011 §Fallback Behavior` requires
 * to be answered before proceeding. Every other reason an act might fail is the
 * daemon's, is not consulted here, and renders as the refusal beside the act.
 *
 * `inFlightAction` is the second such fact and the last. While the holder is waiting
 * on the bridge the controls are held and an open confirm is withdrawn, so a
 * participant cannot confirm a second act against a payload whose answer has not
 * arrived. That is not the daemon's rule either — the holder refuses a second request
 * whatever this component draws — it is this surface declining to invite one.
 */
export function ProposalActionGroup(props: {
  readonly actions: readonly ProposalAction[];
  /** Why an act the list does not carry is absent. Composed by the model, never here. */
  readonly withheldReason: string | undefined;
  readonly onRequestAction: ((action: ProposalAction) => void) | undefined;
  readonly actionRefusals: ReadonlyMap<ProposalAction, ConsoleRefusal> | undefined;
  readonly inFlightAction: ProposalAction | undefined;
  readonly isBlocked: boolean;
  /** What the acts on offer would send, as one value. Composed by the gate. */
  readonly confirmationScope: string;
}): React.JSX.Element | null {
  const confirmation = usePendingConfirmation(props.confirmationScope);
  const actionAwaitingConfirm = confirmation.pendingAction;
  if (props.onRequestAction === undefined || props.actions.length === 0) {
    return null;
  }
  const isAwaitingBridge = props.inFlightAction !== undefined;
  return (
    <div className="meridian-proposal-gate__acts" role="group" aria-label="Git actions">
      {props.withheldReason === undefined ? null : (
        // Static explanatory copy and deliberately NOT a live region: the settled arm
        // is announced once by the surface that holds the reader, and a second
        // announcement here would say the same settlement twice.
        <p className="meridian-proposal-gate__withheld-act">{props.withheldReason}</p>
      )}
      {props.inFlightAction === undefined ? null : (
        // The act being waited on is NAMED. A row of controls that stopped responding
        // with nothing saying why reads as a broken surface rather than as a request
        // in flight.
        <p className="meridian-proposal-gate__in-flight" role="status">
          {PROPOSAL_ACTION_PRESENTATION[props.inFlightAction].label} was sent. The daemon has not
          answered yet, so nothing else is sent until it settles.
        </p>
      )}
      {props.actions.map((action) => {
        const presentation = PROPOSAL_ACTION_PRESENTATION[action];
        const refusal = props.actionRefusals?.get(action);
        const isAwaitingConfirm = actionAwaitingConfirm === action;
        return (
          <div className="meridian-proposal-gate__act-row" key={action}>
            <button
              type="button"
              className={
                action === "prepare-proposal"
                  ? "meridian-proposal-gate__act meridian-proposal-gate__act--primary"
                  : "meridian-proposal-gate__act"
              }
              // The two conditions this surface owns, and no third: an unanswered
              // blocking choice, and an act of its own already awaiting the bridge.
              // Every other reason an act might fail is the daemon's and arrives as
              // the refusal beside the control.
              disabled={props.isBlocked || isAwaitingBridge}
              onClick={() => {
                confirmation.toggle(action);
              }}
              aria-expanded={isAwaitingConfirm}
            >
              {presentation.label}
            </button>
            {isAwaitingConfirm && !isAwaitingBridge ? (
              <div className="meridian-proposal-gate__confirm">
                {/* The consequence is stated before the act, never after it. */}
                <p className="meridian-proposal-gate__consequence">{presentation.consequence}</p>
                <button
                  type="button"
                  className="meridian-proposal-gate__act"
                  onClick={() => {
                    confirmation.close();
                    props.onRequestAction?.(action);
                  }}
                >
                  {presentation.label} now
                </button>
                <button
                  type="button"
                  className="meridian-proposal-gate__act"
                  onClick={() => {
                    confirmation.close();
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : null}
            {refusal === undefined ? null : (
              // Inline, beside the control that produced it, and the control stays:
              // the act did not happen and the participant may try another one.
              <InlineRefusal code={refusal.code} detail={refusal.detail} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The one confirmation this group holds, and the offer it belongs to.
 *
 * A CONFIRMATION IS AN APPROVAL OF ONE PARTICULAR THING, so it does not outlive it.
 * With Push confirmed and a refresh moving the prepared proposal from `ready` to
 * `draft`, the row disappeared and this state did not — and the next proposal to become
 * `ready` remounted with its confirmation already open, offering to send a payload
 * whose consequence nobody had read.
 *
 * CLEARED AS THE OFFER MOVES, RATHER THAN HIDDEN WHILE IT HAS MOVED. The arm can come
 * back to exactly the value it left — a proposal that went `draft` and became `ready`
 * again composes the same scope — so comparing the stored scope with the current one
 * would let the confirmation reappear with it. Clearing on the CHANGE is what makes the
 * approval unrepeatable.
 *
 * WHICH IS THE CONSOLE'S OWN SUBJECT RULE, TAKEN RATHER THAN WRITTEN AGAIN.
 * `store/subject-scoped-state.ts` seeds during the render that first sees a new key,
 * so no committed frame carries the previous offer's confirmation — an effect would
 * clear it one commit later, and that commit is a frame in which the confirm button
 * for the new offer is on screen and pressable. It also drops a write captured under
 * an offer that has since moved, which the register this function used to keep could
 * not: a pass React discarded left that register naming the old scope, and the return
 * to it re-opened a confirmation nobody had re-read.
 *
 * THE MOUNT IS THE SUBJECT AND THE OFFER IS THE KEY WITHIN IT. There is no live
 * object here whose replacement retires the confirmation — this group holds no
 * transport and no projection — and the thing a confirmation belongs to is a value,
 * which is exactly what a key is. So the subject is this mount, minted once and
 * compared by reference, and it moves only when the group is remounted.
 */
function usePendingConfirmation(confirmationScope: string): {
  readonly pendingAction: ProposalAction | undefined;
  readonly toggle: (action: ProposalAction) => void;
  readonly close: () => void;
} {
  const [confirmationSubject] = useState<object>(() => ({}));
  const { value: pendingAction, publish } = useSubjectScopedState<ProposalAction | undefined>(
    confirmationSubject,
    confirmationScope,
    () => undefined,
  );
  return {
    pendingAction,
    toggle: (action: ProposalAction) => {
      publish((standing) => (standing === action ? undefined : action));
    },
    close: () => {
      publish(undefined);
    },
  };
}
