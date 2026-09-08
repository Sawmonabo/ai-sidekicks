// The membership ledger: who is in this session, on what terms, and what changing
// one of those terms costs.
//
// The members section renders three bodies and this is the second of them. The
// ROSTER above it answers who is here right now, from `presence.read`; this answers
// on what terms they are here at all; the SENT-INVITE ledger below answers who has
// been asked and has not arrived. Presence is deliberately not read again here —
// one reader per read, and the section already holds it.
//
// TWO SOURCES, AND THE ROWS ARE DERIVED FROM BOTH BEFORE THEY REACH HERE
//
//   • THE LOG. The session store's projected participants — who joined, as what, and
//     whether the membership has since been suspended, revoked, or restored, folded
//     from all five `membership.*` beats. Where no beat stated a fact, the row says so
//     instead of inventing it.
//   • THE MEMBERSHIP ROSTER READ, on the growth port, which is where a membership id
//     comes from for everyone the log did not see admitted — including the session's
//     own opener, who has no admission beat at all. It refuses on a live build, and
//     its refusal is one line beside the rows rather than instead of them: the
//     log-derived rows are still the best reading there is.
//
// The merge is `members-model.ts`'s and the derivation is the section body's, so this
// component renders rows and never composes them. A row that still has no membership
// id after both sources cannot be the subject of `membership.update` and says so.
//
// AND WHAT CLOSES THE CONTROLS IS THE TRANSPORT, NEVER THE PROJECTION
//
// Those are two different facts and this section used to run them together: the four
// controls were gated on the session store's degraded flag, which is raised by a
// sequence gap, a projection failure, a closed subscription, or a failed read — none
// of which says anything about whether `membership.update` can be sent. A window that
// missed one event in the stream lost every membership control it had, permanently,
// on a flag only a completed re-pull clears. So the two facts are now rendered
// separately: a degraded projection says the rows are LAST-KNOWN and leaves the
// controls alone, and the shell's own condition — `store/shell-mutation-block.ts`, the
// console's one answer to "may I send this" — is what closes them. Where the shell has
// said nothing, nothing closes: silence is not an outage, and the daemon's refusal is
// the answer a person is entitled to rather than a control that was never offered.
//
// ELIGIBILITY IS THE DAEMON'S, NOT THIS SECTION'S
//
// The controls project wire state fail-closed and never compute permission. The
// revoke control is offered on every row that has a membership id, including the
// last owner's: `Spec-002 §Required Behavior` makes the last owner's refusal a
// real answer with a real remedy, and hiding the control to avoid provoking it
// would replace an answer a person can act on with a control they cannot find.
// The one thing a row does gate on is its own wire state — owner elevation is not
// offered against a membership that is not active, because "active membership" is
// a fact printed on the row rather than a permission inferred about the caller.
// Whether the CALLER may do any of it is `membership.permission_denied`, and it
// renders where it was raised.
//
// WHY THE CONSEQUENCE COPY LIVES IN THE CONFIRMATION AND NOT ON THE ROW
//
// Revoking a runtime contributor interrupts active runs on their node and
// detaches it; revoking a collaborator expires pending interventions at once and
// ends read access after a thirty-second grace window. Neither is undone by
// pressing Reactivate. Printed on every row that copy is noise a person stops
// reading; printed in the confirmation it is the sentence they are agreeing to.
//
// AND WHY THE DEEP LINK'S INVITATION IS NOT ANNOUNCED HERE AT ALL
//
// It used to be. An invitation arriving on the operating-system deep link is about a
// session this window is NOT in, and the person it reaches most often has no session
// open at all — so a lifecycle mounted under this section opened its two feeds only
// while a session view happened to be on screen, and a first-time recipient following
// a link into a fresh window saw nothing. `Plan-023` T-023r-6-3 puts that lifecycle at
// the window instead, and it is hosted there now
// (`../invites/InviteLifecycleOverlay.tsx`, seated through `seats/single-slot/window-overlay-seat.ts`).
// This section renders the sent-invite ledger and nothing about arrivals: two notices
// for one invitation would be two places to answer it, and the second one would be
// wherever the reader happened not to be looking.

import { useMemo } from "react";
import type { ConsoleRefusal } from "../../core/index.js";
import type { SidebarSectionContext } from "../../seats/index.js";
import { shellBlockForMethod, useShellState } from "../../store/index.js";
import type { MembershipRow } from "./members-model.js";
import {
  WireMutationCoordinator,
  daemonMutation,
  useWireMutation,
} from "../mutation-coordinator.js";
import { SentInvites } from "../invites/SentInvites.js";
import { MembershipLedger } from "./MembershipLedger.js";

/** The wire method every one of the four controls calls, through the daemon gateway. */
const MEMBERSHIP_UPDATE_METHOD = "membership.update";

export interface MembershipsProps {
  readonly context: SidebarSectionContext;
  /** The merged rows, derived once by the section body and read by two surfaces. */
  readonly rows: readonly MembershipRow[];
  /** Why the membership roster read did not answer, where it did not. */
  readonly rosterRefusal: ConsoleRefusal | undefined;
  /**
   * True when this session's projection is behind — a gap, a failed apply, a wire
   * that stopped.
   *
   * The rows are LAST-KNOWN under it and the ledger says so, and that is all it does.
   * It closes no control: a projection that is behind is a fact about what this window
   * has been told, and `membership.update` is a call this window makes.
   */
  readonly isLastKnown: boolean;
}

export function Memberships(props: MembershipsProps): React.JSX.Element {
  const { context, rows } = props;
  const { bridge, sessionStore } = context;

  const coordinator = useMemo(
    () =>
      new WireMutationCoordinator({
        perform: daemonMutation(bridge, MEMBERSHIP_UPDATE_METHOD),
        describeWhat: "The membership change",
      }),
    [bridge],
  );
  const mutation = useWireMutation(coordinator);
  // Whether this window can send the one method these controls call. SUBSCRIBED, so a
  // supervisor going down or coming back moves the controls without waiting for some
  // other read to settle — and asked per METHOD through the one seam that knows which
  // calls an outage closes, rather than read off the connection here, where a second
  // reading of that rule would be free to disagree with the banner above it.
  const mutationBlock = shellBlockForMethod(
    useShellState(context.frameStore),
    MEMBERSHIP_UPDATE_METHOD,
  );

  return (
    <section className="meridian-members" aria-label="Memberships">
      <header className="meridian-members__head">
        <h3 className="meridian-members__title">Memberships</h3>
        <p className="meridian-members__lede">
          Everyone with a membership in this session, on the terms they hold it. A suspended
          membership is still a row.
        </p>
      </header>

      <MembershipLedger
        rows={rows}
        rosterRefusal={props.rosterRefusal}
        isLastKnown={props.isLastKnown}
        mutationBlock={mutationBlock}
        mutation={mutation}
        onApply={(row, update) => {
          if (row.membershipId === undefined) {
            return;
          }
          void coordinator.run(row.membershipId, update);
        }}
        onDismissRefusal={(membershipId) => {
          coordinator.dismiss(membershipId);
        }}
      />

      <SentInvites bridge={bridge} sessionId={sessionStore.sessionId} />
    </section>
  );
}
