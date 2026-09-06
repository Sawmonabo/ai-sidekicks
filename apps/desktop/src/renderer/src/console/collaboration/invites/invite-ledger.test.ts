// The ledger fold, driven on values rather than through a render.
//
// The two properties worth pinning here are the ones a rendered assertion cannot
// see: that a settlement naming a row this ledger never held changes nothing, and
// that "changes nothing" means the SAME reading object, so a surface holding it in
// state does not re-render over a reply it had no row for.

import { describe, expect, it } from "vitest";

import type { InviteId, InviteRevokeResponse } from "@ai-sidekicks/contracts";

import { growthUnavailable, type ServedInvite } from "../../bridge/index.js";
import { partitionInvites, withSettledInvite, type LedgerReading } from "./invite-ledger.js";

function invite(overrides: Partial<ServedInvite> = {}): ServedInvite {
  return {
    inviteId: "invite-1",
    state: "pending",
    expiresAt: "2026-01-08T10:05:00.000Z",
    joinMode: "collaborator",
    ...overrides,
  };
}

/** A reading holding a served answer — what the fold is asked to write into. */
function served(invites: readonly ServedInvite[]): LedgerReading {
  return { kind: "answered", outcome: { status: "served", value: invites } };
}

/** A reading holding the port's own refusal, which the fold must leave alone. */
function refusedByThePort(): LedgerReading {
  return { kind: "answered", outcome: growthUnavailable("invitesList") };
}

/** A reading of a call that produced no outcome at all — the fold's other identity case. */
function unreadable(): LedgerReading {
  return {
    kind: "unreadable",
    refusal: {
      code: "read-failed",
      origin: "sent-invites",
      detail: "the invites read never reached the daemon",
    },
  };
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
    expect(next?.kind).toBe("answered");
    const rows =
      next?.kind === "answered" && next.outcome.status === "served" ? next.outcome.value : [];
    expect(rows.map((row) => [row.inviteId, row.state])).toStrictEqual([
      ["invite-1", "revoked"],
      ["invite-2", "pending"],
    ]);
  });

  it("answers with the very same reading when it held no such row", () => {
    const held = served([invite()]);
    expect(withSettledInvite(held, revokedReply("invite-absent"))).toBe(held);
  });

  it("leaves a refused read refused rather than inventing a ledger to write into", () => {
    const refused = refusedByThePort();
    expect(withSettledInvite(refused, revokedReply("invite-1"))).toBe(refused);
    expect(withSettledInvite(undefined, revokedReply("invite-1"))).toBeUndefined();
  });

  it("does the same for a call that produced no outcome at all", () => {
    // The arm the outcome union has no member for: a rejection. A settlement cannot
    // write a row into a read that never answered, and folding one in would report
    // a failed read as a ledger with exactly one row in it.
    const failed = unreadable();
    expect(withSettledInvite(failed, revokedReply("invite-1"))).toBe(failed);
  });

  it("negative control: the matching case above really does produce a new reading", () => {
    // Without this, the identity cases would pass over a fold that returned its
    // argument unconditionally.
    const held = served([invite()]);
    expect(withSettledInvite(held, revokedReply("invite-1"))).not.toBe(held);
  });
});
