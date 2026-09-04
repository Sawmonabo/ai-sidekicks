// The latch's one rule, stated over the two axes it is keyed on.
//
// A held slot belongs to a `(bridge, key)` pair and to nothing else. The cases below
// are the four ways a caller can be wrong about that: claiming twice, releasing what
// another key holds, releasing what another bridge holds, and treating a replaced
// bridge as though it inherited the old one's holds.

import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "./console-bridge.js";
import { BridgeScopedLatch } from "./bridge-scoped-latch.js";

const BRIDGE_ONE = { source: "fixture" } as unknown as ConsoleBridge;
const BRIDGE_TWO = { source: "fixture" } as unknown as ConsoleBridge;
const KEY_ONE = "session-one";
const KEY_TWO = "session-two";

describe("one act in flight per (bridge, key)", () => {
  it("refuses a second claim on the key that already holds the slot", () => {
    const latch = new BridgeScopedLatch();
    expect(latch.claim(BRIDGE_ONE, KEY_ONE)).toBe(true);
    expect(latch.claim(BRIDGE_ONE, KEY_ONE)).toBe(false);
  });

  it("admits another key under the same bridge", () => {
    // The scope control: "one in flight" is one per key, never one per latch.
    const latch = new BridgeScopedLatch();
    latch.claim(BRIDGE_ONE, KEY_ONE);
    expect(latch.claim(BRIDGE_ONE, KEY_TWO)).toBe(true);
  });

  it("admits the same key under a replaced bridge", () => {
    // A swapped bridge is a fresh generation. Without this, an act still travelling
    // on the old transport would hold the new one's slot for as long as it took to
    // answer — or forever, where it never did.
    const latch = new BridgeScopedLatch();
    latch.claim(BRIDGE_ONE, KEY_ONE);
    expect(latch.claim(BRIDGE_TWO, KEY_ONE)).toBe(true);
  });

  it("releases only the pair it was given", () => {
    const latch = new BridgeScopedLatch();
    latch.claim(BRIDGE_ONE, KEY_ONE);
    latch.claim(BRIDGE_ONE, KEY_TWO);
    latch.claim(BRIDGE_TWO, KEY_ONE);

    latch.release(BRIDGE_ONE, KEY_ONE);

    expect(latch.claim(BRIDGE_ONE, KEY_ONE)).toBe(true);
    expect(latch.claim(BRIDGE_ONE, KEY_TWO)).toBe(false);
    expect(latch.claim(BRIDGE_TWO, KEY_ONE)).toBe(false);
  });

  it("negative control: releasing a slot nothing holds changes nothing", () => {
    // Without this, a latch that emptied itself on any release would pass the case
    // above by accident — and a late settlement releasing an abandoned generation is
    // exactly that call.
    const latch = new BridgeScopedLatch();
    latch.claim(BRIDGE_ONE, KEY_ONE);
    latch.release(BRIDGE_TWO, KEY_ONE);
    latch.release(BRIDGE_ONE, KEY_TWO);
    expect(latch.claim(BRIDGE_ONE, KEY_ONE)).toBe(false);
  });
});
