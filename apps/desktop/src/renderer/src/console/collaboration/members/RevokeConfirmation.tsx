import { AlertDialog } from "@base-ui/react/alert-dialog";
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
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="meridian-members__dialog-backdrop" />
        <AlertDialog.Popup className="meridian-members__dialog">
          <AlertDialog.Title className="meridian-members__dialog-title">
            Revoke this membership?
          </AlertDialog.Title>
          <AlertDialog.Description className="meridian-members__dialog-body">
            {cost ?? "The membership ends. Nothing else about the session changes."}
          </AlertDialog.Description>
          <div className="meridian-members__dialog-acts">
            <AlertDialog.Close className="meridian-members__dialog-cancel">
              Keep it
            </AlertDialog.Close>
            <AlertDialog.Close
              className="meridian-members__dialog-confirm"
              onClick={props.onConfirm}
            >
              Revoke
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
