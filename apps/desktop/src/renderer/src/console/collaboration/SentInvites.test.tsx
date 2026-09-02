// The sent-invite ledger: what it reads, what it refuses to draw, and what it
// will not turn a refusal into.
//
// The properties worth the most are the two absences. A ledger that rendered an
// empty list for an unregistered read would tell a person they had invited
// nobody, which is a fact this console never established; and a create control
// drawn against a request the console cannot compose would be a capability
// claimed and not implemented, which is the shape the whole surface set forbids.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { SentInvites, type SentInvite } from "./SentInvites.js";

type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];
type InvitesListOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["invitesList"]>>;

/**
 * A scenario with nothing scripted.
 *
 * The point is that it scripts NO reply: the fixture bridge then refuses every
 * `daemon.call`, which is exactly the arm the revoke control has to render.
 */
const EMPTY_SCENARIO: FixtureScenario = {
  id: "collaboration-invites-test",
  label: "Invites, with nothing scripted",
  purpose: "Drives the sent-invite ledger against a bridge that scripts no reply.",
  sessionId: "session-collaboration",
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

function invite(overrides: Partial<SentInvite> = {}): SentInvite {
  return {
    inviteId: "invite-1",
    state: "pending",
    expiresAt: "2026-01-08T10:05:00.000Z",
    ...overrides,
  };
}

/** The real fixture bridge, with the one growth operation this surface reads served. */
function bridgeServing(invites: readonly SentInvite[]): ConsoleBridge {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  const served: InvitesListOutcome = { status: "served", value: invites };
  return {
    ...fixture,
    growth: { ...fixture.growth, invitesList: async () => await Promise.resolve(served) },
  };
}

/** Let the one-shot read and the effects it schedules land. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("sent invites — the read", () => {
  it("renders the port's refusal verbatim rather than an empty ledger", async () => {
    const bridge = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    const { container } = render(<SentInvites bridge={bridge} sessionId="session-1" />);
    await settle();
    expect(container.textContent ?? "").toContain("wire-unregistered");
    expect(container.textContent ?? "").not.toContain("Nobody has been invited");
  });

  it("negative control: a served empty list DOES say nobody was invited", async () => {
    // Without this, the case above would pass over a ledger that never rendered
    // its empty state at all.
    const { container } = render(<SentInvites bridge={bridgeServing([])} sessionId="session-1" />);
    await settle();
    expect(container.textContent ?? "").toContain("Nobody has been invited");
    expect(container.textContent ?? "").not.toContain("wire-unregistered");
  });

  it("says nothing was asked when the section holds no session", async () => {
    const bridge = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    const { container } = render(<SentInvites bridge={bridge} sessionId={undefined} />);
    await settle();
    expect(container.textContent ?? "").toContain("has not asked");
  });
});

describe("sent invites — the ledger", () => {
  it("puts pending rows first and folds the settled ones under one disclosure", async () => {
    const { container } = render(
      <SentInvites
        bridge={bridgeServing([
          invite({ inviteId: "invite-accepted", state: "accepted" }),
          invite({ inviteId: "invite-pending" }),
          invite({ inviteId: "invite-expired", state: "expired" }),
        ])}
        sessionId="session-1"
      />,
    );
    await settle();
    const fold = container.querySelector("details");
    expect(fold).not.toBeNull();
    expect(fold?.textContent ?? "").toContain("2 already settled");
    expect(fold?.textContent ?? "").toContain("invite-accepted");
    expect(fold?.textContent ?? "").not.toContain("invite-pending");
  });

  it("offers revoke on a pending row and on no settled one", async () => {
    const { container } = render(
      <SentInvites
        bridge={bridgeServing([
          invite({ inviteId: "invite-pending" }),
          invite({ inviteId: "invite-revoked", state: "revoked" }),
        ])}
        sessionId="session-1"
      />,
    );
    await settle();
    const actions = container.querySelectorAll(".meridian-invites__row-action");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.getAttribute("aria-label")).toBe("Revoke invitation invite-pending");
  });

  it("renders the daemon's refusal against the row that asked for it", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    const revoke = container.querySelector<HTMLButtonElement>(".meridian-invites__row-action");
    await act(async () => {
      revoke?.click();
      await Promise.resolve();
    });
    await settle();
    // The scenario scripts no `invite.revoke` reply, so the fixture refuses — and
    // the refusal renders in place rather than vanishing.
    expect(container.textContent ?? "").toContain("reply-unscripted");
    expect(container.textContent ?? "").toContain("The invitation was not applied");
  });

  it("negative control: an untouched row carries no refusal", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    expect(container.textContent ?? "").not.toContain("reply-unscripted");
  });
});

describe("sent invites — the controls that are not drawn", () => {
  it("draws no create control and says which read is missing", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("cannot mint an invitation");
    const labels = [...container.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels.some((label) => label.toLowerCase().includes("invite"))).toBe(false);
  });

  it("draws no copy control, because no row carries a link or a token", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    const labels = [...container.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels.some((label) => label.toLowerCase().includes("copy"))).toBe(false);
  });

  it("draws no decline column and never counts down against the pending cap", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).not.toContain("declined");
    expect(text).not.toMatch(/retry in|try again in|\d+\s*s left/iu);
  });

  it("negative control: the revoke control IS drawn", async () => {
    // Without this, the three cases above would pass over a ledger that drew no
    // controls whatsoever.
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    expect(container.querySelector(".meridian-invites__row-action")).not.toBeNull();
  });
});

describe("sent invites — what a person reads", () => {
  it("says revocation is silent", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("is told nothing");
  });

  it("names no governance work anywhere", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });
});
