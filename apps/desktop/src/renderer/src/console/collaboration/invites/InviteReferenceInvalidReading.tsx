// The handle stopped resolving: which of the three ways, and what that means for the
// link the person is holding.
//
// A STATEMENT ABOUT THE HANDLE AND NOT ABOUT THE INVITATION, which is why this is not
// a refusal reading and carries no wire code. Nothing was asked of any control plane
// here: the main process mints these handles, holds them for a bound shorter than the
// invitation's own, and answers for them itself — so what a person is told is what
// main knows, and the three readings differ on the one thing they can act on, whether
// following the link again is worth anything.
//
// IT IS ALSO HOW A PROMPT HELD OPEN BY AUTHENTICATION ENDS. An acceptance waiting on a
// sign-in keeps its reference across the ceremony under the original deadline, never
// re-armed; when that lapses this is the arm that arrives, and before it existed the
// prompt stayed on screen with nothing to press for the life of the window.
//
// NOTHING HERE DISPATCHES ANYTHING. The close is the card's acknowledgement — there is
// no reference left for a dismissal to release.

import type { GrowthInviteOutcome } from "../../bridge/index.js";

export interface InviteReferenceInvalidReadingProps {
  readonly outcome: Extract<GrowthInviteOutcome, { readonly kind: "reference-invalid" }>;
}

export function InviteReferenceInvalidReading(
  props: InviteReferenceInvalidReadingProps,
): React.JSX.Element {
  return (
    <div className="meridian-invite-outcome__body">
      <h4 className="meridian-invite-outcome__title">This invitation could not be answered.</h4>
      <p className="meridian-invite-outcome__lede">{reasonWords(props.outcome.reason)}</p>
    </div>
  );
}

/**
 * What each reason means for the link, in one sentence.
 *
 * Total over the closed vocabulary rather than a default arm: a fourth reason would
 * fail to compile here instead of being told to a person as one of these three.
 */
function reasonWords(reason: "unknown" | "consumed" | "expired"): string {
  switch (reason) {
    case "expired":
      return "This window held its place for a limited time and that time has passed. The invitation itself may well be fine. Following the link again starts over.";
    case "consumed":
      return "This invitation has already been accepted, so there is nothing left to answer. If that was you, the session is already yours.";
    case "unknown":
      return "This window is not holding anything for that invitation any more — it may have been put away, or this window may have been restarted since the link was followed. Following the link again starts over.";
  }
}
