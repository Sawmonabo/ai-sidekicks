// Retiring a worktree, with what it costs stated first.
//
// The strongest interaction on this screen, and it is built as one. An alert dialog rather
// than a button: it traps focus, it does not dismiss on an outside press, and its
// description is the consequence of retiring rather than a generic warning.
//
// The consequence comes from the model and is not written here.
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
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { Nothing, OverlayAlertDialogPopup } from "@renderer/console/primitives/index.js";
import { useConfirmationLifecycle } from "../hooks/useConfirmationLifecycle.js";
import { type DisposalOperations, type DisposalReading } from "./disposal-controller.js";
import { useRootDisposal } from "./hooks/useRootDisposal.js";
import { disposalSubjectFor } from "./disposal-subject.js";

/** What the control says. The verb is the daemon's, not a softened one. */
const DISPOSAL_VERB = "Retire this root";

/** The question the confirmation asks. */
const DISPOSAL_QUESTION = "Retire this execution root?";

/** What the retire confirmation is bound to: one worktree, and the call it sends. */
export interface RootDisposalConfirmationProps {
  readonly bridge: ConsoleBridge;
  /** The retire this confirmation sends. */
  readonly operations: DisposalOperations;
  /** The worktree's own id. Sent verbatim; nothing about it is re-derived here. */
  readonly rootId: string;
  /** Read the section again, so the root's new state reaches the list it is drawn in. */
  readonly onSettled: () => void;
}

/** The alert dialog that retires one worktree after stating what the retirement costs. */
export function RootDisposalConfirmation(props: RootDisposalConfirmationProps): React.JSX.Element {
  const subject = disposalSubjectFor(props.rootId);
  const { reading, send, clear } = useRootDisposal(props.bridge, subject, props.operations);
  const { onSettled } = props;
  // The settlement belonged to the press that produced it, so a reconsideration of the
  // question discards it and a walk away discards it — and the confirm press, which
  // closes this dialog on its way to publishing the next one, discards nothing.
  const lifecycle = useConfirmationLifecycle(clear);

  return (
    <div className="meridian-root-disposal">
      <AlertDialog.Root onOpenChange={lifecycle.openChanged}>
        <AlertDialog.Trigger
          className="meridian-root-disposal__trigger"
          disabled={reading.status === "sending"}
          aria-label={`${DISPOSAL_VERB} ${props.rootId}`}
        >
          {DISPOSAL_VERB}
        </AlertDialog.Trigger>
        {/* The popup shell is the primitive's, which is what puts this confirmation in
            the window's airspace: a native browser-pane view yields to what is
            registered there, and a confirmation it painted over is the one thing
            forbidden outright. */}
        <OverlayAlertDialogPopup
          backdropClassName="meridian-root-disposal__backdrop"
          className="meridian-root-disposal__dialog"
        >
          <AlertDialog.Title className="meridian-root-disposal__title">
            {DISPOSAL_QUESTION}
          </AlertDialog.Title>
          <AlertDialog.Description className="meridian-root-disposal__body">
            {subject.consequence}
          </AlertDialog.Description>
          <div className="meridian-root-disposal__acts">
            <AlertDialog.Close
              className="meridian-root-disposal__cancel"
              onClick={lifecycle.cancelled}
            >
              Keep it
            </AlertDialog.Close>
            <AlertDialog.Close
              className="meridian-root-disposal__confirm"
              onClick={() => {
                send();
              }}
            >
              {DISPOSAL_VERB}
            </AlertDialog.Close>
          </div>
        </OverlayAlertDialogPopup>
      </AlertDialog.Root>
      {renderSettlement(reading, onSettled)}
    </div>
  );
}

/**
 * What the disposal did, drawn beside the root it was about.
 *
 * The settled arm carries the state the wire sent and not a sentence about disk. The reply
 * answers `retired` and carries no cleanup instant, which lands on the status read
 * afterwards, so a line here claiming the files are gone would answer a question the
 * daemon did not.
 */
function renderSettlement(
  reading: DisposalReading,
  onSettled: () => void,
): React.JSX.Element | null {
  switch (reading.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Sending." />;
    case "settled":
      return (
        <p className="meridian-root-disposal__settled" role="status">
          <span className="meridian-root-disposal__state">{reading.state}</span>
          <button type="button" className="meridian-root-disposal__reread" onClick={onSettled}>
            Read the roots again
          </button>
        </p>
      );
  }
}
