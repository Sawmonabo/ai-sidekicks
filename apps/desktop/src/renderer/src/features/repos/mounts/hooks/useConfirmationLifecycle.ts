// When a confirmation discards the settlement standing under it. The confirm control is an
// `AlertDialog.Close`, so a discard keyed on any close would fire right after the send published
// `sending` and erase the settlement that press just produced. Only opening and cancel discard.
// The caller supplies the discard, so the hook shares the rule and not the state.

import { useCallback, useMemo } from "react";

/** The two handlers a confirmation wires, and the only two moments that discard. */
export interface ConfirmationLifecycle {
  /**
   * Hand to `AlertDialog.Root`'s `onOpenChange`. Discards on open and never on close: a close
   * does not say which control produced it, and the confirm is one of them.
   */
  readonly openChanged: (isOpen: boolean) => void;
  /** Hand to the cancel `AlertDialog.Close`'s `onClick`, and to no other control. */
  readonly canceled: () => void;
}

/**
 * Wire one confirmation's discard rule. `discardSettlement` runs at most once per user act and
 * never from a render body.
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
  const canceled = useCallback(() => {
    discardSettlement();
  }, [discardSettlement]);
  return useMemo(() => ({ openChanged, canceled }), [openChanged, canceled]);
}
