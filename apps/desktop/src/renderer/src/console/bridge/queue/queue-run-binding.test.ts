// A refused binding read is asked again, exactly as the subscription beside it is.
//
// THE CLAIM IS THE SIBLING'S. `queue-reading.ts`'s `requestRead` lets a REFUSED
// subscription fall through its own short-circuit because "the joiner's arrival is
// exactly the reason to try the failed read again", and the binding read inside the
// same class got the opposite treatment: `#hasAsked` was terminal, so one refusal left
// every row in the runs pane queue and the composer shelf unbound for the life of the
// reading, under a refusal with no control and no trigger that could clear it.
//
// DRIVEN AT BOTH LEVELS, because the fix has two halves and either alone is silent: the
// class has to forget that it asked, and the reading has to ask it again. A case on the
// class alone would pass over a reading whose `requestRead` never reaches it.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { fixtureBridgeWithGrowth } from "../fixture/call-plane/bridge.test-support.js";
import { growthUnavailable } from "../growth-port/index.js";
import { RUNS_SCENARIO } from "../scenarios/runs.js";
import type { ConsoleBridge } from "../console-bridge.js";
import { QueueRunBindings } from "./queue-run-binding.js";
import { SessionQueueReading } from "./queue-reading.js";

const SESSION_ID = RUNS_SCENARIO.sessionId;

/** The shipped fixture with the one binding read answered by this case, and counted. */
function bridgeAnsweringBindings(answerFor: (askNumber: number) => "refused" | "served"): {
  readonly bridge: ConsoleBridge;
  readonly asks: () => number;
} {
  let asks = 0;
  const bridge = fixtureBridgeWithGrowth(RUNS_SCENARIO, {
    runRecordQueueRunBindingRead: async () => {
      asks += 1;
      return await Promise.resolve(
        answerFor(asks) === "refused"
          ? growthUnavailable("runRecordQueueRunBindingRead")
          : { status: "served", value: { bindings: [] } },
      );
    },
  });
  return { bridge, asks: () => asks };
}

describe("QueueRunBindings — a refused read is asked again and a served one clears it", () => {
  it("asks a second time once the first read settled refused", async () => {
    const { bridge, asks } = bridgeAnsweringBindings(() => "refused");
    const bindings = new QueueRunBindings(bridge, SESSION_ID, () => undefined);

    bindings.open();
    await crossMacrotaskBoundary();
    expect(asks()).toBe(1);
    expect(bindings.state.bindingRefusal).not.toBeUndefined();

    bindings.open();
    await crossMacrotaskBoundary();

    expect(asks()).toBe(2);
  });

  it("negative control: a served read is not asked again, because its answer stands", async () => {
    // Without this, the case above would pass over a binding read that asked on every
    // trigger — which is the standing question a repeat would re-put, and the whole
    // reason the class remembers having asked at all.
    const { bridge, asks } = bridgeAnsweringBindings(() => "served");
    const bindings = new QueueRunBindings(bridge, SESSION_ID, () => undefined);

    bindings.open();
    await crossMacrotaskBoundary();
    bindings.open();
    bindings.open();
    await crossMacrotaskBoundary();

    expect(asks()).toBe(1);
  });

  it("takes the stale refusal off the reading once a later read serves", async () => {
    const { bridge } = bridgeAnsweringBindings((askNumber) =>
      askNumber === 1 ? "refused" : "served",
    );
    const bindings = new QueueRunBindings(bridge, SESSION_ID, () => undefined);

    bindings.open();
    await crossMacrotaskBoundary();
    expect(bindings.state.bindingRefusal).not.toBeUndefined();

    bindings.open();
    await crossMacrotaskBoundary();

    expect(bindings.state.bindingRefusal).toBeUndefined();
  });
});

describe("SessionQueueReading — a read trigger re-asks the refused binding read", () => {
  it("issues a second binding read when a joiner or a repair asks for one", async () => {
    const { bridge, asks } = bridgeAnsweringBindings(() => "refused");
    const reading = new SessionQueueReading(bridge, SESSION_ID, () => undefined);
    const unwatch = reading.watch(() => undefined);
    await crossMacrotaskBoundary();
    expect(asks()).toBe(1);

    reading.requestRead("subscribe");
    await crossMacrotaskBoundary();

    expect(asks()).toBe(2);
    unwatch();
  });
});
