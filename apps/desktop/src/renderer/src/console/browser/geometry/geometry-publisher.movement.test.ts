import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AirspaceRegistry, ManualClock } from "../../core/index.js";
import { installFakeResizeObserver } from "../../primitives/element-resize.test-support.js";
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
  RecordingViewHost,
  rect,
} from "./geometry-publisher.test-support.js";

// The move source, and the reason that had no producer.
//
// `layout-mover` was in the invalidation enumeration and no production path raised
// it: a repo-wide search found it only in this file. So a pane carried by a deck
// reorder, a sibling's relayout, or a rail sliding in kept publishing its old
// rectangle until something unrelated — a scroll, a window resize, a theme flip —
// happened to invalidate, and the native view sat over whatever chrome the pane had
// just moved away from.
describe("PaneGeometryPublisher — the move source", () => {
  beforeEach(() => {
    installFakeResizeObserver();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    withDocumentAnimations(undefined);
    detachAttachedRoots();
  });

  /** Reorder the pane's parent around it, which is what a deck does to its seats. */
  function reorderAround(hostElement: HTMLElement): void {
    const sibling = trackAttachedRoot(document.createElement("div"));
    document.body.insertBefore(sibling, hostElement);
  }

  function publishingPublisherOver(hostElement: HTMLElement): {
    readonly publisher: PaneGeometryPublisher;
    readonly clock: ManualClock;
    readonly host: RecordingViewHost;
  } {
    const host = new RecordingViewHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    publisher.observe(hostElement);
    clock.runFrame();
    return { publisher, clock, host };
  }

  it("resamples once when the pane's parent is reordered around it", async () => {
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    const { publisher, clock, host } = publishingPublisherOver(hostElement);
    expect(publisher.publishCount).toBe(1);

    moveElementRect(hostElement, rect(0, 40, 100, 100));
    reorderAround(hostElement);
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(publisher.publishCount).toBe(2);
    expect(host.samples.at(-1)?.reason).toBe("layout-mover");
    expect(host.samples.at(-1)?.rect).toStrictEqual(rect(0, 40, 100, 100));
    publisher.dispose();
  });

  it("coalesces a move and a scroll arriving in one relayout into a single write", async () => {
    // Three observers firing on one relayout must cost one publish, not three:
    // publishing per source is what makes a pane drag during a rail collapse.
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    const { publisher, clock, host } = publishingPublisherOver(hostElement);

    publisher.invalidate("document-scroll");
    moveElementRect(hostElement, rect(0, 40, 100, 100));
    reorderAround(hostElement);
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(publisher.publishCount).toBe(2);
    // The move arrived last, so it is the reading that got written — a second
    // queued frame would have written the scroll's stale rectangle first.
    expect(host.samples.at(-1)?.reason).toBe("layout-mover");
    publisher.dispose();
  });

  it("publishes the pane's new rectangle while a fixed-size sibling animates beside it", () => {
    // A rail collapsing next to the pane. Nothing resizes — the rail, the pane, and
    // the row holding both keep the boxes they had — and nothing containing the pane
    // animates, so neither the size source nor a containment test sees anything. The
    // pane is nevertheless somewhere else on the screen for the whole animation, and
    // the native view is painted over whatever it moved away from until this arm
    // reads where it actually is.
    const sibling = trackAttachedRoot(document.createElement("div"));
    document.body.append(sibling);
    const hostElement = elementWithRect(rect(240, 0, 100, 100));
    withAnimations(hostElement, []);
    const { publisher, clock, host } = publishingPublisherOver(hostElement);
    expect(publisher.publishCount).toBe(1);

    const motion = movingAnimation();
    withDocumentAnimations([motion.animation]);
    sibling.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    moveElementRect(hostElement, rect(120, 0, 100, 100));
    clock.runFrame();
    clock.runFrame();

    expect(publisher.publishCount).toBe(2);
    expect(host.samples.at(-1)?.reason).toBe("layout-mover");
    expect(host.samples.at(-1)?.rect).toStrictEqual(rect(120, 0, 100, 100));
    motion.settle();
    clock.runFrame();
    clock.runFrame();
    // And it comes to rest: the idle-CPU budget says nothing samples once the
    // animation is over, and a loop that kept running would satisfy the case above.
    expect(clock.pendingCount).toBe(0);
    publisher.dispose();
  });

  it("publishes the new rectangle while an animation nothing announced carries the pane", async () => {
    // The same rail collapse, driven through `element.animate()` instead of a CSS
    // transition. No `transitionrun`, no `animationstart`, no size change on any
    // watched box — so before source 5 the sampler never armed and the native view
    // held the pane's old coordinates for the whole animation.
    const sibling = trackAttachedRoot(document.createElement("div"));
    document.body.append(sibling);
    const hostElement = elementWithRect(rect(240, 0, 100, 100));
    withAnimations(hostElement, []);
    const { publisher, clock, host } = publishingPublisherOver(hostElement);
    expect(publisher.publishCount).toBe(1);

    const motion = movingAnimation();
    withDocumentAnimations([motion.animation]);
    // Nothing announced it, so nothing is armed on the strength of the animation
    // alone. This is the half the finding is about.
    expect(clock.pendingCount).toBe(0);

    // The class the collapsing rail wrote, which is a source this module already had.
    sibling.className = "is-collapsing";
    await settleMutationRecords();
    moveElementRect(hostElement, rect(120, 0, 100, 100));
    clock.runFrame();

    expect(publisher.publishCount).toBe(2);
    expect(host.samples.at(-1)?.reason).toBe("layout-mover");
    expect(host.samples.at(-1)?.rect).toStrictEqual(rect(120, 0, 100, 100));

    motion.settle();
    clock.runFrame();
    clock.runFrame();
    // And it comes to rest: nothing samples once the animation is over.
    expect(clock.pendingCount).toBe(0);
    publisher.dispose();
  });

  it("negative control: a disposed publisher hears no reorder at all", async () => {
    // Without the disposer reaching the position sources, a pane that unmounted
    // would keep sampling for the life of the window, once per deck reorder.
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
