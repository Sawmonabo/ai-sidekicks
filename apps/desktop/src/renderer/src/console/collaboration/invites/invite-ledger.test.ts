// The ledger fold, driven on values rather than through a render.
//
// The two properties worth pinning here are the ones a rendered assertion cannot
// see: that a settlement naming a row this ledger never held changes nothing, and
// that "changes nothing" means the SAME outcome object, so a surface holding it in
// state does not re-render over a reply it had no row for.

import { describe, expect, it } from "vitest";

import type { InviteId, InviteRevokeResponse } from "@ai-sidekicks/contracts";

import {
  growthUnavailable,
  type InvitesListOutcome,
  type ServedInvite,
} from "../../bridge/index.js";
import { partitionInvites, withSettledInvite } from "./invite-ledger.js";

function invite(overrides: Partial<ServedInvite> = {}): ServedInvite {
  return {
    inviteId: "invite-1",
    state: "pending",
    expiresAt: "2026-01-08T10:05:00.000Z",
    ...overrides,
  };
}

function served(invites: readonly ServedInvite[]): InvitesListOutcome {
  return { status: "served", value: invites };
}

/**
 * One `invite.revoke` reply.
 *
 * The id brand is compile-time nominal typing over a plain string and the narrowing
 * happens at this one seam, exactly as it does at the surface's own call site.
 */
function revokedReply(inviteId: string): InviteRevokeResponse {
  return { inviteId: inviteId as InviteId, state: "revoked" };
}

describe("the ledger's two halves", () => {
  it("puts a pending row in one half and every settled state in the other", () => {
    const ledger = partitionInvites([
      invite({ inviteId: "pending-one" }),
      invite({ inviteId: "accepted-one", state: "accepted" }),
      invite({ inviteId: "revoked-one", state: "revoked" }),
      invite({ inviteId: "expired-one", state: "expired" }),
    ]);
    expect(ledger.pending.map((row) => row.inviteId)).toStrictEqual(["pending-one"]);
    expect(ledger.settled.map((row) => row.inviteId)).toStrictEqual([
      "accepted-one",
      "revoked-one",
      "expired-one",
    ]);
  });
});

describe("consuming one settled revocation", () => {
  it("writes the state the daemon sent onto the row the daemon named", () => {
    const next = withSettledInvite(
      served([invite(), invite({ inviteId: "invite-2" })]),
      revokedReply("invite-1"),
    );
    expect(next?.status).toBe("served");
    const rows = next?.status === "served" ? next.value : [];
    expect(rows.map((row) => [row.inviteId, row.state])).toStrictEqual([
      ["invite-1", "revoked"],
      ["invite-2", "pending"],
    ]);
  });

  it("answers with the very same outcome when it held no such row", () => {
    const held = served([invite()]);
    expect(withSettledInvite(held, revokedReply("invite-absent"))).toBe(held);
  });

  it("leaves a refused read refused rather than inventing a ledger to write into", () => {
    const refused = growthUnavailable("invitesList");
    expect(withSettledInvite(refused, revokedReply("invite-1"))).toBe(refused);
    expect(withSettledInvite(undefined, revokedReply("invite-1"))).toBeUndefined();
  });

  it("negative control: the matching case above really does produce a new outcome", () => {
    // Without this, the identity cases would pass over a fold that returned its
    // argument unconditionally.
    const held = served([invite()]);
    expect(withSettledInvite(held, revokedReply("invite-1"))).not.toBe(held);
  });
});
