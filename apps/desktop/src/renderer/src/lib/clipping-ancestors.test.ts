// Which ancestors clip, and which reading decides: the axes, with the shorthand as a fallback.

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
 * Report `declaration` for one element and `visible` on both axes for every other. Scoped
 * because the walk reaches the document root, and a blanket answer would make `body` clip too.
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
      // The empty string is what a stylesheet-free document reports for every box.
      expect(ancestorsAbovePaneUnder({ overflowX: value, overflowY: value })).toStrictEqual([]);
    },
  );

  it("finds an ancestor that clips on one axis only", () => {
    expect(ancestorsAbovePaneUnder({ overflowX: "hidden", overflowY: "visible" })).toHaveLength(1);
  });

  it("negative control: the union is closed over exactly the tuple", () => {
    // A type-level control: a value added to the tuple but not here, or here but not in the
    // tuple, fails to compile.
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
    // Uses the tier's real document: `happy-dom` reports the empty string for both axes of an
    // element styled with the shorthand alone, so a walk reading only the axes finds nothing.
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
    // The shorthand is a fallback: a conformant engine derives it from the axes.
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
    // The pane layout's early exit relies on this; an eager walk reads every ancestor per pass.
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
