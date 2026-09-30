// The ways a pane moves while its own box keeps its shape, which a size observer on the element
// reports as nothing: the pane layout reorders its panes, a sibling shrinks and the flex line
// redistributes, a rail slides in carrying everything inside it, and a fixed-size neighbor gets a
// new width in one step by a class. This file owns which sources reach the observer; the frame
// loop it then arms is `element-motion.sampling.test.ts`'s. The size seam's own cases are beside
// `lib/element-resize.ts`; this suite installs the fake because the observer arms that seam over
// every ancestor.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
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
    // Watching the element's own child list would fire on every render of whatever the pane
    // contains and never on the pane layout reordering it.
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
    // A shrinking sibling resizes neither this element nor, to a naive observer, anything else;
    // what changes is the ancestor's content box, which is why ancestors are observed.
    const resizeObserver = installFakeResizeObserver();
    const { ancestor, element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    resizeObserver.deliverFor(ancestor);

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("negative control: the element's own size belongs to the other seam", () => {
    // The host's own size is reported by a separate `observeElementResize` arm as
    // `resize-observer`; claiming it here too would count one relayout as two facts.
    const resizeObserver = installFakeResizeObserver();
    const { element } = attachedPair();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    resizeObserver.deliverFor(element);

    expect(onMove).not.toHaveBeenCalled();
    detach();
  });
});
