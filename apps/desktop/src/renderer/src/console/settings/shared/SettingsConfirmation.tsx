import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";

/**
 * The tone a confirming act wears, closed at the three the settings pages use.
 *
 * A tone rather than a `className`: the caller says what the act IS and this module
 * decides what that looks like, so two pages confirming two destructive things cannot
 * end up drawn differently because one of them passed a class the other did not.
 */
export type SettingsConfirmationTone = "neutral" | "primary" | "destructive";

/** The trigger's class for each tone. Total, so a fourth tone is a compile error. */
const TRIGGER_TONE_CLASSES: Readonly<Record<SettingsConfirmationTone, string>> = {
  neutral: "meridian-settings-page__action",
  primary: "meridian-settings-page__action meridian-settings-page__action--primary",
  destructive: "meridian-settings-page__action meridian-settings-page__action--destructive",
};

/**
 * A settings act that states its consequence before it happens.
 *
 * An alert dialog rather than a plain button: it traps focus, it does not dismiss on
 * an outside press, and its description is the consequence sentence for THIS act.
 * The pattern is the members surface's `RevokeConfirmation.tsx`; what is different is
 * that this one is the settings family's own, because that component's classes belong
 * to the collaboration family's stylesheet and a view family may not reach into
 * another's (`apps/desktop/AGENTS.md`, view families are siblings).
 *
 * IT IS SHARED RATHER THAN PER PAGE. Two settings acts confirm — a restart that
 * interrupts running work, and a recovery action that moves a stuck run — and both
 * need the same three things: the consequence stated in the caller's own words, a
 * cancel that is the default, and a confirm that carries the act's tone. Written
 * twice they would drift in exactly the place it matters, which is which button is
 * focused when the dialog opens.
 *
 * THE DESCRIPTION IS PHRASING CONTENT. Base UI renders `AlertDialog.Description` as a
 * `<p>`, so a caller passes spans and text — never a paragraph or a list, which the
 * document would reject and the browser would silently re-parent.
 */
export function SettingsConfirmation(props: {
  /** The words on the button that opens this dialog. */
  readonly triggerLabel: string;
  /** What that button is called to someone who cannot see the page around it. */
  readonly triggerAriaLabel: string;
  readonly tone: SettingsConfirmationTone;
  /** Some other act is in flight, so this one cannot be opened. */
  readonly isDisabled: boolean;
  readonly title: string;
  /** The consequence, in the caller's words. Phrasing content only. */
  readonly description: ReactNode;
  /** The words on the act that does nothing. It is the dialog's default. */
  readonly keepLabel: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        className={TRIGGER_TONE_CLASSES[props.tone]}
        disabled={props.isDisabled}
        aria-label={props.triggerAriaLabel}
      >
        {props.triggerLabel}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="meridian-settings-confirm__backdrop" />
        <AlertDialog.Popup className="meridian-settings-confirm">
          <AlertDialog.Title className="meridian-settings-confirm__title">
            {props.title}
          </AlertDialog.Title>
          <AlertDialog.Description className="meridian-settings-confirm__body">
            {props.description}
          </AlertDialog.Description>
          <div className="meridian-settings-confirm__acts">
            <AlertDialog.Close className="meridian-settings-confirm__keep">
              {props.keepLabel}
            </AlertDialog.Close>
            <AlertDialog.Close
              className={`meridian-settings-confirm__confirm meridian-settings-confirm__confirm--${props.tone}`}
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
