// Hands a banner-class refusal (`lib/refusal/remedies.ts` names which codes) to the frame,
// since the banner spans the session screen and is held by the window's store.
//
// It escalates once per condition, not per render or per refusal object: producers mint a fresh
// refusal on each retry, so an unchanged condition would re-raise a dismissed banner. The
// condition is the origin, code and daemon sentence together; a changed one comes back.

import { useEffect, useRef } from "react";

import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { isBannerClass } from "../refusal-banner-selection.js";

/** Hand a banner-class refusal to the frame; every other refusal is left to its view. */
export function useRefusalBannerEscalation(
  frameStore: WindowStore,
  refusal: Refusal | undefined,
): void {
  // What this mount already handed over, and to which store. Held because a dismissed banner
  // is gone from the frame's stack, which is the state this must not re-raise into.
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
 * What makes two refusals the same condition, as one comparable value. The separator is one no
 * wire string carries, so neighboring fields cannot collide.
 */
function escalationIdentityOf(refusal: Refusal): string {
  return `${refusal.origin}\u0000${refusal.code}\u0000${refusal.detail}`;
}
