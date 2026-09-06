// What the sent-invite ledger reads, and what it refuses to draw from it.
//
// The properties worth the most are the two absences. A ledger that rendered an
// empty list for an unregistered read would tell a person they had invited nobody,
// which is a fact this console never established; and a create control drawn against
// a request the console cannot compose would be a capability claimed and not
// implemented, which is the shape the whole surface set forbids.
//
// The revoke MUTATION is `SentInvites.revoking.test.tsx` and the session a row
// belongs to is `SentInvites.subject.test.tsx`: three questions on the module's own
// three seams, over the one cast in `sent-invites.test-support.tsx`.
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fixtureBridgeWithGrowth } from "../../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { formatClockTime, formatDateTime } from "../../primitives/index.js";
import { SentInvites } from "./SentInvites.js";
import {
  EMPTY_SCENARIO,
  INVITE_2,
  INVITE_ACCEPTED,
  INVITE_EXPIRED,
  INVITE_PENDING,
  INVITE_REVOKED,
  SESSION_ID,
  bridgeRefusingInvites,
  bridgeServing,
  invite,
  settle,
} from "./sent-invites.test-support.js";

describe("sent invites — the read", () => {
  it("renders the port's refusal verbatim rather than an empty ledger", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeRefusingInvites()} sessionId={SESSION_ID} />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("wire-unregistered");
    expect(container.textContent ?? "").not.toContain("Nobody has been invited");
  });

  it("negative control: a served empty list DOES say nobody was invited", async () => {
    // Without this, the case above would pass over a ledger that never rendered
    // its empty state at all.
    const { container } = render(<SentInvites bridge={bridgeServing([])} sessionId={SESSION_ID} />);
    await settle();
    expect(container.textContent ?? "").toContain("Nobody has been invited");
    expect(container.textContent ?? "").not.toContain("wire-unregistered");
  });

  it("says nothing was asked when the section holds no session", async () => {
    const bridge = fixtureBridgeWithGrowth(EMPTY_SCENARIO, {});
    const { container } = render(<SentInvites bridge={bridge} sessionId={undefined} />);
    await settle();
    expect(container.textContent ?? "").toContain("has not asked");
  });
});

describe("sent invites — an expiry names the day it falls on", () => {
  /** The same wall-clock minute as the fixture's expiry, one day later. */
  const NEXT_DAY_SAME_MINUTE = "2026-01-09T10:05:00.000Z";

  /** What each row prints for its expiry, found by the instant it carries. */
  function expiryReadings(container: HTMLElement, instants: readonly string[]): string[] {
    return instants.map((instant) => {
      const figure = container.querySelector(`.meridian-invites__row-facts [title="${instant}"]`);
      if (figure === null) {
        throw new Error(`no expiry figure for ${instant}`);
      }
      return figure.textContent ?? "";
    });
  }

  it("prints two expiries a day apart as two different readings", async () => {
    // The ledger has no day divider to carry the date once, so a clock-only reading
    // made "stops working tomorrow" and "stops working today" the same six
    // characters — and the row a person would revoke first was unfindable.
    const { container } = render(
      <SentInvites
        bridge={bridgeServing([
          invite(),
          invite({ inviteId: INVITE_2, expiresAt: NEXT_DAY_SAME_MINUTE }),
        ])}
        sessionId={SESSION_ID}
      />,
    );
    await settle();

    const [today, tomorrow] = expiryReadings(container, [invite().expiresAt, NEXT_DAY_SAME_MINUTE]);
    expect(today).toBe(formatDateTime(invite().expiresAt));
    expect(tomorrow).not.toBe(today);
  });

  it("negative control: the clock-only reading of those two instants is one string", () => {
    // Without this the case above would pass over two instants that were never a
    // collision, and would prove nothing about which formatter the row reaches for.
    expect(formatClockTime(NEXT_DAY_SAME_MINUTE)).toBe(formatClockTime(invite().expiresAt));
  });
});

