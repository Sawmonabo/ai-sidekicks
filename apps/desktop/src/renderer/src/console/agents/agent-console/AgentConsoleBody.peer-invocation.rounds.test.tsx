// One peer-invocation change at a time, and what a superseded round may not decide.
//
// The other half of the grant's story. What a pane that MOVES between sessions gets
// wrong is `AgentConsoleBody.peer-invocation.test.tsx`; this file never moves the
// pane at all — it holds one mutation open and asks what a second press, and a reply
// whose round the projection has already replaced, are allowed to do to the switch a
// person is looking at.
//
// Both suites drive the real pane over the same scripted daemon, from the one cast in
// `peer-invocation-pane.test-support.tsx`.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleReads } from "./agent-console.test-support.js";
import {
  FIRST_SESSION_ID,
  PeerInvocationDaemon,
  bridgeCalling,
  grantSwitch,
  pane,
  pressGrantOn,
  projectGrant,
  storeProjecting,
  switchState,
} from "./peer-invocation-pane.test-support.js";

describe("agent console — one peer-invocation change at a time", () => {
  it("takes no second change while the daemon has not answered the first", async () => {
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    scriptedDaemon.holdNextReply();
    const { container } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);

    // The grant is durable: a second appended record for one intended act is two
    // records, and their replies race to decide which settlement is shown.
    expect(grantSwitch(container).disabled).toBe(true);
    await pressGrantOn(container);
    expect(scriptedDaemon.callCount).toBe(1);
  });

  it("discards a reply whose round the projection had already replaced", async () => {
    // The race the latch alone does not reach. This control's own append lands in
    // the store as a projected row BEFORE its reply comes back; the projection
    // moving retires that round and hands the switch back, so a second change is
    // admitted and the two replies may land in either order.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    scriptedDaemon.holdNextReply();
    await pressGrantOn(container);
    await projectGrant(sessionStore, true);
    expect(grantSwitch(container).disabled).toBe(false);

    scriptedDaemon.holdNextReply();
    await pressGrantOn(container);
    await act(async () => {
      await scriptedDaemon.settleNewestHeldReply(false);
    });
    await settleReads(bridge);
    expect(switchState(container)).toBe(false);

    // The older reply lands last and says the opposite of the settlement on screen.
    await act(async () => {
      await scriptedDaemon.settleHeldReply(true);
    });
    await settleReads(bridge);

    expect(switchState(container)).toBe(false);
  });

  it("negative control: with no change outstanding the switch is live", async () => {
    // Without this, the disabled case above would hold for a control that never
    // takes a press at all, which is a switch nobody can use rather than one that
    // refuses a second change.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);

    expect(grantSwitch(container).disabled).toBe(false);
    await pressGrantOn(container);
    await settleReads(bridge);

    expect(scriptedDaemon.callCount).toBe(1);
    expect(grantSwitch(container).disabled).toBe(false);
  });
});
