// The sent-invite ledger: what it reads, what it refuses to draw, and what it
// will not turn a refusal into.
//
// The properties worth the most are the two absences. A ledger that rendered an
// empty list for an unregistered read would tell a person they had invited
// nobody, which is a fact this console never established; and a create control
// drawn against a request the console cannot compose would be a capability
// claimed and not implemented, which is the shape the whole surface set forbids.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { InviteRevokeResponse } from "@ai-sidekicks/contracts";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
  unscriptedScenario,
} from "../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { formatClockTime, formatDateTime } from "../primitives/index.js";
import type { SentInvite } from "./invite-ledger.js";
import { SentInvites } from "./SentInvites.js";

/**
 * A scenario with nothing scripted.
 *
 * The point is that it scripts NO reply: the fixture bridge then refuses every
 * `daemon.call`, which is exactly the arm the revoke control has to render.
 */
const EMPTY_SCENARIO = unscriptedScenario("collaboration-invites-test");

function invite(overrides: Partial<SentInvite> = {}): SentInvite {
  return {
    inviteId: "invite-1",
    state: "pending",
    expiresAt: "2026-01-08T10:05:00.000Z",
    ...overrides,
  };
}

/**
 * The real fixture bridge, with the one growth operation this surface reads REFUSING.
 *
 * The fixture serves `invitesList` — a scenario answers it from its own script and
 * otherwise from the empty ledger — so the refusal this surface has to render is a
 * fact about the LIVE bridge rather than about a scenario that scripts nothing. The
 * refusal is the shipped port's own `growthUnavailable`, not a hand-written envelope,
 * so what this asserts is what a release build actually produces.
 */
function bridgeRefusingInvites(): ConsoleBridge {
  return fixtureBridgeWithGrowth(EMPTY_SCENARIO, {
    invitesList: growthRefusing("invitesList"),
  });
}

/** The real fixture bridge, with the one growth operation this surface reads served. */
function bridgeServing(invites: readonly SentInvite[]): ConsoleBridge {
  return fixtureBridgeWithGrowth(EMPTY_SCENARIO, { invitesList: growthServing(invites) });
}

/**
 * A scenario whose only scripted reply is the one `invite.revoke` answers with.
 *
 * The reply is the shipped `InviteRevokeResponse` shape — `{inviteId, state}` and
 * nothing else — so what the ledger consumes here is what the daemon actually sends.
 */
function scenarioSettlingRevoke(inviteId: string): ConsoleScenario {
  return {
    ...unscriptedScenario("collaboration-invites-revoke-test"),
    replies: [{ call: "invite.revoke", result: { inviteId, state: "revoked" } }],
  };
}

/** The bridge for a revoke that settles, with every `invitesList` call counted. */
function bridgeSettlingRevoke(invites: readonly SentInvite[]): {
  readonly bridge: ConsoleBridge;
  readonly invitesListCallCount: () => number;
} {
  const invitesList = vi.fn(growthServing(invites));
  return {
    bridge: fixtureBridgeWithGrowth(scenarioSettlingRevoke("invite-1"), { invitesList }),
    invitesListCallCount: () => invitesList.mock.calls.length,
  };
}

/** Press the one revoke control on screen and let its reply land. */
async function pressRevoke(container: HTMLElement): Promise<void> {
  const revoke = container.querySelector<HTMLButtonElement>(".meridian-invites__row-action");
  await act(async () => {
    revoke?.click();
    await Promise.resolve();
  });
  await settle();
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
    const { container } = render(
      <SentInvites bridge={bridgeRefusingInvites()} sessionId="session-1" />,
    );
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
          invite({ inviteId: "invite-2", expiresAt: NEXT_DAY_SAME_MINUTE }),
        ])}
        sessionId="session-1"
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

describe("sent invites — one revoke at a time", () => {
  /** Every revoke control on screen, read fresh after each render. */
  function revokeControls(container: HTMLElement): readonly HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".meridian-invites__row-action")];
  }

  async function renderTwoPending(): Promise<HTMLElement> {
    const { container } = render(
      <SentInvites
        bridge={bridgeServing([
          invite({ inviteId: "invite-one" }),
          invite({ inviteId: "invite-two" }),
        ])}
        sessionId="session-1"
      />,
    );
    await settle();
    return container;
  }

  it("closes every pending row's control while one revoke is unsettled", async () => {
    const container = await renderTwoPending();
    expect(revokeControls(container).map((control) => control.disabled)).toStrictEqual([
      false,
      false,
    ]);

    // A SYNCHRONOUS act on purpose: the coordinator publishes its pending key
    // before the call it awaits settles, so this reads the tree at exactly the
    // moment one revoke is in flight. An awaiting act would flush the reply first
    // and find the surface back at rest.
    act(() => {
      revokeControls(container)[0]?.click();
    });

    expect(revokeControls(container).map((control) => control.disabled)).toStrictEqual([
      true,
      true,
    ]);
    // The row that was pressed says what it is doing; its neighbour is only shut.
    expect(revokeControls(container)[0]?.textContent).toBe("Revoking…");
    expect(revokeControls(container)[1]?.textContent).toBe("Revoke");
    await settle();
  });

  it("negative control: both controls open again once that revoke settles", async () => {
    // Without this, the case above would pass over a ledger that disabled every
    // revoke control permanently.
    const container = await renderTwoPending();

    await pressRevoke(container);

    expect(container.textContent ?? "").toContain("reply-unscripted");
    expect(revokeControls(container).map((control) => control.disabled)).toStrictEqual([
      false,
      false,
    ]);
  });
});

