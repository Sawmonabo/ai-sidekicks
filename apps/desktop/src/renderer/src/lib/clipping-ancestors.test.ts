// Which ancestors clip, the shape the answer is declared in, and which reading decides.
//
// Carried here from `browser/geometry/geometry-publisher.clipping.test.ts` when the walk
// was hoisted out of that module: the vocabulary claims belong beside the vocabulary, and
// the publisher's own suite keeps only the claim that it subtracts what the walk finds.
// Two claims are new, and they are the ones the two copies disagreed about — an ancestor
// declared with the `overflow` shorthand alone is found, and a readable axis is never
// overruled by the shorthand.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIPPING_OVERFLOW_VALUES,
  clippingAncestorsOf,
  clipsItsContents,
  type ClippingOverflowValue,
} from "./clipping-ancestors.js";

/** One element inside another, both attached, so the walk has a real chain to climb. */
function attach(...elements: readonly HTMLElement[]): void {
  for (const [index, element] of elements.entries()) {
    const parent = elements[index - 1];
    if (parent === undefined) {
      document.body.append(element);
      continue;
    }
    parent.append(element);
  }
}

/**
 * Report `declaration` for ONE element and `visible` on both axes for every other.
 *
 * Scoped rather than blanket, because the walk runs to the document root: a blanket
 * answer makes `body` and the document element clippers too, so every case would report
 * three ancestors whichever value it named, which is no test at all.
 */
function withComputedStyle(subject: Element, declaration: Partial<CSSStyleDeclaration>): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (element: Element) =>
      (element === subject
        ? declaration
        : { overflowX: "visible", overflowY: "visible" }) as CSSStyleDeclaration,
  );
}

describe("clippingAncestorsOf — the ancestors that clip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  /** The ancestors found above a pane sitting inside one candidate clipper. */
  function ancestorsAbovePaneUnder(declaration: Partial<CSSStyleDeclaration>): readonly Element[] {
    const candidate = document.createElement("div");
    const pane = document.createElement("div");
    attach(candidate, pane);
    withComputedStyle(candidate, declaration);
    return [...clippingAncestorsOf(pane)];
  }

  it.each([...CLIPPING_OVERFLOW_VALUES])("finds an ancestor whose overflow is %s", (value) => {
    expect(ancestorsAbovePaneUnder({ overflowX: value, overflowY: value })).toHaveLength(1);
  });

  it.each(["visible", "", "revert-layer", "hiddenish"])(
    "walks past an ancestor whose overflow is %o",
    (value) => {
      // The empty string is the case the positive set exists for: a stylesheet-free
      // document reports it for every box, and a `!== "visible"` reading would clip every
      // pane to nothing and look exactly like a pane that never attached.
      expect(ancestorsAbovePaneUnder({ overflowX: value, overflowY: value })).toStrictEqual([]);
    },
  );

  it("finds an ancestor that clips on one axis only", () => {
    expect(ancestorsAbovePaneUnder({ overflowX: "hidden", overflowY: "visible" })).toHaveLength(1);
  });

  it("negative control: the union is closed over exactly the tuple", () => {
    // A type-level foil, and it is the control on the declaration rather than on the
    // behaviour: adding a sixth value to the tuple without adding it here fails to
    // compile, and so does naming one here that the tuple does not hold. Without it the
    // cases above would pass over a tuple that had quietly grown a member no reader knew
    // about.
    const everyClippingValue = {
      hidden: true,
      clip: true,
      scroll: true,
      auto: true,
      overlay: true,
    } satisfies Record<ClippingOverflowValue, true>;

    expect(Object.keys(everyClippingValue).toSorted()).toStrictEqual(
      [...CLIPPING_OVERFLOW_VALUES].toSorted(),
    );
  });

  it("negative control: a value the tuple does not hold clips nothing", () => {
    expect(clipsItsContents("auto")).toBe(true);
    expect(clipsItsContents("visible")).toBe(false);
  });
});

describe("clippingAncestorsOf — which reading decides", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("finds an ancestor declared with the overflow shorthand alone", () => {
    // The deck's shape, driven through the tier's REAL document rather than a fake,
    // because the reading being pinned is that document's: `happy-dom` reports the empty
    // string for both axes of an element whose only declaration is the shorthand, so a
    // walk that read the axes alone found nothing here — which is what the browser copy
    // did, under the very tier both copies are tested in.
    const scroller = document.createElement("div");
    scroller.style.overflow = "auto";
    const pane = document.createElement("div");
    attach(scroller, pane);

    expect([...clippingAncestorsOf(pane)]).toStrictEqual([scroller]);
  });

  it("reads a two-value shorthand as the two axes it names", () => {
    expect([...clippingAncestorsOf(paneUnderShorthandOnly("visible hidden"))]).toHaveLength(1);
  });

  it("negative control: a readable axis is not overruled by the shorthand", () => {
    // What makes the shorthand a FALLBACK rather than a third co-equal test. On a
    // conformant engine the shorthand is serialized FROM the axes and cannot disagree
    // with them, so a reading that let it win would be answering from the derived value.
    const candidate = document.createElement("div");
    const pane = document.createElement("div");
    attach(candidate, pane);
    withComputedStyle(candidate, {
      overflowX: "visible",
      overflowY: "visible",
      overflow: "hidden",
    });

    expect([...clippingAncestorsOf(pane)]).toStrictEqual([]);
  });

  it("negative control: an unattached element has nothing above it", () => {
    expect([...clippingAncestorsOf(document.createElement("div"))]).toStrictEqual([]);
  });

  /** A pane whose one candidate ancestor reports the shorthand and neither axis. */
  function paneUnderShorthandOnly(shorthand: string): Element {
    const candidate = document.createElement("div");
    const pane = document.createElement("div");
    attach(candidate, pane);
    withComputedStyle(candidate, { overflowX: "", overflowY: "", overflow: shorthand });
    return pane;
  }
});

describe("clippingAncestorsOf — the walk is lazy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("reads no style above the ancestor a caller stopped at", () => {
    // The property the deck's early exit rests on. An eager walk would take one
    // `getComputedStyle` per ancestor to the document root on every pass, and a pass is
    // armed on capture-phase document scroll.
    const outerClipper = document.createElement("div");
    const passThrough = document.createElement("div");
    const innerClipper = document.createElement("div");
    const pane = document.createElement("div");
    attach(outerClipper, passThrough, innerClipper, pane);
    const readStyle = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation(
        (element: Element) =>
          (element === outerClipper || element === innerClipper
            ? { overflowX: "hidden", overflowY: "hidden" }
            : { overflowX: "visible", overflowY: "visible" }) as CSSStyleDeclaration,
      );

    const walk = clippingAncestorsOf(pane);
    expect(walk.next().value).toBe(innerClipper);
    expect(readStyle).toHaveBeenCalledTimes(1);

    expect([...walk]).toStrictEqual([outerClipper]);
    expect(readStyle.mock.calls.length).toBeGreaterThan(1);
  });
});
