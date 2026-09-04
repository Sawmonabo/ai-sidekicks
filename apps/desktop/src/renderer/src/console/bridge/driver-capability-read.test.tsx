// One capability read per bridge, however many surfaces want the answer — and no
// answer that stands for the life of the window.
//
// Two claims, and both are arithmetic on the wire rather than anything on screen.
// Two families gate controls on `driver.listCapabilities`, and before this module
// each performed its own read, so a session view holding both put two calls on the
// wire for one answer. And the read used to be latched, so a transient first-read
// refusal hid Steer, Rewind, and the compaction control for as long as the window
// stayed open. The counting is done against a bridge that records every call, on a
// frozen clock so the scheduler's coalescing window is advanced explicitly and no
// case depends on how fast the runner happens to be.
//
// The negative controls are a second bridge — which must read again, because the
// cache is keyed by the bridge and a global "read once ever" would serve a second
// window the first window's answer — and a refresh reason nobody gave, which must
// put nothing on the wire.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import { ManualClock, REFRESH_MAX_WAIT_MS, type ConsoleRefusal } from "../core/index.js";
import { SessionStore } from "../store/index.js";
import type { ConsoleBridge } from "./console-bridge.js";
import {
  declaredFlagsForDriver,
  useDriverCapabilities,
  useDriverCapabilityRepairRead,
  withRunDriverBindings,
  type DriverCapabilityReadout,
} from "./driver-capability-read.js";

/** One driver's report: the named flags true, every other flag false. */
function reportFor(driverName: string, declared: readonly DriverCapabilityFlag[]): unknown {
  return {
    driverName,
    capabilities: {
      flags: Object.fromEntries(
        DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, declared.includes(flag)]),
      ),
      contractVersion: "1",
    },
  };
}

interface CountingBridge {
  readonly bridge: ConsoleBridge;
  readonly methodCalls: string[];
  readonly clock: ManualClock;
}

/**
 * A bridge that answers the capability read and records every call it is given.
 *
 * `answers` is walked in order, so a case about a node whose drivers changed between
 * two reads says so by supplying two replies; the last one stands for every read
 * after it, which is what a node that stopped changing does.
 */
function bridgeAnswering(...answers: readonly unknown[]): CountingBridge {
  const methodCalls: string[] = [];
  const clock = new ManualClock();
  let answered = 0;
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (method: string) => {
          methodCalls.push(method);
          if (method !== "driver.listCapabilities") {
            return undefined;
          }
          const reply = answers[Math.min(answered, answers.length - 1)];
          answered += 1;
          return reply;
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    growthServedOperations: new Set(),
    source: "fixture",
    scenarioEngine: { clock },
  } as unknown as ConsoleBridge;
  return { bridge, methodCalls, clock };
}

/**
 * Let the scheduler's window elapse and the read that follows it settle.
 *
 * The absolute deadline rather than the debounce, so a case that asked more than
 * once still reaches a performed read; the awaits drain the promise the call itself
 * is.
 */
async function settleRead(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_MAX_WAIT_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** How many times one bridge was asked for the declarations. */
function capabilityCallCount(counted: CountingBridge): number {
  return counted.methodCalls.filter((method) => method === "driver.listCapabilities").length;
}

/** One consumer of the read, standing in for a view family that gates on it. */
function CapabilityProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly onReadout: (readout: DriverCapabilityReadout | undefined) => void;
}): React.JSX.Element {
  const readout = useDriverCapabilities(props.bridge);
  props.onReadout(readout);
  return <span />;
}

/** The refusal a settled reading carries, or a failure naming what was found instead. */
function settledRefusalOf(readout: DriverCapabilityReadout | undefined): ConsoleRefusal {
  if (readout?.readRefusal === undefined) {
    throw new Error("the capability read settled without the refusal the case is about");
  }
  return readout.readRefusal;
}

/** A reading no read produces, so a probe whose callback never ran fails loudly. */
function neverRead(): DriverCapabilityReadout {
  return { flagsByDriverName: new Map(), driverNameByRunId: new Map(), readRefusal: undefined };
}

