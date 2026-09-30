// One identity, current readings, and a cancel that finds the clock it armed on. A naive
// forwarder gets the third wrong: handles are per clock, so a cancel sent to the current clock
// cancels a stranger's work. `ManualClock.pendingCount` shows which one was canceled.

import { describe, expect, it } from "vitest";

import { ManualClock } from "./clock.js";
import { ForwardingClock } from "./forwarding-clock.js";

describe("ForwardingClock — the reading is the window's, the identity is the mount's", () => {
  it("answers from the clock held now, not the one it was constructed with", () => {
    const first = new ManualClock(1_000);
    const second = new ManualClock(50);
    const forwarding = new ForwardingClock(first);

    expect(forwarding.now()).toBe(1_000);
    forwarding.holdClock(second);

    // Backwards on purpose: two frozen fixture engines are two time bases.
    expect(forwarding.now()).toBe(50);
  });

  it("keeps one identity across every replacement", () => {
    const forwarding = new ForwardingClock(new ManualClock());
    const before = forwarding;
    forwarding.holdClock(new ManualClock());

    // `LiveAnnouncerProvider` rebuilds its announcer when the clock identity moves.
    expect(forwarding).toBe(before);
  });
});

describe("ForwardingClock — armed work stays with the clock that armed it", () => {
  it("cancels through the arming clock after the window's clock has moved", () => {
    const arming = new ManualClock();
    const current = new ManualClock();
    const forwarding = new ForwardingClock(arming);
    let fired = false;
    const handle = forwarding.scheduleTimeout(() => {
      fired = true;
    }, 100);
    forwarding.holdClock(current);

    forwarding.cancel(handle);
    arming.advance(1_000);

    expect(fired).toBe(false);
    expect(arming.pendingCount).toBe(0);
  });

  it("negative control: routing the cancel to the current clock strands the work", () => {
    // The defect the handle map prevents: another clock accepts the number and cancels nothing.
    const arming = new ManualClock();
    const current = new ManualClock();
    let fired = false;
    const handle = arming.scheduleTimeout(() => {
      fired = true;
    }, 100);

    current.cancel(handle);
    arming.advance(1_000);

    expect(fired).toBe(true);
  });

  it("fires through the current clock for work armed after the replacement", () => {
    const retired = new ManualClock();
    const live = new ManualClock();
    const forwarding = new ForwardingClock(retired);
    forwarding.holdClock(live);
    let fired = false;

    forwarding.scheduleTimeout(() => {
      fired = true;
    }, 10);
    retired.advance(1_000);
    expect(fired).toBe(false);

    live.advance(10);
    expect(fired).toBe(true);
  });

  it("forgets a handle once it has fired, and cancels an unknown one harmlessly", () => {
    // A fired handle leaves nothing behind, and an unknown handle cancels nothing.
    const clock = new ManualClock();
    const forwarding = new ForwardingClock(clock);
    const handle = forwarding.scheduleTimeout(() => undefined, 10);
    clock.advance(10);

    expect(() => {
      forwarding.cancel(handle);
      forwarding.cancel(handle);
      forwarding.cancel(9_999);
    }).not.toThrow();
    expect(clock.pendingCount).toBe(0);
  });

  it("routes a frame the same way a timeout is routed", () => {
    const arming = new ManualClock();
    const forwarding = new ForwardingClock(arming);
    let fired = false;
    const handle = forwarding.scheduleFrame(() => {
      fired = true;
    });
    forwarding.holdClock(new ManualClock());

    forwarding.cancel(handle);
    arming.runFrame();

    expect(fired).toBe(false);
    expect(arming.pendingFrameCount).toBe(0);
  });
});