describe("sent invites — a revoke that settles", () => {
  it("moves the row into the settled ledger from the reply itself", async () => {
    const served = bridgeSettlingRevoke([invite()]);
    const { container } = render(<SentInvites bridge={served.bridge} sessionId="session-1" />);
    await settle();
    expect(container.querySelector(".meridian-invites__row-action")).not.toBeNull();

    await pressRevoke(container);

    // The row is in the fold now, carrying the state the daemon sent — and the
    // pending half says so rather than still offering a control on it.
    const fold = container.querySelector("details");
    expect(fold?.textContent ?? "").toContain("invite-1");
    expect(fold?.textContent ?? "").toContain("revoked");
    expect(container.textContent ?? "").toContain("No invitation is still waiting");
    expect(container.querySelector(".meridian-invites__row-action")).toBeNull();
  });

  it("puts no second read on the wire, because the reply carried the row", async () => {
    const served = bridgeSettlingRevoke([invite()]);
    const { container } = render(<SentInvites bridge={served.bridge} sessionId="session-1" />);
    await settle();
    expect(served.invitesListCallCount()).toBe(1);

    await pressRevoke(container);

    expect(served.invitesListCallCount()).toBe(1);
  });

  it("negative control: a refused revoke leaves the row pending and offers the control again", async () => {
    // Without this, the two cases above would pass over a ledger that settled every
    // row it was asked about, refusal or not.
    const { container } = render(
      <SentInvites bridge={bridgeServing([invite()])} sessionId="session-1" />,
    );
    await settle();

    await pressRevoke(container);

    expect(container.textContent ?? "").toContain("reply-unscripted");
    const action = container.querySelector<HTMLButtonElement>(".meridian-invites__row-action");
    expect(action).not.toBeNull();
    expect(action?.disabled).toBe(false);
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("sent invites — the session a row and a control belong to", () => {
  /** The two sessions the members section moves between, each with its own row. */
  const SESSION_A = "session-a";
  const SESSION_B = "session-b";

  /**
   * The daemon's own revoke reply for one row.
   *
   * The id is branded on the wire and every id in this file is a plain string, so
   * the narrowing happens here — at the one seam that hands a reply to the surface —
   * exactly as `SentInvites` narrows the request it sends.
   */
  function revokedReply(inviteId: string): InviteRevokeResponse {
    return { inviteId: inviteId as InviteRevokeResponse["inviteId"], state: "revoked" };
  }

  /** A bridge whose invites read answers per session, as the real one is scoped to. */
  function bridgeServingPerSession(
    rowsBySession: Readonly<Record<string, readonly SentInvite[]>>,
  ): ConsoleBridge {
    return fixtureBridgeWithGrowth(EMPTY_SCENARIO, {
      invitesList: async (request) =>
        await Promise.resolve({ status: "served", value: rowsBySession[request.sessionId] ?? [] }),
    });
  }

  /**
   * A bridge that holds `invite.revoke` open and records what each call asked for.
   *
   * Holding the call is what makes the defect visible: a reply delivered on the next
   * microtask settles the coordinator before the session can move, and every
   * ordering then looks correct.
   */
  function bridgeHoldingRevoke(rowsBySession: Readonly<Record<string, readonly SentInvite[]>>): {
    readonly bridge: ConsoleBridge;
    readonly revokeRequests: readonly unknown[];
    readonly settleRevoke: (reply: InviteRevokeResponse) => void;
  } {
    const base = bridgeServingPerSession(rowsBySession);
    const revokeRequests: unknown[] = [];
    let release: ((reply: InviteRevokeResponse) => void) | undefined;
    const call = (async (method: string, params: unknown): Promise<unknown> => {
      if (method !== "invite.revoke") {
        throw new Error(`unscripted ${method}`);
      }
      revokeRequests.push(params);
      return await new Promise<InviteRevokeResponse>((resolve) => {
        release = resolve;
      });
    }) as unknown as ConsoleBridge["sidekicks"]["daemon"]["call"];
    return {
      bridge: {
        ...base,
        sidekicks: { ...base.sidekicks, daemon: { ...base.sidekicks.daemon, call } },
      },
      revokeRequests,
      settleRevoke: (reply) => {
        release?.(reply);
      },
    };
  }

  function revokeControls(container: HTMLElement): readonly HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".meridian-invites__row-action")];
  }

  it("draws no row of the session it left on the frame that names the one it entered", async () => {
    const bridge = bridgeServingPerSession({
      [SESSION_A]: [invite({ inviteId: "invite-from-a" })],
      [SESSION_B]: [invite({ inviteId: "invite-from-b" })],
    });
    const view = render(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();
    expect(view.container.textContent ?? "").toContain("invite-from-a");

    // No await: this is the committed frame between the render that renames the
    // session and the effect that installs its read.
    view.rerender(<SentInvites bridge={bridge} sessionId={SESSION_B} />);

    expect(view.container.textContent ?? "").not.toContain("invite-from-a");
    expect(view.container.textContent ?? "").toContain("Reading this session's invitations");
    // There is therefore no control to press, so no request pairing one session's
    // id with another session's row can be composed at all.
    expect(revokeControls(view.container)).toHaveLength(0);

    await settle();
    expect(view.container.textContent ?? "").toContain("invite-from-b");
  });

  it("negative control: the frame before the move DOES carry the row it read", async () => {
    // Without this, the case above would pass over a ledger that rendered no row at
    // any point — a different defect wearing the same green.
    const bridge = bridgeServingPerSession({
      [SESSION_A]: [invite({ inviteId: "invite-from-a" })],
    });
    const { container } = render(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();
    expect(container.textContent ?? "").toContain("invite-from-a");
    expect(revokeControls(container)).toHaveLength(1);
  });

  it("negative control: after the move the control works again, on this session's pair", async () => {
    // Without this, the cases around it would pass over a ledger that stopped
    // offering a usable revoke the moment a session ever changed.
    const held = bridgeHoldingRevoke({
      [SESSION_A]: [invite({ inviteId: "invite-from-a" })],
      [SESSION_B]: [invite({ inviteId: "invite-from-b" })],
    });
    const view = render(<SentInvites bridge={held.bridge} sessionId={SESSION_A} />);
    await settle();
    view.rerender(<SentInvites bridge={held.bridge} sessionId={SESSION_B} />);
    await settle();

    await act(async () => {
      revokeControls(view.container)[0]?.click();
      await Promise.resolve();
    });

    expect(held.revokeRequests).toStrictEqual([
      { sessionId: SESSION_B, inviteId: "invite-from-b" },
    ]);
  });

  it("leaves the entered session's controls open while the left session's revoke hangs", async () => {
    const held = bridgeHoldingRevoke({
      [SESSION_A]: [invite({ inviteId: "invite-from-a" })],
      [SESSION_B]: [invite({ inviteId: "invite-from-b" })],
    });
    const view = render(<SentInvites bridge={held.bridge} sessionId={SESSION_A} />);
    await settle();
    await act(async () => {
      revokeControls(view.container)[0]?.click();
      await Promise.resolve();
    });
    expect(held.revokeRequests).toHaveLength(1);

    view.rerender(<SentInvites bridge={held.bridge} sessionId={SESSION_B} />);
    await settle();

    // One coordinator per session: the unsettled revoke belongs to the session that
    // was left, and closing this session's control would refuse a press for an act
    // nobody here performed.
    expect(revokeControls(view.container).map((control) => control.disabled)).toStrictEqual([
      false,
    ]);
    expect(view.container.textContent ?? "").not.toContain("still being applied");
  });

  it("installs nothing when the left session's revoke finally answers", async () => {
    const held = bridgeHoldingRevoke({
      [SESSION_A]: [invite({ inviteId: "invite-from-a" })],
      [SESSION_B]: [invite({ inviteId: "invite-from-a" })],
    });
    const view = render(<SentInvites bridge={held.bridge} sessionId={SESSION_A} />);
    await settle();
    await act(async () => {
      revokeControls(view.container)[0]?.click();
      await Promise.resolve();
    });
    view.rerender(<SentInvites bridge={held.bridge} sessionId={SESSION_B} />);
    await settle();

    // The reply names an id THIS session also holds — the worst case, and the one a
    // ledger that folded a superseded settlement would silently move.
    await act(async () => {
      held.settleRevoke(revokedReply("invite-from-a"));
      await Promise.resolve();
    });
    await settle();

    expect(view.container.querySelector("details")).toBeNull();
    expect(revokeControls(view.container)).toHaveLength(1);
    expect(view.container.textContent ?? "").not.toContain("revoked");
  });
});
