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
import { callDaemon } from "../../bridge/index.js";
import { shellBlockForMethod, useSessionPartition, useShellState } from "../../store/index.js";
import type { SidebarSectionContext } from "../../seats/index.js";
import {
  InviteConfirmation,
  type PendingInviteConfirmation,
} from "../invites/InviteConfirmation.js";
import { deriveMembershipRows } from "./members-model.js";
import {
  WireMutationCoordinator,
  useWireMutation,
  type CollaborationMutation,
  type CollaborationMutationMethod,
} from "../mutation-coordinator.js";
import { SentInvites } from "../invites/SentInvites.js";
import { MembershipLedger } from "./MembershipLedger.js";

/**
 * The wire method every one of the four controls calls, through the daemon gateway.
 *
 * The `satisfies` IS the binding, on `onboarding/provider-readiness/`'s precedent:
 * `store/shell-mutation-block.ts` is the console's registration of what a supervisor's
 * condition closes, so a membership change that ever left that tuple stops compiling
 * here rather than quietly going back to being dispatchable through a stopped shell.
 * The literal type survives it, which is what `callDaemon` needs to type the request
 * and the reply; a wider annotation would take both.
 */
const MEMBERSHIP_UPDATE_METHOD = "membership.update" satisfies CollaborationMutationMethod;

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

  const coordinator = useMemo(() => {
    // The door call sits HERE, where exactly one method is named, rather than behind
    // a binder generic over the family's methods: one call site naming one method is
    // what lets the read-signal gate read the deliberate absence of a cancellation
    // signal as deliberate. A membership change that has reached the daemon has
    // HAPPENED, so there is nothing this window may abandon it with.
    const updateMembership: CollaborationMutation<typeof MEMBERSHIP_UPDATE_METHOD> = async (
      request,
    ) => await callDaemon(bridge, MEMBERSHIP_UPDATE_METHOD, request);
    return new WireMutationCoordinator({
      perform: updateMembership,
      describeWhat: "The membership change",
    });
  }, [bridge]);
  const mutation = useWireMutation(coordinator);
  // Whether this window may send a membership change at all, from the shell state the
  // frame publishes. Asked of the one seam every dispatching control goes through, so
  // the projected rows beside it stay on screen through the same outage — that seam
  // answers about a method, never about the window.
  const updateBlock = shellBlockForMethod(
    useShellState(context.frameStore),
    MEMBERSHIP_UPDATE_METHOD,
  );

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
        updateBlock={updateBlock}
        onApply={(row, update) => {
          if (row.membershipId === undefined) {
            return;
          }
          // Fail-closed at the dispatch site and not only on the control, on the
          // sessions destination's precedent: the menu and the confirmation are
          // disabled from this same block, so this is the guard rather than the
          // affordance, and a press that reached here anyway must still put nothing.
          if (updateBlock !== undefined) {
            return;
          }
          void coordinator.run(row.membershipId, update);
        }}
        onDismissRefusal={(membershipId) => {
          coordinator.dismiss(membershipId);
        }}
      />

      <SentInvites
        bridge={bridge}
        frameStore={context.frameStore}
        sessionId={sessionStore.sessionId}
      />
    </section>
  );
}
