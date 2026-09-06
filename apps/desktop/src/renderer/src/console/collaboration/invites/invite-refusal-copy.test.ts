// What a person is told, on each of the invite plane's two paths.

import { describe, expect, it } from "vitest";

import {
  INVITE_WIRE_REFUSAL_CODES,
  inviteAcceptanceMeaning,
  inviteCreateRemedy,
  isInviteWireRefusalCode,
} from "./invite-refusal-copy.js";

describe("the create path's remedies", () => {
  it("names a remedy for each limit a mint can hit", () => {
    expect(inviteCreateRemedy("invite.limit_exceeded")).toContain("Revoke an invitation");
    expect(inviteCreateRemedy("rate_limited")).toContain("Revoke an invitation");
    expect(inviteCreateRemedy("invite.permission_denied")).toContain("owner");
  });

  it("stays silent where there is nothing to do", () => {
    // The wire's own sentence always renders; this line is only for the codes whose
    // remedy is not in it, and inventing one for the rest would be the console
    // answering for a daemon it cannot see.
    expect(inviteCreateRemedy("invite.not_found")).toBeUndefined();
    expect(inviteCreateRemedy("session.not_found")).toBeUndefined();
  });
});

describe("the accept path's meanings", () => {
  it("says something about every code the plane registers", () => {
    // Exhaustive rather than sampled: the whole point of the table is that a person
    // holding a link is never shown a bare identifier.
    for (const code of INVITE_WIRE_REFUSAL_CODES) {
      expect(inviteAcceptanceMeaning(code)?.length ?? 0).toBeGreaterThan(0);
    }
    expect(INVITE_WIRE_REFUSAL_CODES).toHaveLength(6);
  });

  it("tells a lapsed invitation apart from a withdrawn one", () => {
    // One is the clock and the other is a person changing their mind, and the remedy
    // reads differently even though both arrive as 410.
    expect(inviteAcceptanceMeaning("invite.expired")).toContain("stops working");
    expect(inviteAcceptanceMeaning("invite.revoked")).toContain("withdrawn");
  });

  it("names trying again only where trying again is the remedy", () => {
    expect(inviteAcceptanceMeaning("invite.limit_exceeded")).toContain("try it again shortly");
    for (const code of ["invite.not_found", "invite.expired", "invite.revoked"]) {
      expect(inviteAcceptanceMeaning(code)).not.toContain("try it again");
    }
  });

  it("says nothing about a code some other subsystem owns", () => {
    expect(inviteAcceptanceMeaning("session.not_found")).toBeUndefined();
    expect(isInviteWireRefusalCode("session.not_found")).toBe(false);
  });

  it("negative control: a registered code IS recognized", () => {
    // Without this the case above would pass over a predicate that answered false to
    // everything, and the whole table would be unreachable.
    expect(isInviteWireRefusalCode("invite.revoked")).toBe(true);
  });
});
