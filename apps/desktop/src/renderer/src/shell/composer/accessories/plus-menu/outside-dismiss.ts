// Dismissing an open disclosure by leaving it, which is the other half of Escape.
//
// ITS OWN MODULE BECAUSE IT IS AN EFFECT AND NOT A LAYOUT. `apps/desktop/AGENTS.md`:
// subscriptions live in a hook or a class and never in a render body, and this one
// listens on the DOCUMENT — a listener a component body attached would be attached
// again on every pass and removed on none.
//
// TWO EVENTS, BECAUSE THERE ARE TWO WAYS TO LEAVE. A pointer press outside the region
// is the mouse's way; focus landing outside it is the keyboard's, and a menu that only
// watched the pointer would strand a Tab-out person's panel open behind whatever they
// tabbed into. Both are read on the DOCUMENT and in the CAPTURE phase, because a press
// on a control that unmounts itself never bubbles to a document-level listener at all.
//
// `pointerdown` AND NOT `click`. A click is settled on release, so a press that starts
// outside and releases inside — a drag, a text selection that ends over the panel —
// fires no click on the document and leaves an open panel a person has visibly left.
// Pointer events also cover touch and pen, which `mousedown` does not.
//
// AND THE DISMISSAL IS NOT THE CLOSE. Escape closes and returns focus to the trigger,
// because Escape is a person saying "not this, put me back". Leaving is a person
// already somewhere else, and moving focus back to a trigger they walked away from
// would take the caret out of whatever they had just reached for. So this hook is
// handed the dismissal and never the close, and the two stay different acts.

import { useEffect, type RefObject } from "react";

/**
 * Dismiss while `isOpen`, when a pointer press or a focus change lands outside `region`.
 *
 * Does nothing at all while closed — no listener is attached, so a composer with a
 * shut menu costs the document nothing. `dismiss` is read through a ref-free
 * dependency, so a caller passing a `useCallback` gets one subscription per open.
 */
export function useOutsideDismiss(
  region: RefObject<HTMLElement | null>,
  isOpen: boolean,
  dismiss: () => void,
): void {
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const dismissIfOutside = (event: Event): void => {
      const target = event.target;
      // `Node` and not `HTMLElement`: a press can land on a text node, and a focus
      // change on the document itself. Neither is inside the region, and asking
      // `contains` about a non-node would throw inside a listener nothing catches.
      if (target instanceof Node && region.current?.contains(target) === true) {
        return;
      }
      dismiss();
    };
    document.addEventListener("pointerdown", dismissIfOutside, true);
    document.addEventListener("focusin", dismissIfOutside, true);
    return () => {
      document.removeEventListener("pointerdown", dismissIfOutside, true);
      document.removeEventListener("focusin", dismissIfOutside, true);
    };
  }, [region, isOpen, dismiss]);
}
