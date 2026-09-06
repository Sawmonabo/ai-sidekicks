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
// THE SHADOW IS NOT THIS MODULE'S AND THE RULE IS. `repos/element-height-shim.test-support.ts`
// owns writing the property on `HTMLElement.prototype` and taking it back, because that
// write is global to the environment and this family has two windowed lists that each
// needed it — written twice, one of the two copies could leak a shadow into every later
// file in the same worker. What stays here is the only part that is the diff's: which
// element is a scroller, which is a row, and which row the wrap toggle grew.

import { ElementHeightShim } from "../element-height-shim.test-support.js";
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
  readonly #shim = new ElementHeightShim();

  public install(options: DiffLayoutFixtureOptions): void {
    this.#shim.install((element) => laidOutHeightPx(element, options));
  }

  public restore(): void {
    this.#shim.restore();
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
