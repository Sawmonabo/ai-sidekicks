// A newly pending card is announced, and focus is taken only from the composer.
//
// Split out of `ApprovalsPaneBody.tsx`. The rule it keeps is one of the three the
// approvals pane's composition owns rather than any one card — `ApprovalsPane.tsx`
// states it — and it is a subscription with a remembered set, so it lives in a hook
// rather than in a render body.

import { useEffect, useRef, useState } from "react";

import { type ApprovalRecord } from "../../../bridge/index.js";
import { findApprovalCardAction } from "../card/ApprovalCard.js";

/** The composer's root class. Focus moves to a new card only from inside it. */
const COMPOSER_ROOT_SELECTOR = ".meridian-composer";

/**
 * Announce a newly pending card, and move focus only when the composer had it.
 *
 * The focus rule is the sharp half, and it has two parts. WHETHER focus moves is a
 * question about where focus already is: a person typing in the composer is looking
 * at the work and has asked for nothing else, while a person reading a diff, or
 * mid-sentence in a field this pane knows nothing about, has not. WHERE it moves is
 * a question about which record arrived — the announcement names that record, so
 * landing the caret on an older card's button describes one request and hands over
 * another. Both the pane root and the record are named rather than assumed: a
 * document-wide query for the first action in DOM order answers with neither.
 */
export function useArrivalAnnouncement(
  pending: readonly ApprovalRecord[],
  paneRootRef: React.RefObject<HTMLElement | null>,
): string {
  const [announcement, setAnnouncement] = useState("");
  const seenIdsRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(pending.map((record) => record.approvalRequestId));
    const arrived = pending.filter((record) => !seenIdsRef.current.has(record.approvalRequestId));
    seenIdsRef.current = currentIds;
    if (arrived.length === 0) {
      return;
    }
    const first = arrived[0];
    if (first === undefined) {
      return;
    }
    setAnnouncement(
      arrived.length === 1
        ? `A decision is waiting: ${first.category} requested by ${first.requestedBy}.`
        : `${String(arrived.length)} decisions are waiting.`,
    );
    if (typeof document === "undefined") {
      return;
    }
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || focused.closest(COMPOSER_ROOT_SELECTOR) === null) {
      return;
    }
    // Scoped to this pane, because a deck may hold a second one and its cards are
    // no more this arrival's than an older card of this pane's is.
    const action = findApprovalCardAction(paneRootRef.current ?? document, first.approvalRequestId);
    action?.focus();
  }, [pending, paneRootRef]);

  return announcement;
}
