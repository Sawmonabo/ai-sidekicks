import { describe, expect, it, vi } from "vitest";

import { TransportReconnectSignal } from "./transport-reconnect.js";

describe("TransportReconnectSignal", () => {
  it("starts unknown and claims nothing", () => {
    expect(new TransportReconnectSignal().reachability).toBe("unknown");
  });

  it("does not emit for a first connection, which is not a reconnect", () => {
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);

    signal.observe("reachable");

    expect(onReconnect).not.toHaveBeenCalled();
    expect(signal.reachability).toBe("reachable");
  });

  it("emits once on the returning edge", () => {
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);

    signal.observe("reachable");
    signal.observe("unreachable");
    signal.observe("reachable");

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("does not emit while the transport stays away", () => {
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);

    signal.observe("reachable");
    signal.observe("unreachable");
    signal.observe("unreachable");

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("costs nothing when the same state is reported repeatedly", () => {
    // One transport, four bound sessions: the binder reports `reachable` per bind.
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);

    signal.observe("reachable");
    signal.observe("reachable");
    signal.observe("reachable");
    signal.observe("reachable");

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("emits on every later return, not only the first", () => {
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);

    signal.observe("reachable");
    signal.observe("unreachable");
    signal.observe("reachable");
    signal.observe("unreachable");
    signal.observe("reachable");

    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("stops delivering to an unsubscribed reading", () => {
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    const unsubscribe = signal.subscribe(onReconnect);

    signal.observe("reachable");
    unsubscribe();
    signal.observe("unreachable");
    signal.observe("reachable");

    expect(onReconnect).not.toHaveBeenCalled();
    expect(signal.listenerCount).toBe(0);
  });

  it("releases every listener on dispose", () => {
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);

    signal.dispose();
    signal.observe("reachable");
    signal.observe("unreachable");
    signal.observe("reachable");

    expect(onReconnect).not.toHaveBeenCalled();
    expect(signal.listenerCount).toBe(0);
  });
});
