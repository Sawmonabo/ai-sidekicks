// The sent-invite ledger's rows, and the four absences it renders instead of them.
//
// Split out of `SentInvites.tsx` because the two answer different questions. That
// module owns the READ and the REVOKE — a bridge call, a mutation coordinator, a
// stamped outcome — and this owns what a person sees once both have settled. Neither
// holds any state of the other's: every value here arrives as a prop, which is what
// lets a case drive the four absences without a bridge at all.
//
// THE REVOKE CONTROL APPEARS ONLY ON A PENDING ROW. There is nothing to revoke on a
// row that has already settled — that is the row's own state saying so, and not a
// control hidden to prevent a refusal.

import { InlineRefusal, Nothing, formatCount } from "../../primitives/index.js";
import { SETTLED_INVITE_VISIBLE_CAP } from "../../core/index.js";
import { type InviteLedger, type LedgerReading } from "./invite-ledger.js";
import { InviteLedgerRow } from "./InviteLedgerRow.js";

export function SentInvitesLedger(props: {
  readonly sessionId: string | undefined;
  readonly reading: LedgerReading | undefined;
  readonly ledger: InviteLedger | undefined;
  readonly pendingRevokeKey: string | undefined;
  readonly refusalByInviteId: Readonly<
    Record<string, { readonly code: string; readonly detail: string }>
  >;
  readonly onRevoke: (inviteId: string) => void;
  readonly onDismissRefusal: (inviteId: string) => void;
}): React.JSX.Element {
  if (props.sessionId === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No invitations have been read."
        detail="The invites read is scoped to a session, and this section is not holding one — so it has not asked."
      />
    );
  }
  if (props.reading === undefined) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading this session's invitations." />
    );
  }
  // A call that produced NO outcome and one that produced a refusing outcome render
  // the same way, and deliberately so: both are the port declining to answer, and
  // the only fact a person needs from either is the code and the sentence.
  if (props.reading.kind === "unreadable") {
    return <InlineRefusal {...props.reading.refusal} />;
  }
  if (props.reading.outcome.status === "unavailable") {
    return (
      <InlineRefusal code={props.reading.outcome.code} detail={props.reading.outcome.detail} />
    );
  }
  const ledger = props.ledger ?? { pending: [], settled: [] };
  if (ledger.pending.length === 0 && ledger.settled.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="Nobody has been invited to this session."
        detail="An invitation appears here with the role it grants and the date it stops working."
      />
    );
  }
  return (
    <>
      {ledger.pending.length === 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="No invitation is still waiting."
          detail="Every one this session sent has been accepted, revoked, or has expired."
        />
      ) : (
        <ul className="meridian-invites__rows">
          {ledger.pending.map((invite) => (
            <li key={invite.inviteId}>
              <InviteLedgerRow
                invite={invite}
                isRevoking={props.pendingRevokeKey === invite.inviteId}
                // Every pending row's control closes while ANY revoke is
                // unsettled, not only the one being revoked: the coordinator
                // behind them applies one at a time.
                isAnyRevoking={props.pendingRevokeKey !== undefined}
                refusal={props.refusalByInviteId[invite.inviteId]}
                onRevoke={() => {
                  props.onRevoke(invite.inviteId);
                }}
                onDismissRefusal={() => {
                  props.onDismissRefusal(invite.inviteId);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {ledger.settled.length === 0 ? null : (
        <details className="meridian-invites__fold">
          <summary className="meridian-invites__fold-summary">
            {`${formatCount(ledger.settled.length)} already settled`}
          </summary>
          <ul className="meridian-invites__rows">
            {ledger.settled.slice(0, SETTLED_INVITE_VISIBLE_CAP).map((invite) => (
              <li key={invite.inviteId}>
                <InviteLedgerRow
                  invite={invite}
                  isRevoking={false}
                  isAnyRevoking={false}
                  refusal={undefined}
                />
              </li>
            ))}
          </ul>
          {ledger.settled.length > SETTLED_INVITE_VISIBLE_CAP ? (
            <p className="meridian-invites__fold-overflow">
              {`${formatCount(ledger.settled.length - SETTLED_INVITE_VISIBLE_CAP)} older ones are not shown — no invites read carries a cursor to page with.`}
            </p>
          ) : null}
        </details>
      )}
    </>
  );
}
