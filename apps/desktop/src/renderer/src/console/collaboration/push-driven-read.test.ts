// The five rules the shared read discipline exists to hold.
//
// Each one is driven against the real module on a frozen clock: the class takes the
// clock as a dependency precisely so a test never needs a real timer, and
// `ManualClock.pendingCount` after teardown is how "no timer outlives the surface"
// is checked rather than asserted.

import { describe, expect, it, vi } from "vitest";

import { ConsoleRefusalError, ManualClock, refuse } from "../core/index.js";
import { PushDrivenRead } from "./push-driven-read.js";

/** Let the scheduler's in-flight promise settle without advancing the clock. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function buildRead(options: {
  readonly clock: ManualClock;
  readonly read: () => Promise<string>;
  readonly onSubscribe?: (signal: () => void) => void;
}): { model: PushDrivenRead<string>; signal: () => void; subscribeCount: () => number } {
  let capturedSignal: (() => void) | undefined;
  let subscribeCount = 0;
  const model = new PushDrivenRead<string>({
    clock: options.clock,
    origin: "test-read",
    read: options.read,
    subscribe: (onChangeSignal) => {
      subscribeCount += 1;
      capturedSignal = onChangeSignal;
      options.onSubscribe?.(onChangeSignal);
      return () => {
        capturedSignal = undefined;
      };
    },
  });
  return {
    model,
    signal: () => {
      capturedSignal?.();
    },
    subscribeCount: () => subscribeCount,
  };
}

describe("push-driven read — subscribe before read", () => {
  it("has an open subscription before the first read is performed", async () => {
    const clock = new ManualClock();
    let subscribedWhenReadRan: boolean | undefined;
    const harness = buildRead({
      clock,
      read: async () => {
        subscribedWhenReadRan = harness.model.isSubscribed;
        return "value";
      },
    });
    harness.model.start();
    clock.advance(200);
    await settle();
    expect(subscribedWhenReadRan).toBe(true);
  });

  it("negative control: nothing subscribes and nothing reads before start", () => {
    const clock = new ManualClock();
    const read = vi.fn(async () => "value");
    const harness = buildRead({ clock, read });
    clock.advance(5000);
    expect(harness.subscribeCount()).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(harness.model.state.kind).toBe("not-loaded");
  });

  it("subscribes exactly once across a repeated start, as strict mode does it", () => {
    const clock = new ManualClock();
    const harness = buildRead({ clock, read: async () => "value" });
    harness.model.start();
    harness.model.start();
    expect(harness.subscribeCount()).toBe(1);
  });
});

describe("push-driven read — one read per burst", () => {
  it("collapses a burst of signals into a single read", async () => {
    const clock = new ManualClock();
    const read = vi.fn(async () => "value");
    const harness = buildRead({ clock, read });
    harness.model.start();
    clock.advance(200);
    await settle();
    expect(harness.model.readCount).toBe(1);

    for (let signalIndex = 0; signalIndex < 8; signalIndex += 1) {
      harness.signal();
      clock.advance(10);
    }
    clock.advance(200);
    await settle();
    expect(harness.model.readCount).toBe(2);
  });

  it("negative control: signals spaced past the window each get their own read", async () => {
    const clock = new ManualClock();
    const harness = buildRead({ clock, read: async () => "value" });
    harness.model.start();
    clock.advance(200);
    await settle();
    for (let signalIndex = 0; signalIndex < 3; signalIndex += 1) {
      harness.signal();
      clock.advance(200);
      await settle();
    }
    expect(harness.model.readCount).toBe(4);
  });
});

describe("push-driven read — no flicker and no swallowed failure", () => {
  it("never returns to the loading shape once loaded", async () => {
    const clock = new ManualClock();
    const seen: string[] = [];
    let readCount = 0;
    const harness = buildRead({
      clock,
      read: async () => {
        readCount += 1;
        return `value-${String(readCount)}`;
      },
    });
    harness.model.onChange(() => {
      seen.push(harness.model.state.kind);
    });
    harness.model.start();
    clock.advance(200);
    await settle();
    harness.signal();
    clock.advance(200);
    await settle();
    expect(seen).toStrictEqual(["loaded", "loaded"]);
  });

  it("renders the daemon's own refusal rather than an empty result", async () => {
    const clock = new ManualClock();
    const harness = buildRead({
      clock,
      read: () =>
        Promise.reject(
          new ConsoleRefusalError(refuse("daemon", "channel.not_found", "That channel is gone.")),
        ),
    });
    harness.model.start();
    clock.advance(200);
    await settle();
    expect(harness.model.state).toStrictEqual({
      kind: "failed",
      refusal: { code: "channel.not_found", detail: "That channel is gone.", origin: "daemon" },
    });
  });

  it("names itself when the failure carries no refusal of its own", async () => {
    const clock = new ManualClock();
    const harness = buildRead({ clock, read: () => Promise.reject(new Error("socket closed")) });
    harness.model.start();
    clock.advance(200);
    await settle();
    expect(harness.model.state).toStrictEqual({
      kind: "failed",
      refusal: { code: "read-failed", detail: "socket closed", origin: "test-read" },
    });
  });
});

describe("push-driven read — teardown is terminal", () => {
  it("releases the subscription and arms no timer after dispose", async () => {
    const clock = new ManualClock();
    const read = vi.fn(async () => "value");
    const harness = buildRead({ clock, read });
    harness.model.start();
    clock.advance(200);
    await settle();
    harness.model.dispose();
    harness.signal();
    harness.model.refresh("reconnect");
    clock.advance(5000);
    await settle();
    expect(harness.model.isSubscribed).toBe(false);
    expect(clock.pendingCount).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("negative control: without dispose the same signal does produce a read", async () => {
    const clock = new ManualClock();
    const read = vi.fn(async () => "value");
    const harness = buildRead({ clock, read });
    harness.model.start();
    clock.advance(200);
    await settle();
    harness.signal();
    clock.advance(200);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
