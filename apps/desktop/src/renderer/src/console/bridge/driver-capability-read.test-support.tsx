// What both halves of the capability suite build their cases out of.
//
// The read's cases and the pure readers' cases were one file, and the fixtures they
// share are the reason it could be split at all: a driver's report, the counting
// bridge that answers it, the probe that consumes the hook, and the two readings that
// stand for "nothing was read". Written once so the two files cannot drift into
// disagreeing about what a report looks like.

import { type ConsoleRefusal } from "../core/index.js";
import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import { bridgeAnswering, type RecordedDaemonCall } from "./fixture-bridge.test-support.js";
import type { ConsoleBridge } from "./console-bridge.js";
import { useDriverCapabilities, type DriverCapabilityReadout } from "./driver-capability-read.js";

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
  };
}

export interface CountingBridge {
  readonly bridge: ConsoleBridge;
  readonly calls: readonly RecordedDaemonCall[];
}

/**
 * The shipped fixture answering the capability read, and the record of every call.
 *
 * `answers` is walked in order, so a case about a node whose drivers changed between
 * two reads says so by supplying two replies; the last one stands for every read
 * after it, which is what a node that stopped changing does.
 *
 * Over the family's own `bridgeAnswering` rather than a second one of this file's
 * own. What stood here was a private function of the same name built on an object
 * cast to `ConsoleBridge`, which answered every other seam with whatever it happened
 * to carry and had to mint a hand-made scenario engine so the scheduler had a clock —
 * a member the fixture already has, and the reason `settleScheduledRead` can now
 * settle these reads with the same call every other console suite makes.
 */
export function answeringCapabilityReads(...answers: readonly unknown[]): CountingBridge {
  let answered = 0;
  return bridgeAnswering(async ({ method }) => {
    if (method !== "driver.listCapabilities") {
      return undefined;
    }
    const reply = answers[Math.min(answered, answers.length - 1)];
    answered += 1;
    return reply;
  });
}

/** How many times one bridge was asked for the declarations. */
export function capabilityCallCount(counted: CountingBridge): number {
  return counted.calls.filter((call) => call.method === "driver.listCapabilities").length;
}

/** One consumer of the read, standing in for a view family that gates on it. */
export function CapabilityProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly onReadout: (readout: DriverCapabilityReadout | undefined) => void;
}): React.JSX.Element {
  const readout = useDriverCapabilities(props.bridge);
  props.onReadout(readout);
  return <span />;
}

/** The refusal a settled reading carries, or a failure naming what was found instead. */
export function settledRefusalOf(readout: DriverCapabilityReadout | undefined): ConsoleRefusal {
  if (readout?.readRefusal === undefined) {
    throw new Error("the capability read settled without the refusal the case is about");
  }
  return readout.readRefusal;
}

/** A reading no read produces, so a probe whose callback never ran fails loudly. */
export function neverRead(): DriverCapabilityReadout {
  return { flagsByDriverName: new Map(), driverNameByRunId: new Map(), readRefusal: undefined };
}
