// The membership ledger: who is in this session, on what terms, and what changing
// one of those terms costs.
//
// The members section renders three bodies and this is the second of them. The
// ROSTER above it answers who is here right now, from `presence.read`; this answers
// on what terms they are here at all; the SENT-INVITE ledger below answers who has
// been asked and has not arrived. Presence is deliberately not read again here —
// one reader per read, and the section already holds it.
//
// TWO FACTS, AND ONE OF THEM HAS NO READ
//
//   • ROLE AND MEMBERSHIP STATE come from the session store's projected
//     participants — the ledger's own account of who joined and as what. Where an
//     event has not stated a role, the row says so instead of inventing one.
//   • A MEMBERSHIP ID has no read at all. `presence.read` does not carry one,
//     `SessionReadResponse` carries no memberships, and `MembershipSummary` — the
//     only shape with all three facts — is returned by `session.create` alone. So
//     a row that has no membership id cannot be the subject of `membership.update`
//     and says which read would let it be.
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

import { useMemo, useState } from "react";
import { useSessionPartition } from "../../store/index.js";
import type { SidebarSectionContext } from "../../seats/index.js";
import {
  InviteConfirmation,
  type PendingInviteConfirmation,
} from "../invites/InviteConfirmation.js";
import { deriveMembershipRows, membershipRefusalRemedy } from "./members-model.js";
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
  /**
   * An invitation waiting on this person's confirmation.
   *
   * Always absent today, and the absence is the wire's rather than a default: the
   * deep-link pending-invite subscription, its preview, and its confirm / retry /
   * dismiss verbs are on no bridge namespace and on no growth-slate row, so
   * nothing in this console can produce one. It is a prop rather than a read for
   * exactly that reason — a reader supplies it when one exists, and until then the
   * confirmation renders nothing at all.
   */
  readonly pendingInvite?: PendingInviteConfirmation | undefined;
}

export function Memberships(props: MembershipsProps): React.JSX.Element {
  const { context } = props;
  const { bridge, sessionStore } = context;
  const participantEntities = useSessionPartition(sessionStore, "participant");
  const rows = useMemo(() => deriveMembershipRows(participantEntities), [participantEntities]);
  const [isConfirmationDismissed, setIsConfirmationDismissed] = useState(false);

  const coordinator = useMemo(
    () =>
      new WireMutationCoordinator({
        perform: daemonMutation(bridge, MEMBERSHIP_UPDATE_METHOD),
        describeWhat: "The membership change",
      }),
    [bridge],
  );
  const mutation = useWireMutation(coordinator);

  const pendingInvite = isConfirmationDismissed ? undefined : props.pendingInvite;
  if (pendingInvite !== undefined) {
    // One screen, one job. Nothing else this body renders survives a pending
    // confirmation — an early return rather than a conditional wrapper, so there is
    // no branch in which the ledger's own controls are reachable behind the dialog.
    return (
      <InviteConfirmation
        pending={pendingInvite}
        bridgeSource={bridge.source}
        onDismiss={() => {
          setIsConfirmationDismissed(true);
        }}
      />
    );
  }

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

export function remedySuffix(code: string): string {
  const remedy = membershipRefusalRemedy(code);
  return remedy === undefined ? "" : ` ${remedy}`;
}
