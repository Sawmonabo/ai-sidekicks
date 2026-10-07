// What the capability suites build their cases from: a driver's report, the counting bridge that
// answers it, and the probe that consumes the hook.

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { bridgeAnswering, type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { useDriverCapabilities } from "./useDriverCapabilities.js";
import { type DriverCapabilityReadout } from "#renderer/store/driver-capabilities/readout.js";

/** One driver with no models: the model catalog every capability case is answered with. */
const MODEL_CATALOG = { drivers: [{ driverName: "claude", models: [] }] };

/** A bridge that answers capability reads and records every call. */
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
 * The shipped fixture answering the capability read, and the record of every call. `answers` is
 * walked in order and the last one stands for every read after it; the model catalog read is
 * answered with {@link MODEL_CATALOG}. It uses the shared `bridgeAnswering` so the engine's clock
 * drives the scheduler, and `settleScheduledRead` works as in every other suite.
 */
export function answeringCapabilityReads(...answers: readonly unknown[]): CountingBridge {
  let answered = 0;
  const { bridge, calls, engine } = bridgeAnswering(async ({ method }) => {
    if (method === "driver.listModels") {
      return MODEL_CATALOG;
    }
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
