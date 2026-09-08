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
//   • Once the reference is SPENT the close path is ACKNOWLEDGEMENT and not dismissal.
//     There is nothing left to release and a `dismissPending` on it would be an act
//     against a handle main no longer holds. The card owns that branch because it is
//     the only place that can make it once — see the resolved `close` below, which is
//     handed to every path rather than being decided again per control.
//   • AN ANSWER IS NOT THE SAME FACT AS A SPENT REFERENCE, and conflating them is what
//     this branch got wrong twice. An acceptance waiting on authentication has main
//     driving a ceremony and HOLDING the reference across it; an acceptance that never
//     reached the control plane settles `unavailable`, which the wire itself marks
//     retryable — main is holding that one too, and the report even offers a second
//     attempt on it. Both were read as settled, so **Done**, Escape and the backdrop
//     alike put the card away and released nothing: the reference stayed allocated
//     until its TTL, and reopening or replaying the pending feed surfaced the same
//     invitation again after the person had put it away. So the branch tests what main
//     is HOLDING — `isInviteReferenceHeld`, the lifecycle's own predicate, which the
//     adapter's own local release is refused by — and never whether an outcome exists.
//
// AND IT RENDERS THE TWO PREVIEWS THAT PRODUCED NO INVITATION, which is the other
// half of what the pending feed carries. A preview the control plane REFUSED and one
// that could not be put at all mint no reference, so neither has facts to confirm —
// but a window that drew nothing for them would leave an expired link and an
// unreachable control plane looking exactly like a link nobody followed, and the one
// act either admits, the retry, would be offered by no surface at all. Those two arms
// are `InvitePreviewFailureReading.tsx`, rendered inside this same dialog: it is the
// same question about the same deep link, and a second overlay for it would be a
// second card competing for one window's screen. On that branch every close path is
// the ACKNOWLEDGEMENT above, for a stronger reason than a spent reference — there was
// never a reference for `invite.dismissPending` to release.

import { Dialog } from "@base-ui/react/dialog";
import { useRef } from "react";

import { InlineRefusal, OverlayDialogPopup } from "../../primitives/index.js";
import { InvitationReading } from "./InvitationReading.js";
import { InvitePreviewFailureReading } from "./InvitePreviewFailureReading.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";
import { isInviteReferenceHeld } from "./pending-invite-reading.js";

export interface InviteConfirmationProps {
  readonly open: boolean;
  /** The lifecycle's current reading. Rendered only where it names an invitation. */
  readonly snapshot: PendingInviteSnapshot;
  readonly onConfirm: () => void;
  /**
   * Put a preview that could not be put to the control plane again.
   *
   * Offered on exactly one arm and gated by the reading's own `canRetry`, never by
   * this card's reading of which state it is looking at. It is not a close path: a
   * retry's answer arrives as a fresh pending state rather than in this card, and the
   * head it was dispatched on is released by the lifecycle when the call is served.
   */
  readonly onRetry: () => void;
  /**
   * Release the reference and put the card away, telling nobody.
   *
   * The close act on every arm where main still holds the handle — nothing answered
   * yet, a ceremony still running, or an acceptance that never reached the control
   * plane — reached from the close control, Escape, and the backdrop alike. There is
   * no decline to send. The lifecycle refuses it while an act on the same reference is
   * unsettled, which is why the control that dispatches it closes for that lifetime.
   */
  readonly onDismiss: () => void;
  /**
   * Put a spent prompt away and move to whatever was waiting behind it.
   *
   * The close act on the arms where main holds nothing: a reference already consumed,
   * refused, or no longer resolving, and a preview that minted none at all.
   */
  readonly onAcknowledge: () => void;
  readonly overlayContainer?: HTMLElement | null | undefined;
}

export function InviteConfirmation(props: InviteConfirmationProps): React.JSX.Element | null {
  const { snapshot } = props;
  const { invite, previewFailure } = snapshot;
  // ONE REF FOR BOTH ARMS, because both name the same rule: the control that sends
  // nothing is first in the tree and is the one the dialog opens with focused. Exactly
  // one of the two arms is ever mounted, so exactly one control ever attaches to it.
  const closeRef = useRef<HTMLButtonElement>(null);
  if (invite === undefined && previewFailure === undefined) {
    return null;
  }
  const isActing = snapshot.actInFlight !== undefined;
  // THE ONE CLOSE ACT, RESOLVED ONCE AND HANDED TO EVERY PATH. Closing is a DISMISSAL
  // — the wire act that releases what main is holding — on exactly the arms where main
  // is holding something: an invitation nobody has answered yet, an acceptance whose
  // ceremony is still running, and one that never reached the control plane and is
  // therefore still retryable. A reference that was consumed, refused or has stopped
  // resolving is spent, and a preview failure never minted one, so on those the act is
  // the local acknowledgement — a `dismissPending` there would be an act against a
  // handle main does not hold. What main holds is the lifecycle's own predicate,
  // consulted rather than re-derived, because a card deciding it separately is how the
  // two came to disagree in the first place.
  //
  // It travels DOWN as one callback rather than as the pair this card is handed. The
  // bodies below draw the close under two labels — **Not now** before an answer,
  // **Done** once there is one to read — and the library hands the same act back for
  // Escape and the backdrop, so four entry points reach one function and no component
  // beneath this one gets to decide what closing means.
  const close =
    previewFailure === undefined && isInviteReferenceHeld(snapshot.outcome)
      ? props.onDismiss
      : props.onAcknowledge;

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      // The mode `Spec-023 §Console Libraries` adopts, and never the library default:
      // fully modal locks body scroll and hangs `aria-hidden` on a background the
      // shell was never told to inert. `trap-focus` keeps the keyboard inside this
      // card and leaves the background to the shell — which has to be TOLD, and is
      // told by whoever owns this card's open state. That is `InviteLifecycleOverlay`,
      // on the palette's precedent: the owner of the boolean arms the guard, so this
      // card stays a card and takes no window store.
      modal="trap-focus"
    >
      {/* The popup shell is the primitive's, which is what puts this card in the
          window's airspace (`Spec-023 §Console Design (Meridian)` 12.3): a native
          browser-pane view yields to what is registered there, and a decision it
          painted over is the one thing 12.3 forbids outright. The card heads its body
          with an ordinary element rather than a `Dialog.Title`, so the name travels as
          the label — which is what the popup carried before the shell moved. */}
      <OverlayDialogPopup
        container={props.overlayContainer}
        backdropClassName="meridian-invite-confirmation__backdrop"
        className="meridian-invite-confirmation"
        label={
          previewFailure === undefined ? "Confirm this invitation" : "This invitation did not open"
        }
        initialFocus={closeRef}
      >
        {previewFailure === undefined ? (
          <InvitationReading
            snapshot={snapshot}
            isActing={isActing}
            closeRef={closeRef}
            onConfirm={props.onConfirm}
            onClose={close}
          />
        ) : (
          <InvitePreviewFailureReading
            failure={previewFailure}
            canRetry={snapshot.canRetry}
            isActing={isActing}
            onRetry={props.onRetry}
            onClose={close}
            closeRef={closeRef}
          />
        )}

        {snapshot.actRefusal === undefined ? null : (
          <InlineRefusal code={snapshot.actRefusal.code} detail={snapshot.actRefusal.detail} />
        )}
      </OverlayDialogPopup>
    </Dialog.Root>
  );
}
