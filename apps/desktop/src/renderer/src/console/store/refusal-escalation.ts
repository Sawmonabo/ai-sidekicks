// When a surface's refusal stops being that surface's business.
//
// `core/refusal-remedies.ts` records which of rule 9's three shapes a named code
// calls for, and one of the three is the workspace banner — a refusal that changed
// what the whole room can do. A pane cannot draw one: the banner spans the frame and
// is held by the frame's store, so what a pane does is HAND it over. That handover is
// this hook, and it lives here because the frame store lives here.
//
// IT ESCALATES ONCE PER REFUSAL, not once per render. The effect is keyed on the
// refusal value, so a pane re-rendering under an unchanged refusal raises nothing
// further — and the frame store's banner is a single slot, so a second raise of the
// same refusal would be indistinguishable from the first anyway. What the keying
// actually prevents is the reverse: a pane whose read refuses on every retry would
// otherwise re-raise on every one, and a banner that keeps reappearing after a person
// dismisses it is a banner they stop reading.
//
// AND ONLY FOR THE CODES THE TABLE NAMES AS BANNERS. A pane's ordinary refusal is
// the pane's own business and renders where it happened; escalating everything would
// put a read failure in one pane across the whole workspace.

import { useEffect } from "react";

import { refusalRemedyFor, type ConsoleRefusal } from "../core/index.js";
import { type FrameStore } from "./frame-store.js";

/** Hand a whole-workspace refusal to the frame, and leave every other one alone. */
export function useRefusalBannerEscalation(
  frameStore: FrameStore,
  refusal: ConsoleRefusal | undefined,
): void {
  useEffect(() => {
    if (refusal === undefined) {
      return;
    }
    if (refusalRemedyFor(refusal.code)?.rendering !== "banner") {
      return;
    }
    frameStore.raiseRefusalBanner(refusal);
  }, [frameStore, refusal]);
}
