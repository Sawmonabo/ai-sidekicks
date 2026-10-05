// The shared read discipline on a frozen clock: the subscription is open before the first read, so
// nothing that changes between the two is lost; a failed read renders the daemon's refusal rather
// than an empty answer, a subscribe that throws settles `failed` instead of taking the view down,
// and a refused open is not terminal. The stub preload refuses every open because it implements
// each daemon method by throwing, so "started" is the subscription handle, set only after the
// attempt succeeds, and a trigger re-attempts the open once at a time.

import { describe, expect, it, vi } from "vitest";

import { RefusalError, refuse } from "@renderer/lib/refusal.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { PushDrivenRead } from "./push-driven-read.js";

/** Let the scheduler's in-flight promise settle without advancing the clock. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A read over a subscribe seam that always opens. */
function buildRead(options: {
  readonly clock: ManualClock;
  readonly read: () => Promise<string>;
}): { readonly model: PushDrivenRead<string> } {
  const model = new PushDrivenRead<string>({
    clock: options.clock,
    origin: "test-read",
    read: options.read,
    subscribe: () => () => undefined,
  });
  return { model };
}

/**
 * A read whose subscribe refuses until `admitOpens` is called, then holds. The seam returns a
 * real release handle when admitting, so the model's own decision about "started" is driven.
 */
function buildRefusingRead(
  options: { readonly clock: ManualClock } = { clock: new ManualClock() },
): {
  readonly model: PushDrivenRead<string>;
  readonly subscribeCount: () => number;
  readonly admitOpens: () => void;
} {
  let opensAdmitted = false;
  let subscribeCount = 0;
  const model = new PushDrivenRead<string>({
    clock: options.clock,
    origin: "presence-list",
    read: async () => "presence",
    subscribe: () => {
      subscribeCount += 1;
      if (!opensAdmitted) {
        throw new Error("daemon.subscribe is not available in this build");
      }
      return () => undefined;
    },
  });
  return {
    model,
    subscribeCount: () => subscribeCount,
    admitOpens: () => {
      opensAdmitted = true;
    },
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
});

describe("push-driven read — no swallowed failure", () => {
  it("renders the daemon's own refusal rather than an empty result", async () => {
    const clock = new ManualClock();
    const harness = buildRead({
      clock,
      read: () =>
        Promise.reject(
          new RefusalError(refuse("daemon", "session.not_found", "That session is gone.")),
        ),
    });
    harness.model.start();
    clock.advance(200);
    await settle();
    expect(harness.model.state).toStrictEqual({
      kind: "failed",
      refusal: { code: "session.not_found", detail: "That session is gone.", origin: "daemon" },
    });
  });

  it("settles failed in the thrower's own words when subscribe throws synchronously", async () => {
    const clock = new ManualClock();
    const read = vi.fn(async () => "value");
    // The installed stub preload bridge throws exactly this way from every daemon method.
    const model = new PushDrivenRead<string>({
      clock,
      origin: "presence-list",
      read,
      subscribe: () => {
        throw new Error("daemon.subscribe is not available in this build");
      },
    });

    model.start();
    clock.advance(5000);
    await settle();

    expect(model.state).toStrictEqual({
      kind: "failed",
      refusal: {
        code: "subscribe-failed",
        detail: "daemon.subscribe is not available in this build",
        origin: "presence-list",
      },
    });
    // No read behind a subscription that never opened, and no timer armed for one.
    expect(read).not.toHaveBeenCalled();
    expect(model.isSubscribed).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("push-driven read — a refused open is not the end of the read", () => {
  it("re-opens on a user's trigger and loads behind the new subscription", async () => {
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });

    harness.model.start();
    clock.advance(5000);
    await settle();
    expect(harness.model.state.kind).toBe("failed");

    // What a repair, a focus, a reconnect, or a person pressing the control does.
    harness.admitOpens();
    harness.model.refresh("user-request");

    // Pinned before the read settles: the subscription is live and the refusal has stopped
    // being true, so the view says it is reading rather than that it broke.
    expect(harness.model.isSubscribed).toBe(true);
    expect(harness.model.state).toStrictEqual({ kind: "not-loaded" });

    clock.advance(200);
    await settle();

    expect(harness.model.isSubscribed).toBe(true);
    // The refusal is gone rather than standing beside a live subscription.
    expect(harness.model.state).toStrictEqual({ kind: "loaded", value: "presence" });
    expect(harness.subscribeCount()).toBe(2);
  });

  it("takes one subscription when a seam signals from inside its own subscribe", async () => {
    // The single-flight case: a publisher that resends its state on subscription signals
    // before it has returned a handle, so the model is re-entered holding nothing.
    const clock = new ManualClock();
    const subscribe = vi.fn((onChangeSignal: () => void) => {
      onChangeSignal();
      onChangeSignal();
      return () => undefined;
    });
    const model = new PushDrivenRead<string>({
      clock,
      origin: "presence-list",
      read: async () => "presence",
      subscribe,
    });

    model.start();
    clock.advance(200);
    await settle();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(model.isSubscribed).toBe(true);
    expect(model.state).toStrictEqual({ kind: "loaded", value: "presence" });
    model.dispose();
  });
});
