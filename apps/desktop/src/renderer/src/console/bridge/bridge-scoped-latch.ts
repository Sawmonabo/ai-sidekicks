// Which keys have an act in flight, per bridge.
//
// The mutable half of `session-scoped-state.ts`'s rule. That holder answers what a
// surface RENDERS for the subject it is bound to; this one answers whether an act
// may be dispatched at all, which a handler has to decide inside its own tick — a
// rendered value read there is the one from the render that produced the handler, so
// two presses in one frame both find the surface idle and both dispatch.
//
// THE KEY IS WHAT THE RULE IS ABOUT, AND IT IS NEVER THE MOUNT. "One in flight" is
// one per subject: one goal mutation per session, one send per composer address, one
// control per run. A boolean per mounted component said otherwise, and a surface
// rebound while a call was outstanding then refused the NEW subject's first act as
// though it already had one settling — and a call that never answered refused it for
// as long as that surface stayed mounted.
//
// A `WeakMap` on the bridge for `driver-capability-read.ts`'s reason: the key is a
// live object, so a bridge that goes away takes its held keys with it. That is also
// what makes a replaced bridge a fresh generation rather than an emptied one — a
// settlement arriving after the swap releases the generation it was claimed in, and
// the live one is untouched.

import type { ConsoleBridge } from "./console-bridge.js";

export class BridgeScopedLatch {
  readonly #heldKeysByBridge = new WeakMap<ConsoleBridge, Set<string>>();

  /** Take one key's slot, or answer `false` where that key already holds it. */
  public claim(bridge: ConsoleBridge, key: string): boolean {
    const heldKeys = this.#heldKeysFor(bridge);
    if (heldKeys.has(key)) {
      return false;
    }
    heldKeys.add(key);
    return true;
  }

  /** Release one key's slot. Every other key's, and every other bridge's, is untouched. */
  public release(bridge: ConsoleBridge, key: string): void {
    this.#heldKeysByBridge.get(bridge)?.delete(key);
  }

  #heldKeysFor(bridge: ConsoleBridge): Set<string> {
    const held = this.#heldKeysByBridge.get(bridge);
    if (held !== undefined) {
      return held;
    }
    const created = new Set<string>();
    this.#heldKeysByBridge.set(bridge, created);
    return created;
  }
}
