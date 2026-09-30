import { afterEach, describe, expect, it, vi } from "vitest";

import { AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import {
  elementWithRect,
  moveElementRect,
  RecordingPageHost,
  rect,
} from "./geometry-publisher.test-support.js";

// The size source, armed through the shared resize seam in `lib/element-resize.ts`.
describe("PaneGeometryPublisher — the size source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function publisherOverRecordingPageHost(): {
    readonly publisher: PaneGeometryPublisher;
    readonly clock: ManualClock;
    readonly pageHost: RecordingPageHost;
  } {
    const pageHost = new RecordingPageHost();
    const clock = new ManualClock();
    return {
      pageHost,
      clock,
      publisher: new PaneGeometryPublisher({
        pageHost,
        clock,
        occlusion: new AirspaceRegistry(),
      }),
    };
  }

  it("resamples on a size delivery for its own host element, and disconnects on dispose", () => {
    const resizeObserver = installFakeResizeObserver();
    const { publisher, clock, pageHost } = publisherOverRecordingPageHost();
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    publisher.observe(hostElement);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);

    moveElementRect(hostElement, rect(0, 0, 100, 240));
    resizeObserver.deliverFor(hostElement);
    clock.runFrame();

    expect(publisher.publishCount).toBe(2);
    expect(pageHost.samples.at(-1)?.reason).toBe("resize-observer");
    expect(pageHost.samples.at(-1)?.rect).toStrictEqual(rect(0, 0, 100, 240));

    publisher.dispose();
    expect(resizeObserver.liveObserverCount()).toBe(0);
  });

  it("negative control: a platform with no size observer still publishes, coarser", () => {
    // Feature detection belongs to the seam: an absent `ResizeObserver` makes the reading coarser
    // instead of throwing inside `observe` and leaving the pane publishing nothing.
    vi.stubGlobal("ResizeObserver", undefined);
    const { publisher, clock } = publisherOverRecordingPageHost();

    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();

    expect(publisher.publishCount).toBe(1);
    publisher.dispose();
  });
});
