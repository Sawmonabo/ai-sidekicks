// The heights a DOM shim has no layout engine to produce.
//
// The console's unit tier runs under happy-dom, which reports every box as zero.
// A virtualized list reads exactly one of those boxes twice over — the scroller's,
// which is the viewport it windows against, and each rendered row's, which is how
// tall that row turned out — and `@tanstack/react-virtual` reads both of them
// through `offsetHeight`. Against a zero-height scroller it answers with an empty
// range, which is correct and is not a bug to route around: a scroller with no
// height shows no rows. So a happy-dom case that asserts anything about a rendered
// diff row has to say how tall the pane is, and this module is where it says it.
//
// WHAT THIS BUYS BEYOND MAKING THE CASES PASS. Before a virtualizer was adopted,
// those cases ran against a viewport of zero and were carried entirely by the
// overscan band — a window bound of "fewer than a hundred rows" that a zero-height
// viewport satisfies without virtualizing anything. Stating the height makes the
// bound a bound.
//
// IT IS NOT IMPORTED BY ANY RENDERING PATH, and the FILE NAME is what says so. This
// module shadows a property on `HTMLElement.prototype` — global to the environment,
// which is why installing and restoring are one object's two methods rather than a
// module-level flag two files could both flip — and a shim of that reach reached from
// a rendering path would be a production surface monkey-patching the DOM. Under the
// `.test-support.ts` suffix the claim stops being a sentence in a header: the shared
// source walk every architecture gate reads excludes these modules, and the layering
// gate admits them as roots precisely because their only legitimate dependents are
// the suites it removes from the graph. The rule `diff-fixture.test-support.ts` keeps by hand, this
// one keeps by name.

import { DIFF_FILE_ROW_HEIGHT_PX, DIFF_ROW_HEIGHT_PX } from "./diff-bounds.js";

/** A row the wrap toggle grew, and how tall it turned out. */
export interface DiffGrownRow {
  readonly rowIndex: number;
  readonly heightPx: number;
}

/** What a case says about the pane it is measuring. */
export interface DiffLayoutFixtureOptions {
  readonly viewportHeightPx: number;
  /** Absent, every row is one row tall — which is the unwrapped diff. */
  readonly grownRow?: DiffGrownRow;
}

/**
 * The viewport the diff cases measure against, in CSS pixels.
 *
 * A laptop-class pane: tall enough that the window holds a screenful rather than
 * only its overscan band, which is what makes a rendered-row ceiling a claim about
 * virtualization rather than about the overscan constant.
 */
export const DIFF_FIXTURE_VIEWPORT_HEIGHT_PX = 800;

/**
 * Report the heights a browser would have laid out.
 *
 * Installing twice replaces the reading rather than stacking a second shadow, so
 * a case that wants a grown row says so in one line and the hook that installed
 * the plain reading stays where it is.
 */
export class DiffLayoutFixture {
  #restore: (() => void) | undefined;

  public install(options: DiffLayoutFixtureOptions): void {
    this.restore();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return laidOutHeightPx(this, options);
      },
    });
    this.#restore = () => {
      if (original === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      } else {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      }
    };
  }

  public restore(): void {
    this.#restore?.();
    this.#restore = undefined;
  }
}

/**
 * The height one element reports.
 *
 * Either scroller answers the viewport, a row of either list answers its own, and
 * everything else answers the zero happy-dom answers anyway — so nothing outside the
 * diff changes behaviour under an installed fixture.
 *
 * BOTH LISTS, because the pane windows two: the rows, and the changed-file list
 * beside them. A fixture that knew only the first would leave every file-list case
 * measuring a zero-height viewport, which is the state a window bound cannot be a
 * bound in.
 */
function laidOutHeightPx(element: HTMLElement, options: DiffLayoutFixtureOptions): number {
  if (
    element.classList.contains("meridian-diff") ||
    element.classList.contains("meridian-diff-files__scroller")
  ) {
    return options.viewportHeightPx;
  }
  if (element.classList.contains("meridian-diff-files__row")) {
    return DIFF_FILE_ROW_HEIGHT_PX;
  }
  if (!element.classList.contains("meridian-diff__row")) {
    return 0;
  }
  const rowIndex = Number(element.getAttribute("data-index"));
  return options.grownRow !== undefined && options.grownRow.rowIndex === rowIndex
    ? options.grownRow.heightPx
    : DIFF_ROW_HEIGHT_PX;
}
