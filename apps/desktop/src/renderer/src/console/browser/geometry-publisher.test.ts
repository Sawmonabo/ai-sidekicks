// The publisher's two promises: read now, and write next frame.
//
// The cases below are about a publisher's failure modes rather than its output —
// publishing from inside observer delivery strands the view, retrying a rejected
// rectangle republishes it once a frame forever, and a burst of five invalidations
// that costs five writes is the reason a pane drags during a rail collapse. The last
// case is the control: every claim here about suppression, dedupe, and disposal would
// hold vacuously against a publisher that never armed or published anything at all.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock, refuse, type ConsoleRefusal } from "../core/index.js";
import { installFakeResizeObserver } from "./element-motion.test-support.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import { PaneOcclusionRegistry } from "./occlusion-registry.js";
import type { PaneGeometrySample, PaneRect } from "./pane-geometry.js";
import {
  PANE_VIEW_HOST_REFUSAL_ORIGIN,
  unavailablePaneViewHost,
  type AttachedPaneViewHost,
} from "./view-host.js";

function rect(x: number, y: number, width: number, height: number): PaneRect {
  return { x, y, width, height };
}

/** A host that records what it was handed, and can be told to reject. */
class RecordingViewHost implements AttachedPaneViewHost {
  public readonly state = "attached" as const;
  public readonly transport = "recording";
  public readonly samples: PaneGeometrySample[] = [];
  #rejection: ConsoleRefusal | undefined;

  public rejectNextWith(refusal: ConsoleRefusal): void {
    this.#rejection = refusal;
  }

  public setRect(sample: PaneGeometrySample): ReturnType<AttachedPaneViewHost["setRect"]> {
    this.samples.push(sample);
    return this.#rejection === undefined
      ? { status: "accepted" }
      : { status: "rejected", refusal: this.#rejection };
  }
}

/** Put an element's box where the test wants it, standing in for a relayout. */
function moveElementRect(element: HTMLElement, box: PaneRect): void {
  element.getBoundingClientRect = (): DOMRect =>
    ({
      ...box,
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
    }) as DOMRect;
}

/** An element whose box the test decides, standing in for a laid-out host. */
function elementWithRect(box: PaneRect): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  moveElementRect(element, box);
  return element;
}

