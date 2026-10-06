// The heights a DOM shim has no layout engine to produce.
//
// The unit tier runs under happy-dom, which reports every box as zero, and
// `@tanstack/react-virtual` reads the scroller's viewport and each row's height through
// `offsetHeight`. A zero-height scroller correctly shows no rows, so a case asserting about a
// rendered diff row must state how tall the pane is, which also makes the window bound a real
// bound instead of one the overscan band satisfies.
//
// `tests/helpers/element/height-shim.ts` owns writing and restoring the global `offsetHeight`
// property; what stays here is the diff's part: which element is a scroller, which is a row, and
// which row a wrapped line grew.

import { ElementHeightShim } from "../element/height-shim.js";
import {
  DIFF_FILE_ROW_HEIGHT_PX,
  DIFF_ROW_HEIGHT_PX,
} from "#renderer/features/repos/diff/measures.js";

/** A row a wrapped line grew, and how tall it turned out. */
export interface DiffGrownRow {
  readonly rowIndex: number;
  readonly heightPx: number;
}

/** What a case says about the pane it is measuring. */
export interface DiffLayoutFixtureOptions {
  readonly viewportHeightPx: number;
  /** Absent, every row is one row tall. */
  readonly grownRow?: DiffGrownRow;
}

/**
 * The viewport the diff cases measure against, in CSS pixels.
 *
 * Tall enough that the window holds a screenful rather than only its overscan band, so a
 * rendered-row ceiling is a claim about virtualization.
 */
export const DIFF_FIXTURE_VIEWPORT_HEIGHT_PX = 800;

/**
 * Reports the heights a browser would have laid out.
 *
 * Installing twice replaces the reading instead of stacking a second shadow.
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
 * Either scroller answers the viewport, a row of either list answers its own, and everything else
 * answers the zero happy-dom gives anyway. Both lists are covered because the pane windows two:
 * the rows and the changed-file list beside them.
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
