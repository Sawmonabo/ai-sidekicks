// The lease line: where the session's one shared shell is held, and the single control
// that changes that.
//
// The pane shows output and this line only; the transition history is one click away,
// and the claim control is the single affordance in the header. Its prohibitions are
// each a line of code here rather than a note:
//
//   • **Never derives the holder from the last observed claim.** Pressing the
//     control calls the wire and then does nothing to the holder. The line moves
//     when a `pty.control_changed` transition reaches the fold, and not before.
//   • **Never animates a claim by the current holder.** A window that holds the shell
//     sees Release, so the idempotent self-claim — which succeeds and broadcasts
//     nothing — is not reachable from this surface at all. There is no transition to
//     animate because there is no transition.
//   • **Never queues a claim.** A refusal renders beside the control and stays
//     there until the person acts. No retry, no timer, no wait list.
//   • **Never offers a claim it cannot attribute.** The control acts on this window's
//     behalf and the fold names the holder by user id, so until this device's
//     identity has been READ there is no control here at all. Taking the shell is not
//     gated on anything else: the shell belongs to the one person using this machine.
//     `lease-acquisition.ts` owns that fold and states why release is not gated either.
//
// EVERY TRANSITION NAMES ITS REASON. The disclosure renders one ledger line per
// transition through the console's own row primitive, and the sentence comes from
// `lease-transition.ts`'s table — which is total over the closed reason set, so the
// three automatic reasons cannot collapse into one.
//
// STEPPING IN IS NOT THIS CONTROL. The composer's Step in pauses a run and hands over
// the conversation; it never moves the keyboard. One line says so where a person might
// otherwise reach for the wrong thing, and it is copy rather than a second affordance
// for exactly that reason.

import { useCallback, useState } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  Chip,
  DerivedFigure,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatCount,
  type ChipTone,
} from "../../primitives/index.js";
import { LeaseHoldingStatement } from "./LeaseHoldingStatement.js";
import { LeaseTransitionLedger } from "./LeaseTransitionLedger.js";
import { OfflineNodeLine } from "./OfflineNodeLine.js";
import { resolveTerminalClaimAffordance } from "./lease-acquisition.js";
import { useTerminalLeaseClaim } from "./lease-claim.js";
import { WithheldClaimControl } from "./WithheldClaimControl.js";
import { type TerminalLeaseHolding, type TerminalLeaseState } from "./lease-model.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";

export interface LeaseLineProps {
  readonly bridge: ConsoleBridge;
  /**
   * The session whose one shared shell this lease governs.
   *
   * The session and not the pane, because that is what the registered pair carries:
   * `session.takeControl` and `session.releaseControl` both take `{ sessionId }`, and
   * V1 gives a session exactly one shared terminal, so the session id is the lease's
   * subject rather than a stand-in for one. The pane keeps its own local id for the
   * emulator it mounts; that id never reaches this wire.
   */
  readonly sessionId: string;
  readonly state: TerminalLeaseState;
  /**
   * Which window this is, which is what the claim control is gated on.
   *
   * The control acts on this window's behalf and the fold names the holder by
   * user id, so a surface that offered it without the identity would be
   * offering a control it cannot report the outcome of: a take would come back as a
   * hold it could not recognise, the button would still read Claim, and there would be
   * no way to release. A control that cannot act is neither an offer nor a refusal.
   */
  readonly viewerIdentity: TerminalViewerIdentity;
  /**
   * Whether the session has a run a person could step into right now.
   *
   * Handed in rather than folded here, because the pane already holds the timeline
   * and this surface holds none: a second read of the log from a component would be
   * a second answer to a question the fold beside the pane already answers.
   */
  readonly hasSteppableRun: boolean;
}

/**
 * What the chip says for each holding. Total over the closed set.
 *
 * `unrecognized-transition` is the one amber row, and amber is spent on exactly what it
 * means: a person is needed. The daemon moved the shell under a transition this build
 * cannot read, so where it is held cannot be told until somebody updates this console
 * or looks at the log — which is a different thing from the neutral "not checked",
 * where the console simply has not asked.
 */