describe("PaneGeometryPublisher", () => {
  function publisherOver(host: AttachedPaneViewHost): {
    readonly publisher: PaneGeometryPublisher;
    readonly clock: ManualClock;
    readonly occlusion: PaneOcclusionRegistry;
  } {
    const clock = new ManualClock();
    const occlusion = new PaneOcclusionRegistry();
    return { publisher: new PaneGeometryPublisher({ host, clock, occlusion }), clock, occlusion };
  }

  it("arms nothing at all on an unavailable host, and says why", () => {
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host: unavailablePaneViewHost("no host in this window"),
      clock,
      occlusion: new PaneOcclusionRegistry(),
    });
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    expect(publisher.armedSourceCount).toBe(0);
    expect(clock.pendingCount).toBe(0);
    expect(publisher.lastOutcome()?.status).toBe("suppressed");
    expect(publisher.publishCount).toBe(0);
  });

  it("reads on invalidation but does not write until the frame runs", () => {
    const host = new RecordingViewHost();
    const { publisher, clock } = publisherOver(host);
    publisher.observe(elementWithRect(rect(4, 8, 300, 200)));
    // `observe` invalidates once. The sample exists; the write does not.
    expect(host.samples).toStrictEqual([]);
    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(host.samples).toHaveLength(1);
    expect(host.samples[0]?.rect).toStrictEqual(rect(4, 8, 300, 200));
    publisher.dispose();
  });

  it("coalesces a burst into one frame and dedupes an unchanged publish", () => {
    const host = new RecordingViewHost();
    const { publisher, clock } = publisherOver(host);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    publisher.invalidate("window-resize");
    publisher.invalidate("document-scroll");
    publisher.invalidate("layout-mover");
    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);

    publisher.invalidate("theme-change");
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);
    expect(publisher.lastOutcome()?.status).toBe("deduped");
    publisher.dispose();
  });

  it("unsubscribes rather than retrying when the host says the pane is gone", () => {
    const host = new RecordingViewHost();
    host.rejectNextWith(
      refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const { publisher, clock } = publisherOver(host);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    expect(publisher.armedSourceCount).toBe(0);
    expect(publisher.lastOutcome()?.status).toBe("suppressed");

    publisher.invalidate("window-resize");
    clock.runFrame();
    expect(host.samples).toHaveLength(1);
  });

  it("re-samples when an overlay opens, so the view yields without waiting for a scroll", () => {
    const host = new RecordingViewHost();
    const { publisher, clock, occlusion } = publisherOver(host);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    occlusion.register("dialog", () => rect(0, 0, 500, 500));
    clock.runFrame();
    expect(host.samples.at(-1)?.visible).toBe(false);
    publisher.dispose();
  });

  it("is terminal: dispose cancels the queued frame and nothing re-arms", () => {
    const host = new RecordingViewHost();
    const { publisher, clock } = publisherOver(host);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    publisher.dispose();
    expect(clock.pendingCount).toBe(0);
    publisher.invalidate("window-resize");
    expect(clock.pendingCount).toBe(0);
    expect(host.samples).toStrictEqual([]);
  });

  it("negative control: an attached host does arm its sources and does publish", () => {
    // Every claim above about suppression and disposal would hold vacuously against a
    // publisher that never armed or published anything.
    const host = new RecordingViewHost();
    const { publisher, clock } = publisherOver(host);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    expect(publisher.armedSourceCount).toBeGreaterThan(0);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);
    publisher.dispose();
  });
});

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
      occlusion: new PaneOcclusionRegistry(),
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
      occlusion: new PaneOcclusionRegistry(),
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

  it("announces the host's rejection before disposing itself over it", () => {
    // The order is the whole point: disposal is terminal, so a notification raised
    // after it would be raised into a publisher nobody is listening to any more.
    const host = new RecordingViewHost();
    host.rejectNextWith(
      refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry(),
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
      occlusion: new PaneOcclusionRegistry(),
    });
    const listener = countingSubscriber(publisher);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    expect(listener.count()).toBe(1);
    expect(publisher.lastOutcome()?.status).toBe("suppressed");
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
      occlusion: new PaneOcclusionRegistry(),
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

// The size source, and the seam it is armed through.
//
// The publisher used to construct a `ResizeObserver` of its own beside the one
// `element-motion.ts` already owned — two bodies for one seam, free to drift in
// feature detection and in whether they disconnect, with nothing that would fail
// when they did. The arm runs through the seam now, and these are the two
// behaviours that had to survive the move.
describe("PaneGeometryPublisher — the size source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function publisherOverRecordingHost(): {
    readonly publisher: PaneGeometryPublisher;
    readonly clock: ManualClock;
    readonly host: RecordingViewHost;
  } {
    const host = new RecordingViewHost();
    const clock = new ManualClock();
    return {
      host,
      clock,
      publisher: new PaneGeometryPublisher({
        host,
        clock,
        occlusion: new PaneOcclusionRegistry(),
      }),
    };
  }

  it("resamples on a size delivery for its own host, and disconnects on dispose", () => {
    const resizeObserver = installFakeResizeObserver();
    const { publisher, clock, host } = publisherOverRecordingHost();
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    publisher.observe(hostElement);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);

    moveElementRect(hostElement, rect(0, 0, 100, 240));
    resizeObserver.deliverFor(hostElement);
    clock.runFrame();

    expect(publisher.publishCount).toBe(2);
    expect(host.samples.at(-1)?.reason).toBe("resize-observer");
    expect(host.samples.at(-1)?.rect).toStrictEqual(rect(0, 0, 100, 240));

    publisher.dispose();
    expect(resizeObserver.liveObserverCount()).toBe(0);
  });

  it("negative control: a platform with no size observer still publishes, coarser", () => {
    // The feature detection is the seam's now, and this is what it buys: an
    // absent `ResizeObserver` makes the reading coarser — the delivery above
    // never comes — rather than throwing inside `observe` and leaving the pane
    // publishing nothing at all.
    vi.stubGlobal("ResizeObserver", undefined);
    const { publisher, clock } = publisherOverRecordingHost();

    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();

    expect(publisher.publishCount).toBe(1);
    publisher.dispose();
  });
});
