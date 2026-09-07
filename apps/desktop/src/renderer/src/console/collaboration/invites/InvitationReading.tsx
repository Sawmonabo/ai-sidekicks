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
  const { invite } = snapshot;
  if (invite === undefined) {
    return null;
  }
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

      {snapshot.outcome === undefined ? (
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
          // The same act the block above offers, handed on: an acceptance that never
          // reached the control plane is answered by confirming again, and inventing a
          // second callback for it would be one act reaching the lifecycle two ways.
          onConfirm={props.onConfirm}
          onAcknowledge={props.onAcknowledge}
          isActing={isActing}
        />
      )}

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
