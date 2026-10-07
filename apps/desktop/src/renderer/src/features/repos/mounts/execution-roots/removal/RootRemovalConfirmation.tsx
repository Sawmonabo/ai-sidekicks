// Removing a worktree, asked as an alert dialog (it traps focus and does not dismiss on an
// outside press). The settlement renders on the card, outside the popup, because the confirm
// control closes the dialog. For the same reason the discard rule lives in
// `useConfirmationLifecycle`, which this file wires.

import "./RootRemovalConfirmation.css";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { OverlayAlertDialogPopup } from "#renderer/components/OverlayPopups/OverlayAlertDialogPopup.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { BUTTON_CLASS_NAME } from "../../button-class.js";
import { useConfirmationLifecycle } from "../../hooks/useConfirmationLifecycle.js";
import { type RootRemovalOperations, type RootRemovalReading } from "./controller.js";
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
}

/** The alert dialog that asks before removing one worktree. */
export function RootRemovalConfirmation(props: RootRemovalConfirmationProps): React.JSX.Element {
  const { reading, send, clear } = useRootRemoval(props.bridge, props.rootId, props.operations);
  // The settlement belongs to the press that produced it: reconsidering or walking away
  // discards it, and the confirm press, which closes the dialog, discards nothing.
  const lifecycle = useConfirmationLifecycle(clear);

  return (
    <div className="meridian-root-removal">
      <AlertDialog.Root onOpenChange={lifecycle.openChanged}>
        <AlertDialog.Trigger
          className={BUTTON_CLASS_NAME}
          disabled={reading.status === "sending"}
          aria-label={`${REMOVAL_LABEL} ${props.rootId}`}
        >
          {REMOVAL_LABEL}
        </AlertDialog.Trigger>
        {/* The primitive's portal puts this in the window's airspace, where a native browser-pane
            view yields to it. */}
        <OverlayAlertDialogPopup
          backdropClassName="meridian-dialog__backdrop"
          className="meridian-dialog"
        >
          <AlertDialog.Title className="meridian-dialog__title">
            {REMOVAL_QUESTION}
          </AlertDialog.Title>
          <div className="meridian-dialog__actions">
            <AlertDialog.Close className={BUTTON_CLASS_NAME} onClick={lifecycle.canceled}>
              Keep it
            </AlertDialog.Close>
            <AlertDialog.Close
              className={`${BUTTON_CLASS_NAME} meridian-action-button--destructive`}
              onClick={() => {
                send();
              }}
            >
              {REMOVAL_LABEL}
            </AlertDialog.Close>
          </div>
        </OverlayAlertDialogPopup>
      </AlertDialog.Root>
      {renderSettlement(reading)}
    </div>
  );
}

/**
 * What the removal did, drawn beside the root. The settled arm carries the state the wire sent,
 * not a sentence about disk: the reply carries no cleanup instant, so claiming the files are
 * gone would answer a question the daemon did not.
 */
function renderSettlement(reading: RootRemovalReading): React.JSX.Element | null {
  switch (reading.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Sending." />;
    case "refused":
      return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
    case "settled":
      return (
        <p className="meridian-form__settlement meridian-form__settlement--inline" role="status">
          {codeWords(reading.state)}
        </p>
      );
  }
}
