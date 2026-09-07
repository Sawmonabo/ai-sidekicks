// When a confirmation discards the settlement standing under it, and when it must not.
//
// THE CONFIRM CONTROL IS AN `AlertDialog.Close`, AND THAT IS THE WHOLE DEFECT. Both of
// this family's confirmations put the consequence inside the popup and the settlement
// on the card, because a settlement drawn inside a dialog the confirm press closes is
// drawn into a popup that is already gone. So the confirm press does two things in one
// act: it sends, and it closes. A discard rule wired to `onOpenChange` and keyed on the
// CLOSE therefore fires immediately after the send published `sending` — the card falls
// back to idle, the trigger it disabled re-enables under a call still on the wire, and
// a second press reaches the controller's single-flight guard and returns silently. The
// settlement a person is owed for the press they just made is the one that close erased.
//
// SO THE DISCARD IS KEYED ON THE TWO MOMENTS IT BELONGS TO. A confirmation OPENING is a
// new consideration of the act, so nothing an earlier press settled stands under it; a
// confirmation CANCELLED is a person walking away from one, so the record they walked
// away from goes with them. The confirm press is neither — it is what produces the next
// settlement, and it is the one close this module exists to leave alone.
//
// ONE HELPER FOR BOTH CONSUMERS rather than the same two handlers written twice. They
// hand over different discards — one clears a controller's act, the other resets a
// `useState` reading — so what is shared is the RULE and not the state, which is why
// this takes the discard as a parameter instead of owning one.

import { useCallback, useMemo } from "react";

/** The two handlers a confirmation wires, and the only two moments that discard. */
export interface ConfirmationLifecycle {
  /**
   * Hand to `AlertDialog.Root`'s `onOpenChange`.
   *
   * Discards on the OPEN edge and on no close at all — a close carries no information
   * about which control produced it, and the one that does is the confirm.
   */
  readonly openChanged: (isOpen: boolean) => void;
  /** Hand to the cancel `AlertDialog.Close`'s `onClick`, and to no other control. */
  readonly cancelled: () => void;
}

/**
 * Wire one confirmation's discard rule.
 *
 * `discardSettlement` is called at most once per participant act and never from a
 * render body, so a caller whose discard is a `useState` setter and a caller whose
 * discard reaches a controller are both served without this module knowing which.
 */
export function useConfirmationLifecycle(discardSettlement: () => void): ConfirmationLifecycle {
  const openChanged = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        discardSettlement();
      }
    },
    [discardSettlement],
  );
  const cancelled = useCallback(() => {
    discardSettlement();
  }, [discardSettlement]);
  return useMemo(() => ({ openChanged, cancelled }), [openChanged, cancelled]);
}
