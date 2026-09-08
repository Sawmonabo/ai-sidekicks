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
// ALL THREE OF THIS SURFACE'S DESIGNED CONTROLS ARE NOW DRAWN, and the two that
// were not each needed a read rather than a decision:
//
//   • CREATE. `InviteCreate` is `{sessionId, inviter, joinMode, expiresAt}` and
//     `inviter` is the SENDER'S OWN participant id, which no session read marks —
//     `presence.read` answers other people's ids and their presence,
//     `SessionReadResponse` carries a snapshot and cursors, and the store projects
//     participants without saying which one is the operator. The growth port's
//     `callerParticipantRead` is that read, and `CreateInvite.tsx` composes the
//     request from it. A read still in flight closes the send control and a refused
//     one says why, which is the request's own missing member rather than a
//     permission this console decided.
//
//   • COPY LINK. `Spec-002 §Invite Delivery` writes the link as
//     `https://<control-plane-host>/invite/<token>`. The token is returned exactly
//     once by `invite.create` and by nothing else, so the copy control belongs to
//     the moment of the mint and not to a ledger row — `InviteLinkReveal.tsx` is
//     that moment. The host is the growth port's `controlPlaneHostRead`, taken
//     BEFORE the mint; a host that refuses ends the act there and mints nothing, so
//     no row this ledger could show is ever one whose link could not be written.
//
// WHEN THE LEDGER ASKS AGAIN IS NOT HERE. A mint re-reads, a pending row crossing
// its expiry re-reads, and both of those overlap with each other and with the
// receipt below — so the read line, its ordering, and the answer it holds are
// `sent-invites-reading.ts`, and this file renders what that hook publishes. Still
// no interval: `store/scheduling.ts` is where a periodic re-read would go and there
// is none, which that module states with its reasons.
//
// REVOKE IS DRAWN, because both of its inputs exist: the session comes from the
// store this section is scoped to, and the invite id is on the served row. It is
// offered on every pending row and the daemon's refusal renders in place — and when
// it SETTLES, the reply moves the row. `invite.revoke` answers `{inviteId, state}`,
// which is the row itself, so the ledger consumes that projection rather than
// re-reading `invitesList`: a row left saying "pending" beside a re-enabled Revoke
// control would be this surface contradicting the answer it just received.
// `invite-ledger.ts` owns the fold and says why no second read is put, and the
// reading hook applies it ON the read line — so a refresh that was already in flight
// when the revoke settled cannot restore the row afterwards. One revoke runs at a
// time, so while one is unsettled EVERY pending row's control is closed rather than
// only the row being revoked — the coordinator would refuse a second press, and a
// control that leads only to that refusal is worse than a control that waits.
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

import { useEffect, useMemo } from "react";

import { callDaemon, heldIdAsWireId, type ConsoleBridge } from "../../bridge/index.js";
import {
  currentShellBlock,
  shellBlockForMethod,
  useShellState,
  type FrameStore,
} from "../../store/index.js";
import {
  WireMutationCoordinator,
  type CollaborationMutation,
  type CollaborationMutationMethod,
  useWireMutation,
} from "../mutation-coordinator.js";
import { useSentInviteLedger } from "./sent-invites-reading.js";
import { SentInvitesLedger } from "./SentInvitesLedger.js";
import { CreateInvite } from "./CreateInvite.js";

/**
 * The wire method the revoke control calls, through the daemon gateway.
 *
 * The `satisfies` IS the binding, on `onboarding/provider-readiness/`'s precedent:
 * `store/shell-mutation-block.ts` is the console's registration of what a supervisor's
 * condition closes, so a revoke that ever left that tuple stops compiling here rather
 * than quietly going back to being dispatchable through a stopped shell. The literal
 * type survives it, which is what `callDaemon` needs to type the request and the
 * reply; a wider annotation would take both.
 */
const INVITE_REVOKE_METHOD = "invite.revoke" satisfies CollaborationMutationMethod;

export interface SentInvitesProps {
  readonly bridge: ConsoleBridge;
  /** The session whose invites these are. `undefined` means nothing was asked. */
  readonly sessionId: string | undefined;
  /**
   * Where this window's shell condition is published.
   *
   * Held rather than a derived block passed in, because the question this surface
   * asks is per METHOD: `shellBlockForMethod` answers about `invite.revoke` and the
   * read beside it survives the same outage, which a whole-window block handed down
   * could not express.
   */
  readonly frameStore: FrameStore;
}

