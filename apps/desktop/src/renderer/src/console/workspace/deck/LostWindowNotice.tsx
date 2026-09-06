// What happened to the window a pane was in, said beside that pane.
//
// Its own module for the one-component rule.

import { InlineRefusal } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";

/**
 * The pane's error slot: what happened to the window this pane was in.
 *
 * INLINE rather than a banner, on the refusal grammar's own question — what did this
 * change, and for whom? One pane's window died and one pane's body came back; the
 * rest of the room is untouched, so the note belongs beside the pane and not across
 * the workspace.
 *
 * Dismissable, and the dismissal is the caller's act rather than local state: the
 * record lives on the hand-off, so a note cleared in a component that then
 * re-rendered from the hand-off's own publish would come straight back.
 */
export function LostWindowNotice(props: {
  readonly paneId: string;
  readonly notice: ConsoleRefusal;
  readonly onDismiss?: (paneId: string) => void;
}): React.JSX.Element {
  const { onDismiss, paneId } = props;
  return (
    <div className="meridian-deck__pane-error">
      <InlineRefusal
        code={props.notice.code}
        detail={props.notice.detail}
        {...(onDismiss === undefined
          ? {}
          : {
              action: (
                <button
                  type="button"
                  className="meridian-deck__detached-control"
                  onClick={() => {
                    onDismiss(paneId);
                  }}
                >
                  Dismiss
                </button>
              ),
            })}
      />
    </div>
  );
}
