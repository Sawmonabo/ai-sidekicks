// A subscription that refused can be taken again, and only once at a time.
//
// The suite beside this one drives the five rules a push-driven read holds while its
// subscription is up. These cases are about the state that reaches every one of them
// first: the open itself, which the shipped Tier-1 preload refuses on every call,
// because that build implements each daemon method by throwing. Under the shape this
// replaced, that refusal was terminal for the life of the window — the model marked
// itself started BEFORE the attempt, so every later open returned at the guard and
// `refresh()` requested reads behind a subscription nothing had ever taken.
//
// The clock is manual for the reason the sibling suite gives: the model takes one so
// a case can drive its coalescing window without a real timer.

import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "../core/index.js";
import { PushDrivenRead } from "./push-driven-read.js";

/** Let the scheduler's in-flight promise settle without advancing the clock. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A read whose subscribe refuses until `admitOpens` is called, then holds.
 *
 * The seam is a real one — it returns a real release handle on the admitting arm —
 * so what these cases drive is the model's own decision about when it has started,
 * and never a stand-in for the decision.
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

describe("push-driven read — a refused open is not the end of the surface", () => {
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

  it("re-opens on a participant's trigger and loads behind the new subscription", async () => {
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });

    harness.model.start();
    clock.advance(5000);
    await settle();
    expect(harness.model.state.kind).toBe("failed");

    // What a repair, a focus, a reconnect, or a person pressing the control does.
    harness.admitOpens();
    harness.model.refresh("participant-request");

    // Pinned BEFORE the read settles, because this is the moment the replaced shape
    // could not reach: the subscription is live and the refusal beside it has already
    // stopped being true, so the surface says it is reading rather than that it broke.
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
    // This is the case the replaced shape got wrong, and the one an assertion on the
    // state alone cannot see: a model that did NOTHING on the trigger also reports
    // `failed`. The subscribe count is what separates "tried again and was refused"
    // from "never tried" — under the old shape it stays at one.
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });

    harness.model.start();
    clock.advance(5000);
    await settle();
    expect(harness.subscribeCount()).toBe(1);

    harness.model.refresh("participant-request");
    clock.advance(5000);
    await settle();

    expect(harness.subscribeCount()).toBe(2);
    expect(harness.model.state.kind).toBe("failed");
    expect(harness.model.isSubscribed).toBe(false);
    // Still no read behind a subscription that never opened.
    expect(harness.readCount()).toBe(0);
  });

  it("takes one subscription when a seam signals from inside its own subscribe", async () => {
    // The single-flight case. A publisher that replays its current state on
    // subscription calls the change signal before it has returned a handle, so the
    // model is re-entered holding nothing — which is indistinguishable, from inside,
    // from a trigger arriving while an open is under way.
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

  it("negative control: dispose beats a re-open, and the trigger opens nothing", async () => {
    const clock = new ManualClock();
    const harness = buildRefusingRead({ clock });

    harness.model.start();
    clock.advance(5000);
    await settle();
    harness.model.dispose();

    harness.admitOpens();
    harness.model.refresh("participant-request");
    harness.model.start();
    clock.advance(5000);
    await settle();

    expect(harness.subscribeCount()).toBe(1);
    expect(harness.model.isSubscribed).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });
});
