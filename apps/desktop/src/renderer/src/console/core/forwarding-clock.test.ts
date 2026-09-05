// One identity, current readings, and a cancel that finds the clock it armed on.
//
// The three claims are separable and the third is the one a naive forwarder gets
// wrong: `ScheduledHandle` is a number each clock mints for itself, so forwarding a
// cancel to whichever clock is current cancels a stranger's work. `ManualClock` is
// the instrument here because it counts what is armed — `pendingCount` is what makes
// "the right one was cancelled" a reading rather than an inference.

import { describe, expect, it } from "vitest";

import { ManualClock } from "./clock.js";
import { ForwardingConsoleClock } from "./forwarding-clock.js";

describe("ForwardingConsoleClock — the reading is the window's, the identity is the mount's", () => {
  it("answers from the clock held now, not the one it was constructed with", () => {
    const first = new ManualClock(1_000);
    const second = new ManualClock(50);
    const forwarding = new ForwardingConsoleClock(first);

    expect(forwarding.now()).toBe(1_000);
    forwarding.holdClock(second);

    // Backwards, and deliberately: two frozen fixture engines are two time bases, and
    // reporting the retired one's would be the conflation this seam exists to end.
    expect(forwarding.now()).toBe(50);
  });

  it("keeps one identity across every replacement", () => {
    const forwarding = new ForwardingConsoleClock(new ManualClock());
    const before = forwarding;
    forwarding.holdClock(new ManualClock());

    // The property `LiveAnnouncerProvider` pins on: it re-mints its announcer when the
    // clock identity moves, so an identity that changed per replacement would rebuild
    // the announcer and drop whatever it was holding.
    expect(forwarding).toBe(before);
  });
});

describe("ForwardingConsoleClock — armed work stays with the clock that armed it", () => {
  it("cancels through the arming clock after the window's clock has moved", () => {
    const arming = new ManualClock();
    const current = new ManualClock();
    const forwarding = new ForwardingConsoleClock(arming);
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
    // The defect this seam's handle map prevents, driven through the real clocks. The
    // handle a clock mints is its own number, so the current clock happily accepts it
    // and cancels whatever it happens to name — here, nothing at all.
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
    const forwarding = new ForwardingConsoleClock(retired);
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
    // Both halves of the seam's idempotence claim: a fired handle leaves nothing behind
    // to grow the map, and a handle this never minted cancels nothing rather than
    // throwing — which is what makes a double cancel and a late cancel both safe.
    const clock = new ManualClock();
    const forwarding = new ForwardingConsoleClock(clock);
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
    const forwarding = new ForwardingConsoleClock(arming);
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
