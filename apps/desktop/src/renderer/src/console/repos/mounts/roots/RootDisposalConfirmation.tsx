// Retiring a worktree, or disposing an ephemeral clone, with what it costs stated first.
//
// THE STRONGEST INTERACTION ON THIS SCREEN, and it is built as one. An alert dialog
// rather than a button: it traps focus, it does not dismiss on an outside press, and
// its description is the consequence for THIS kind of root rather than a generic
// warning — which is the whole difference between a confirmation and a speed bump.
//
// ONE COMPONENT FOR BOTH KINDS, because the interaction is identical and only the
// sentence and the call differ. Two components would be two copies of one dialog with
// one word changed, and the word that changed is the one a person is consenting to.
//
// THE CONSEQUENCE COMES FROM THE MODEL AND IS NOT WRITTEN HERE. `root-act-model.ts`
// holds both sentences and states why they are two: a retire RECORDS a transition and
// the sweep removes files afterwards, while a clone disposal brings forward a terminal
// the clone reaches anyway. A component that composed its own sentence would be the
// second place either claim is made.
//
// AND THE SETTLEMENT RENDERS ON THE CARD, OUTSIDE THE POPUP, on `ReattachControl`'s
// reasoning: the confirm control closes the dialog, so anything drawn inside it is
// drawn into a popup that is already gone — and `worktree.retire_conflict`, the refusal
// a root held by a live run takes, would be silent.
//
// WHICH IS ALSO WHY THE DISCARD RULE IS NOT THIS MODULE'S. That same close reaches
// `onOpenChange`, so a discard keyed on it takes back the `sending` the press had just
// published; `confirmation/confirmation-lifecycle.ts` holds the two moments a discard
// belongs to, and this file wires them rather than restating them.

import { AlertDialog } from "@base-ui/react/alert-dialog";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { InlineRefusal, Nothing, OverlayAlertDialogPopup } from "../../../primitives/index.js";
import { useConfirmationLifecycle } from "../confirmation/index.js";
import { mountRefusalRecovery } from "../mount-refusal-copy.js";
import { RefusalRecovery } from "../RefusalRecovery.js";
import { useRootDisposal, type DisposalReading } from "./disposal-controller.js";
import { disposalSubjectFor, type DisposalSubject } from "./root-act-model.js";

/** What the control says, per kind. The verb is the daemon's, not a softened one. */
const DISPOSAL_VERB: Readonly<Record<DisposalSubject["kind"], string>> = {
  worktree: "Retire this root",
  "ephemeral-clone": "Dispose of this clone",
};

/** The question the confirmation asks, per kind. */
const DISPOSAL_QUESTION: Readonly<Record<DisposalSubject["kind"], string>> = {
  worktree: "Retire this execution root?",
  "ephemeral-clone": "Dispose of this clone now?",
};

export interface RootDisposalConfirmationProps {
  readonly bridge: ConsoleBridge;
  readonly kind: DisposalSubject["kind"];
  /** The root's own id. Sent verbatim; nothing about it is re-derived here. */
  readonly rootId: string;
  /** Read the section again, so the root's new state reaches the list it is drawn in. */
  readonly onSettled: () => void;
}

export function RootDisposalConfirmation(props: RootDisposalConfirmationProps): React.JSX.Element {
  const subject = disposalSubjectFor(props.kind, props.rootId);
  const { reading, send, clear } = useRootDisposal(props.bridge, subject);
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
          aria-label={`${DISPOSAL_VERB[props.kind]} ${props.rootId}`}
        >
          {DISPOSAL_VERB[props.kind]}
        </AlertDialog.Trigger>
        {/* The popup shell is the primitive's, which is what puts this confirmation in
            the window's airspace (`Spec-023 §Console Design (Meridian)` 12.3): a native
            browser-pane view yields to what is registered there, and a confirmation it
            painted over is the one thing 12.3 forbids outright. */}
        <OverlayAlertDialogPopup
          backdropClassName="meridian-root-disposal__backdrop"
          className="meridian-root-disposal__dialog"
        >
          <AlertDialog.Title className="meridian-root-disposal__title">
            {DISPOSAL_QUESTION[props.kind]}
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
              {DISPOSAL_VERB[props.kind]}
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
 * THE SETTLED ARM CARRIES THE STATE THE WIRE SENT AND NOT A SENTENCE ABOUT DISK. Both
 * replies answer `retired` and neither carries a cleanup instant — that lands on the
 * status read afterwards — so a line here claiming the files are gone would be the
 * renderer answering a question the daemon deliberately did not.
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
    case "refused": {
      const recovery = mountRefusalRecovery(reading.refusal.code);
      return (
        <InlineRefusal
          code={reading.refusal.code}
          detail={reading.refusal.detail}
          action={recovery === undefined ? undefined : <RefusalRecovery recovery={recovery} />}
        />
      );
    }
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
