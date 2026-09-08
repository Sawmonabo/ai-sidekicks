// Opening the session an acceptance just joined, once, on the event that says so.
//
// THE EVENT AND NOT THE REPLY. `invite.confirmPending` resolves to `void`: acceptance
// runs in the main process and can take an authentication detour, so the reply says
// only that the request was taken. What says a membership exists is the `joined`
// frame on the outcome feed, which carries the session id the frame navigates to —
// `Plan-023` T-023r-6-3 puts it exactly that way ("navigation happens on the `joined`
// outcome event, not on `confirmPending` returning"). A surface that navigated on the
// reply would open a session the recipient may not yet be a member of.
//
// ONCE PER REFERENCE, AND WHY THE GUARD IS A REFERENCE RATHER THAN A BOOLEAN. The
// outcome stays on the reading until the person acknowledges it, so every re-render
// under it sees the same `joined` frame. A boolean would let a SECOND invitation's
// join go unnavigated once the first had set it; the reference is the identity of the
// attempt, so each one navigates exactly once and no later one is swallowed.
//
// NOTHING IS NAVIGATED FROM A RENDER BODY. The act moves the frame's route, which is
// a store write, so it happens in an effect — a family writing to the window's route
// mid-pass would be steering the tree it is being drawn in.

import { useEffect, useRef } from "react";

import type { PendingInviteSnapshot } from "./pending-invite.js";

/**
 * Open the joined session as soon as the outcome feed says there is one.
 *
 * @param snapshot - The lifecycle's current reading. Only its head outcome is read.
 * @param openSession - The frame's own navigation, handed down by the seat. A view
 *   family reaches no route of its own.
 */
export function useJoinedOutcomeNavigation(
  snapshot: PendingInviteSnapshot,
  openSession: (sessionId: string) => void,
): void {
  const navigatedReference = useRef<string | undefined>(undefined);
  const { outcome } = snapshot;
  useEffect(() => {
    if (outcome === undefined || outcome.kind !== "joined") {
      return;
    }
    if (navigatedReference.current === outcome.reference) {
      return;
    }
    navigatedReference.current = outcome.reference;
    openSession(outcome.sessionId);
  }, [outcome, openSession]);
}
