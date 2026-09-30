import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
import {
  detachAttachedRoots,
  movingAnimation,
  settleMutationRecords,
  trackAttachedRoot,
  withAnimations,
  withDocumentAnimations,
} from "./element-motion.test-support.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import {
  elementWithRect,
  moveElementRect,
  RecordingPageHost,
  rect,
} from "./geometry-publisher.test-support.js";

// The move source (`layout-mover`): a pane carried by a pane layout reorder, a sibling's relayout
// or a sliding rail would otherwise keep its old rectangle until something unrelated invalidated,
// leaving the native view over the chrome the pane moved away from.
describe("PaneGeometryPublisher — the move source", () => {
  beforeEach(() => {
    installFakeResizeObserver();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    withDocumentAnimations(undefined);
    detachAttachedRoots();
  });

  /** Reorder the pane's parent around it, which is what a pane layout does to its panes. */
  function reorderAround(hostElement: HTMLElement): void {
    const sibling = trackAttachedRoot(document.createElement("div"));
    document.body.insertBefore(sibling, hostElement);
  }

  function publishingPublisherOver(hostElement: HTMLElement): {
    readonly publisher: PaneGeometryPublisher;
    readonly clock: ManualClock;
    readonly pageHost: RecordingPageHost;
  } {
    const pageHost = new RecordingPageHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    publisher.observe(hostElement);
    clock.runFrame();
    return { publisher, clock, pageHost };
  }

  it("resamples once when the pane's parent is reordered around it", async () => {
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    const { publisher, clock, pageHost } = publishingPublisherOver(hostElement);
    expect(publisher.publishCount).toBe(1);

    moveElementRect(hostElement, rect(0, 40, 100, 100));
    reorderAround(hostElement);
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(publisher.publishCount).toBe(2);
    expect(pageHost.samples.at(-1)?.reason).toBe("layout-mover");
    expect(pageHost.samples.at(-1)?.rect).toStrictEqual(rect(0, 40, 100, 100));
    publisher.dispose();
  });

  it("coalesces a move and a scroll arriving in one relayout into a single write", async () => {
    // Three observers firing on one relayout must cost one publish; per-source publishing makes
    // a pane drag during a rail collapse.
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    const { publisher, clock, pageHost } = publishingPublisherOver(hostElement);

    publisher.invalidate("document-scroll");
    moveElementRect(hostElement, rect(0, 40, 100, 100));
    reorderAround(hostElement);
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(publisher.publishCount).toBe(2);
    // The move arrived last, so it is the reading written; a second queued frame would have
    // written the scroll's stale rectangle first.
    expect(pageHost.samples.at(-1)?.reason).toBe("layout-mover");
    publisher.dispose();
  });

  it("publishes the pane's new rectangle while a fixed-size sibling animates beside it", () => {
    // A rail collapsing next to the pane: nothing resizes and nothing containing the pane
    // animates, so neither the size source nor a containment test sees it, yet the pane is
    // elsewhere for the whole animation.
    const sibling = trackAttachedRoot(document.createElement("div"));
    document.body.append(sibling);
    const hostElement = elementWithRect(rect(240, 0, 100, 100));
    withAnimations(hostElement, []);
    const { publisher, clock, pageHost } = publishingPublisherOver(hostElement);
    expect(publisher.publishCount).toBe(1);

    const motion = movingAnimation();
    withDocumentAnimations([motion.animation]);
    sibling.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    moveElementRect(hostElement, rect(120, 0, 100, 100));
    clock.runFrame();
    clock.runFrame();

    expect(publisher.publishCount).toBe(2);
    expect(pageHost.samples.at(-1)?.reason).toBe("layout-mover");
    expect(pageHost.samples.at(-1)?.rect).toStrictEqual(rect(120, 0, 100, 100));
    motion.settle();
    clock.runFrame();
    clock.runFrame();
    // It comes to rest: nothing samples once the animation is over.
    expect(clock.pendingCount).toBe(0);
    publisher.dispose();
  });

  it("publishes the new rectangle while an animation nothing announced carries the pane", async () => {
    // The same collapse through `element.animate()`: no `transitionrun`, no `animationstart` and
    // no size change on any watched box.
    const sibling = trackAttachedRoot(document.createElement("div"));
    document.body.append(sibling);
    const hostElement = elementWithRect(rect(240, 0, 100, 100));
    withAnimations(hostElement, []);
    const { publisher, clock, pageHost } = publishingPublisherOver(hostElement);
    expect(publisher.publishCount).toBe(1);

    const motion = movingAnimation();
    withDocumentAnimations([motion.animation]);
    // Nothing announced it, so the animation alone arms nothing.
    expect(clock.pendingCount).toBe(0);

    // The class the collapsing rail wrote.
    sibling.className = "is-collapsing";
    await settleMutationRecords();
    moveElementRect(hostElement, rect(120, 0, 100, 100));
    clock.runFrame();

    expect(publisher.publishCount).toBe(2);
    expect(pageHost.samples.at(-1)?.reason).toBe("layout-mover");
    expect(pageHost.samples.at(-1)?.rect).toStrictEqual(rect(120, 0, 100, 100));

    motion.settle();
    clock.runFrame();
    clock.runFrame();
    // It comes to rest: nothing samples once the animation is over.
    expect(clock.pendingCount).toBe(0);
    publisher.dispose();
  });

  it("negative control: a disposed publisher hears no reorder at all", async () => {
    // Without the disposer reaching the position sources, an unmounted pane would keep sampling
    // for the life of the window.
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    const { publisher, clock } = publishingPublisherOver(hostElement);
    publisher.dispose();

    moveElementRect(hostElement, rect(0, 40, 100, 100));
    reorderAround(hostElement);
    await settleMutationRecords();

    expect(clock.pendingCount).toBe(0);
    expect(publisher.publishCount).toBe(1);
  });
});
