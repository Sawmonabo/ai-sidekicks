// One capability read per bridge, however many views want the answer — and no
// answer that stands for the life of the window.
//
// Two claims, and both are arithmetic on the wire rather than anything on screen.
// Two features gate controls on `driver.listCapabilities`, and a read of their own
// each would put two calls on the wire for one answer in a session view holding
// both. And a latched read would let a transient first-read refusal hide Steer,
// Rewind, and the compaction control for as long as the window stayed open. The
// counting is done against a bridge that records every call, on a frozen clock so the
// scheduler's coalescing window is advanced explicitly and no case depends on how fast
// the runner happens to be.
//
// The negative controls are a second bridge — which must read again, because the
// cache is keyed by the bridge and a global "read once ever" would serve a second
// window the first window's answer — and a refresh reason nobody gave, which must
// put nothing on the wire.

import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";

import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { PlatformBridgeProvider } from "../platform/PlatformBridgeProvider.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import {
  CapabilityProbe,
  answeringCapabilityReads,
  capabilityCallCount,
  reportFor,
} from "./useDriverCapabilities.test-support.js";
import {
  neverRead,
  settledRefusalOf,
} from "@renderer/store/driver-capabilities/driver-capability-readout.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { useDriverCapabilityRepairRead } from "./useDriverCapabilityRepairRead.js";
import { type DriverCapabilityReadout } from "@renderer/store/driver-capabilities/driver-capability-readout.js";
import { declaredFlagsForDriver } from "@renderer/store/driver-capabilities/driver-capability-readings.js";

describe("useDriverCapabilities — one read, every consumer", () => {
  it("asks once for two consumers sharing one bridge", async () => {
    const counted = answeringCapabilityReads({
      drivers: [reportFor("claude", ["context_compaction"])],
    });
    const readoutsByLabel = new Map<string, DriverCapabilityReadout | undefined>();
    const record =
      (label: string) =>
      (readout: DriverCapabilityReadout | undefined): void => {
        readoutsByLabel.set(label, readout);
      };

    await act(async () => {
      render(
        <>
          <CapabilityProbe bridge={counted.bridge} onReadout={record("runs")} />
          <CapabilityProbe bridge={counted.bridge} onReadout={record("composer")} />
        </>,
        { wrapper: bridgeWrapper(counted.bridge, counted.clock) },
      );
    });
    await settleScheduledRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(1);
    // Both consumers see the same settled reading, not one served and one waiting.
    expect(declaredFlagsForDriver(readoutsByLabel.get("runs"), "claude")?.context_compaction).toBe(
      true,
    );
    expect(readoutsByLabel.get("composer")).toBe(readoutsByLabel.get("runs"));
  });

  it("negative control: a second bridge is a second reading and is asked again", async () => {
    const first = answeringCapabilityReads({
      drivers: [reportFor("claude", ["context_compaction"])],
    });
    const second = answeringCapabilityReads({ drivers: [reportFor("codex", [])] });
    const readoutsByLabel = new Map<string, DriverCapabilityReadout | undefined>();
    const record =
      (label: string) =>
      (readout: DriverCapabilityReadout | undefined): void => {
        readoutsByLabel.set(label, readout);
      };

    await act(async () => {
      render(
        <>
          <PlatformBridgeProvider bridge={first.bridge} clock={first.clock}>
            <CapabilityProbe bridge={first.bridge} onReadout={record("window-one")} />
          </PlatformBridgeProvider>
          <PlatformBridgeProvider bridge={second.bridge} clock={second.clock}>
            <CapabilityProbe bridge={second.bridge} onReadout={record("window-two")} />
          </PlatformBridgeProvider>
        </>,
      );
    });
    await settleScheduledRead(first.clock);
    await settleScheduledRead(second.clock);

    expect(capabilityCallCount(first)).toBe(1);
    expect(capabilityCallCount(second)).toBe(1);
    expect(
      declaredFlagsForDriver(readoutsByLabel.get("window-two"), "codex")?.context_compaction,
    ).toBe(false);
    // The second bridge's reply names no `claude`, so nothing is carried across.
    expect(declaredFlagsForDriver(readoutsByLabel.get("window-two"), "claude")).toBeUndefined();
  });

  it("keeps a consumer that mounts late off the wire", async () => {
    const counted = answeringCapabilityReads({ drivers: [reportFor("claude", ["steer"])] });
    const readoutsByLabel = new Map<string, DriverCapabilityReadout | undefined>();
    const record =
      (label: string) =>
      (readout: DriverCapabilityReadout | undefined): void => {
        readoutsByLabel.set(label, readout);
      };

    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={record("first")} />, {
        wrapper: bridgeWrapper(counted.bridge, counted.clock),
      });
    });
    await settleScheduledRead(counted.clock);
    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={record("second")} />, {
        wrapper: bridgeWrapper(counted.bridge, counted.clock),
      });
    });

    // The late consumer is served the settled answer straight away rather than an
    // absence, and its own `subscribe` reason is coalesced into one further read
    // rather than one per consumer.
    expect(declaredFlagsForDriver(readoutsByLabel.get("second"), "claude")?.steer).toBe(true);
    await settleScheduledRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(2);
  });
});

