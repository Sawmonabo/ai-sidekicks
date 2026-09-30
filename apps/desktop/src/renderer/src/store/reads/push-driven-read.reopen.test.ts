// A subscription that refused can be taken again, and only once at a time. The stub preload
// refuses every open because it implements each daemon method by throwing, so a refusal must
// not be terminal: the model's "started" state is the subscription handle, set only after the
// attempt succeeds. The clock is manual so cases drive the coalescing window without a timer.

import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { LatchedOnceOpen } from "./push-driven-read.latched-open.test-support.js";
import { PushDrivenRead } from "./push-driven-read.js";

/** Let the scheduler's in-flight promise settle without advancing the clock. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
  readonly readCount: () => number;
} {
  let opensAdmitted = false;
  let subscribeCount = 0;
  let readCount = 0;
  const model = new PushDrivenRead<string>({
    clock: options.clock,
    origin: "presence-roster",
    read: async () => {
      readCount += 1;
      return "roster";
    },
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
    readCount: () => readCount,
  };
}

describe("push-driven read — a refused open is not the end of the read", () => {
  it("settles failed and holds no subscription when the open refuses", async () => {
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });

    harness.model.start();
    clock.advance(5000);
    await settle();

    expect(harness.model.state).toStrictEqual({
      kind: "failed",
      refusal: {
        code: "subscribe-failed",
        detail: "daemon.subscribe is not available in this build",
        origin: "presence-roster",
      },
    });
    expect(harness.model.isSubscribed).toBe(false);
    expect(harness.readCount()).toBe(0);
  });

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
    expect(harness.model.state).toStrictEqual({ kind: "loaded", value: "roster" });
    expect(harness.subscribeCount()).toBe(2);
  });

  it("negative control: a trigger against a seam that still refuses re-attempts the open", async () => {
    // A model that did nothing on the trigger also reports `failed`, so the subscribe count is
    // what separates "tried again and was refused" from "never tried".
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });

    harness.model.start();
    clock.advance(5000);
    await settle();
    expect(harness.subscribeCount()).toBe(1);

    harness.model.refresh("user-request");
    clock.advance(5000);
    await settle();

    expect(harness.subscribeCount()).toBe(2);
    expect(harness.model.state.kind).toBe("failed");
    expect(harness.model.isSubscribed).toBe(false);
    // Still no read behind a subscription that never opened.
    expect(harness.readCount()).toBe(0);
  });

  it("takes one subscription when a seam signals from inside its own subscribe", async () => {
    // The single-flight case: a publisher that replays its state on subscription signals
    // before it has returned a handle, so the model is re-entered holding nothing.
    const clock = new ManualClock();
    const subscribe = vi.fn((onChangeSignal: () => void) => {
      onChangeSignal();
      onChangeSignal();
      return () => undefined;
    });
    const model = new PushDrivenRead<string>({
      clock,
      origin: "presence-roster",
      read: async () => "roster",
      subscribe,
    });

    model.start();
    clock.advance(200);
    await settle();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(model.isSubscribed).toBe(true);
    expect(model.state).toStrictEqual({ kind: "loaded", value: "roster" });
    model.dispose();
  });

  it("negative control: the shape this replaced refuses the re-open this one admits", async () => {
    // Both objects are driven over one seam that refuses the first subscribe and admits the
    // second, so only the open differs. `push-driven-read.latched-open.test-support.ts` is the
    // faulty open kept runnable as a control, so reintroducing it fails this case.
    let opensAdmitted = false;
    let latchedSubscribeCount = 0;
    const latched = new LatchedOnceOpen({
      origin: "presence-roster",
      subscribe: () => {
        latchedSubscribeCount += 1;
        if (!opensAdmitted) {
          throw new Error("daemon.subscribe is not available in this build");
        }
        return () => undefined;
      },
    });

    latched.start();
    expect(latched.state.kind).toBe("failed");

    // The repair a person performs: the seam works now, and the read is asked again.
    opensAdmitted = true;
    latched.refresh();
    latched.start();

    // It never asked a second time, so the refusal is still the answer and no
    // subscription is held — for the life of the window.
    expect(latchedSubscribeCount).toBe(1);
    expect(latched.isSubscribed).toBe(false);
    expect(latched.state.kind).toBe("failed");

    // The same seam, in the same order, against the real model.
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });
    harness.model.start();
    clock.advance(5000);
    await settle();
    expect(harness.model.state.kind).toBe("failed");

    harness.admitOpens();
    harness.model.refresh("user-request");
    clock.advance(200);
    await settle();

    expect(harness.subscribeCount()).toBe(2);
    expect(harness.model.isSubscribed).toBe(true);
    expect(harness.model.state).toStrictEqual({ kind: "loaded", value: "roster" });
  });

  it("negative control: a listener answering the refusal synchronously is not swallowed", async () => {
    // A `#changes` listener runs inside the settlement, so the open's single-flight guard must
    // already be lowered when the refusal settles, or a listener answering its own refusal
    // returns at the guard and asks for nothing. The subscribe count separates "answered" from
    // "ignored", since a model that did nothing also reports `failed`.
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });
    let answered = false;
    const stopListening = harness.model.onChange(() => {
      if (answered || harness.model.state.kind !== "failed") {
        return;
      }
      answered = true;
      // What a repair or a reconnect does on hearing the refusal.
      harness.admitOpens();
      harness.model.refresh("terminal-event");
    });

    harness.model.start();
    clock.advance(5000);
    await settle();

    expect(answered).toBe(true);
    expect(harness.subscribeCount()).toBe(2);
    expect(harness.model.isSubscribed).toBe(true);
    expect(harness.model.state).toStrictEqual({ kind: "loaded", value: "roster" });
    stopListening();
    harness.model.dispose();
  });

  it("negative control: dispose beats a re-open, and the trigger opens nothing", async () => {
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });

    harness.model.start();
    clock.advance(5000);
    await settle();
    harness.model.dispose();

    harness.admitOpens();
    harness.model.refresh("user-request");
    harness.model.start();
    clock.advance(5000);
    await settle();

    expect(harness.subscribeCount()).toBe(1);
    expect(harness.model.isSubscribed).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });
});