describe("useDriverCapabilities — one read, every consumer", () => {
  it("asks once for two consumers sharing one bridge", async () => {
    const counted = bridgeAnswering({ drivers: [reportFor("claude", ["context_compaction"])] });
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
      );
    });
    await settleRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(1);
    // Both consumers see the same settled reading, not one served and one waiting.
    expect(declaredFlagsForDriver(readoutsByLabel.get("runs"), "claude")?.context_compaction).toBe(
      true,
    );
    expect(readoutsByLabel.get("composer")).toBe(readoutsByLabel.get("runs"));
  });

  it("negative control: a second bridge is a second reading and is asked again", async () => {
    const first = bridgeAnswering({ drivers: [reportFor("claude", ["context_compaction"])] });
    const second = bridgeAnswering({ drivers: [reportFor("codex", [])] });
    const readoutsByLabel = new Map<string, DriverCapabilityReadout | undefined>();
    const record =
      (label: string) =>
      (readout: DriverCapabilityReadout | undefined): void => {
        readoutsByLabel.set(label, readout);
      };

    await act(async () => {
      render(
        <>
          <CapabilityProbe bridge={first.bridge} onReadout={record("window-one")} />
          <CapabilityProbe bridge={second.bridge} onReadout={record("window-two")} />
        </>,
      );
    });
    await settleRead(first.clock);
    await settleRead(second.clock);

    expect(capabilityCallCount(first)).toBe(1);
    expect(capabilityCallCount(second)).toBe(1);
    expect(
      declaredFlagsForDriver(readoutsByLabel.get("window-two"), "codex")?.context_compaction,
    ).toBe(false);
    // The second bridge's reply names no `claude`, so nothing is carried across.
    expect(declaredFlagsForDriver(readoutsByLabel.get("window-two"), "claude")).toBeUndefined();
  });

  it("keeps a consumer that mounts late off the wire", async () => {
    const counted = bridgeAnswering({ drivers: [reportFor("claude", ["steer"])] });
    const readoutsByLabel = new Map<string, DriverCapabilityReadout | undefined>();
    const record =
      (label: string) =>
      (readout: DriverCapabilityReadout | undefined): void => {
        readoutsByLabel.set(label, readout);
      };

    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={record("first")} />);
    });
    await settleRead(counted.clock);
    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={record("second")} />);
    });

    // The late consumer is served the settled answer straight away rather than an
    // absence, and its own `subscribe` reason is coalesced into one further read
    // rather than one per consumer.
    expect(declaredFlagsForDriver(readoutsByLabel.get("second"), "claude")?.steer).toBe(true);
    await settleRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(2);
  });
});

