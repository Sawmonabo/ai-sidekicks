// The fold that never turns absence into "off".
//
// Three readers now depend on this one answer — the control that draws the grant,
// the ledger window that explains a session where it is off, and the store door
// that publishes it to both — so the cases below are about the FOLD rather than
// about any surface: what a projected row says, and what it does not say.

import { describe, expect, it } from "vitest";

import { type ConsoleEntity } from "./entities.js";
import { peerInvocationEnabledIn } from "./peer-invocation-projection.js";

const SESSION_ID = "session-peer-invocation";

/** One projected session row, with whatever body a case is about. */
function sessionRow(body: Readonly<Record<string, unknown>>): ConsoleEntity {
  return { kind: "session", id: SESSION_ID, body };
}

describe("the peer-invocation fold", () => {
  it("reads a projected boolean through", () => {
    expect(
      peerInvocationEnabledIn(
        { [SESSION_ID]: sessionRow({ peerInvocationEnabled: true }) },
        SESSION_ID,
      ),
    ).toBe(true);
  });

  it("negative control: a projected FALSE is false and never unknown", () => {
    // Without this, the absence cases below would pass over a fold that answered
    // `undefined` for everything — which would hide a session that reported off,
    // and the ledger's empty window says something different for exactly that one.
    expect(
      peerInvocationEnabledIn(
        { [SESSION_ID]: sessionRow({ peerInvocationEnabled: false }) },
        SESSION_ID,
      ),
    ).toBe(false);
  });

  it("answers unknown for an absent member, an absent row, and a wrong type", () => {
    // None of the three says the grant is off, and rendering `false` for any of
    // them would present an enabled session as safe.
    expect(peerInvocationEnabledIn({ [SESSION_ID]: sessionRow({}) }, SESSION_ID)).toBeUndefined();
    expect(peerInvocationEnabledIn({}, SESSION_ID)).toBeUndefined();
    expect(
      peerInvocationEnabledIn(
        { [SESSION_ID]: sessionRow({ peerInvocationEnabled: "true" }) },
        SESSION_ID,
      ),
    ).toBeUndefined();
  });

  it("reads the addressed session and never a neighbour's row", () => {
    // Two open sessions share one partition map. Without the key, a window over the
    // session with the grant off would take the enabled neighbour's answer and stay
    // silent about the handoff thread it cannot reach.
    const partition: Readonly<Record<string, ConsoleEntity>> = {
      [SESSION_ID]: sessionRow({ peerInvocationEnabled: false }),
      "session-other": {
        kind: "session",
        id: "session-other",
        body: { peerInvocationEnabled: true },
      },
    };
    expect(peerInvocationEnabledIn(partition, SESSION_ID)).toBe(false);
    expect(peerInvocationEnabledIn(partition, "session-other")).toBe(true);
  });
});
