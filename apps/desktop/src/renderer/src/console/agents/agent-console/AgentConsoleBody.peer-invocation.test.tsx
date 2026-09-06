// The peer-invocation grant, and the one thing a pane that MOVES gets wrong.
//
// The pane stays mounted when the console goes from one session to another — the
// deck hands it new props rather than a new instance — so the control's own record
// of what a mutation settled with outlived the session it was about. Two ways: the
// value kept winning over the session the console had arrived at, and a reply from
// the session it had left could land after the move and decide the switch there. A
// refusal the participant raised is the third: it is theirs and not the grant's, so
// a partition that moves under it retires the settlement and never the refusal.
//
// Every case drives the real pane over a real fixture bridge with one scripted
// daemon method, because both defects are only visible in an ORDER — a mutation, a
// move, and a reply — and a bridge that answered on the next microtask could not put
// the move between the last two.
//
// What one ROUND of the mutation may do while another is outstanding is
// `AgentConsoleBody.peer-invocation.rounds.test.tsx`, over the same cast in
// `peer-invocation-pane.test-support.tsx`.

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleReads } from "./agent-console.test-support.js";
import {
  FIRST_SESSION_ID,
  PeerInvocationDaemon,
  SECOND_SESSION_ID,
  bridgeCalling,
  pane,
  pressGrantOn,
  projectGrant,
  storeProjecting,
  switchState,
} from "./peer-invocation-pane.test-support.js";

describe("agent console — the peer-invocation settlement belongs to one session", () => {
  it("shows the session it moved to, not the one it settled in", async () => {
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container, rerender } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);
    expect(switchState(container)).toBe(true);

    rerender(pane(bridge, storeProjecting(SECOND_SESSION_ID, false)));
    await settleReads(bridge);

    expect(switchState(container)).toBe(false);
  });

  it("drops a reply from the session it has left", async () => {
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    scriptedDaemon.holdNextReply();
    const { container, rerender } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);
    await pressGrantOn(container);

    rerender(pane(bridge, storeProjecting(SECOND_SESSION_ID, false)));
    await settleReads(bridge);
    await act(async () => {
      await scriptedDaemon.settleHeldReply(true);
    });
    await settleReads(bridge);

    expect(switchState(container)).toBe(false);
  });

  it("shows what the projection says once it has moved past the reply", async () => {
    // The session stamp only reaches a move BETWEEN sessions. Within one session the
    // reply used to win forever, so a grant another participant turned off — or a
    // reconnect read that answered differently — never reached the switch, and the
    // control sat on a value nothing on the wire claimed any more.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);
    expect(switchState(container)).toBe(true);

    // The projection moving is a read landing in the store, which is exactly what a
    // reconnect and another participant's event both are.
    await act(async () => {
      sessionStore.initialise({
        cursor: 9,
        entities: [
          { kind: "session", id: FIRST_SESSION_ID, body: { peerInvocationEnabled: false } },
        ],
        participantJoinLog: [],
      });
      await crossMacrotaskBoundary();
    });

    expect(switchState(container)).toBe(false);
  });

  it("negative control: a projection that has not moved leaves the reply standing", async () => {
    // Without this the case above would pass over a control that retired every
    // settlement on the next render, which would put a person's accepted choice back
    // to the projection's older answer a frame after they made it.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container, rerender } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);

    rerender(pane(bridge, sessionStore));
    await settleReads(bridge);

    expect(switchState(container)).toBe(true);
  });

  it("negative control: the settlement does win for the session it was asked of", async () => {
    // Without this, both cases above would pass over a control that ignored every
    // settlement — which would leave a person's accepted choice invisible until
    // something else re-read the projection.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);
    expect(switchState(container)).toBe(false);

    await pressGrantOn(container);
    await settleReads(bridge);

    expect(switchState(container)).toBe(true);
  });
});

describe("agent console — a refused grant is the participant's own fact", () => {
  it("keeps the refusal when the session partition moves under it", async () => {
    // The projection moving is the daemon speaking more recently about the GRANT. It
    // says nothing about whether this participant's press was refused, and the
    // refusal used to be retired with the settlement anyway — so any unrelated
    // partition event (another participant's `session.*`, a reconnect read, the
    // re-read control beside this one) took the reason off the screen with no act of
    // theirs, possibly before it was read.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    scriptedDaemon.refuseNextReply("peer invocation is not yours to set");
    await pressGrantOn(container);
    await settleReads(bridge);
    expect(container.textContent ?? "").toContain("peer invocation is not yours to set");

    await projectGrant(sessionStore, false);

    expect(container.textContent ?? "").toContain("peer invocation is not yours to set");
  });

  it("replaces it on the next press rather than letting it stand for ever", async () => {
    // The other half. A refusal is kept because nothing but the participant has
    // spoken about it — so the moment they speak again, it goes.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    scriptedDaemon.refuseNextReply("peer invocation is not yours to set");
    await pressGrantOn(container);
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);

    expect(container.textContent ?? "").not.toContain("peer invocation is not yours to set");
    expect(switchState(container)).toBe(true);
  });

  it("negative control: a settlement IS retired when the partition moves", async () => {
    // Without this, the first case would hold for a control that kept every arm
    // through a projection move — which is the defect the move exists to fix: a
    // grant another participant turned off would go on reading as on.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);
    expect(switchState(container)).toBe(true);

    await projectGrant(sessionStore, false);

    expect(switchState(container)).toBe(false);
  });
});
