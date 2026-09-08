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
import { invitationFootnote } from "./invite-footnote-copy.js";
import { InviteOutcomeReport } from "./InviteOutcomeReport.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";
import { isInviteAnswerOutstanding } from "./pending-invite-reading.js";

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
  readonly closeRef: React.RefObject<HTMLButtonElement | null>;
  /** Accept it, on the reference the reading carries. */
  readonly onConfirm: () => void;
  /**
   * Put the card away — the card's one close act, already resolved.
   *
   * Whether it releases the reference over the wire or clears a spent prompt locally
   * is decided once, by the card, from what main is still holding. This arm draws it
   * and never chooses it: a body that branched again would be the second reading that
   * let a retryable reference be closed away without being released.
   */
  readonly onClose: () => void;
}

export function InvitationReading(props: InvitationReadingProps): React.JSX.Element | null {
  const { snapshot, isActing } = props;
  const { invite, outcome } = snapshot;
  if (invite === undefined) {
    return null;
  }
  // WHETHER AN ANSWER IS STILL COMING, on the lifecycle's own predicate. It is what
  // decides whether THIS arm draws the close or the report below does, and it is
  // deliberately not "is there an outcome": an acceptance waiting on authentication
  // carries one while main drives the ceremony, and reading the presence alone left
  // that arm rendering a report with no control at all — a stalled ceremony a person
  // could look at and not back out of. It is equally not "what main is holding": a
  // `unavailable` answer is one main still holds the reference for AND one the report
  // has words and a retry for, so drawing this row there would put two close controls
  // on one card.
  const answerOutstanding = isInviteAnswerOutstanding(outcome);
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
          onClose={props.onClose}
          isActing={isActing}
        />
      )}

      {/* THE ROW SURVIVES AN ANSWER THAT IS STILL RUNNING, AND ONLY THAT ONE. It used
          to be replaced by the report outright, which is right for every arm that has
          words to draw and an act to offer, and wrong for the one that is a step in
          progress: it took the close off screen while main was still holding the
          reference, leaving the person looking at a ceremony with nothing to press.
          What comes back is the SAME act and not a fourth way to close — one callback,
          one class, one `closeRef` — so the card still offers exactly one close reached
          three ways. The acceptance does not come back with it, because a second
          confirmation would race the answer main is already driving. And the row stays
          OFF for an acceptance that could not be put: main holds that reference too,
          but the report is what a person reads there, so the close belongs on its row
          and drawing both would offer one act twice. */}
      {answerOutstanding ? (
        <div className="meridian-invite-confirmation__acts">
          {/* First in the tree AND named by `initialFocus`: the ordering alone is
                  not enough, since a later control could be inserted above it, and the
                  reference alone is not either, since it says nothing to a reader
                  scanning the markup. */}
          <button
            type="button"
            ref={props.closeRef}
            className="meridian-invite-confirmation__dismiss"
            disabled={isActing}
            onClick={props.onClose}
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

      {/* THE FOOTNOTE FOLLOWS THE ANSWER, and until this it did not. One line about
          **Not now** was printed under every state — including the four terminal ones,
          where that control is not drawn at all and the report's **Done** is, and where
          "the link still works if you change your mind" is false of a link an
          acceptance has already consumed. So the card said one thing in its result and
          the opposite underneath it. The words are `invite-footnote-copy.ts`, exhaustive
          over the outcome union and reading the same `isInviteAnswerOutstanding` this
          body draws its act row on, which is what keeps the sentence and the control it
          names from being two answers to one question. */}
      <p className="meridian-invite-confirmation__footnote">{invitationFootnote(snapshot)}</p>
    </>
  );
}
