// The question a palette prefill asks before it takes somebody's line.
//
// An alert dialog rather than an inline hint, on the console's own precedent
// (`collaboration/members/RevokeConfirmation.tsx`): it traps focus, it does not
// dismiss on an outside press, and its description states the cost of the act rather
// than restating the act. A browser `confirm()` is not a candidate — it is a main
// process modal this console does not style, cannot test, and cannot render in an
// auxiliary window.
//
// IT IS CONTROLLED AND CARRIES NO TRIGGER. The act that raises it is a command-palette
// row, which is a surface away from here, so the open state is the composer's own and
// the dialog renders nothing at all while nothing is pending.
//
// THE TEXT THAT WOULD GO IS SHOWN, and it is shown as the participant's own bytes in
// a preformatted block rather than paraphrased or counted: "your unsent message" is a
// description of a thing, and what a person needs to decide is the thing itself.

import { AlertDialog } from "@base-ui/react/alert-dialog";

import type { WorkflowStartPrefillSurface } from "./prefill.js";

/** The pending replace decision for one composer, or nothing where none is pending. */
export function WorkflowStartPrefillConfirm(
  props: WorkflowStartPrefillSurface,
): React.JSX.Element | null {
  const { displacedText, replaceLine, keepLine } = props;
  if (displacedText === undefined) {
    return null;
  }
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        // Every dismissal this dialog admits — Escape, the close control — keeps the
        // line. Only the explicit act replaces it.
        if (!open) {
          keepLine();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="meridian-workflow-start__backdrop" />
        <AlertDialog.Popup className="meridian-workflow-start__dialog">
          <AlertDialog.Title className="meridian-workflow-start__dialog-title">
            Replace what you have typed?
          </AlertDialog.Title>
          <AlertDialog.Description className="meridian-workflow-start__dialog-body">
            Starting a workflow from the palette types the command onto this line, and this composer
            already holds unsent text. Replacing it cannot be undone.
          </AlertDialog.Description>
          <pre className="meridian-workflow-start__displaced">{displacedText}</pre>
          <div className="meridian-workflow-start__dialog-acts">
            <AlertDialog.Close className="meridian-workflow-start__dialog-keep">
              Keep what I typed
            </AlertDialog.Close>
            {/*
              A plain button and deliberately not a `Close`: closing is what KEEPS the
              line, so routing the replace through the same part would run both
              answers to one question and leave which one won to event ordering. This
              act ends the decision by settling it, and the dialog unmounts with it.
            */}
            <button
              type="button"
              className="meridian-workflow-start__dialog-replace"
              onClick={replaceLine}
            >
              Replace it
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
