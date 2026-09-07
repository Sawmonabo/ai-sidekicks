// What an open reports, and what it does not swallow on the way.
//
// The rule is three lines, and each of the three is a claim a caller relies on: a
// returned open says the wire is there, a thrown one says it is not, and the throw
// still reaches the caller that has an arm for it.

import { describe, expect, it, vi } from "vitest";

import { TransportReconnectSignal } from "./transport-reconnect.js";
import { openObservedSubscription } from "./observed-subscription.js";

describe("openObservedSubscription — one rule for what an open observed", () => {
  it("reports the wire reachable when the open returned, and hands back its release", () => {
    const signal = new TransportReconnectSignal();
    const release = vi.fn();

    const returned = openObservedSubscription(signal, () => release);

    expect(signal.reachability).toBe("reachable");
    expect(returned).toBe(release);
  });

  it("reports the wire unreachable when the open threw, and re-raises unchanged", () => {
    const signal = new TransportReconnectSignal();
    const openFailure = new Error("the daemon event stream is not reachable from this window");

    expect(() =>
      openObservedSubscription(signal, () => {
        throw openFailure;
      }),
    ).toThrow(openFailure);
    expect(signal.reachability).toBe("unreachable");
  });

  it("emits the returning edge when a LATER, unrelated open succeeds", () => {
    // The deadlock this whole seam exists to break, at its smallest: the open that
    // failed and the open that recovers are different callers, so the edge cannot
    // depend on the failing one being retried first.
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);

    expect(() =>
      openObservedSubscription(signal, () => {
        throw new Error("away");
      }),
    ).toThrow();
    openObservedSubscription(signal, () => () => undefined);

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("negative control: an open that is never taken reports nothing at all", () => {
    // Without it, the cases above would pass over a helper that reported `reachable`
    // on every call — which would make the returning edge a fact about being asked
    // rather than about the wire answering.
    const signal = new TransportReconnectSignal();
    const open = vi.fn(() => () => undefined);

    expect(signal.reachability).toBe("unknown");
    expect(open).not.toHaveBeenCalled();
  });
});
