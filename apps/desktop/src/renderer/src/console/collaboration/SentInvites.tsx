// Invites this session has sent: what became of each one, and the one act the
// console can still perform on them.
//
// WHAT THE WIRE ACTUALLY GIVES THIS SURFACE, AND WHAT IT DOES NOT
//
// The ledger is the growth port's `invitesList` — the same read the sessions
// destination's received-invite shelf uses, and the only invites read the console
// has. `Plan-023 §Console growth slate` files it under the `invites-list` row and
// the live bridge answers every call with a typed refusal, which renders verbatim
// rather than as an empty ledger: "the read is not registered" and "you have sent
// nobody an invitation" are different facts.
//
// Two of this surface's three designed controls are NOT drawn, each for a reason
// that is a missing input rather than a policy choice:
//
//   • CREATE. `InviteCreate` is `{sessionId, inviter, joinMode, expiresAt}` and
//     `inviter` is the SENDER'S OWN participant id. No registered read tells this
//     console who it is — `presence.read` answers other people's ids and their
//     presence, `SessionReadResponse` carries a snapshot and cursors, and the
//     store projects participants without marking which one is the operator. The
//     request cannot be composed, so the region says which read would let it be
//     rather than drawing a control that would compose a request with a guess in
//     it. The all-sessions list sets the precedent in its own header: an offered
//     control with no wire behind it is the capability-claimed-but-not-implemented
//     shape, and drawing it disabled is the same claim with a tooltip.
//
//   • COPY LINK. The link is `https://<control-plane-host>/invite/<token>`, and
//     the ledger row carries neither half: `GrowthInviteSummary` is
//     `{inviteId, state, expiresAt}`, the plaintext token is returned exactly once
//     by `invite.create` (which this console cannot call), and no read anywhere
//     hands the renderer its control-plane host. A copy control would copy an
//     identifier that opens nothing.
//
// REVOKE IS DRAWN, because both of its inputs exist: the session comes from the
// store this section is scoped to, and the invite id is on the served row. It is
// offered on every pending row and the daemon's refusal renders in place — and when
// it SETTLES, the reply moves the row. `invite.revoke` answers `{inviteId, state}`,
// which is the row itself, so the ledger consumes that projection rather than
// re-reading `invitesList`: a row left saying "pending" beside a re-enabled Revoke
// control would be this surface contradicting the answer it just received.
// `invite-ledger.ts` owns the fold and says why no second read is put. One revoke
// runs at a time, so while one is unsettled EVERY pending row's control is closed
// rather than only the row being revoked — the coordinator would refuse a second
// press, and a control that leads only to that refusal is worse than a control
// that waits.
//
// REVOCATION IS SILENT AND THE SENDER IS TOLD SO (`Spec-002 §Invite Revocation`).
// There is no decline column either — `InviteState` is exactly
// `pending | accepted | revoked | expired` and declining is implicit, so a
// `declined` column would be a fifth state the wire does not have.
//
// NO COUNTDOWN AGAINST THE PENDING CAP. `Spec-021`'s hundred-pending-invite cap
// refuses with no retry time, no reset time, and no retry header, so its only
// truthful rendering is "revoke or let one expire". The sliding-window limits DO
// carry a retry time on the wire, and the console still does not render one: the
// refusal reaches the renderer as `{code, message}` (`src/shared/wire-errors.ts`)
// and no registered envelope in `packages/contracts` carries a retry field for it
// to read. A timer counting down from a number the console invented would be
// worse than the sentence.

import { useEffect, useMemo, useState } from "react";

import type {
  InviteId,
  InviteRevoke,
  InviteRevokeResponse,
  SessionId,
} from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../bridge/index.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatCount,
  formatDateTime,
} from "../primitives/index.js";
import { SETTLED_INVITE_VISIBLE_CAP } from "../core/index.js";
import {
  partitionInvites,
  withSettledInvite,
  type InviteLedger,
  type InvitesListOutcome,
  type SentInvite,
} from "./invite-ledger.js";
import {
  WireMutationCoordinator,
  daemonMutation,
  useWireMutation,
} from "./mutation-coordinator.js";

