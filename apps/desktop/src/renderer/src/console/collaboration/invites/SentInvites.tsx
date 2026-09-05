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
// EVERY ROW AND EVERY CONTROL BELONGS TO ONE SESSION, AND THE SECTION OUTLIVES IT.
// The members section stays mounted when the console moves from one session to the
// next, so the read this surface started for the session it is leaving answers after
// the render that named the session it arrived at. A ledger holding an unstamped
// answer would draw the left session's rows under the arriving one, and Revoke on
// such a row composes `{sessionId: <arrived>, inviteId: <left>}` — a request naming
// two different sessions, which the daemon can only refuse. So the answer is held
// WITH the exact bridge and session it was asked of, and rendered only while that
// pair still matches: a mismatched frame is the `not-loaded` absence, which is the
// honest reading of a session nothing has been read for yet. The revoke coordinator
// is keyed on the same pair for the second half of the same fact — one revoke at a
// time is a rule about THIS session's ledger, and an unsettled revoke in the session
// being left would otherwise close every control in the session being entered.
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

import { heldIdAsWireId, type ConsoleBridge, type InvitesListOutcome } from "../../bridge/index.js";
import { Nothing } from "../../primitives/index.js";
import { partitionInvites, withSettledInvite } from "./invite-ledger.js";
import {
  WireMutationCoordinator,
  daemonMutation,
  useWireMutation,
} from "../mutation-coordinator.js";
import { LedgerBody } from "./SentInvitesLedger.js";

/** The wire method the revoke control calls, through the daemon gateway. */
const INVITE_REVOKE_METHOD = "invite.revoke";

export interface SentInvitesProps {
  readonly bridge: ConsoleBridge;
  /** The session whose invites these are. `undefined` means nothing was asked. */
  readonly sessionId: string | undefined;
}

/**
 * One `invitesList` answer, and the exact subject it was asked of.
 *
 * The bridge is compared by identity beside the session id rather than trusted to
 * follow it: a window handed a replacement bridge for the same session is holding
 * an answer from a transport that no longer exists, and the ledger's own control
 * would dispatch through the replacement while showing the retired one's rows.
 */
interface StampedInvitesOutcome {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly outcome: InvitesListOutcome;
}

export function SentInvites(props: SentInvitesProps): React.JSX.Element {
  const { bridge, sessionId } = props;
  const [stamped, setStamped] = useState<StampedInvitesOutcome | undefined>(undefined);

  const revokeCoordinator = useMemo(
    () =>
      new WireMutationCoordinator({
        perform: daemonMutation(bridge, INVITE_REVOKE_METHOD),
        describeWhat: "The invitation",
      }),
    // Keyed on the SUBJECT and not only on the transport: the coordinator's whole
    // state — what is in flight, whose refusal stands — is about one session's
    // rows, and a session's ledger inheriting another's is what closed every
    // control here on the frame after a move.
    [bridge, sessionId],
  );
  const revoke = useWireMutation(revokeCoordinator);

  useEffect(() => {
    // The coordinator being retired is superseded rather than dropped: dropping the
    // reference leaves its unsettled call able to publish and to resolve into a
    // caller that would install into the ledger now on screen.
    return () => {
      revokeCoordinator.supersede();
    };
  }, [revokeCoordinator]);

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
        setStamped({ bridge, sessionId, outcome: result });
      }
    });
    return () => {
      isAttached = false;
    };
  }, [bridge, sessionId]);

  // The stamp is read HERE rather than trusted from the effect that installed it:
  // an effect's state lands one committed frame after the render that renamed the
  // subject, and that frame is the one this whole surface has to get right.
  const outcome =
    stamped !== undefined && stamped.bridge === bridge && stamped.sessionId === sessionId
      ? stamped.outcome
      : undefined;

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
              sessionId: heldIdAsWireId(sessionId),
              inviteId: heldIdAsWireId(inviteId),
            })
            .then((settlement) => {
              // `undefined` is the refused arm — and the superseded one, where the
              // subject moved while the call was unsettled. Either way the reason
              // is on the coordinator's snapshot beside the control that asked, or
              // there is no control left to put one beside. Nothing moves.
              if (settlement === undefined) {
                return;
              }
              setStamped((held) => {
                if (held === undefined || held.bridge !== bridge || held.sessionId !== sessionId) {
                  return held;
                }
                const settled = withSettledInvite(held.outcome, settlement);
                // `undefined` here would mean the ledger held no answer at all, and
                // this one does; identity means the settlement named no row it
                // holds. Both leave the ledger exactly as it stands.
                return settled === undefined || settled === held.outcome
                  ? held
                  : { ...held, outcome: settled };
              });
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
