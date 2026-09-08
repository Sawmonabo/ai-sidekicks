import { Chip, InlineRefusal, WireFigure, formatDateTime } from "../../primitives/index.js";
import type { ServedInvite } from "../../bridge/index.js";
import type { ShellMutationBlock } from "../../store/index.js";

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
  /**
   * Why the shell closes the revoke, or `undefined` while nothing does.
   *
   * The control carries it as its disabled reason; the SENTENCE is said once for the
   * whole ledger by `SentInvitesLedger.tsx`, because the cause is the window's and one
   * copy per invitation would be the same words repeated down a list.
   */
  readonly revokeBlock: ShellMutationBlock | undefined;
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
          disabled={props.isAnyRevoking || props.revokeBlock !== undefined}
          title={props.revokeBlock?.detail}
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
