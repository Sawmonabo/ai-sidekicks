// The invitation itself: what it grants, and the acts on the reference it carries.
//
// ITS OWN MODULE rather than a branch inside the card, because the two arms of that
// dialog share only the dialog around them — this one renders facts and offers the
// acts that spend a reference, and `InvitePreviewFailureReading.tsx` renders words the
// wire sent about a link that produced none. The card owns which arm is mounted and
// what closing MEANS on each; what is here is one arm's body.
//
// THE DISMISSAL IS FIRST IN THE TREE, and that ordering is load-bearing rather than
// tidy: Base UI focuses the first focusable child, and the card names this control
// through `initialFocus` as well, so a dialog cannot open with the accepting control
// focused and turn a stray return key into a single-use invitation spent.
//
// NOTHING HERE DISPATCHES ANYTHING. Every act is a callback the card supplies, so this
// is a pure reading of one value and a suite renders it without a bridge.

import { Dialog } from "@base-ui/react/dialog";

import { Chip, Nothing, WireFigure, formatDateTime } from "../../primitives/index.js";
import { InviteOutcomeReport } from "./InviteOutcomeReport.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";
import { isInviteReferenceHeld } from "./pending-invite-reading.js";

export interface InvitationReadingProps {
  /** The lifecycle's current reading. Rendered only where it names an invitation. */
  readonly snapshot: PendingInviteSnapshot;
  /** True while an act on this reference is unsettled, so a second is not offered. */
  readonly isActing: boolean;
  /**
   * The control the dialog opens with focused.
   *
   * The card's rule, applied to this arm: the act that spends nothing is first in the
   * tree and is the one named, so a stray return key puts an invitation away rather
   * than accepting one.
   */
  readonly dismissRef: React.RefObject<HTMLButtonElement | null>;
  /** Accept it, on the reference the reading carries. */
  readonly onConfirm: () => void;
  /** Release that reference and put the card away, telling nobody. */
  readonly onDismiss: () => void;
  /** Put a settled outcome away and move to whatever was waiting behind it. */
  readonly onAcknowledge: () => void;
}

export function InvitationReading(props: InvitationReadingProps): React.JSX.Element | null {
  const { snapshot, isActing } = props;
  const { invite, outcome } = snapshot;
  if (invite === undefined) {
    return null;
  }
  // WHAT MAIN IS STILL HOLDING, on the lifecycle's own predicate. It is what decides
  // whether the dismissal stays on screen, and it is deliberately not "is there an
  // outcome": an acceptance waiting on authentication carries one while the reference
  // is still main's, and reading the presence alone left that arm rendering a report
  // with no control at all — a stalled ceremony a person could look at and not back
  // out of.
  const referenceHeld = isInviteReferenceHeld(outcome);
  return (
    <>
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

      {outcome === undefined ? null : (
        <InviteOutcomeReport
          outcome={outcome}
          // The same act the row below offers, handed on: an acceptance that never
          // reached the control plane is answered by confirming again, and inventing a
          // second callback for it would be one act reaching the lifecycle two ways.
          onConfirm={props.onConfirm}
          onAcknowledge={props.onAcknowledge}
          isActing={isActing}
        />
      )}

      {/* THE ROW SURVIVES THE FIRST ANSWER WHERE THAT ANSWER IS NOT AN END. It used to
          be replaced by the report outright, which is right for the five terminal arms
          — their reference is spent, and the report carries the acts an answer admits
          — and wrong for the one that is a step still running: it took the dismissal
          off screen while main was still holding the reference, leaving the person
          looking at a ceremony with nothing to press. What comes back is the SAME
          control and not a fourth way to close: one act, one class, one `dismissRef`,
          so the card still offers exactly one dismissal reached three ways. The
          acceptance does not come back with it, because a second confirmation would
          race the answer main is already driving. */}
      {referenceHeld ? (
        <div className="meridian-invite-confirmation__acts">
          {/* First in the tree AND named by `initialFocus`: the ordering alone is
                  not enough, since a later control could be inserted above it, and the
                  reference alone is not either, since it says nothing to a reader
                  scanning the markup. */}
          <button
            type="button"
            ref={props.dismissRef}
            className="meridian-invite-confirmation__dismiss"
            disabled={isActing}
            onClick={props.onDismiss}
          >
            Not now
          </button>
          {outcome === undefined ? (
            <button
              type="button"
              className="meridian-invite-confirmation__confirm"
              disabled={isActing}
              aria-busy={isActing}
              onClick={props.onConfirm}
            >
              {isActing ? "Joining…" : "Join this session"}
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="meridian-invite-confirmation__footnote">
        {snapshot.waitingBehind > 0
          ? `Not now puts this away and tells nobody. ${String(snapshot.waitingBehind)} more ${
              snapshot.waitingBehind === 1 ? "invitation is" : "invitations are"
            } behind it.`
          : "Not now puts this away and tells nobody, because there is no decline to send. The link still works if you change your mind."}
      </p>
    </>
  );
}
