import { describe, expect, it, vi } from "vitest";

import {
  ManualClock,
  COMPOSING_IDLE_STOP_MS,
  COMPOSING_PUBLISH_INTERVAL_MS,
} from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthServing,
  unscriptedScenario,
} from "../fixture/fixture-bridge.test-support.js";
import { ComposingPublisher, publishableChannelId } from "./composing-publisher.js";

const SESSION_ID = "session-composing";
const MAIN_CHANNEL_ID = "channel-main";
const RESTRICTED_CHANNEL_ID = "channel-review";

/** The bootstrap channel, named the way the projection names it. */
const MAIN_TARGET = { channelId: MAIN_CHANNEL_ID, channelName: "main" } as const;

/**
 * A publisher over a port that SERVES both writes, plus the clock driving its bounds.
 *
 * The port is the shipped fixture's with two operations replaced, which is the same
 * shape the settings suites take: everything the publisher is not exercising answers
 * the way a release build's port would, so a publisher that grew a third call would
 * meet a real refusal rather than `undefined`.
 */
function servingPublisher(): {
  readonly publisher: ComposingPublisher;
  readonly clock: ManualClock;
  readonly setCalls: ReturnType<typeof vi.fn>;
  readonly clearCalls: ReturnType<typeof vi.fn>;
} {
  const setCalls = vi.fn(growthServing<undefined>(undefined));
  const clearCalls = vi.fn(growthServing<undefined>(undefined));
  const bridge = fixtureBridgeWithGrowth(unscriptedScenario("composing-publisher"), {
    presenceComposingSet: setCalls,
    presenceComposingClear: clearCalls,
  });
  const clock = new ManualClock();
  return {
    publisher: new ComposingPublisher({ growth: bridge.growth, clock, sessionId: SESSION_ID }),
    clock,
    setCalls,
    clearCalls,
  };
}

/**
 * How far apart the keystrokes in the rate-limit cases fall.
 *
 * Shorter than the idle stop on purpose: the stop is the SHORTER of the two bounds,
 * so a case that advanced straight to the rate-limit window would have the line go
 * idle, clear, and then publish again on the next keystroke — proving a clear-then-
 * publish round trip rather than the window it meant to prove. A person still typing
 * is a person re-arming the stop, and that is what these cases play.
 */
const KEYSTROKE_INTERVAL_MS = 1_000;

/** Type steadily from the current instant until `elapsedMs` has passed. */
function typeUntil(publisher: ComposingPublisher, clock: ManualClock, elapsedMs: number): void {
  publisher.noteComposing(MAIN_TARGET);
  for (let elapsed = 0; elapsed < elapsedMs; elapsed += KEYSTROKE_INTERVAL_MS) {
    clock.advance(KEYSTROKE_INTERVAL_MS);
    publisher.noteComposing(MAIN_TARGET);
  }
}

describe("the composing gate — which channel a publication may name at all", () => {
  it("names the bootstrap channel, which every member of the session is in", () => {
    expect(publishableChannelId(MAIN_TARGET)).toBe(MAIN_CHANNEL_ID);
  });

  it("names nothing for a channel whose name is not the bootstrap one", () => {
    expect(
      publishableChannelId({ channelId: RESTRICTED_CHANNEL_ID, channelName: "review" }),
    ).toBeUndefined();
  });

  it("names nothing for a channel the projection has not named", () => {
    expect(
      publishableChannelId({ channelId: RESTRICTED_CHANNEL_ID, channelName: undefined }),
    ).toBeUndefined();
  });

  it("names nothing for the session's own default, which this window cannot name", () => {
    expect(publishableChannelId({ channelId: undefined, channelName: "main" })).toBeUndefined();
  });
});

