// Which session a row and a control belong to.
//
// The seam the module holds through the family's subject-scoped holder: a settlement
// that arrives after the surface has been re-addressed publishes nowhere, including
// on the round-trip back to a session it has already been on, where the
// `(bridge, sessionId)` pair compares equal on two different visits.
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { InviteRevokeResponse } from "@ai-sidekicks/contracts";

import {
  fixtureBridgeWithGrowth,
  withDaemonCall,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleBridge, InvitesListOutcome, ServedInvite } from "../../bridge/index.js";
import { SentInvites } from "./SentInvites.js";
import {
  EMPTY_SCENARIO,
  INVITE_FROM_A,
  INVITE_FROM_B,
  SESSION_A,
  SESSION_B,
  invite,
  settle,
} from "./sent-invites.test-support.js";

describe("sent invites — the session a row and a control belong to", () => {
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
    rowsBySession: Readonly<Record<string, readonly ServedInvite[]>>,
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
  function bridgeHoldingRevoke(rowsBySession: Readonly<Record<string, readonly ServedInvite[]>>): {
    readonly bridge: ConsoleBridge;
    readonly revokeRequests: readonly unknown[];
    readonly settleRevoke: (reply: InviteRevokeResponse) => void;
  } {
    let release: ((reply: InviteRevokeResponse) => void) | undefined;
    // Through the shared call-arm helper rather than a spread written here: it holds
    // the record of what was asked, and a second copy of the spread would be a second
    // place the bridge's namespace shape is restated.
    const { bridge, calls } = withDaemonCall(
      bridgeServingPerSession(rowsBySession),
      async ({ method }) => {
        if (method !== "invite.revoke") {
          throw new Error(`unscripted ${method}`);
        }
        return await new Promise<InviteRevokeResponse>((resolve) => {
          release = resolve;
        });
      },
    );
    return {
      bridge,
      // A getter, because `calls` is the live record the helper pushes into: mapping
      // it here would freeze the empty array the construction call sees.
      get revokeRequests(): readonly unknown[] {
        return calls.map((call) => call.params);
      },
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
      [SESSION_A]: [invite({ inviteId: INVITE_FROM_A })],
      [SESSION_B]: [invite({ inviteId: INVITE_FROM_B })],
    });
    const view = render(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();
    expect(view.container.textContent ?? "").toContain(INVITE_FROM_A);

    // No await: this is the committed frame between the render that renames the
    // session and the effect that installs its read.
    view.rerender(<SentInvites bridge={bridge} sessionId={SESSION_B} />);

    expect(view.container.textContent ?? "").not.toContain(INVITE_FROM_A);
    expect(view.container.textContent ?? "").toContain("Reading this session's invitations");
    // There is therefore no control to press, so no request pairing one session's
    // id with another session's row can be composed at all.
    expect(revokeControls(view.container)).toHaveLength(0);

    await settle();
    expect(view.container.textContent ?? "").toContain(INVITE_FROM_B);
  });

  it("drops a read that answers after the surface has been back to the session it left", async () => {
    // The A → B → A round-trip. `(bridge, sessionId)` compares EQUAL on the first and
    // third visits, so a pair comparison — which is what this surface used to hold
    // instead of the family's holder — reads a settlement from the first visit as
    // current on the third and installs a ledger nobody asked for on this visit.
    // The holder's addressing tells the two visits apart, so the stale answer is
    // dropped and the third visit's own read is what lands.
    let releaseFirstVisit: ((outcome: InvitesListOutcome) => void) | undefined;
    let listCallCount = 0;
    const bridge = fixtureBridgeWithGrowth(EMPTY_SCENARIO, {
      invitesList: async () => {
        listCallCount += 1;
        if (listCallCount === 1) {
          return await new Promise<InvitesListOutcome>((resolve) => {
            releaseFirstVisit = resolve;
          });
        }
        return await Promise.resolve({
          status: "served",
          value: [invite({ inviteId: INVITE_FROM_B })],
        });
      },
    });

    const view = render(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();
    view.rerender(<SentInvites bridge={bridge} sessionId={SESSION_B} />);
    await settle();
    view.rerender(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();

    // The first visit's read answers now, naming a row only that visit asked for.
    await act(async () => {
      releaseFirstVisit?.({
        status: "served",
        value: [invite({ inviteId: INVITE_FROM_A })],
      });
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(view.container.textContent ?? "").not.toContain(INVITE_FROM_A);
  });

  it("negative control: the third visit's own read is what the ledger shows", async () => {
    // Without this, the case above would pass over a ledger that showed no row at
    // all after a round-trip — the stale answer dropped and the fresh one with it.
    const bridge = bridgeServingPerSession({
      [SESSION_A]: [invite({ inviteId: INVITE_FROM_A })],
      [SESSION_B]: [invite({ inviteId: INVITE_FROM_B })],
    });
    const view = render(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();
    view.rerender(<SentInvites bridge={bridge} sessionId={SESSION_B} />);
    await settle();
    view.rerender(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();

    expect(view.container.textContent ?? "").toContain(INVITE_FROM_A);
  });

  it("negative control: the frame before the move DOES carry the row it read", async () => {
    // Without this, the case above would pass over a ledger that rendered no row at
    // any point — a different defect wearing the same green.
    const bridge = bridgeServingPerSession({
      [SESSION_A]: [invite({ inviteId: INVITE_FROM_A })],
    });
    const { container } = render(<SentInvites bridge={bridge} sessionId={SESSION_A} />);
    await settle();
    expect(container.textContent ?? "").toContain(INVITE_FROM_A);
    expect(revokeControls(container)).toHaveLength(1);
  });

  it("negative control: after the move the control works again, on this session's pair", async () => {
    // Without this, the cases around it would pass over a ledger that stopped
    // offering a usable revoke the moment a session ever changed.
    const held = bridgeHoldingRevoke({
      [SESSION_A]: [invite({ inviteId: INVITE_FROM_A })],
      [SESSION_B]: [invite({ inviteId: INVITE_FROM_B })],
    });
    const view = render(<SentInvites bridge={held.bridge} sessionId={SESSION_A} />);
    await settle();
    view.rerender(<SentInvites bridge={held.bridge} sessionId={SESSION_B} />);
    await settle();

    await act(async () => {
      revokeControls(view.container)[0]?.click();
      await crossMacrotaskBoundary();
    });

    expect(held.revokeRequests).toStrictEqual([{ sessionId: SESSION_B, inviteId: INVITE_FROM_B }]);
  });

  it("leaves the entered session's controls open while the left session's revoke hangs", async () => {
    const held = bridgeHoldingRevoke({
      [SESSION_A]: [invite({ inviteId: INVITE_FROM_A })],
      [SESSION_B]: [invite({ inviteId: INVITE_FROM_B })],
    });
    const view = render(<SentInvites bridge={held.bridge} sessionId={SESSION_A} />);
    await settle();
    await act(async () => {
      revokeControls(view.container)[0]?.click();
      await crossMacrotaskBoundary();
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
      [SESSION_A]: [invite({ inviteId: INVITE_FROM_A })],
      [SESSION_B]: [invite({ inviteId: INVITE_FROM_A })],
    });
    const view = render(<SentInvites bridge={held.bridge} sessionId={SESSION_A} />);
    await settle();
    await act(async () => {
      revokeControls(view.container)[0]?.click();
      await crossMacrotaskBoundary();
    });
    view.rerender(<SentInvites bridge={held.bridge} sessionId={SESSION_B} />);
    await settle();

    // The reply names an id THIS session also holds — the worst case, and the one a
    // ledger that folded a superseded settlement would silently move.
    await act(async () => {
      held.settleRevoke(revokedReply(INVITE_FROM_A));
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(view.container.querySelector("details")).toBeNull();
    expect(revokeControls(view.container)).toHaveLength(1);
    expect(view.container.textContent ?? "").not.toContain("revoked");
  });
});
