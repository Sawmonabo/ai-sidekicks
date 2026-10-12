// Stops a virtualizer observing the items a commit took out of the document. The library's ref
// lets go of an item while it is still in the document, so the item stays observed until the
// observer next reports on it; when a render inside that very report took the item down, the
// report cannot deliver it and the browser raises its resize loop error.

import { type Virtualizer } from "@tanstack/virtual-core";
import { useLayoutEffect } from "react";

/**
 * Stops `virtualizer` observing every item element the owning list's last commit took out of the
 * document, before the browser's next resize report.
 */
export function useStopObservingRemovedItems<TItemElement extends Element>(
  virtualizer: Pick<Virtualizer<Element, TItemElement>, "measureElement">,
): void {
  useLayoutEffect(() => {
    // Called with no element, the library drops every observed item no longer in the document.
    virtualizer.measureElement(null);
  });
}
