import { Chip, InlineRefusal, WireFigure, formatDateTime } from "../../primitives/index.js";
import type { ServedInvite } from "../../bridge/index.js";

/**
 * One invitation.
 *
 * The revoke control appears only on a row that is still pending, because there
 * is nothing to revoke on a row that has already settled — that is the row's own
 * state saying so, not a control hidden to prevent a refusal.
 */
export function InviteLedgerRow(props: {
  readonly invite: ServedInvite;
  /** This row is the one being revoked. */
  readonly isRevoking: boolean;
  /** Some row is being revoked — this one, or a neighbour. */
  readonly isAnyRevoking: boolean;
  readonly refusal: { readonly code: string; readonly detail: string } | undefined;
  readonly onRevoke?: () => void;
  readonly onDismissRefusal?: () => void;
}): React.JSX.Element {
  const { invite, onRevoke, onDismissRefusal } = props;
  return (
    <div className="meridian-invites__row">
      <div className="meridian-invites__row-facts">
        <WireFigure value={invite.inviteId} />
        <Chip label={invite.state} mono tone={invite.state === "pending" ? "accent" : "neutral"} />
        <WireFigure value={formatDateTime(invite.expiresAt)} title={invite.expiresAt} />
      </div>
      {onRevoke === undefined ? null : (
        <button
          type="button"
          className="meridian-invites__row-action"
          onClick={onRevoke}
          disabled={props.isAnyRevoking}
          aria-label={`Revoke invitation ${invite.inviteId}`}
        >
          {props.isRevoking ? "Revoking…" : "Revoke"}
        </button>
      )}
      {props.refusal === undefined ? null : (
        <InlineRefusal
          code={props.refusal.code}
          detail={props.refusal.detail}
          action={
            onDismissRefusal === undefined ? undefined : (
              <button
                type="button"
                className="meridian-invites__refusal-dismiss"
                onClick={onDismissRefusal}
              >
                Dismiss
              </button>
            )
          }
        />
      )}
    </div>
  );
}
