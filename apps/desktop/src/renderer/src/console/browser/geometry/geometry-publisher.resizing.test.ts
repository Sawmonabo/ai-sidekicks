import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/index.js";
import { installFakeResizeObserver } from "../../primitives/element-resize.test-support.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import { PaneOcclusionRegistry } from "./occlusion-registry.js";
import {
  elementWithRect,
  moveElementRect,
  RecordingViewHost,
  rect,
} from "./geometry-publisher.test-support.js";

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
        occlusion: new PaneOcclusionRegistry({ clock }),
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
