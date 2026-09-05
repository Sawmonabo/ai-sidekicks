import { describe, expect, it } from "vitest";

import { ManualClock, refuse } from "../core/index.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import { PaneOcclusionRegistry } from "./occlusion-registry.js";
import { PANE_VIEW_HOST_REFUSAL_ORIGIN, unavailablePaneViewHost } from "./view-host.js";
import { elementWithRect, RecordingViewHost, rect } from "./geometry-publisher.test-support.js";

// Who finds out what the host said.
//
// The publisher records an outcome on four paths and, until it announced them, the
// only way to read one was to ask at a moment of your own choosing. The pane's moment
// is attach — before the first frame has run, when the answer is `undefined` by
// construction — so a `pane-gone` rejection landed in a private field and reached
// nobody, and the surface kept saying "no page yet" over a host that had said the
// pane was destroyed.
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
    const host = new RecordingViewHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    // The frame has not run, which is exactly the moment the pane reads.
    expect(publisher.lastOutcome()).toBeUndefined();
    expect(listener.count()).toBe(0);
    clock.runFrame();
    expect(listener.count()).toBe(1);
    expect(publisher.lastOutcome()?.status).toBe("published");
    publisher.dispose();
  });

  it("announces a dedupe too, because it is a reading and not a non-event", () => {
    const host = new RecordingViewHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
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

  it("announces the host's rejection over a publisher it has already disposed", () => {
    // Both halves in one claim, and the order between them is what the case after
    // this one pins: disposal is terminal and it deliberately keeps the sinks, so a
    // notification raised after it still reaches everyone who was subscribed — and
    // reaches them over a publisher whose `isDisposed` already agrees with the
    // sentence they are about to render.
    const host = new RecordingViewHost();
    host.rejectNextWith(
      refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    expect(listener.count()).toBe(1);
    expect(publisher.isDisposed).toBe(true);
    expect(publisher.lastOutcome()).toStrictEqual({
      status: "suppressed",
      refusal: refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    });
  });

  it("announces the unavailable host's suppression, which is recorded before any frame", () => {
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host: unavailablePaneViewHost("no host in this window"),
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    expect(listener.count()).toBe(1);
    expect(publisher.lastOutcome()?.status).toBe("suppressed");
  });

  it("reaches its terminal state even when a sink throws on the rejection", () => {
    // `Emitter` re-raises what a sink threw. With the announcement first, a single
    // throwing observer carried the exception out of the flush before the disposal
    // ran — leaving the publisher armed, subscribed, and still writing rectangles to
    // a pane the host had just declared gone. The throw is still raised; what
    // changed is that it can no longer keep the publisher alive.
    const host = new RecordingViewHost();
    host.rejectNextWith(
      refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
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
    expect(host.samples).toHaveLength(1);

    // And nothing reaches the host afterwards, however late an invalidation arrives.
    publisher.invalidate("window-resize");
    clock.runFrame();
    expect(host.samples).toHaveLength(1);
  });

  it("negative control: a sink that returns leaves the same terminal state", () => {
    // Without this, a flush that disposed and then swallowed every sink failure
    // would satisfy the case above while hiding a defect in the one path whose
    // whole job is to report one.
    const host = new RecordingViewHost();
    host.rejectNextWith(
      refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
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
    // Without this, a publisher that announced unconditionally — or one whose
    // unsubscribe did nothing — would satisfy every case above, and a pane that had
    // unmounted would keep being told about rectangles it no longer has.
    const host = new RecordingViewHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
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
