// One deliberate confirmation, over everything else, on a reference and never a token.
//
// WHAT ARRIVES HERE. `Plan-023 §Invariants` I-023-5 confines the raw invite token to
// the main process and I-023-10 makes what the renderer holds an opaque, single-use,
// TTL-bounded REFERENCE. So this card is handed a `GrowthPendingInvite`, which has no
// token member and nowhere for one to arrive — the confinement is a property of the
// shape rather than a rule somebody has to remember — and every act it offers is
// dispatched by `pending-invite.ts` on that reference. The main-side half of the
// lifecycle is `T-023r-5-5`: the protocol handler, the bridge-event dispatcher, and
// the reference table these references live in. `Plan-023 §Phase 6 — Renderer Shell,
// Router, And Composer` T-023r-6-3 is the live-wiring leg over this body.
//
// WHY THE SHIPPED ACCEPTANCE COMPONENT IS NOT MOUNTED HERE. `session-members/
// invite-accept-view.tsx` takes the raw `token` as a prop and issues `invite.accept`
// itself, which is exactly what the invariant above forbids the renderer to hold; its
// own header records that the reshape retires that prop. Mounting it under this
// lifecycle would mean handing it a reference where it expects a credential, which a
// live control plane would answer `invite.not_found`. So it is not mounted, and it is
// not edited either — the acceptance it performs is performed by main, behind the
// reference, and this card is the confirmation that asks for it.
//
// WHAT THIS CARD WILL NOT DO
//
//   • It never accepts on mount, on open, or on a key. Confirming is a press.
//   • It never auto-focuses the confirm control. Base UI would focus the first
//     focusable child, so the dismissal is deliberately first in the tree and the
//     popup's `initialFocus` names it: a dialog that opens with the accepting control
//     focused turns a stray return key into a single-use invitation spent.
//   • It renders no fact it was not given. `sessionName` and `inviterDisplayName` are
//     `null` where the preview answered and the fact was empty — a different reading
//     from a preview never put — and each absent one renders as an absence rather
//     than as a blank or a guess.
//   • It has no decline verb, because the wire has none. What it has is ONE
//     dismissal, reached three ways — **Not now**, Escape, and the backdrop — and all
//     three release the reference main is holding and tell nobody, which is the only
//     act the plane actually has. T-023r-6-3 states it as a requirement: "dismissal
//     by escape, backdrop, or the decline control routes to `invite.dismissPending`,
//     never to confirm." A separate **Discard it** control used to sit beside **Not
//     now** and is retired rather than re-labelled: once every close path releases the
//     reference, the two controls performed one act under two names, and a card that
//     offers one act twice is a card that says the quieter one does less.
//   • Once an answer has settled the close path is ACKNOWLEDGEMENT and not dismissal.
//     The reference is already spent, so there is nothing left to release and a
//     `dismissPending` on it would be an act against a handle main no longer holds.
//     The card owns that branch because it already makes it — it is the same test
//     that chooses which of the two blocks below renders.

import { Dialog } from "@base-ui/react/dialog";
import { useRef } from "react";

import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatDateTime,
} from "../../primitives/index.js";
import { InviteOutcomeReport } from "./InviteOutcomeReport.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";

export interface InviteConfirmationProps {
  readonly open: boolean;
  /** The lifecycle's current reading. Rendered only where it names an invitation. */
  readonly snapshot: PendingInviteSnapshot;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  /**
   * Release the reference and put the card away — the card's whole close path while
   * nothing has settled, reached from **Not now**, Escape, and the backdrop alike.
   *
   * Nobody is told; there is no decline to send. The lifecycle refuses it while an act
   * on the same reference is unsettled, which is why the control that dispatches it
   * closes for that lifetime.
   */
  readonly onDismiss: () => void;
  /**
   * Put a settled outcome away and move to whatever was waiting behind it.
   *
   * The close path too, once an outcome has arrived: the reference is spent, so there
   * is nothing left to release.
   */
  readonly onAcknowledge: () => void;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function InviteConfirmation(props: InviteConfirmationProps): React.JSX.Element | null {
  const { snapshot } = props;
  const { invite } = snapshot;
  const dismissRef = useRef<HTMLButtonElement>(null);
  if (invite === undefined) {
    return null;
  }
  const isActing = snapshot.actInFlight !== undefined;
  // The one close path, and the one branch that decides what closing MEANS. A
  // settled outcome has already spent the reference, so the act that puts the card
  // away is an acknowledgement; before one arrives it is the dismissal that releases
  // what main is holding. The library hands this back for Escape and the backdrop as
  // well as for the control, which is what makes the three entry points one act.
  const close = snapshot.outcome === undefined ? props.onDismiss : props.onAcknowledge;

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <Dialog.Portal container={props.overlayContainer}>
        <Dialog.Backdrop className="meridian-invite-confirmation__backdrop" />
        <Dialog.Popup
          className="meridian-invite-confirmation"
          aria-label="Confirm this invitation"
          initialFocus={dismissRef}
        >
          <Dialog.Title className="meridian-invite-confirmation__title">
            {invite.sessionName ?? "You have been invited to a session."}
          </Dialog.Title>
          <p className="meridian-invite-confirmation__identity">
            <WireFigure value={invite.sessionId} />
          </p>

          <dl className="meridian-invite-confirmation__facts">
            <div className="meridian-invite-confirmation__fact">
              <dt>Invited by</dt>
              <dd>
                {invite.inviterDisplayName ?? (
                  <Nothing
                    kind="empty"
                    placement="inline"
                    title="Not named"
                    detail="The preview answered and carried no display name for the inviter, and the raw identifier is not a name."
                  />
                )}
              </dd>
            </div>
            <div className="meridian-invite-confirmation__fact">
              <dt>Joining as</dt>
              <dd>
                <Chip label={invite.joinMode} mono tone="accent" />
              </dd>
            </div>
            <div className="meridian-invite-confirmation__fact">
              <dt>Stops working</dt>
              <dd>
                <WireFigure value={formatDateTime(invite.expiresAt)} title={invite.expiresAt} />
              </dd>
            </div>
          </dl>

          {snapshot.outcome === undefined ? (
            <div className="meridian-invite-confirmation__acts">
              {/* First in the tree AND named by `initialFocus`: the ordering alone is
                  not enough, since a later control could be inserted above it, and the
                  reference alone is not either, since it says nothing to a reader
                  scanning the markup. */}
              <button
                type="button"
                ref={dismissRef}
                className="meridian-invite-confirmation__dismiss"
                disabled={isActing}
                onClick={props.onDismiss}
              >
                Not now
              </button>
              <button
                type="button"
                className="meridian-invite-confirmation__confirm"
                disabled={isActing}
                aria-busy={isActing}
                onClick={props.onConfirm}
              >
                {isActing ? "Joining…" : "Join this session"}
              </button>
            </div>
          ) : (
            <InviteOutcomeReport
              outcome={snapshot.outcome}
              onRetry={props.onRetry}
              onAcknowledge={props.onAcknowledge}
              isActing={isActing}
            />
          )}

          {snapshot.actRefusal === undefined ? null : (
            <InlineRefusal code={snapshot.actRefusal.code} detail={snapshot.actRefusal.detail} />
          )}

          <p className="meridian-invite-confirmation__footnote">
            {snapshot.waitingBehind > 0
              ? `Not now puts this away and tells nobody. ${String(snapshot.waitingBehind)} more ${
                  snapshot.waitingBehind === 1 ? "invitation is" : "invitations are"
                } behind it.`
              : "Not now puts this away and tells nobody, because there is no decline to send. The link still works if you change your mind."}
          </p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
