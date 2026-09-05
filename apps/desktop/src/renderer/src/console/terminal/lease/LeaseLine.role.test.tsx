// The lease line offers acquisition by role.
//
// The second gate on the same control, and a different question from the identity
// one: the identity is what the lease fold compares the holder against, and the role
// is what the daemon checks before it moves the shell. Taking the shell is
// owner/collaborator-only, so a viewer or a runtime contributor is shown a designed
// read-only statement rather than a button whose only possible answer is
// `pty.permission_denied`. `lease-acquisition.ts` owns that fold and states why
// release is deliberately not gated with it.

import { describe, expect, it } from "vitest";

import type { MembershipRole } from "@ai-sidekicks/contracts";
import type { CallerMembershipRoleResult } from "../../store/index.js";
import {
  VIEWER_IDENTITY_READ,
  claimControl,
  leaseState,
  refusingBridge,
  renderLease,
} from "./LeaseLine.test-support.js";
import { OTHER_PARTICIPANT, VIEWER_PARTICIPANT } from "./lease-model.test-support.js";

describe("the lease line offers acquisition by role", () => {
  const roleRead = (role: MembershipRole): CallerMembershipRoleResult => ({
    status: "read",
    participantId: VIEWER_PARTICIPANT,
    role,
  });

  it("renders a read-only statement for a viewer rather than a control it cannot use", () => {
    // The finding. `session.takeControl` is owner/collaborator-only, so the button
    // this used to draw could only ever come back `pty.permission_denied`.
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      refusingBridge(),
      VIEWER_IDENTITY_READ,
      roleRead("viewer"),
    );

    expect(container.querySelector(".meridian-lease-line__claim")).toBeNull();
    expect(container.textContent).toContain("open to owners and collaborators");
    expect(container.textContent).toContain("viewer");
  });

  it("renders the same statement for a runtime contributor", () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      refusingBridge(),
      VIEWER_IDENTITY_READ,
      roleRead("runtime contributor"),
    );

    expect(container.querySelector(".meridian-lease-line__claim")).toBeNull();
    expect(container.textContent).toContain("runtime contributor");
  });

  it("offers the claim to a collaborator", () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      refusingBridge(),
      VIEWER_IDENTITY_READ,
      roleRead("collaborator"),
    );

    expect(claimControl(container).textContent).toBe("Claim the shell");
  });

  it("still offers the handback to a holder whose role has dropped to viewer", () => {
    // Authorization loss propagates as an event, and until a transition says
    // otherwise this participant holds the shell. Withdrawing the release control
    // here would strand the keyboard with no way to give it back.
    const { container } = renderLease(
      leaseState({
        holding: "held-by-you",
        holderParticipantId: VIEWER_PARTICIPANT,
        holderVouching: "vouched",
      }),
      refusingBridge(),
      VIEWER_IDENTITY_READ,
      roleRead("viewer"),
    );

    expect(claimControl(container).textContent).toBe("Release the shell");
    expect(container.textContent).not.toContain("open to owners and collaborators");
  });

  it("says the role is still being read rather than showing nothing at all", () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      refusingBridge(),
      VIEWER_IDENTITY_READ,
      { status: "not-loaded" },
    );

    expect(container.querySelector(".meridian-lease-line__claim")).toBeNull();
    expect(container.textContent).toContain("Reading what you may do");
  });

  it("negative control: the holder line is unchanged by any of this", () => {
    // The gate is about the CONTROL. A line that had blanked itself for a viewer
    // would satisfy every case above and tell nobody who holds the shell.
    const { container } = renderLease(
      leaseState({
        holding: "held-by-another",
        holderParticipantId: OTHER_PARTICIPANT,
        holderVouching: "vouched",
      }),
      refusingBridge(),
      VIEWER_IDENTITY_READ,
      roleRead("viewer"),
    );

    expect(container.textContent).toContain("Held by");
    expect(container.textContent).toContain(OTHER_PARTICIPANT);
  });
});
