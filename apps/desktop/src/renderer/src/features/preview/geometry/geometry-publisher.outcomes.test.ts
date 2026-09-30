import { describe, expect, it } from "vitest";

import { AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { refuse } from "@renderer/lib/refusal.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import { PAGE_HOST_REFUSAL_ORIGIN } from "./page-host.js";
import { elementWithRect, RecordingPageHost, rect } from "./geometry-publisher.test-support.js";

// Who finds out what the page host said. The pane reads at attach, before the first frame, when
// the answer is `undefined`, so a `pane-gone` rejection has to be announced to reach it.
describe("PaneGeometryPublisher outcome subscription", () => {
  function countingSubscriber(publisher: PaneGeometryPublisher): {
    readonly count: () => number;
    readonly stop: () => void;
  } {
    let announced = 0;
    const stop = publisher.subscribeToOutcomes(() => {
      announced += 1;
    });
    return { count: () => announced, stop };
  }

  it("announces the publish the pane could not have read at attach", () => {
    const pageHost = new RecordingPageHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    // The frame has not run, which is the moment the pane reads.
    expect(publisher.lastOutcome()).toBeUndefined();
    expect(listener.count()).toBe(0);
    clock.runFrame();
    expect(listener.count()).toBe(1);
    expect(publisher.lastOutcome()?.status).toBe("published");
    publisher.dispose();
  });

  it("announces a dedupe too, because it is a reading and not a non-event", () => {
    const pageHost = new RecordingPageHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    const listener = countingSubscriber(publisher);
    publisher.invalidate("theme-change");
    clock.runFrame();
    expect(listener.count()).toBe(1);
    expect(publisher.lastOutcome()?.status).toBe("deduped");
    publisher.dispose();
  });

  it("announces the page host's rejection over a publisher it has already disposed", () => {
    // Disposal is terminal but keeps the sinks, so a notification raised after it still reaches
    // every subscriber, over a publisher whose `isDisposed` already agrees.
    const pageHost = new RecordingPageHost();
    pageHost.rejectNextWith(
      refuse(PAGE_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    expect(listener.count()).toBe(1);
    expect(publisher.isDisposed).toBe(true);
    expect(publisher.lastOutcome()).toStrictEqual({
      status: "suppressed",
      refusal: refuse(PAGE_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    });
  });

  it("reaches its terminal state even when a sink throws on the rejection", () => {
    // `Emitter` re-raises what a sink throws. With the announcement first, a throwing sink
    // carried the exception out of the flush before disposal ran, leaving the publisher armed.
    // The throw is still raised; it cannot keep the publisher alive.
    const pageHost = new RecordingPageHost();
    pageHost.rejectNextWith(
      refuse(PAGE_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    const sinkFailure = new Error("the outcome sink refused the rejection");
    publisher.subscribeToOutcomes(() => {
      throw sinkFailure;
    });
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));

    expect(() => {
      clock.runFrame();
    }).toThrow(sinkFailure);

    expect(publisher.isDisposed).toBe(true);
    expect(publisher.armedSourceCount).toBe(0);
    expect(pageHost.samples).toHaveLength(1);

    // And nothing reaches the page host afterwards, however late an invalidation arrives.
    publisher.invalidate("window-resize");
    clock.runFrame();
    expect(pageHost.samples).toHaveLength(1);
  });

  it("negative control: a sink that returns leaves the same terminal state", () => {
    // Without this, a flush that disposed and swallowed every sink failure would satisfy the
    // case above.
    const pageHost = new RecordingPageHost();
    pageHost.rejectNextWith(
      refuse(PAGE_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));

    expect(() => {
      clock.runFrame();
    }).not.toThrow();

    expect(listener.count()).toBe(1);
    expect(publisher.isDisposed).toBe(true);
    expect(publisher.armedSourceCount).toBe(0);
  });

  it("negative control: a stopped subscription hears nothing further", () => {
    // Without this, a publisher that announced unconditionally, or whose unsubscribe did nothing,
    // would satisfy every case above.
    const pageHost = new RecordingPageHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    expect(listener.count()).toBe(1);
    listener.stop();
    publisher.invalidate("window-resize");
    clock.runFrame();
    expect(listener.count()).toBe(1);
    publisher.dispose();
  });
});
