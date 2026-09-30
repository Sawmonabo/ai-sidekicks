// What both halves of the capability suite build their cases out of.
//
// A driver's report, the counting bridge that answers it, and the probe that consumes the
// hook, written once so the read's cases and the pure readers' cases cannot drift into
// disagreeing about what a report looks like.

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import { bridgeAnswering, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import type { Clock } from "@renderer/lib/clock.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { useDriverCapabilities } from "./useDriverCapabilities.js";
import { type DriverCapabilityReadout } from "@renderer/store/driver-capabilities/driver-capability-readout.js";

export interface CountingBridge {
  readonly bridge: PlatformBridge;
  /** The clock the bridge's window runs on: the scenario's frozen one. */
  readonly clock: Clock;
  readonly calls: readonly RecordedDaemonCall[];
}

/** One driver's report: the named flags true, every other flag false. */
export function reportFor(driverName: string, declared: readonly DriverCapabilityFlag[]): unknown {
  return {
    driverName,
    capabilities: {
      flags: Object.fromEntries(
        DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, declared.includes(flag)]),
      ),
      contractVersion: "1",
    },
    builtInTools: [],
  };
}

/**
 * The shipped fixture answering the capability read, and the record of every call.
 *
 * `answers` is walked in order, so a case about a node whose drivers changed between
 * two reads says so by supplying two replies; the last one stands for every read
 * after it, which is what a node that stopped changing does.
 *
 * Built on the shared `bridgeAnswering` rather than a private bridge cast to
 * `PlatformBridge`: the fixture bridge answers every other member honestly and
 * carries the scenario engine whose clock the scheduler runs on, which is why
 * `settleScheduledRead` settles these reads with the same call every other suite
 * makes.
 */
export function answeringCapabilityReads(...answers: readonly unknown[]): CountingBridge {
  let answered = 0;
  const { bridge, calls, engine } = bridgeAnswering(async ({ method }) => {
    if (method !== "driver.listCapabilities") {
      return undefined;
    }
    const reply = answers[Math.min(answered, answers.length - 1)];
    answered += 1;
    return reply;
  });
  return { bridge, calls, clock: engine.clock };
}

/** How many times one bridge was asked for the declarations. */
export function capabilityCallCount(counted: CountingBridge): number {
  return counted.calls.filter((call) => call.method === "driver.listCapabilities").length;
}

/** One consumer of the read, standing in for a feature that gates on it. */
export function CapabilityProbe(props: {
  readonly bridge: PlatformBridge;
  readonly onReadout: (readout: DriverCapabilityReadout | undefined) => void;
}): React.JSX.Element {
  const readout = useDriverCapabilities(props.bridge);
  props.onReadout(readout);
  return <span />;
}
