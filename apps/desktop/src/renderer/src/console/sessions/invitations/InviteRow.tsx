import type { ServedInvite } from "../../bridge/index.js";
import { Chip, WireFigure, formatDateTime } from "../../primitives/index.js";

/**
 * One invitation.
 *
 * The action is one button whose label is the act, because both acts this shelf
 * has — setting aside and bringing back — are local and reversible, and a control
 * that is safe to press twice needs no confirmation between the presses.
 *
 * The expiry carries its DATE. This shelf has no day divider, so the ledger's
 * date-free clock reading would render two invitations expiring days apart
 * identically — while the empty-state copy beside it promises the date the
 * invitation stops working. The raw instant stays on `title` as the verbatim wire
 * value, but it is hover-only and reaches nobody reading with a keyboard or a
 * screen reader, so it is a second copy rather than the answer.
 */
export function InviteRow(props: {
  readonly invite: ServedInvite;
  readonly actionLabel: string;
  readonly onAct: () => void;
}): React.JSX.Element {
  const { invite } = props;
  return (
    <div className="meridian-invite-shelf__row">
      <div className="meridian-invite-shelf__row-facts">
        <WireFigure value={invite.inviteId} />
        <Chip label={invite.state} mono />
        <WireFigure value={formatDateTime(invite.expiresAt)} title={invite.expiresAt} />
      </div>
      <button type="button" className="meridian-invite-shelf__row-action" onClick={props.onAct}>
        {props.actionLabel}
      </button>
    </div>
  );
}
