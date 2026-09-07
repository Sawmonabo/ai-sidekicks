// The one act an auxiliary window can perform on ITSELF: give its pane back.
//
// `Spec-023 §The surface set` keeps the moved pane's slot in the deck as a
// placeholder for the whole life of the window, so the way back is a control rather
// than a re-open. The deck has had its half since the placeholder did — a return
// control in the slot — and the WINDOW had none, which left the person who was
// looking at the moved pane with only the operating system's close button.
//
// AND THAT BUTTON IS NOT THIS ACT. Closing the window through the shell's own
// chrome is a window that stopped being open, which is what the deck's crashed-window
// signal reports — a crash note in the pane's error slot about a close somebody
// deliberately performed. Routing an orderly return through that path would say a
// window died when it did nothing of the kind. So the window addresses the shell's
// close operation itself, by the handle its own route carries, and the shell reports
// the return on the signal that means exactly that.
//
// THE HANDLE IS THE WHOLE REASON THIS IS POSSIBLE. A window opened from the Window
// menu belongs to no deck slot and carries no handle, so it has nothing to return to
// and offers no control; a window opened by a detach carries the handle the deck was
// given, stamped into its route by the window factory. `routeAuxiliaryWindowId` is
// the one reader of that member, and its absence is what suppresses the control —
// never `process.platform`, never a guess about how the window was opened.

import { useCallback, useState } from "react";

import { settledGrowthCall, type ConsoleBridge } from "../bridge/index.js";
import { type ConsoleRefusal } from "../core/index.js";
import { routeAuxiliaryWindowId, type ConsoleRoute } from "../routing/index.js";

/** What the window's own return control renders from. */
export interface AuxiliaryReturnState {
  /**
   * The window this frame IS, where it is a window a deck asked for.
   *
   * `undefined` on every other route — the main window's, and an auxiliary window
   * opened from the Window menu, which no deck slot is holding a place for.
   */
  readonly windowId: string | undefined;
  /**
   * True once the close has been asked for and not refused.
   *
   * It does not go back to false on success, and that is the honest reading rather
   * than an oversight: a served close is the shell agreeing to destroy this window,
   * so the control has nothing left to offer and a second press would ask the shell
   * to close a window it is already closing. A REFUSED close does clear it, because
   * then the window is still here and the person may want to try again.
   */
  readonly isReturning: boolean;
  /** Ask the shell to close this window, which puts the pane back in the deck. */
  readonly returnToDeck: () => void;
}

/**
 * Hold the window's own return act.
 *
 * The refusal goes to the caller rather than being rendered beside the control:
 * `Spec-023 §Meridian, the design language` puts a refusal that changes what the
 * whole window can do in the frame's banner list, and this window has exactly one
 * surface — so a refusal about closing it is about all of it.
 *
 * There is no local record of the return beyond `isReturning`, and deliberately: the
 * deck's slot is restored by the shell's own orderly-return signal, which is the only
 * account of this window that survives it being destroyed.
 */
export function useAuxiliaryReturn(options: {
  readonly route: ConsoleRoute;
  readonly growth: ConsoleBridge["growth"];
  readonly onRefused: (refusal: ConsoleRefusal) => void;
}): AuxiliaryReturnState {
  const { growth, onRefused, route } = options;
  const windowId = routeAuxiliaryWindowId(route);
  const [isReturning, setIsReturning] = useState(false);

  const returnToDeck = useCallback(() => {
    if (windowId === undefined) {
      return;
    }
    setIsReturning(true);
    // Settled, so a rejecting wire reaches the banner as a refusal rather than as an
    // unhandled rejection off an event handler — the same rule every growth ACT in
    // the console follows. A `GrowthUnavailable` IS a `ConsoleRefusal`, carrying the
    // operation and the row that owes the wire, so nothing here re-mints one and
    // nothing translates it into a second vocabulary.
    void settledGrowthCall("windowCloseAuxiliary", () =>
      growth.windowCloseAuxiliary({ windowId }),
    ).then((answer) => {
      if (answer.status === "unavailable") {
        setIsReturning(false);
        onRefused(answer);
      }
    });
  }, [growth, onRefused, windowId]);

  return { windowId, isReturning, returnToDeck };
}
