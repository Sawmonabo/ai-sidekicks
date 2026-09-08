// The auxiliary window's own header control. Its own module for the one-component rule.

import { type ConsoleBridge } from "../bridge/index.js";
import { type ConsoleRefusal } from "../core/index.js";
import { type ConsoleRoute } from "../routing/index.js";
import { useAuxiliaryReturn } from "./auxiliary-return.js";

/**
 * The strip an auxiliary window wears above its surface: one control, which gives the
 * pane back.
 *
 * NOTHING AT ALL ON EVERY OTHER WINDOW, including an auxiliary one opened from the
 * Window menu. `auxiliary-return.ts` says why the window handle is the discriminator:
 * a window no deck asked for has no slot waiting for its pane, and a control offering
 * to return it somewhere would be offering a place that does not exist.
 *
 * IT IS CHROME, WHICH IS WHY IT IS HERE AND NOT IN THE SURFACE. The frame renders it
 * above the surface's own error boundary, so a window whose timeline throws is still a
 * window whose pane can be given back — the state in which being stranded would be
 * worst.
 */
export function AuxiliaryReturn(props: {
  readonly route: ConsoleRoute;
  readonly auxiliaryWindows: ConsoleBridge["auxiliaryWindows"];
  readonly onRefused: (refusal: ConsoleRefusal) => void;
}): React.JSX.Element | null {
  const { isReturning, returnToDeck, windowId } = useAuxiliaryReturn(props);
  if (windowId === undefined) {
    return null;
  }
  return (
    <header className="meridian-window-controls">
      <button
        type="button"
        className="meridian-window-controls__control"
        disabled={isReturning}
        onClick={returnToDeck}
      >
        {isReturning ? "Returning it to the deck…" : "Return it to the deck"}
      </button>
    </header>
  );
}
