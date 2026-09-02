// The controls one membership row offers, and the confirmation the destructive one
// opens.
//
// Split out of the ledger beside it because the two are different subjects: the
// ledger decides WHICH rows exist and what each states, and this decides what a
// person can do to one and what they are told before they do it. Both are Base UI
// compositions under Meridian tokens, and the accessibility they rest on —
// `aria-haspopup` / `aria-expanded`, roving focus, typeahead, Escape, outside
// press, focus return, the dialog's focus trap — is the library's rather than
// hand-rolled here.
//
// ELIGIBILITY IS THE DAEMON'S. Nothing below computes permission. The one thing a
// control gates on is a fact printed on the row it belongs to, and the caller's
// authority is `membership.permission_denied`, rendered where it is raised.

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";

import type { MembershipId, MembershipUpdate } from "@ai-sidekicks/contracts";

import {
  MEMBERSHIP_ACTIONS,
  MEMBERSHIP_ACTION_NOTES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_ROLE_NOTES,
  type ArgumentFreeMembershipAction,
  type MembershipRow,
} from "./members-model.js";

/**
 * The acts the menu itself carries, derived from the vocabulary rather than typed
 * out beside it.
 *
 * Two are excluded and each for its own reason: `change_role` is not one item but
 * one per candidate role, and the destructive act opens a confirmation instead of
 * firing from a menu press. Filtering by `isDestructive` rather than by naming
 * `revoke` means a second destructive act would arrive in the confirmation path by
 * default, which is the safe direction.
 */
const LIFECYCLE_MENU_ACTIONS: readonly ArgumentFreeMembershipAction[] = MEMBERSHIP_ACTIONS.filter(
  (action): action is ArgumentFreeMembershipAction =>
    action !== "change_role" && !MEMBERSHIP_ACTION_NOTES[action].isDestructive,
);

/**
 * The four acts, behind one per-row control.
 *
 * Base UI's menu owns the trigger's `aria-haspopup` / `aria-expanded`, the popup's
 * roles, arrow-key navigation, typeahead, Escape, outside press, and returning
 * focus to the trigger on close. Revoke is the one act that does not open from
 * here directly: it opens a confirmation, because it is the one act the opposite
 * control does not undo.
 */
export function MembershipActionsMenu(props: {
  readonly row: MembershipRow;
  readonly isPending: boolean;
  readonly onApply: (update: MembershipUpdate) => void;
}): React.JSX.Element {
  const { row } = props;
  // Non-null by the caller's guard; bound once so every arm below reads the same
  // value rather than re-asserting it four times.
  const membershipId = (row.membershipId ?? "") as MembershipId;
  const isActive = row.state === "active";
  return (
    <div className="meridian-members__row-acts">
      <Menu.Root>
        <Menu.Trigger
          className="meridian-members__manage"
          disabled={props.isPending}
          aria-label={`Manage the membership of ${row.participantId}`}
        >
          {props.isPending ? "Applying…" : "Manage"}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="meridian-members__menu-positioner" sideOffset={4}>
            <Menu.Popup className="meridian-members__menu">
              {MEMBERSHIP_ROLES.filter(
                (candidate) =>
                  candidate !== row.role &&
                  // Owner elevation is offered only against an active membership,
                  // which is a fact printed on this row — not a permission this
                  // renderer worked out about the caller.
                  (candidate !== "owner" || isActive),
              ).map((candidate) => (
                <Menu.Item
                  key={candidate}
                  className="meridian-members__menu-item"
                  onClick={() => {
                    props.onApply({ membershipId, action: "change_role", newRole: candidate });
                  }}
                >
                  {`Make ${candidate}`}
                </Menu.Item>
              ))}
              {LIFECYCLE_MENU_ACTIONS.map((action) => (
                <Menu.Item
                  key={action}
                  className="meridian-members__menu-item"
                  onClick={() => {
                    props.onApply({ membershipId, action });
                  }}
                >
                  {MEMBERSHIP_ACTION_NOTES[action].label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <RevokeConfirmation
        row={row}
        isPending={props.isPending}
        onConfirm={() => {
          props.onApply({ membershipId, action: "revoke" });
        }}
      />
    </div>
  );
}

/**
 * Revoking, and what it costs, stated before it happens.
 *
 * An alert dialog rather than a menu item: it traps focus, it has no default
 * dismissal on outside press, and its description is the consequence sentence for
 * THIS row's role. A role whose revocation the contract gives no named cost gets
 * the plain sentence rather than an invented one.
 */
function RevokeConfirmation(props: {
  readonly row: MembershipRow;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const cost =
    props.row.role === undefined ? undefined : MEMBERSHIP_ROLE_NOTES[props.row.role].revocationCost;
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        className="meridian-members__revoke"
        disabled={props.isPending}
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
