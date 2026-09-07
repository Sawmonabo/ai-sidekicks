// A deep link that produced no invitation: what the preview answered, and the one act
// either arm admits.
//
// THE THIRD READING BESIDE THE OUTCOME'S OWN. `InviteOutcomeReport.tsx` renders how an
// ATTEMPT ended and every arm of it is about a reference that existed; this renders the
// two arms where no reference was ever minted, so there is nothing to confirm and
// nothing to release. They are opposite halves of one card and not two shades of one
// reading — a refusal of the preview is a statement about the LINK, and a refusal of
// the acceptance is a statement about the attempt on it.
//
// WHY A RETRY LIVES HERE AND NOWHERE ELSE. Trying again means putting a preview to the
// control plane again, which is a property of a preview that never reached it — the
// `unavailable` arm, which is the only one carrying the attempt handle a retry is
// dispatched on. The two authentication outcomes look retryable and are not: one is a
// ceremony main is still driving and the other has already released its reference. So
// the offer is read off `PendingInviteSnapshot.canRetry`, which is the lifecycle's own
// answer, rather than re-derived from the arm — a component deciding it separately
// would be a second answer that goes stale the first time an arm is added.
//
// THE REFUSED ARM OFFERS NO SECOND ATTEMPT, for the reason a refused acceptance does
// not: pressing again puts the identical request to the identical answer. What it
// offers is the close, and the close is an ACKNOWLEDGEMENT rather than a dismissal —
// there is no reference for `invite.dismissPending` to release, so the act that puts
// this away is local by construction.
//
// NOTHING HERE DISPATCHES ANYTHING. Every act is a callback the card supplies, so this
// is a pure reading of one value and a suite renders both arms without a bridge.

import { Dialog } from "@base-ui/react/dialog";

import type { GrowthPendingInvitePreviewFailure } from "../../bridge/index.js";
import { InviteRefusalWords } from "./InviteRefusalWords.js";

export interface InvitePreviewFailureReadingProps {
  /** The head, where it is a preview that produced nothing to confirm. */
  readonly failure: GrowthPendingInvitePreviewFailure;
  /**
   * Whether the lifecycle will accept a retry on this head.
   *
   * The reading's own answer, consulted rather than re-derived from
   * {@link failure}'s arm: which states admit a second attempt is a property of the
   * machine that dispatches them.
   */
  readonly canRetry: boolean;
  /** True while an act on this head is unsettled, so a second is not offered. */
  readonly isActing: boolean;
  /** Put the preview to the control plane again, on the head's own attempt handle. */
  readonly onRetry: () => void;
  /** Put this prompt away and move to whatever was waiting behind it. */
  readonly onAcknowledge: () => void;
  /**
   * The control the dialog opens with focused.
   *
   * The card's rule, applied to this arm: the act that SENDS nothing is first in the
   * tree and is the one named, so a stray return key closes a prompt rather than
   * putting a request on the wire.
   */
  readonly acknowledgeRef: React.RefObject<HTMLButtonElement | null>;
}

export function InvitePreviewFailureReading(
  props: InvitePreviewFailureReadingProps,
): React.JSX.Element {
  const { failure } = props;
  const isRefused = failure.status === "refused";
  return (
    <>
      <Dialog.Title className="meridian-invite-confirmation__title">
        {isRefused ? "This invitation cannot be opened." : "This invitation could not be checked."}
      </Dialog.Title>
      <section className="meridian-invite-outcome" aria-label="What the preview answered">
        <div className="meridian-invite-outcome__body">
          {failure.status === "refused" ? (
            <InviteRefusalWords code={failure.code} detail={failure.detail} />
          ) : (
            <p className="meridian-invite-outcome__lede">
              {/* The honest reading of an arm that carries no words from anybody: the
                  control plane was never reached, so it has said nothing about this
                  link — which is a different fact from a refusal and is why the arm
                  exists at all. */}
              This window could not reach the control plane that issued this link, so nothing is
              known about the invitation yet. The link is untouched, and trying again costs it
              nothing.
            </p>
          )}
        </div>

        <div className="meridian-invite-outcome__acts">
          <button
            type="button"
            ref={props.acknowledgeRef}
            className="meridian-invite-outcome__acknowledge"
            disabled={props.isActing}
            onClick={props.onAcknowledge}
          >
            Done
          </button>
          {props.canRetry ? (
            <button
              type="button"
              className="meridian-invite-outcome__retry"
              disabled={props.isActing}
              aria-busy={props.isActing}
              onClick={props.onRetry}
            >
              {props.isActing ? "Trying…" : "Try again"}
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}
