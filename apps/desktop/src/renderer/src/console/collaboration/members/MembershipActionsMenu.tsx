import { Menu } from "@base-ui/react/menu";
import { useState } from "react";

import type { MembershipId, MembershipUpdate } from "@ai-sidekicks/contracts";

import { OverlayMenuPopup } from "../../primitives/index.js";
import type { ShellMutationBlock } from "../../store/index.js";

import {
  MEMBERSHIP_ACTIONS,
  MEMBERSHIP_ACTION_NOTES,
  MEMBERSHIP_ROLES,
  type ArgumentFreeMembershipAction,
  type MembershipRow,
} from "./members-model.js";
import { RevokeConfirmation } from "./RevokeConfirmation.js";

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
  /** This row's own change is the one in flight. */
  readonly isPending: boolean;
  /**
   * Some row's change is in flight — this one's, or a neighbour's.
   *
   * Both controls close on it rather than on `isPending` alone, because the
   * coordinator behind them applies one mutation at a time: a neighbour's control
   * left open offers an act the surface would answer with a refusal about a row
   * the person did not press. The pending row keeps its own in-flight wording, so
   * "not now" and "this is the one running" stay two different states on screen.
   */
  readonly isAnyPending: boolean;
  /**
   * Why the shell closes every one of these acts, or `undefined` while nothing does.
   *
   * Both controls close on it for the reason `isAnyPending` closes them: an act the
   * surface would refuse should not be offered. Its SENTENCE is the members section's,
   * said once above everything under that heading.
   */
  readonly updateBlock: ShellMutationBlock | undefined;
  readonly onApply: (update: MembershipUpdate) => void;
}): React.JSX.Element {
  const { row } = props;
  // One predicate for both controls, so the menu and the confirmation cannot disagree
  // about whether this row is actionable.
  const isClosed = props.isAnyPending || props.updateBlock !== undefined;
  // THE MENU IS CONTROLLED FOR ONE CASE: a close that arrives while it is open. The
  // trigger's `disabled` reaches the trigger and nothing else — the items of a menu
  // someone had already opened stayed pressable, and a press reached the dispatch-time
  // guard and did nothing, silently. Adjusting state during render is React's own
  // prescription for a value derived from props, and it commits before the closed menu
  // could paint once; the menu stays closed when the acts come back, since reopening
  // it would be a menu nobody asked for.
  const [isOpen, setIsOpen] = useState(false);
  if (isOpen && isClosed) {
    setIsOpen(false);
  }
  // Non-null by the caller's guard; bound once so every arm below reads the same
  // value rather than re-asserting it four times.
  const membershipId = (row.membershipId ?? "") as MembershipId;
  const isActive = row.state === "active";
  return (
    <div className="meridian-members__row-acts">
      <Menu.Root open={isOpen} onOpenChange={setIsOpen}>
        <Menu.Trigger
          className="meridian-members__manage"
          disabled={isClosed}
          title={props.updateBlock?.detail}
          aria-label={`Manage the membership of ${row.participantId}`}
        >
          {props.isPending ? "Applying…" : "Manage"}
        </Menu.Trigger>
        {/* The anchored part of the menu is the primitive's, which is what puts it
            in the window's airspace (`Spec-023 §Console Design (Meridian)` 12.3): a
            row that mounted its own portal would be a menu a native browser-pane view
            paints over and takes the presses of. */}
        <OverlayMenuPopup
          positionerClassName="meridian-members__menu-positioner"
          sideOffset={4}
          className="meridian-members__menu"
        >
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
        </OverlayMenuPopup>
      </Menu.Root>

      <RevokeConfirmation
        row={row}
        isClosed={isClosed}
        onConfirm={() => {
          props.onApply({ membershipId, action: "revoke" });
        }}
      />
    </div>
  );
}