const HOLDING_CHIPS: Readonly<Record<TerminalLeaseHolding, { label: string; tone: ChipTone }>> = {
  "not-checked": { label: "Not checked", tone: "neutral" },
  unheld: { label: "Free", tone: "neutral" },
  "held-by-you": { label: "You hold it", tone: "accent" },
  "held-by-another": { label: "Held", tone: "neutral" },
  "unrecognized-transition": { label: "Unread transition", tone: "attention" },
};

export function LeaseLine(props: LeaseLineProps): React.JSX.Element {
  const { bridge, sessionId, state, viewerIdentity } = props;
  const claim = useTerminalLeaseClaim(bridge, sessionId);
  const [isLedgerOpen, setIsLedgerOpen] = useState(false);

  const chip = HOLDING_CHIPS[state.holding];
  const affordance = resolveTerminalClaimAffordance({ holding: state.holding, viewerIdentity });

  // The health line is about the node a HOLDER sits on, so it is rendered only when
  // there is a holder. A `released` transition nulls the holder and the chip beside
  // it already reads Free, and "the console cannot say whether the holding node is
  // reachable" there discusses a machine the same line says nobody is using.
  //
  // The `unrecognized-transition` arm nulls the holder too, and this gate silences
  // the health line there as well — which reads correctly: what is unknown in that
  // state is the transition, and its own paragraph below says so, while a second
  // sentence about an unread roster would answer a question nobody asked.
  //
  // The gate is HERE and not in `readVouching`. `holderVouching` is a fact about
  // whether a roster read happened, and a fold that answered `vouched` because
  // nobody holds the lease would be reporting a read it never performed.
  const isHolderHealthUnread =
    state.holderUserId !== null && state.holderVouching === "not-checked";

  const onToggleLedger = useCallback(() => {
    setIsLedgerOpen((wasOpen) => !wasOpen);
  }, []);

  return (
    <div className="meridian-lease-line" role="group" aria-label="Terminal lease">
      <div className="meridian-lease-line__head">
        <span className="meridian-lease-line__holder">
          <Chip tone={chip.tone} label={chip.label} />
          <LeaseHoldingStatement holding={state.holding} />
        </span>
        <div className="meridian-lease-line__controls">
          {affordance.control === "none" ? null : (
            <button
              type="button"
              className="meridian-lease-line__claim"
              onClick={affordance.control === "release" ? claim.release : claim.acquire}
              disabled={claim.isInFlight}
            >
              {affordance.control === "release" ? "Release the shell" : "Claim the shell"}
            </button>
          )}
          <button
            type="button"
            className="meridian-lease-line__disclosure"
            onClick={onToggleLedger}
            aria-expanded={isLedgerOpen}
          >
            Transitions <DerivedFigure text={formatCount(state.transitionCount)} />
          </button>
        </div>
      </div>

      {affordance.control === "none" ? (
        <WithheldClaimControl withheld={affordance.withheld} />
      ) : null}

      {isHolderHealthUnread ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Node health not read"
          detail="The console has not read the node roster, so it cannot say whether the holding machine is reachable. The hold shown here is the one the log named."
        />
      ) : null}

      {state.offlineNode === undefined ? null : <OfflineNodeLine reading={state.offlineNode} />}

      {state.unreadTransition === undefined ? null : (
        <p className="meridian-lease-line__unread">
          The shell changed hands under a transition this build cannot read, so where it is held is
          not shown and the surface stays read-only.
          {state.unreadTransition.reason === undefined ? null : (
            <>
              {" "}
              The wire called it <WireFigure value={state.unreadTransition.reason} />.
            </>
          )}
        </p>
      )}

      {claim.refusal === undefined ? null : (
        <InlineRefusal code={claim.refusal.code} detail={claim.refusal.detail} />
      )}

      {/* The clarification, and only where there is something to clarify: the sentence
          is about a control, and a control nobody can reach is not worth a paragraph on
          every idle terminal. */}
      {props.hasSteppableRun ? (
        <p className="meridian-lease-line__aside">
          Stepping in pauses a run and hands you the conversation. It never moves the keyboard —
          taking the shell is the claim above, and stopping an agent is a run control.
        </p>
      ) : null}

      {isLedgerOpen ? <LeaseTransitionLedger state={state} /> : null}
    </div>
  );
}