describe("sent invites — the ledger", () => {
  it("puts pending rows first and folds the settled ones under one disclosure", async () => {
    const { container } = render(
      <SentInvites
        bridge={bridgeServing([
          invite({ inviteId: INVITE_ACCEPTED, state: "accepted" }),
          invite({ inviteId: INVITE_PENDING }),
          invite({ inviteId: INVITE_EXPIRED, state: "expired" }),
        ])}
        sessionId={SESSION_ID}
      />,
    );
    await settle();
    const fold = container.querySelector("details");
    expect(fold).not.toBeNull();
    expect(fold?.textContent ?? "").toContain("2 already settled");
    expect(fold?.textContent ?? "").toContain(INVITE_ACCEPTED);
    expect(fold?.textContent ?? "").not.toContain(INVITE_PENDING);
  });

  it("offers revoke on a pending row and on no settled one", async () => {
    const { container } = render(
      <SentInvites
        bridge={bridgeServing([
          invite({ inviteId: INVITE_PENDING }),
          invite({ inviteId: INVITE_REVOKED, state: "revoked" }),
        ])}
        sessionId={SESSION_ID}
      />,
    );
    await settle();
    const actions = container.querySelectorAll(".meridian-invites__row-action");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.getAttribute("aria-label")).toBe(`Revoke invitation ${INVITE_PENDING}`);
  });

  it("renders the daemon's refusal against the row that asked for it", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();
    const revoke = container.querySelector<HTMLButtonElement>(".meridian-invites__row-action");
    await act(async () => {
      revoke?.click();
      await Promise.resolve();
    });
    await settle();
    // The scenario scripts no `invite.revoke` reply, so the fixture refuses — and
    // the refusal renders in place rather than vanishing. Both halves of the door's
    // own refusal reach the row: the code a person pastes into a search, and the
    // fixture's own sentence naming which call had no answer. The coordinator adds
    // no prefix of its own to either — a refusal is rendered verbatim, and a family
    // that re-worded one would be paraphrasing the seam that knows what happened.
    expect(container.textContent ?? "").toContain("reply-unscripted");
    expect(container.textContent ?? "").toContain("invite.revoke");
  });

  it("negative control: an untouched row carries no refusal", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();
    expect(container.textContent ?? "").not.toContain("reply-unscripted");
  });
});

describe("sent invites — the controls that are not drawn", () => {
  it("draws no create control and says which read is missing", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
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
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();
    const labels = [...container.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels.some((label) => label.toLowerCase().includes("copy"))).toBe(false);
  });

  it("draws no decline column and never counts down against the pending cap", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
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
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();
    expect(container.querySelector(".meridian-invites__row-action")).not.toBeNull();
  });
});

describe("sent invites — what a person reads", () => {
  it("says revocation is silent", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("is told nothing");
  });

  it("names no governance work anywhere", async () => {
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });
});

describe("sent invites — a read that produced no outcome at all", () => {
  /** The fixture bridge with the ledger's one read REJECTING rather than refusing. */
  function bridgeRejectingInvites(message: string): ConsoleBridge {
    return fixtureBridgeWithGrowth(EMPTY_SCENARIO, {
      invitesList: async () => {
        await Promise.resolve();
        throw new Error(message);
      },
    });
  }

  it("renders the rejection as a refusal rather than as a read still in flight", async () => {
    // The port's contract is that it RESOLVES with an outcome, so a rejection has no
    // arm in its vocabulary — its refusal arm carries a closed code set the port owns.
    // Left unhandled it published nothing and the ledger went on saying "Reading this
    // session's invitations" for the life of the window over a call that had failed.
    const { container } = render(
      <SentInvites
        bridge={bridgeRejectingInvites("the invites read never reached the daemon")}
        sessionId={SESSION_ID}
      />,
    );
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("the invites read never reached the daemon");
    expect(text).not.toContain("Reading this session's invitations.");
    expect(text).not.toContain("Nobody has been invited to this session.");
  });

  it("negative control: a served read still reaches the rows and shows no refusal", async () => {
    // Without this, the case above would hold for a ledger that rendered a refusal
    // whatever the read answered.
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId={SESSION_ID} />,
    );
    await settle();

    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(container.querySelector(".meridian-invites__row-action")).not.toBeNull();
  });
});
