import type { MembershipUpdate } from "@ai-sidekicks/contracts";
import { Chip, InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import { MembershipActionsMenu } from "./MembershipActionsMenu.js";
import { MEMBERSHIP_ROLE_NOTES, type MembershipRow } from "./members-model.js";
import { membershipRefusalRemedy } from "./members-model.js";

export function MembershipLedgerRow(props: {
  readonly row: MembershipRow;
  readonly isLastOwner: boolean;
  /**
   * True while the control plane is unreachable.
   *
   * The row keeps every fact it has and offers no control, because a press that
   * cannot leave the machine is not an offer. Deliberately NOT a permission: whether
   * this caller may change a membership stays the daemon's to answer, and it answers
   * with `membership.permission_denied` where the answer is no.
   */
  readonly isReadOnly: boolean;
  /** This row's own change is the one in flight. */
  readonly isPending: boolean;
  /** Some row's change is in flight — this one's, or a neighbour's. */
  readonly isAnyPending: boolean;
  readonly refusal: { readonly code: string; readonly detail: string } | undefined;
  readonly onApply: (update: MembershipUpdate) => void;
  readonly onDismissRefusal: () => void;
}): React.JSX.Element {
  const { row } = props;
  const notes = row.role === undefined ? undefined : MEMBERSHIP_ROLE_NOTES[row.role];
  return (
    <div className="meridian-members__row">
      <div className="meridian-members__row-facts">
        <WireFigure value={row.participantId} />
        {row.role === undefined ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="Role not read"
            detail="No event this console projected stated this membership's role."
          />
        ) : (
          <Chip label={row.role} mono tone={row.role === "owner" ? "accent" : "neutral"} />
        )}
        {row.state === undefined ? null : (
          <Chip
            label={row.state}
            mono
            tone={row.state === "suspended" || row.state === "revoked" ? "attention" : "neutral"}
          />
        )}
      </div>

      {notes === undefined ? null : <p className="meridian-members__row-reach">{notes.reach}</p>}

      {props.isLastOwner ? (
        <p className="meridian-members__row-note">
          This is the last owner. Ownership has to be transferred before this membership can be
          given up.
        </p>
      ) : null}

      {props.isReadOnly ? null : row.membershipId === undefined ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="No controls for this row"
          detail="Changing a membership names its membership id. No live read returns one alongside a participant, and neither the session's event log nor the membership roster read has supplied one for this row."
        />
      ) : (
        <MembershipActionsMenu
          row={row}
          isPending={props.isPending}
          isAnyPending={props.isAnyPending}
          onApply={props.onApply}
        />
      )}

      {props.refusal === undefined ? null : (
        <InlineRefusal
          code={props.refusal.code}
          detail={`${props.refusal.detail}${remedySuffix(props.refusal.code)}`}
          action={
            <button
              type="button"
              className="meridian-members__refusal-dismiss"
              onClick={props.onDismissRefusal}
            >
              Dismiss
            </button>
          }
        />
      )}
    </div>
  );
}

export function remedySuffix(code: string): string {
  const remedy = membershipRefusalRemedy(code);
  return remedy === undefined ? "" : ` ${remedy}`;
}
