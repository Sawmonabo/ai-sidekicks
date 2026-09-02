// One capability read per bridge, however many surfaces want the answer.
//
// The claim worth a unit is arithmetic on the wire rather than anything on screen:
// two families gate controls on `driver.listCapabilities`, and before this module
// each performed its own read, so a session view holding both put two calls on the
// wire for one answer. The counting is done against a bridge that records every
// call, and the negative control is a second bridge — which must read again, because
// the cache is keyed by the bridge and a global "read once ever" would serve a second
// window the first window's answer.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";
import {
  declaredFlagsForDriver,
  useDriverCapabilities,
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
}

/** A bridge that answers the capability read and records every call it is given. */
function bridgeAnswering(reply: unknown): CountingBridge {
  const methodCalls: string[] = [];
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (method: string) => {
          methodCalls.push(method);
          return method === "driver.listCapabilities" ? reply : undefined;
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    growthServedOperations: new Set(),
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
  return { bridge, methodCalls };
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
    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={record("second")} />);
    });

    expect(capabilityCallCount(counted)).toBe(1);
    // The late consumer is served the settled answer rather than an absence.
    expect(declaredFlagsForDriver(readoutsByLabel.get("second"), "claude")?.steer).toBe(true);
  });
});

describe("useDriverCapabilities — a read that failed says so", () => {
  it("settles with the reason when the reply does not parse, and does not retry", async () => {
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
    await act(async () => {
      render(<CapabilityProbe bridge={counted.bridge} onReadout={() => undefined} />);
    });

    // The gating stays fail-closed — no driver declares anything — and the reason is
    // on the reading rather than swallowed, so a surface can say why its controls went.
    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(settledRefusalOf(readout).code).toBe("reply-unreadable");
    // One ask, not one per consumer: a read that answered unusably has still been put.
    expect(capabilityCallCount(counted)).toBe(1);
  });

  it("carries the daemon's own code when the daemon rejects the read", async () => {
    const methodCalls: string[] = [];
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
      scenarioEngine: undefined,
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

    expect(declaredFlagsForDriver(readout, "claude")).toBeUndefined();
    expect(readout?.readRefusal).toBeUndefined();
  });
});

describe("declaredFlagsForDriver", () => {
  it("says nothing about a driver nobody named", () => {
    expect(declaredFlagsForDriver(undefined, "claude")).toBeUndefined();
    expect(declaredFlagsForDriver(neverRead(), undefined)).toBeUndefined();
  });
});
