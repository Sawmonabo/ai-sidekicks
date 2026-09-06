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
//
// AND WHY THE DEEP LINK'S CONFIRMATION IS ANNOUNCED HERE RATHER THAN OPENED
//
// An invitation arriving on the operating-system deep link is a whole-screen
// question, and it arrives on somebody else's schedule: mid-approval, mid-run,
// mid-sentence. A dialog that opened itself would take the screen from whatever was
// being done, which is the one thing every console surface is forbidden to do. So an
// arrival draws a notice, unmissable and persistent, and the confirmation opens on a
// press — one gesture later, and never a moment the person did not choose.

import { useMemo, useState } from "react";
import { useSessionPartition } from "../../store/index.js";
import type { SidebarSectionContext } from "../../seats/index.js";
import { InlineRefusal } from "../../primitives/index.js";
import { InviteConfirmation } from "../invites/InviteConfirmation.js";
import { usePendingInvites } from "../invites/use-pending-invites.js";
import { deriveMembershipRows } from "./members-model.js";
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
}

export function Memberships(props: MembershipsProps): React.JSX.Element {
  const { context } = props;
  const { bridge, sessionStore } = context;
  const participantEntities = useSessionPartition(sessionStore, "participant");
  const rows = useMemo(() => deriveMembershipRows(participantEntities), [participantEntities]);
  const { snapshot: pendingInvites, adapter } = usePendingInvites(bridge);
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);

  const coordinator = useMemo(
    () =>
      new WireMutationCoordinator({
        perform: daemonMutation(bridge, MEMBERSHIP_UPDATE_METHOD),
        describeWhat: "The membership change",
      }),
    [bridge],
  );
  const mutation = useWireMutation(coordinator);

  return (
    <section className="meridian-members" aria-label="Memberships">
      {pendingInvites.invite === undefined ? null : (
        <div className="meridian-members__invitation" role="status">
          <p className="meridian-members__invitation-lede">
            {pendingInvites.waitingBehind > 0
              ? `You have ${String(pendingInvites.waitingBehind + 1)} invitations waiting.`
              : "You have an invitation waiting."}
          </p>
          <button
            type="button"
            className="meridian-members__invitation-open"
            onClick={() => {
              setIsConfirmationOpen(true);
            }}
          >
            Look at it
          </button>
        </div>
      )}
      {pendingInvites.feedRefusal === undefined ? null : (
        <InlineRefusal
          code={pendingInvites.feedRefusal.code}
          detail={pendingInvites.feedRefusal.detail}
        />
      )}
      <InviteConfirmation
        open={isConfirmationOpen && pendingInvites.invite !== undefined}
        onOpenChange={setIsConfirmationOpen}
        snapshot={pendingInvites}
        onConfirm={() => {
          adapter.confirm();
        }}
        onRetry={() => {
          adapter.retry();
        }}
        onDiscard={() => {
          adapter.dismiss();
          setIsConfirmationOpen(false);
        }}
        onAcknowledge={() => {
          adapter.acknowledge();
          setIsConfirmationOpen(false);
        }}
      />

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