describe("the composing publisher — how often a keystroke reaches the wire", () => {
  it("publishes on the first keystroke", async () => {
    const { publisher, setCalls } = servingPublisher();
    publisher.noteComposing(MAIN_TARGET);
    await crossMacrotaskBoundary();
    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      channelId: MAIN_CHANNEL_ID,
    });
  });

  it("publishes once for every keystroke inside the rate-limit window", async () => {
    const { publisher, clock, setCalls } = servingPublisher();
    typeUntil(publisher, clock, COMPOSING_PUBLISH_INTERVAL_MS - KEYSTROKE_INTERVAL_MS);
    await crossMacrotaskBoundary();
    expect(setCalls).toHaveBeenCalledTimes(1);
  });

  it("publishes again once the window has elapsed", async () => {
    const { publisher, clock, setCalls } = servingPublisher();
    typeUntil(publisher, clock, COMPOSING_PUBLISH_INTERVAL_MS);
    await crossMacrotaskBoundary();
    expect(setCalls).toHaveBeenCalledTimes(2);
  });
});

describe("the composing publisher — when a person stops", () => {
  it("publishes the clear once the line has been idle", async () => {
    const { publisher, clock, clearCalls } = servingPublisher();
    publisher.noteComposing(MAIN_TARGET);
    clock.advance(COMPOSING_IDLE_STOP_MS);
    await crossMacrotaskBoundary();
    expect(clearCalls).toHaveBeenCalledTimes(1);
    expect(publisher.publishedChannelId).toBeUndefined();
  });

  it("re-arms the idle stop on every keystroke rather than on every publication", async () => {
    const { publisher, clock, clearCalls } = servingPublisher();
    publisher.noteComposing(MAIN_TARGET);
    clock.advance(COMPOSING_IDLE_STOP_MS - 1);
    // Inside the rate-limit window, so this keystroke publishes nothing — and it must
    // still push the stop out, which is the difference between measuring the last
    // keystroke and measuring the last publication.
    publisher.noteComposing(MAIN_TARGET);
    clock.advance(COMPOSING_IDLE_STOP_MS - 1);
    await crossMacrotaskBoundary();
    expect(clearCalls).not.toHaveBeenCalled();
    expect(publisher.publishedChannelId).toBe(MAIN_CHANNEL_ID);
  });

  it("clears rather than leaves a publication standing when the target stops being publishable", async () => {
    const { publisher, setCalls, clearCalls } = servingPublisher();
    publisher.noteComposing(MAIN_TARGET);
    publisher.noteComposing({ channelId: RESTRICTED_CHANNEL_ID, channelName: "review" });
    await crossMacrotaskBoundary();
    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(clearCalls).toHaveBeenCalledTimes(1);
  });

  it("clears an outstanding publication when the composer is released", async () => {
    const { publisher, clearCalls } = servingPublisher();
    publisher.noteComposing(MAIN_TARGET);
    publisher.dispose();
    await crossMacrotaskBoundary();
    expect(clearCalls).toHaveBeenCalledTimes(1);
    expect(publisher.isDisposed).toBe(true);
  });
});

describe("the composing publisher — a wire nobody has built", () => {
  it("retires itself on the port's refusal and never calls it again", async () => {
    // The shipped fixture port, unmodified: it serves neither write, so this is the
    // refusal a release build actually answers with rather than one written here.
    const bridge = fixtureBridgeWithGrowth(unscriptedScenario("composing-refused"), {});
    const clock = new ManualClock();
    const refusedSet = vi.spyOn(bridge.growth, "presenceComposingSet");
    const publisher = new ComposingPublisher({
      growth: bridge.growth,
      clock,
      sessionId: SESSION_ID,
    });
    publisher.noteComposing(MAIN_TARGET);
    await crossMacrotaskBoundary();
    expect(publisher.isStopped).toBe(true);
    clock.advance(COMPOSING_PUBLISH_INTERVAL_MS);
    publisher.noteComposing(MAIN_TARGET);
    await crossMacrotaskBoundary();
    expect(refusedSet).toHaveBeenCalledTimes(1);
  });

  it("arms nothing once it has been retired", async () => {
    const bridge = fixtureBridgeWithGrowth(unscriptedScenario("composing-refused-idle"), {});
    const clock = new ManualClock();
    const publisher = new ComposingPublisher({
      growth: bridge.growth,
      clock,
      sessionId: SESSION_ID,
    });
    publisher.noteComposing(MAIN_TARGET);
    await crossMacrotaskBoundary();
    // The idle stop was armed by the keystroke and released by the refusal, so a
    // retired publisher leaves nothing behind for the clock to run.
    expect(clock.pendingCount).toBe(0);
  });
});
