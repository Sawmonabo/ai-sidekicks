// How this tier narrows the page, and how it reports what would still need a
// sideways scroll.
//
// Not a test file — no `include` glob reaches it. It is `axe-run.ts`'s sibling for
// the one criterion axe cannot answer: WCAG 2.2 SC 1.4.10 (Reflow). `axe-tags.
// test.ts` records what the 2.2 tags select at this pin — nothing at Level A, and
// `target-size` alone at AA — so a surface that needed two-dimensional scrolling at
// 320 CSS px would pass every axe case in this directory. Reflow is a property of a
// LAYOUT AT A WIDTH rather than of a node's attributes, so it is measured by
// narrowing the page to the floor and reading what still overflows.
//
// WHY THE TESTER FRAME AND NOT THE BROWSER VIEWPORT. `Emulation.setDeviceMetrics
// Override` over the tier's `cdp()` handle is the obvious instrument and it does not
// work here: measured at this pin, an override to 320 leaves `window.innerWidth`
// inside the tester at the configured 1440. That handle drives the ORCHESTRATOR
// page's target, and the tests run in a same-origin iframe which that page sizes
// with CSS of its own — so the override moves a viewport the console is not laid
// out in. A test built on it would have measured every surface at the tier's default
// width and reported reflow clean at all of them. Resizing the frame element changes
// the CSS pixel width the tests' own document lays out in, which is the unit the
// criterion is written in, and `matchMedia` inside the frame answers against it.
//
// The narrowing throws rather than degrading when the frame is out of reach, which
// is this module's vacuity guard at the source: a silent no-op would leave every
// case measuring the console at 1440, where nothing overflows and every assertion
// below is true for the wrong reason.

/**
 * How much overflow is read as none, in px.
 *
 * `scrollWidth` and `clientWidth` are integers rounded from fractional layout, so a
 * box whose content is a third of a pixel wider than its padding box can report one
 * px of overflow that no person can scroll to. The criterion is about content that
 * REQUIRES scrolling, and one rounded pixel does not, so a single px is read as
 * none. Anything wider is reported.
 */
export const REFLOW_OVERFLOW_TOLERANCE_PX = 1;

/** The three properties the narrowing pins, so the frame cannot be re-sized by its host. */
const TESTER_FRAME_WIDTH_PROPERTIES: readonly string[] = ["width", "min-width", "max-width"];

/**
 * The inline style of the iframe this tier's tests run inside.
 *
 * Reached through a type that makes `style` optional rather than through a cast:
 * `window.frameElement` belongs to the PARENT document, so it is an object from
 * another realm and `instanceof HTMLIFrameElement` is false there however
 * well-formed the element is. Asking whether the member is present is the check
 * that survives the realm boundary.
 */
function testerFrameStyle(): CSSStyleDeclaration {
  const frameElement: (Element & Partial<ElementCSSInlineStyle>) | null = window.frameElement;
  if (frameElement?.style === undefined) {
    throw new Error(
      "the reflow tier could not reach its own tester frame, so no narrowing happened",
    );
  }
  return frameElement.style;
}

/**
 * Lay the tester document out at `cssPixels` wide, and prove it took.
 *
 * `!important`, because the width is the host page's declaration and this one has to
 * beat it. The readback is not defensive noise: it is the difference between this
 * tier measuring the console at the floor and measuring it at the tier's own 1440
 * viewport, and the second reports clean.
 */
export function narrowTesterViewportTo(cssPixels: number): void {
  const style = testerFrameStyle();
  for (const property of TESTER_FRAME_WIDTH_PROPERTIES) {
    style.setProperty(property, `${cssPixels}px`, "important");
  }
  if (window.innerWidth !== cssPixels) {
    throw new Error(
      `the reflow tier asked for a ${cssPixels}px viewport and got ${window.innerWidth}px`,
    );
  }
}

/** Hand the frame back to its host, so the next file in the tier starts at the tier's width. */
export function restoreTesterViewport(): void {
  const style = testerFrameStyle();
  for (const property of TESTER_FRAME_WIDTH_PROPERTIES) {
    style.removeProperty(property);
  }
}

/**
 * One line per element at or under `root` that would need a horizontal scroll.
 *
 * The LIST rather than a count, on `describeViolations`' reasoning: a failure has to
 * name the box to fix. Ancestors of an overflowing element report the overflow too,
 * because a box with `overflow: visible` measures its scrolling area over its
 * children — so a failure reads as a path from the frame down to the culprit, which
 * is more useful than the innermost line alone.
 *
 * Elements with no width are skipped. An inline box and a `display: contents`
 * wrapper both report zero for `clientWidth`, and an inline box reports its content
 * for `scrollWidth`, so every `<span>` of prose on the page would otherwise be
 * reported as overflowing its own zero-width box — which is a property of how the
 * two members are defined rather than of the layout.
 *
 * Boxes the author has CLIPPED are skipped too, and that is a reading of the
 * criterion rather than a convenience. 1.4.10 is about content a person has to
 * scroll sideways to reach; a box whose `overflow-x` is `hidden` or `clip` offers
 * no scrollbar and no scroll gesture, so nothing in it is reachable that way. The
 * console's own `.meridian-visually-hidden` is exactly this shape — a 1 px box
 * around text that exists for assistive technology — and it appears on every
 * surface, so a walk that reported it would report every page and mean nothing.
 * What this skip gives up is the criterion's OTHER half: content clipped away is a
 * loss of information, and this walk cannot tell deliberate screen-reader text from
 * a truncated label. That half is the axe runs' and a reader's, not this one's.
 */
export function describeHorizontalOverflow(root: Element): string[] {
  const overflowing: string[] = [];
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (element.clientWidth === 0 || isHorizontallyClipped(element)) {
      continue;
    }
    const overflowPx = element.scrollWidth - element.clientWidth;
    if (overflowPx > REFLOW_OVERFLOW_TOLERANCE_PX) {
      overflowing.push(
        `${describeElement(element)} overflows by ${overflowPx}px ` +
          `(client ${element.clientWidth}, scroll ${element.scrollWidth})`,
      );
    }
  }
  return overflowing;
}

/** Whether the author has clipped this box's inline axis, so nothing in it scrolls. */
function isHorizontallyClipped(element: Element): boolean {
  const overflowX = window.getComputedStyle(element).overflowX;
  return overflowX === "hidden" || overflowX === "clip";
}

/** An element as a reader would point at it: its tag, its id, and its classes. */
function describeElement(element: Element): string {
  const identifier = element.id === "" ? "" : `#${element.id}`;
  const classes = Array.from(element.classList, (className) => `.${className}`).join("");
  return `${element.localName}${identifier}${classes}`;
}

/**
 * The tier's negative control: a box wider than the floor, inside the console.
 *
 * It guards BOTH halves at once, which is why it is one node and not two. At the
 * narrowed width it overflows and the walk has to name it; at the tier's default
 * 1440 viewport it fits, so a narrowing that silently did nothing turns this control
 * red rather than leaving every clean case above true for the wrong reason. The
 * caller removes the node it is handed.
 */
export function plantHorizontalOverflow(parent: Element, floorCssPixels: number): HTMLElement {
  const planted = document.createElement("div");
  planted.style.width = `${floorCssPixels + 80}px`;
  planted.style.height = "1px";
  parent.append(planted);
  return planted;
}
