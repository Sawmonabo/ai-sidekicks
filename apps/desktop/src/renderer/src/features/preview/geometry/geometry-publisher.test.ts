// The publisher's two promises: read now, and write next frame.
//
// The cases below are about a publisher's failure modes rather than its output —
// publishing from inside observer delivery strands the view, retrying a rejected
// rectangle republishes it once a frame forever, and a burst of five invalidations
// that costs five writes is the reason a pane drags during a rail collapse. The last
// case is the control: every claim here about suppression, dedupe, and disposal would
// hold vacuously against a publisher that never armed or published anything at all.
//
// Four suites sit beside this one, each about a different question the publisher
// answers — who is told what the page host said, and the three sources that make it ask.

import { describe, expect, it } from "vitest";

import { AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { refuse } from "@renderer/lib/refusal.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import { PAGE_HOST_REFUSAL_ORIGIN, type PageHost } from "./page-host.js";
import { elementWithRect, RecordingPageHost, rect } from "./geometry-publisher.test-support.js";

describe("PaneGeometryPublisher", () => {
  function publisherOver(pageHost: PageHost): {
    readonly publisher: PaneGeometryPublisher;
    readonly clock: ManualClock;
    readonly occlusion: AirspaceRegistry;
  } {
    const clock = new ManualClock();
    const occlusion = new AirspaceRegistry();
    return {
      publisher: new PaneGeometryPublisher({ pageHost, clock, occlusion }),
      clock,
      occlusion,
    };
  }

  it("reads on invalidation but does not write until the frame runs", () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(4, 8, 300, 200)));
    // `observe` invalidates once. The sample exists; the write does not.
    expect(pageHost.samples).toStrictEqual([]);
    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(pageHost.samples).toHaveLength(1);
    expect(pageHost.samples[0]?.rect).toStrictEqual(rect(4, 8, 300, 200));
    publisher.dispose();
  });

  it("coalesces a burst into one frame and dedupes an unchanged publish", () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
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

  it("unsubscribes rather than retrying when the page host says the pane is gone", () => {
    const pageHost = new RecordingPageHost();
    pageHost.rejectNextWith(
      refuse(PAGE_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    expect(publisher.armedSourceCount).toBe(0);
    expect(publisher.lastOutcome()?.status).toBe("suppressed");

    publisher.invalidate("window-resize");
    clock.runFrame();
    expect(pageHost.samples).toHaveLength(1);
  });

  it("re-samples when an overlay opens, so the view yields without waiting for a scroll", () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock, occlusion } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    occlusion.register("dialog", () => rect(0, 0, 500, 500));
    clock.runFrame();
    expect(pageHost.samples.at(-1)?.visible).toBe(false);
    publisher.dispose();
  });

  it("is terminal: dispose cancels the queued frame and nothing re-arms", () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    publisher.dispose();
    expect(clock.pendingCount).toBe(0);
    publisher.invalidate("window-resize");
    expect(clock.pendingCount).toBe(0);
    expect(pageHost.samples).toStrictEqual([]);
  });

  it("negative control: an attached host element does arm its sources and does publish", () => {
    // Every claim above about suppression and disposal would hold vacuously against a
    // publisher that never armed or published anything.
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    expect(publisher.armedSourceCount).toBeGreaterThan(0);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);
    publisher.dispose();
  });
});