describe("useDriverCapabilities — a read that failed says so", () => {
  it("settles with the reason when the reply does not parse", async () => {
    const counted = answeringCapabilityReads({ drivers: [{ driverName: "claude" }] });
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
        { wrapper: bridgeWrapper(counted.bridge, counted.clock) },
      );
    });
    await settleScheduledRead(counted.clock);

    // The gating stays fail-closed — no driver declares anything — and the reason is
    // on the reading rather than swallowed, so a view can say why its controls went.
    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(settledRefusalOf(readout).code).toBe("reply-unreadable");
    // One ask for the two consumers that were mounted, not one each.
    expect(capabilityCallCount(counted)).toBe(1);
  });

  it("carries the daemon's own code when the daemon rejects the read", async () => {
    const { bridge, calls, engine } = bridgeAnswering(async () => {
      throw { code: "driver.unavailable", message: "No driver process is bound." };
    });

    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
        { wrapper: bridgeWrapper(bridge, engine.clock) },
      );
    });
    await settleScheduledRead(engine.clock);

    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(settledRefusalOf(readout).code).toBe("driver.unavailable");
    expect(calls.map((call) => call.method)).toStrictEqual(["driver.listCapabilities"]);
  });

  it("negative control: a reply naming no driver is answered, not refused", async () => {
    // An empty declaration set is a fact about the node. Reporting it as a failure
    // would put a refusal on screen for a session that is working exactly as it is.
    const counted = answeringCapabilityReads({ drivers: [] });
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
        { wrapper: bridgeWrapper(counted.bridge, counted.clock) },
      );
    });
    await settleScheduledRead(counted.clock);

    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(readout?.readRefusal).toBeUndefined();
  });
});

// No settlement is terminal for a bridge. A read that failed once, and a report that
// was true when it landed, both have to be re-askable — otherwise a transient refusal
// hides three controls for the life of the window and a driver installed after the
// first read is never seen.
describe("useDriverCapabilities — a settlement is never terminal", () => {
  /** One consumer bound to a session, so the repair reason is wired as a pane wires it. */
  function RepairingProbe(props: {
    readonly bridge: PlatformBridge;
    readonly sessionStore: SessionStore;
    readonly onReadout: (readout: DriverCapabilityReadout | undefined) => void;
  }): React.JSX.Element {
    useDriverCapabilityRepairRead(props.bridge, props.sessionStore);
    return <CapabilityProbe bridge={props.bridge} onReadout={props.onReadout} />;
  }

  function initializedStore(): SessionStore {
    const store = new SessionStore({ sessionId: "019b7a33-3300-75e5-8510-ada11a5a55a5" });
    store.initialize({ cursor: 0, entities: [] });
    return store;
  }

  it("re-reads on window focus, so a refused first read stops hiding the controls", async () => {
    // The first read is refused and the second answers, which is the transient this
    // is about: a daemon that was not ready when the window opened.
    const counted = answeringCapabilityReads(
      { drivers: [{ driverName: "claude" }] },
      { drivers: [reportFor("claude", ["steer", "rollback"])] },
    );
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
        { wrapper: bridgeWrapper(counted.bridge, counted.clock) },
      );
    });
    await settleScheduledRead(counted.clock);
    expect(settledRefusalOf(readout).code).toBe("reply-unreadable");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(2);
    expect(declaredFlagsForDriver(readout, "claude")?.steer).toBe(true);
    expect(readout?.readRefusal).toBeUndefined();
  });

  it("re-reads when a degraded session is repaired", async () => {
    const counted = answeringCapabilityReads(
      { drivers: [reportFor("claude", [])] },
      { drivers: [reportFor("claude", ["rollback"])] },
    );
    const sessionStore = initializedStore();
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <RepairingProbe
          bridge={counted.bridge}
          sessionStore={sessionStore}
          onReadout={(value) => {
            readout = value;
          }}
        />,
        { wrapper: bridgeWrapper(counted.bridge, counted.clock) },
      );
    });
    await settleScheduledRead(counted.clock);
    expect(declaredFlagsForDriver(readout, "claude")?.rollback).toBe(false);

    act(() => {
      sessionStore.markDegraded("subscription-closed");
    });
    // Losing the stream is not the moment: the read would go to a wire that is not
    // answering. The repair is.
    await settleScheduledRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(1);

    act(() => {
      sessionStore.initialize({ cursor: 4, entities: [] });
    });
    await settleScheduledRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(2);
    // A driver installed while the daemon was away is now declared, which the latch
    // could never have seen.
    expect(declaredFlagsForDriver(readout, "claude")?.rollback).toBe(true);
  });

  it("keeps the settled reading on screen while the refresh is in flight", async () => {
    // The not-loaded state is entered once and never re-entered on a refresh: a
    // control that vanished and came back on every window focus would be a worse
    // reading than a slightly stale one.
    const counted = answeringCapabilityReads({ drivers: [reportFor("claude", ["steer"])] });
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
        { wrapper: bridgeWrapper(counted.bridge, counted.clock) },
      );
    });
    await settleScheduledRead(counted.clock);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(declaredFlagsForDriver(readout, "claude")?.steer).toBe(true);
  });

  it("negative control: nothing re-reads without a reason", async () => {
    // Without this, a cache that had simply started polling would pass every case
    // above. Time passes, no reason is given, and the wire stays quiet.
    const counted = answeringCapabilityReads({ drivers: [reportFor("claude", ["steer"])] });
    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={() => undefined} />, {
        wrapper: bridgeWrapper(counted.bridge, counted.clock),
      });
    });
    await settleScheduledRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(1);

    await settleScheduledRead(counted.clock);
    await settleScheduledRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(1);
  });
});
