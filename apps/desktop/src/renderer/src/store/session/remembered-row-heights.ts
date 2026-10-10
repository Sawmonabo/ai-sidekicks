// The transcript row heights one session measured, kept with the session rather than with its
// transcript's mount, so a transcript opened again lays its rows out at the heights they had. A
// height holds only on the display and at the row width it was measured at, so a change to either
// drops every height. Keys are opaque here: the transcript decides what a row key is.

/**
 * The display a row height was measured on: the two facts that re-lay out a row without changing
 * its content.
 */
export interface RowHeightDisplay {
  readonly devicePixelRatio: number;
  readonly rootFontSizePx: number;
}

/**
 * Row heights one session remembers before the least recently measured is let go.
 *
 * One transcript window's worth (its four hundred top-level rows): the rows a reopened transcript
 * mounts with and the screens a reader paged through around them. Measured on Node 24's V8, a
 * height kept as a small integer costs about 30 bytes beside its key, against 49 to 57 as a heap
 * number, so a full table is about 12 KB per open session.
 */
const REMEMBERED_ROW_HEIGHT_CAP = 400;

/**
 * Sixty-fourths of a pixel, the unit the layout engine positions boxes in. A height kept in it is
 * a small integer, which V8 stores in the map slot itself rather than as a heap number per entry,
 * and rounding to it moves a height by under 1/128 px.
 */
const LAYOUT_UNITS_PER_PX = 64;

/** One session's measured row heights, bounded, and dropped when the layout they hold for changes. */
export class RememberedRowHeights {
  readonly #cap: number;
  /** Insertion-ordered, so the cap evicts the least recently measured. */
  readonly #layoutUnitsByRowKey = new Map<string, number>();

  #display: RowHeightDisplay | undefined;
  #rowWidthPx: number | undefined;

  public constructor(cap: number = REMEMBERED_ROW_HEIGHT_CAP) {
    this.#cap = cap;
  }

  /** The display the heights were measured on, or `undefined` before one was declared. */
  public get display(): RowHeightDisplay | undefined {
    return this.#display;
  }

  /** A row's remembered height in pixels, or `undefined` when none is remembered. */
  public heightOf(rowKey: string): number | undefined {
    const layoutUnits = this.#layoutUnitsByRowKey.get(rowKey);
    return layoutUnits === undefined ? undefined : layoutUnits / LAYOUT_UNITS_PER_PX;
  }

  /**
   * Remember a row's height and answer the height kept, rounded to the layout's unit; the row
   * becomes the most recently measured.
   */
  public remember(rowKey: string, heightPx: number): number {
    const layoutUnits = Math.round(heightPx * LAYOUT_UNITS_PER_PX);
    this.#layoutUnitsByRowKey.delete(rowKey);
    this.#layoutUnitsByRowKey.set(rowKey, layoutUnits);
    for (const oldestRowKey of this.#layoutUnitsByRowKey.keys()) {
      if (this.#layoutUnitsByRowKey.size <= this.#cap) {
        break;
      }
      this.#layoutUnitsByRowKey.delete(oldestRowKey);
    }
    return layoutUnits / LAYOUT_UNITS_PER_PX;
  }

  /** Let go of every height whose row key `isKept` refuses. */
  public forgetAllExcept(isKept: (rowKey: string) => boolean): void {
    for (const rowKey of [...this.#layoutUnitsByRowKey.keys()]) {
      if (!isKept(rowKey)) {
        this.#layoutUnitsByRowKey.delete(rowKey);
      }
    }
  }

  /**
   * Declare the display rows are measured on now. A display other than the one the heights were
   * measured on drops them all; answers whether it did. The first declaration has nothing to drop.
   */
  public declareDisplay(display: RowHeightDisplay): boolean {
    const current = this.#display;
    this.#display = display;
    if (
      current === undefined ||
      (current.devicePixelRatio === display.devicePixelRatio &&
        current.rootFontSizePx === display.rootFontSizePx)
    ) {
      return false;
    }
    this.#layoutUnitsByRowKey.clear();
    return true;
  }

  /**
   * Declare the width rows are laid out at now, in pixels. Any other width than the one the
   * heights were measured at rewraps every row, so it drops them all; answers whether it did.
   */
  public declareRowWidth(rowWidthPx: number): boolean {
    const current = this.#rowWidthPx;
    this.#rowWidthPx = rowWidthPx;
    if (current === undefined || current === rowWidthPx) {
      return false;
    }
    this.#layoutUnitsByRowKey.clear();
    return true;
  }
}
