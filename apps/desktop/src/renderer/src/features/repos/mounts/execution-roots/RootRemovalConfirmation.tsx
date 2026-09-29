// Removing a worktree, with what it costs stated first.
//
// The strongest interaction on this screen, and it is built as one. An alert dialog rather
// than a button: it traps focus and it does not dismiss on an outside press.
//
// The settlement renders on the card, outside the popup, on `ReattachControl`'s reasoning:
// the confirm control closes the dialog, so anything drawn inside it is drawn into a popup
// that is already gone.
//
// That is also why the discard rule is not this module's. The same close reaches
// `onOpenChange`, so a discard keyed on it takes back the `sending` the press had just
// published; `hooks/useConfirmationLifecycle.ts` holds the two moments a discard
// belongs to, and this file wires them.

import "./execution-roots.css";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { Nothing, OverlayAlertDialogPopup } from "@renderer/console/primitives/index.js";
import { useConfirmationLifecycle } from "../hooks/useConfirmationLifecycle.js";
import { type RootRemovalOperations, type RootRemovalReading } from "./root-removal-controller.js";
import { useRootRemoval } from "./hooks/useRootRemoval.js";

/** What the control says. */
const REMOVAL_LABEL = "Remove";

/** The question the confirmation asks. */
const REMOVAL_QUESTION = "Remove this worktree?";

/** What the removal confirmation is bound to: one worktree, and the call it sends. */
export interface RootRemovalConfirmationProps {
  readonly bridge: PlatformBridge;
  /** The removal this confirmation sends. */
  readonly operations: RootRemovalOperations;
  /** The worktree's own id. Sent verbatim; nothing about it is re-derived here. */
  readonly rootId: string;
  /** Read the section again, so the root's new state reaches the list it is drawn in. */
  readonly onSettled: () => void;
}

/** The alert dialog that removes one worktree after stating what the removal costs. */
export function RootRemovalConfirmation(props: RootRemovalConfirmationProps): React.JSX.Element {
  const { reading, send, clear } = useRootRemoval(props.bridge, props.rootId, props.operations);
  const { onSettled } = props;
  // The settlement belonged to the press that produced it, so a reconsideration of the
  // question discards it and a walk away discards it — and the confirm press, which
  // closes this dialog on its way to publishing the next one, discards nothing.
  const lifecycle = useConfirmationLifecycle(clear);

  return (
    <div className="meridian-root-removal">
      <AlertDialog.Root onOpenChange={lifecycle.openChanged}>
        <AlertDialog.Trigger
          className="meridian-root-removal__trigger"
          disabled={reading.status === "sending"}
          aria-label={`${REMOVAL_LABEL} ${props.rootId}`}
        >
          {REMOVAL_LABEL}
        </AlertDialog.Trigger>
        {/* The portal, backdrop and popup are the primitive's, which is what puts this
            confirmation in the window's airspace: a native browser-pane view yields to
            what is registered there, and a confirmation it painted over is the one
            thing forbidden outright. */}
        <OverlayAlertDialogPopup
          backdropClassName="meridian-root-removal__backdrop"
          className="meridian-root-removal__dialog"
        >
          <AlertDialog.Title className="meridian-root-removal__title">
            {REMOVAL_QUESTION}
          </AlertDialog.Title>
          <div className="meridian-root-removal__acts">
            <AlertDialog.Close
              className="meridian-root-removal__cancel"
              onClick={lifecycle.canceled}
            >
              Keep it
            </AlertDialog.Close>
            <AlertDialog.Close
              className="meridian-root-removal__confirm"
              onClick={() => {
                send();
              }}
            >
              {REMOVAL_LABEL}
            </AlertDialog.Close>
          </div>
        </OverlayAlertDialogPopup>
      </AlertDialog.Root>
      {renderSettlement(reading, onSettled)}
    </div>
  );
}

/**
 * What the removal did, drawn beside the root it was about.
 *
 * The settled arm carries the state the wire sent and not a sentence about disk. The reply
 * answers `retired` and carries no cleanup instant, which lands on the status read
 * afterwards, so a line here claiming the files are gone would answer a question the
 * daemon did not.
 */
function renderSettlement(
  reading: RootRemovalReading,
  onSettled: () => void,
): React.JSX.Element | null {
  switch (reading.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Sending." />;
    case "settled":
      return (
        <p className="meridian-root-removal__settled" role="status">
          <span className="meridian-root-removal__state">{reading.state}</span>
          <button type="button" className="meridian-root-removal__reread" onClick={onSettled}>
            Read the roots again
          </button>
        </p>
      );
  }
}