export function SentInvites(props: SentInvitesProps): React.JSX.Element {
  const { bridge, frameStore, sessionId } = props;
  const { reading, ledger, noteMinted, applySettledRevoke } = useSentInviteLedger(
    bridge,
    sessionId,
  );

  const revokeCoordinator = useMemo(() => {
    // The door call sits HERE, where exactly one method is named, rather than behind
    // a binder generic over the family's methods: one call site naming one method is
    // what lets the read-signal gate read the deliberate absence of a cancellation
    // signal as deliberate. A revoke that has reached the daemon has HAPPENED, so
    // there is nothing this window may abandon it with.
    const revokeInvite: CollaborationMutation<typeof INVITE_REVOKE_METHOD> = async (request) =>
      await callDaemon(bridge, INVITE_REVOKE_METHOD, request);
    return new WireMutationCoordinator({
      perform: revokeInvite,
      describeWhat: "The invitation",
    });
    // Keyed on the SUBJECT and not only on the transport: the coordinator's whole
    // state — what is in flight, whose refusal stands — is about one session's
    // rows, and a session's ledger inheriting another's is what closed every
    // control here on the frame after a move.
  }, [bridge, sessionId]);
  const revoke = useWireMutation(revokeCoordinator);
  // Whether this window may send the revoke at all, from the shell state the frame
  // publishes. Asked of the one seam every dispatching control goes through, so the
  // ledger's own read stays live through the same outage — that seam answers about a
  // method, never about the window. This value draws the row's control and rides it as
  // its disabled reason; whether a press is admitted is asked again at the dispatch
  // site, off the store, because this one is as old as the last committed render.
  const revokeBlock = shellBlockForMethod(useShellState(frameStore), INVITE_REVOKE_METHOD);

  useEffect(() => {
    // The coordinator being retired is superseded rather than dropped: dropping the
    // reference leaves its unsettled call able to publish and to resolve into a
    // caller that would install into the ledger now on screen.
    return () => {
      revokeCoordinator.supersede();
    };
  }, [revokeCoordinator]);

  return (
    <section className="meridian-invites" aria-label="Invitations you sent">
      <header className="meridian-invites__head">
        <h3 className="meridian-invites__title">Invitations you sent</h3>
        <p className="meridian-invites__lede">
          Revoking one is silent — the person it was sent to is told nothing, and the link simply
          stops working.
        </p>
      </header>

      {/* DISABLED WITH THE CAUSE BESIDE IT, never hidden, and the SENTENCE said once for
          the section: the block is the window's, and the send control below, every revoke
          control in the ledger, and the membership controls above are all closed by the
          same condition. The one line naming it is the hosting members section's, printed
          above everything under that heading — so this surface hands the block to its
          controls as their disabled reason and prints no second copy of the same words
          under the same heading. */}
      <CreateInvite
        bridge={bridge}
        sessionId={sessionId}
        frameStore={frameStore}
        onMinted={noteMinted}
      />

      <SentInvitesLedger
        sessionId={sessionId}
        reading={reading}
        ledger={ledger}
        pendingRevokeKey={revoke.pendingKey}
        revokeBlock={revokeBlock}
        refusalByInviteId={revoke.refusalByKey}
        onRevoke={(inviteId) => {
          if (sessionId === undefined) {
            return;
          }
          // Fail-closed at the dispatch site and not only on the control: the row's
          // control is disabled from this same block, so this is the guard.
          //
          // READ NOW rather than closed over. `revokeBlock` is the last committed
          // render's answer, and a report landing between that render and this press
          // leaves it `undefined` while the supervisor has stopped — so the store is
          // asked at the moment the call would be put.
          if (currentShellBlock(frameStore, INVITE_REVOKE_METHOD) !== undefined) {
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
              applySettledRevoke(settlement);
            });
        }}
        onDismissRefusal={(inviteId) => {
          revokeCoordinator.dismiss(inviteId);
        }}
      />
    </section>
  );
}
