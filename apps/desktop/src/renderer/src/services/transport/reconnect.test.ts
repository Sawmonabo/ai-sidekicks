import { describe, expect, it, vi } from "vitest";

import { TransportReconnectSignal } from "./reconnect.js";

describe("TransportReconnectSignal", () => {
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
});
