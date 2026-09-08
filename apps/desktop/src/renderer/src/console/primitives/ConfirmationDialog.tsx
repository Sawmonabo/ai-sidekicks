import { AlertDialog } from "@base-ui/react/alert-dialog";
import { type ReactNode, useState } from "react";

import { OverlayAlertDialogPopup } from "./overlay/OverlayAlertDialogPopup.js";

/**
 * The tone a confirming act wears, closed at three.
 *
 * A tone rather than a `className` for the CONFIRMING button: the caller says what
 * the act IS and this module decides what that looks like, so two surfaces confirming
 * two destructive things cannot end up drawn differently because one of them passed a
 * class the other did not. That was the whole argument for a shared tone table, and it
 * is the half that generalises — see {@link ConfirmationDialog} on the half that does
 * not.
 */
export type ConfirmationTone = "neutral" | "primary" | "destructive";

/** The confirming button's class for each tone. Total, so a fourth tone is an error. */
const CONFIRM_TONE_CLASSES: Readonly<Record<ConfirmationTone, string>> = {
  neutral: "meridian-confirm__confirm",
  primary: "meridian-confirm__confirm meridian-confirm__confirm--primary",
  destructive: "meridian-confirm__confirm meridian-confirm__confirm--destructive",
};

/**
 * An act that states its consequence before it happens.
 *
 * An alert dialog rather than a plain button: it traps focus, it does not dismiss on
 * an outside press, and its description is the consequence sentence for THIS act. The
 * cancel is the dialog's default, and it is first in the DOM so a keyboard reaches it
 * before the act it undoes.
 *
 * WHY IT IS A PRIMITIVE AND NOT A SETTINGS COMPONENT. Two families were composing the
 * same eight Base UI parts — root, portal, backdrop, popup, title, description, and
 * the two closes — and a view family may not reach into another's, so the settings
 * copy could not import the collaboration one and each carried its own. The parts are
 * the same in both because the pattern is: what differs is the copy and which row the
 * trigger sits in. So the composition lives here, at the lowest family both callers
 * already import, and each caller keeps only what is its own.
 *
 * THE TRIGGER'S CLASS IS THE CALLER'S AND THE CONFIRM'S IS NOT, which looks
 * inconsistent and is the honest split. The trigger is a control in the caller's own
 * row — a compact members row-action, a settings page action — and it has to look like
 * its neighbours or it reads as a different kind of control; measured, the two are
 * different sizes, different weights, and one has a disabled treatment the other has
 * no state for. The confirming button is inside a portal, over everything, in a dialog
 * that belongs to no row, and there is nothing for it to match but itself.
 *
 * THE DESCRIPTION IS PHRASING CONTENT. Base UI renders `AlertDialog.Description` as a
 * `<p>`, so a caller passes spans and text — never a paragraph or a list, which the
 * document would reject and the browser would silently re-parent.
 *
 * THE POPUP SHELL IS `overlay/OverlayAlertDialogPopup.tsx`'S, and that is what puts
 * every confirming act in the window's airspace (`Spec-023 §Console Design (Meridian)`
 * 12.3): a native browser-pane view yields to what is registered there, and a
 * confirmation it painted over is the one thing 12.3 forbids outright. Composing the
 * portal, the backdrop and the popup here instead would register nothing, and the
 * three callers below would each lose the yield without a line of theirs changing —
 * which is why the shell is taken rather than restated.
 */
export function ConfirmationDialog(props: {
  /** The words on the button that opens this dialog. */
  readonly triggerLabel: string;
  /** What that button is called to someone who cannot see the page around it. */
  readonly triggerAriaLabel: string;
  /** The caller's own row-control class for that button. See the note above. */
  readonly triggerClassName: string;
  /**
   * Some other act is in flight, so this one cannot be opened — and, arriving while
   * the dialog is open, closes it.
   */
  readonly isDisabled: boolean;
  readonly title: string;
  /** The consequence, in the caller's words. Phrasing content only. */
  readonly description: ReactNode;
  /** The words on the act that does nothing. It is the dialog's default. */
  readonly keepLabel: string;
  readonly confirmLabel: string;
  /** What the confirming act IS, which decides how it is drawn. */
  readonly tone: ConfirmationTone;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  if (isOpen && props.isDisabled) {
    // A disable that arrives while the dialog is open closes it. The act is no longer
    // available, and the reason is said by the caller's own surface — a section's
    // sentence, a page's shell line — which an open modal covers; a disabled confirm
    // inside the modal would be a dead control over an explanation nobody can read.
    // Adjusted during render rather than in an effect, so no frame commits the open
    // dialog beside the disabled trigger, and held as state rather than derived so a
    // later re-enable does not reopen a dialog nobody asked for.
    setIsOpen(false);
  }
  return (
    <AlertDialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <AlertDialog.Trigger
        className={props.triggerClassName}
        disabled={props.isDisabled}
        aria-label={props.triggerAriaLabel}
      >
        {props.triggerLabel}
      </AlertDialog.Trigger>
      <OverlayAlertDialogPopup
        backdropClassName="meridian-confirm__backdrop"
        className="meridian-confirm"
      >
        <AlertDialog.Title className="meridian-confirm__title">{props.title}</AlertDialog.Title>
        <AlertDialog.Description className="meridian-confirm__body">
          {props.description}
        </AlertDialog.Description>
        <div className="meridian-confirm__acts">
          <AlertDialog.Close className="meridian-confirm__keep">
            {props.keepLabel}
          </AlertDialog.Close>
          <AlertDialog.Close className={CONFIRM_TONE_CLASSES[props.tone]} onClick={props.onConfirm}>
            {props.confirmLabel}
          </AlertDialog.Close>
        </div>
      </OverlayAlertDialogPopup>
    </AlertDialog.Root>
  );
}
