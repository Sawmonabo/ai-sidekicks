import { AlertDialog } from "@base-ui/react/alert-dialog";

import { OverlayAlertDialogPopup } from "../../primitives/index.js";
import {
  MEMBERSHIP_ACTION_NOTES,
  MEMBERSHIP_ROLE_NOTES,
  type MembershipRow,
} from "./members-model.js";

/**
 * Revoking, and what it costs, stated before it happens.
 *
 * An alert dialog rather than a menu item: it traps focus, it has no default
 * dismissal on outside press, and its description is the consequence sentence for
 * THIS row's role. A role whose revocation the contract gives no named cost gets
 * the plain sentence rather than an invented one.
 */
export function RevokeConfirmation(props: {
  readonly row: MembershipRow;
  /** Some row's change is in flight, so this row's confirmation cannot be opened. */
  readonly isAnyPending: boolean;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const cost =
    props.row.role === undefined ? undefined : MEMBERSHIP_ROLE_NOTES[props.row.role].revocationCost;
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        className="meridian-members__revoke"
        disabled={props.isAnyPending}
        aria-label={`Revoke the membership of ${props.row.participantId}`}
      >
        {MEMBERSHIP_ACTION_NOTES.revoke.label}
      </AlertDialog.Trigger>
      {/* The popup shell is the primitive's, which is what puts this confirmation in
          the window's airspace (`Spec-023 §Console Design (Meridian)` 12.3): a native
          browser-pane view yields to what is registered there, and a confirmation it
          painted over is the one thing 12.3 forbids outright. */}
      <OverlayAlertDialogPopup
        backdropClassName="meridian-members__dialog-backdrop"
        className="meridian-members__dialog"
      >
        <AlertDialog.Title className="meridian-members__dialog-title">
          Revoke this membership?
        </AlertDialog.Title>
        <AlertDialog.Description className="meridian-members__dialog-body">
          {cost ?? "The membership ends. Nothing else about the session changes."}
        </AlertDialog.Description>
        <div className="meridian-members__dialog-acts">
          <AlertDialog.Close className="meridian-members__dialog-cancel">Keep it</AlertDialog.Close>
          <AlertDialog.Close className="meridian-members__dialog-confirm" onClick={props.onConfirm}>
            Revoke
          </AlertDialog.Close>
        </div>
      </OverlayAlertDialogPopup>
    </AlertDialog.Root>
  );
}
