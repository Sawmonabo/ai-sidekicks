// The four ways a pane moves while its own box stays exactly the shape it was.
//
// Each source here is a case a size observer on the element reports as nothing at all:
// the deck reorders its seats, a sibling shrinks and the flex line redistributes, a
// rail slides in carrying everything inside it, and a fixed-size box beside it is given
// a new width in one step by a class. The pane's rectangle is wrong for the whole of
// each of them and the platform never says so on the element itself.
//
// This file owns which SOURCES reach the observer at all. What the observer then does
// with one — the frame loop it arms, what it costs at rest, and what survives the
// disposer — is `element-motion.sampling.test.ts`'s.
//
// The size seam's OWN cases are not here. `observeElementResize` lives in
// `primitives/element-resize.ts` and its test moved beside it; this suite still installs
// the fake, because the composed observer arms that seam over every ancestor it watches.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/index.js";
import { installFakeResizeObserver } from "../../primitives/element-resize.test-support.js";
import { observeElementPosition } from "./element-motion.js";
import {
  attachedPair,
  detachAttachedRoots,
  settleMutationRecords,
  withDocumentAnimations,
} from "./element-motion.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  withDocumentAnimations(undefined);
  detachAttachedRoots();
});

describe("observeElementPosition — the sources that reach it", () => {
  it("reports a reorder of the element's ancestors, which changes no size", async () => {
    installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    ancestor.insertBefore(document.createElement("div"), element);
    await settleMutationRecords();

    expect(onMove).toHaveBeenCalled();
    detach();
  });

  it("negative control: the element's OWN children changing is content, not placement", async () => {
    // Watching the element's child list instead of its ancestors' would fire on every
    // render of whatever the pane contains and never once on the deck reordering it.
    installFakeResizeObserver();
    const { element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    element.append(document.createElement("span"));
    await settleMutationRecords();

    expect(onMove).not.toHaveBeenCalled();
    detach();
  });

  it("reports a sibling's relayout, which the platform reports on the ancestor", () => {
    // A sibling that shrinks moves this element and resizes neither it nor, in the
    // reading a naive observer takes, anything else. What actually changes is the
    // ancestor's own content box, which is why the ancestors are what is observed.
    const resizeObserver = installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    resizeObserver.deliverFor(ancestor);

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("negative control: the element's own size belongs to the other seam", () => {
    // `observeElementResize` is armed over the host separately and reports
    // `resize-observer`. If this arm also claimed it, one relayout would be counted
    // as two different facts and the diagnostic reason would stop meaning anything.
    const resizeObserver = installFakeResizeObserver();
    const { element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    resizeObserver.deliverFor(element);

    expect(onMove).not.toHaveBeenCalled();
    detach();
  });
});
