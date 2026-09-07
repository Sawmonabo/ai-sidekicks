import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";

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
 */
export function ConfirmationDialog(props: {
  /** The words on the button that opens this dialog. */
  readonly triggerLabel: string;
  /** What that button is called to someone who cannot see the page around it. */
  readonly triggerAriaLabel: string;
  /** The caller's own row-control class for that button. See the note above. */
  readonly triggerClassName: string;
  /** Some other act is in flight, so this one cannot be opened. */
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
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        className={props.triggerClassName}
        disabled={props.isDisabled}
        aria-label={props.triggerAriaLabel}
      >
        {props.triggerLabel}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="meridian-confirm__backdrop" />
        <AlertDialog.Popup className="meridian-confirm">
          <AlertDialog.Title className="meridian-confirm__title">{props.title}</AlertDialog.Title>
          <AlertDialog.Description className="meridian-confirm__body">
            {props.description}
          </AlertDialog.Description>
          <div className="meridian-confirm__acts">
            <AlertDialog.Close className="meridian-confirm__keep">
              {props.keepLabel}
            </AlertDialog.Close>
            <AlertDialog.Close
              className={CONFIRM_TONE_CLASSES[props.tone]}
              onClick={props.onConfirm}
            >
              {props.confirmLabel}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
