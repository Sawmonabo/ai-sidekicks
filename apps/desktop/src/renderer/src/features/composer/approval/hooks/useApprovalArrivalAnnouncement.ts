// Announces a newly pending card, and moves focus to it only when the composer had focus.

import { isHTMLElement } from "@floating-ui/utils/dom";
import { useEffect, useRef, useState } from "react";

import type { ApprovalProjectionRow } from "@ai-sidekicks/contracts/approval";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { APPROVAL_CATEGORY_LABELS } from "#renderer/lib/approval-vocabulary.js";

import { findApprovalCardAction } from "../components/ApprovalCard.js";

/** The composer's root class. Focus moves to a new card only from inside it. */
const COMPOSER_ROOT_SELECTOR = ".meridian-composer";

/**
 * Announces a newly pending card and moves focus to its action only when the composer had it.
 * Focus lands on the arrived record's own card, found within `cardRootRef`, because the
 * announcement names that record and a document-wide query could land on an older card.
 *
 * @consumedBy the approval card's arrival focus
 */
export function useApprovalArrivalAnnouncement(
  pending: readonly ApprovalProjectionRow[],
  cardRootRef: React.RefObject<HTMLElement | null>,
): string {
  const [announcement, setAnnouncement] = useState("");
  const seenIdsRef = useRef<ReadonlySet<string>>(new Set());
  const ownerDocument = useOwnerWindow().document;

  useEffect(() => {
    const currentIds = new Set(pending.map((record) => record.id));
    const arrived = pending.filter((record) => !seenIdsRef.current.has(record.id));
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
        ? `A decision is waiting: ${APPROVAL_CATEGORY_LABELS[first.category]}.`
        : `${String(arrived.length)} decisions are waiting.`,
    );
    const focused = ownerDocument.activeElement;
    if (!isHTMLElement(focused) || focused.closest(COMPOSER_ROOT_SELECTOR) === null) {
      return;
    }
    // Scoped to this pane, since a pane layout may hold a second one. The focus move never
    // scrolls the conversation.
    const action = findApprovalCardAction(cardRootRef.current ?? ownerDocument, first.id);
    action?.focus({ preventScroll: true });
  }, [pending, cardRootRef, ownerDocument]);

  return announcement;
}