describe("useDriverCapabilities — a read that failed says so", () => {
  it("settles with the reason when the reply does not parse", async () => {
    const counted = bridgeAnswering({ drivers: [{ driverName: "claude" }] });
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
      );
    });
    await settleRead(counted.clock);

    // The gating stays fail-closed — no driver declares anything — and the reason is
    // on the reading rather than swallowed, so a surface can say why its controls went.
    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(settledRefusalOf(readout).code).toBe("reply-unreadable");
    // One ask for the two consumers that were mounted, not one each.
    expect(capabilityCallCount(counted)).toBe(1);
  });

  it("carries the daemon's own code when the daemon rejects the read", async () => {
    const methodCalls: string[] = [];
    const clock = new ManualClock();
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string) => {
            methodCalls.push(method);
            throw { code: "driver.unavailable", message: "No driver process is bound." };
          },
          subscribe: () => () => undefined,
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: { clock },
    } as unknown as ConsoleBridge;

    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
      );
    });
    await settleRead(clock);

    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(settledRefusalOf(readout).code).toBe("driver.unavailable");
    expect(methodCalls).toStrictEqual(["driver.listCapabilities"]);
  });

  it("negative control: a reply naming no driver is answered, not refused", async () => {
    // An empty declaration set is a fact about the node. Reporting it as a failure
    // would put a refusal on screen for a session that is working exactly as it is.
    const counted = bridgeAnswering({ drivers: [] });
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
      );
    });
    await settleRead(counted.clock);

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
    readonly bridge: ConsoleBridge;
    readonly sessionStore: SessionStore;
    readonly onReadout: (readout: DriverCapabilityReadout | undefined) => void;
  }): React.JSX.Element {
    useDriverCapabilityRepairRead(props.bridge, props.sessionStore);
    return <CapabilityProbe bridge={props.bridge} onReadout={props.onReadout} />;
  }

  function initialisedStore(): SessionStore {
    const store = new SessionStore({ sessionId: "019b7a33-3300-75e5-8510-ada11a5a55a5" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    return store;
  }

  it("re-reads on window focus, so a refused first read stops hiding the controls", async () => {
    // The first read is refused and the second answers, which is the transient this
    // is about: a daemon that was not ready when the window opened.
    const counted = bridgeAnswering(
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
      );
    });
    await settleRead(counted.clock);
    expect(settledRefusalOf(readout).code).toBe("reply-unreadable");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(2);
    expect(declaredFlagsForDriver(readout, "claude")?.steer).toBe(true);
    expect(readout?.readRefusal).toBeUndefined();
  });

  it("re-reads when a degraded session is repaired", async () => {
    const counted = bridgeAnswering(
      { drivers: [reportFor("claude", [])] },
      { drivers: [reportFor("claude", ["rollback"])] },
    );
    const sessionStore = initialisedStore();
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
      );
    });
    await settleRead(counted.clock);
    expect(declaredFlagsForDriver(readout, "claude")?.rollback).toBe(false);

    act(() => {
      sessionStore.markDegraded("subscription-closed");
    });
    // Losing the stream is not the moment: the read would go to a wire that is not
    // answering. The repair is.
    await settleRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(1);

    act(() => {
      sessionStore.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    await settleRead(counted.clock);

    expect(capabilityCallCount(counted)).toBe(2);
    // A driver installed while the daemon was away is now declared, which the latch
    // could never have seen.
    expect(declaredFlagsForDriver(readout, "claude")?.rollback).toBe(true);
  });

  it("keeps the settled reading on screen while the refresh is in flight", async () => {
    // Rule 8's `not-loaded` is entered once and never re-entered on a refresh: a
    // control that vanished and came back on every window focus would be a worse
    // reading than a slightly stale one.
    const counted = bridgeAnswering({ drivers: [reportFor("claude", ["steer"])] });
    let readout: DriverCapabilityReadout | undefined = neverRead();
    await act(async () => {
      render(
        <CapabilityProbe
          bridge={counted.bridge}
          onReadout={(value) => {
            readout = value;
          }}
        />,
      );
    });
    await settleRead(counted.clock);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(declaredFlagsForDriver(readout, "claude")?.steer).toBe(true);
  });

  it("negative control: nothing re-reads without a reason", async () => {
    // Without this, a cache that had simply started polling would pass every case
    // above. Time passes, no reason is given, and the wire stays quiet.
    const counted = bridgeAnswering({ drivers: [reportFor("claude", ["steer"])] });
    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={() => undefined} />);
    });
    await settleRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(1);

    await settleRead(counted.clock);
    await settleRead(counted.clock);
    expect(capabilityCallCount(counted)).toBe(1);
  });
});

describe("withRunDriverBindings", () => {
  it("joins the session's bindings onto the node's declarations", () => {
    const declarations: DriverCapabilityReadout = {
      flagsByDriverName: new Map(),
      driverNameByRunId: new Map(),
      readRefusal: undefined,
    };
    const joined = withRunDriverBindings(declarations, new Map([["run-one", "codex"]]));
    expect(joined?.driverNameByRunId.get("run-one")).toBe("codex");
    // The declarations are carried through untouched: this joins a second reading
    // onto the first and decides nothing about either.
    expect(joined?.flagsByDriverName).toBe(declarations.flagsByDriverName);
  });

  it("returns the reading itself when there is nothing to join", () => {
    const declarations: DriverCapabilityReadout = {
      flagsByDriverName: new Map(),
      driverNameByRunId: new Map(),
      readRefusal: undefined,
    };
    // The same pointer, so a surface whose session named no binding re-renders no
    // more often than one that asked for no join at all.
    expect(withRunDriverBindings(declarations, new Map())).toBe(declarations);
    expect(withRunDriverBindings(undefined, new Map([["run-one", "codex"]]))).toBeUndefined();
  });
});

describe("declaredFlagsForDriver", () => {
  it("says nothing about a driver nobody named", () => {
    expect(declaredFlagsForDriver(undefined, "claude")).toBeUndefined();
    expect(declaredFlagsForDriver(neverRead(), undefined)).toBeUndefined();
  });
});
