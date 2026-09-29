// When a surface's refusal stops being that surface's business.
//
// `lib/refusal-remedies.ts` records which of three shapes a named code calls for, and
// one of the three is the workspace banner — a refusal that changed what the whole room
// can do. A surface cannot draw one: the banner spans the frame and is held by the
// window's store, so what a surface does is HAND it over. That handover is this hook.
//
// IT ESCALATES ONCE PER CONDITION, not once per render and not once per refusal
// VALUE. A pane whose read refuses on every retry would otherwise re-raise on every
// one, and a banner that keeps reappearing after a person dismisses it is a banner
// they stop reading. Keying the effect on the refusal object was not enough to stop
// that: no producer in this console reuses a refusal across retries — the approvals
// reader mints a fresh one on each failed refresh, including the window-focus ones
// the read triggers arm — so an unchanged condition arrived as a new object and the
// dismissal lasted until the next retry. What is remembered is therefore the
// refusal's CONTENT, and the two arms of that rule are both behaviors a person
// notices: an unchanged condition stays dismissed, and a changed one comes back.
//
// WHAT COUNTS AS THE SAME CONDITION is the whole of what a banner shows plus who
// raised it — the origin, the code, and the daemon's sentence. Not the code alone:
// two sessions' losses under one code carry different sentences, and suppressing the
// second would leave the first one's words on screen for a different failure. And not
// the object, for the reason above.
//
// AND ONLY FOR THE CODES THE TABLE NAMES AS BANNERS. A pane's ordinary refusal is
// the pane's own business and renders where it happened; escalating everything would
// put a read failure in one pane across the whole workspace.

import { useEffect, useRef } from "react";

import { type Refusal } from "@renderer/lib/refusal.js";
import { type WindowStore } from "@renderer/store/window/window-store.js";
import { isBannerClass } from "../refusal-banner-selection.js";

/** Hand a whole-workspace refusal to the frame, and leave every other one alone. */
export function useRefusalBannerEscalation(
  frameStore: WindowStore,
  refusal: Refusal | undefined,
): void {
  // What this mount has already handed over, and to which store. Held rather than
  // derived because the question is about the PAST — a condition already raised — and
  // the frame's banner stack is not the answer to it: a dismissed banner is gone from
  // there, which is exactly the state this must not re-raise into.
  const handedOver = useRef<{ frameStore: WindowStore; identity: string } | undefined>(undefined);
  useEffect(() => {
    if (refusal === undefined || !isBannerClass(refusal)) {
      return;
    }
    const identity = escalationIdentityOf(refusal);
    const previous = handedOver.current;
    if (previous?.frameStore === frameStore && previous.identity === identity) {
      return;
    }
    handedOver.current = { frameStore, identity };
    frameStore.raiseRefusalBanner(refusal);
  }, [frameStore, refusal]);
}

/**
 * What makes two refusals the same condition, as one comparable value.
 *
 * The three fields a banner is built from, joined by a separator no wire string
 * carries, so a code ending where a detail begins cannot collide with its neighbor.
 */
function escalationIdentityOf(refusal: Refusal): string {
  return `${refusal.origin}\u0000${refusal.code}\u0000${refusal.detail}`;
}
