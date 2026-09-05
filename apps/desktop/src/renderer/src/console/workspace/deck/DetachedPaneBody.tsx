// The pane whose body is somewhere else.
//
// Its own module for the one-component rule.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";

/**
 * The pane whose body is somewhere else.
 *
 * A named absence rather than an empty rectangle, and two controls rather than none:
 * `Spec-023 §The surface set` keeps the SLOT while the auxiliary window shows the
 * projection — "the main window shows the moved pane's slot as a placeholder with a
 * focus control" — so the widths and the order survive the window's whole life and the
 * pane goes back exactly where it was. Closing the pane instead — which is what this
 * replaced — deleted the position the window's own close would have needed to restore.
 *
 * The signal refusal renders HERE, in the slot it is about. A build that cannot
 * subscribe to the crashed-window signal cannot notice a window that died, and a
 * placeholder that showed nothing would be claiming that none has.
 */
export function DetachedPaneBody(props: {
  readonly paneId: string;
  readonly onFocusWindow?: (paneId: string) => void;
  readonly onReturnToDeck?: (paneId: string) => void;
  readonly signalRefusal?: ConsoleRefusal;
}): React.JSX.Element {
  const { onFocusWindow, onReturnToDeck, paneId } = props;
  return (
    <div className="meridian-deck__detached">
      <Nothing
        kind="empty"
        placement="surface"
        title="This pane is open in a window of its own."
        detail="Its contents are shown there, and never in two places at once."
        action={
          <>
            {onFocusWindow === undefined ? null : (
              <button
                type="button"
                className="meridian-deck__detached-control"
                onClick={() => {
                  onFocusWindow(paneId);
                }}
              >
                Bring its window forward
              </button>
            )}
            {onReturnToDeck === undefined ? null : (
              <button
                type="button"
                className="meridian-deck__detached-control"
                onClick={() => {
                  onReturnToDeck(paneId);
                }}
              >
                Return it to the deck
              </button>
            )}
          </>
        }
      />
      {props.signalRefusal === undefined ? null : (
        <InlineRefusal code={props.signalRefusal.code} detail={props.signalRefusal.detail} />
      )}
    </div>
  );
}
