// A window's offer binding, for suites that need one rather than a window.
//
// HOISTED ON THE SECOND USE. The binding is a pair — what a row's offers ARE and the
// one menu they open in — and two suites now need a whole one: this directory's render
// cases, and the row-dispatch suite next door whose subject is the memo boundary the
// binding sits behind. Both would otherwise hand-roll the same two members, and the
// second copy is the one that goes stale when the pair grows a third.
//
// AND THE HANDLE IS THE REAL ONE. `Menu.createHandle()` is what the hook mints, and
// the association between a detached trigger and the root that answers it is the
// property these suites are checking — a stand-in would leave them checking the
// stand-in instead.

import { Menu } from "@base-ui/react/menu";

import {
  type LedgerRowOfferRequest,
  type LedgerRowOffersBinding,
  type LedgerRowOffersHandle,
} from "./ledger-row-offers-binding.js";
import { type LedgerRowOffer } from "./ledger-row-offers.js";

/** A binding that answers every row with whatever the caller decides. */
export function sampleRowOffersBinding(
  answer: (request: LedgerRowOfferRequest) => readonly LedgerRowOffer[],
): LedgerRowOffersBinding {
  const menuHandle: LedgerRowOffersHandle = Menu.createHandle<LedgerRowOfferRequest>();
  return { offersFor: answer, menuHandle };
}