/** The wire method the revoke control calls, through the daemon gateway. */
const INVITE_REVOKE_METHOD = "invite.revoke";

export interface SentInvitesProps {
  readonly bridge: ConsoleBridge;
  /** The session whose invites these are. `undefined` means nothing was asked. */
  readonly sessionId: string | undefined;
}

export function SentInvites(props: SentInvitesProps): React.JSX.Element {
  const { bridge, sessionId } = props;
  const [outcome, setOutcome] = useState<InvitesListOutcome | undefined>(undefined);

  const revokeCoordinator = useMemo(
    () =>
      new WireMutationCoordinator<InviteRevoke, InviteRevokeResponse>({
        perform: daemonMutation<InviteRevoke, InviteRevokeResponse>(bridge, INVITE_REVOKE_METHOD),
        describeWhat: "The invitation",
      }),
    [bridge],
  );
  const revoke = useWireMutation(revokeCoordinator);

  useEffect(() => {
    // One read, on mount, for the received shelf's reason: the wire behind this
    // seam refuses today, so a repeat would re-ask a question with no answer, and
    // `store/scheduling.ts` is where a real re-read will go when there is one.
    if (sessionId === undefined) {
      return undefined;
    }
    let isAttached = true;
    void bridge.growth.invitesList({ sessionId }).then((result) => {
      if (isAttached) {
        setOutcome(result);
      }
    });
    return () => {
      isAttached = false;
    };
  }, [bridge, sessionId]);

  const ledger = useMemo(
    () => (outcome?.status === "served" ? partitionInvites(outcome.value) : undefined),
    [outcome],
  );

  return (
    <section className="meridian-invites" aria-label="Invitations you sent">
      <header className="meridian-invites__head">
        <h3 className="meridian-invites__title">Invitations you sent</h3>
        <p className="meridian-invites__lede">
          Revoking one is silent — the person it was sent to is told nothing, and the link simply
          stops working.
        </p>
      </header>

      <InviteCreationAbsence />

      <LedgerBody
        sessionId={sessionId}
        outcome={outcome}
        ledger={ledger}
        pendingRevokeKey={revoke.pendingKey}
        refusalByInviteId={revoke.refusalByKey}
        onRevoke={(inviteId) => {
          if (sessionId === undefined) {
            return;
          }
          void revokeCoordinator
            .run(inviteId, {
              // The two brands are compile-time nominal typing over plain strings and
              // the narrowing happens at this one seam, per `frame/legacy-surfaces.ts`:
              // whether either id names a live row is the daemon's answer, and this
              // surface renders that answer verbatim.
              sessionId: sessionId as SessionId,
              inviteId: inviteId as InviteId,
            })
            .then((settlement) => {
              // `undefined` is the refused arm, and its reason is already on the
              // coordinator's snapshot beside the control that asked. Nothing moves.
              if (settlement === undefined) {
                return;
              }
              setOutcome((held) => withSettledInvite(held, settlement));
            });
        }}
        onDismissRefusal={(inviteId) => {
          revokeCoordinator.dismiss(inviteId);
        }}
      />
    </section>
  );
}

/**
 * Why there is no create control here.
 *
 * `not-checked` rather than `error`: nothing failed, and nothing is missing from
 * the daemon either. The console cannot ASK, because it does not know who it is.
 */
function InviteCreationAbsence(): React.JSX.Element {
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title="This console cannot mint an invitation yet."
      detail="Creating one names the sender's own participant id, and no read this console has tells it which participant it is. Nothing was asked — this is not a refusal from the daemon."
    />
  );
}

function LedgerBody(props: {
  readonly sessionId: string | undefined;
  readonly outcome: InvitesListOutcome | undefined;
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
  if (props.outcome === undefined) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading this session's invitations." />
    );
  }
  if (props.outcome.status === "unavailable") {
    return <InlineRefusal code={props.outcome.code} detail={props.outcome.detail} />;
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

/**
 * One invitation.
 *
 * The revoke control appears only on a row that is still pending, because there
 * is nothing to revoke on a row that has already settled — that is the row's own
 * state saying so, not a control hidden to prevent a refusal.
 */
function InviteLedgerRow(props: {
  readonly invite: SentInvite;
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
