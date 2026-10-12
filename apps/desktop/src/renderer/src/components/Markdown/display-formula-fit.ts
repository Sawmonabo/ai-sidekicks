// Fits a window's display formulas to their columns from one resize watch over every formula's
// span and its unbreakable pieces. Widths come from the watch's reports, never a layout read, and
// each report's formulas are all read before any is written, so one formula's write never makes
// another's read lay the page out.

import { RealClock, type ScheduledHandle } from "#renderer/lib/clock.js";
import { watchElementsResize, type ElementResizeWatch } from "#renderer/lib/element-resize.js";

/**
 * The display formulas of one window, each fitted to its column: `--math-natural-width` is written
 * on a formula's span when it first has a width, and raised on a later report where a piece drawn
 * at whole-pixel glyph widths overran the column. A write resizes the span and its pieces, so
 * their watch stops in the same report and starts again on the next frame: a report of the size
 * the write made would otherwise land in the same pass, which the browser refuses with a window
 * error.
 */
export class DisplayFormulaFits {
  readonly #watch: ElementResizeWatch;
  /** The span's own window paces the rewatch, not the app's clock: it is layout, not time. */
  readonly #clock: RealClock;
  /** The formula each watched span and piece belongs to. */
  readonly #formulaOf = new Map<Element, FittedFormula>();
  /** Each watched element's border-box width as its last report gave it, in CSS pixels. */
  readonly #widthsPx = new WeakMap<Element, number>();

  public constructor(view: Window & typeof globalThis) {
    this.#clock = new RealClock(view);
    this.#watch = watchElementsResize(view, (entries) => {
      this.#fit(entries);
    });
  }

  /** Fits `span`'s formula until the returned stop is called. */
  public fit(span: HTMLElement): () => void {
    const formula: FittedFormula = {
      span,
      display: span.querySelector(".katex-display"),
      columnWidthPx: 0,
      bases: Array.from(span.querySelectorAll(".katex-base")),
      tags: Array.from(span.querySelectorAll(".katex-tag")),
      hasNaturalWidth: false,
      rewatch: undefined,
    };
    for (const element of elementsOf(formula)) {
      this.#formulaOf.set(element, formula);
    }
    this.#observe(formula);
    return () => {
      this.#unobserve(formula);
      if (formula.rewatch !== undefined) {
        this.#clock.cancel(formula.rewatch);
      }
      for (const element of elementsOf(formula)) {
        this.#formulaOf.delete(element);
      }
    };
  }

  /** Takes a report's widths, reads every formula it touched, then writes those that need it. */
  #fit(entries: readonly ResizeObserverEntry[]): void {
    const formulas = new Set<FittedFormula>();
    for (const entry of entries) {
      this.#widthsPx.set(entry.target, entry.borderBoxSize[0]?.inlineSize ?? 0);
      const formula = this.#formulaOf.get(entry.target);
      if (formula !== undefined) {
        formulas.add(formula);
        if (entry.target === formula.span) {
          formula.columnWidthPx = entry.contentBoxSize[0]?.inlineSize ?? 0;
        }
      }
    }
    const writes: NaturalWidthWrite[] = [];
    for (const formula of formulas) {
      const naturalWidth = formula.hasNaturalWidth
        ? this.#raisedNaturalWidthOf(formula)
        : this.#naturalWidthOf(formula);
      if (naturalWidth !== undefined) {
        writes.push({ formula, naturalWidth });
      }
    }
    for (const { formula, naturalWidth } of writes) {
      formula.span.style.setProperty("--math-natural-width", String(naturalWidth));
      formula.hasNaturalWidth = true;
      this.#unobserve(formula);
      formula.rewatch = this.#clock.scheduleFrame(() => {
        formula.rewatch = undefined;
        this.#observe(formula);
      });
    }
  }

  /**
   * The width the widest unbreakable piece needs, its equation number's room included, over the
   * formula's font size: a unitless ratio that reads right at whatever size the formula is drawn.
   * `undefined` while the span is not laid out yet or the formula is empty.
   */
  #naturalWidthOf(formula: FittedFormula): number | undefined {
    if (formula.display === null || this.#widthOf(formula.span) === 0) {
      return undefined;
    }
    // Rounded up to whole pixels, so a fraction of a pixel never leaves a piece over the edge.
    const widestPiece = Math.ceil(this.#widestOf(formula.bases));
    // The line is centered and its number pinned right, so the number needs room on both sides.
    const naturalWidth = widestPiece + 2 * Math.ceil(this.#widestOf(formula.tags));
    // An empty formula has nothing to fit, and a zero ratio would void the sheet's division. A
    // formula that is only its number has no piece, and still fits by the number's room.
    if (naturalWidth === 0) {
      return undefined;
    }
    // Unmeasured, the sheet draws the display at the span's size, or its column's width where that
    // is less. The span's size is the one read the reports cannot give, and it lays nothing out:
    // no column the span sits in sizes its type, while the display's own size waits on the span's
    // layout.
    const spanFontSizePx = Number.parseFloat(getComputedStyle(formula.span).fontSize);
    return naturalWidth / Math.min(spanFontSizePx, formula.columnWidthPx);
  }

  /**
   * The natural width raised by the share the widest piece overran the column at its drawn size,
   * which the sheet then shrinks the formula by. The width only grows, to at most the widest the
   * piece draws per em at any size, so a formula that fits is left alone, `undefined`; and so is a
   * span whose width was taken away.
   */
  #raisedNaturalWidthOf(formula: FittedFormula): number | undefined {
    const naturalWidth = Number.parseFloat(
      formula.span.style.getPropertyValue("--math-natural-width"),
    );
    const columnWidth = this.#widthOf(formula.span);
    if (Number.isNaN(naturalWidth) || columnWidth === 0) {
      return undefined;
    }
    // Both widths as drawn, unrounded, so a piece that fits by a fraction of a pixel is not shrunk.
    const drawnWidth = this.#widestOf(formula.bases) + 2 * this.#widestOf(formula.tags);
    return drawnWidth <= columnWidth ? undefined : (naturalWidth * drawnWidth) / columnWidth;
  }

  #widthOf(element: Element): number {
    return this.#widthsPx.get(element) ?? 0;
  }

  #widestOf(pieces: readonly Element[]): number {
    let widestPx = 0;
    for (const piece of pieces) {
      widestPx = Math.max(widestPx, this.#widthOf(piece));
    }
    return widestPx;
  }

  #observe(formula: FittedFormula): void {
    for (const element of elementsOf(formula)) {
      this.#watch.observe(element);
    }
  }

  #unobserve(formula: FittedFormula): void {
    for (const element of elementsOf(formula)) {
      this.#watch.unobserve(element);
    }
  }
}

/** The display formulas' fit for `view`, made on its first formula and kept while it lives. */
export function displayFormulaFitsFor(view: Window & typeof globalThis): DisplayFormulaFits {
  return windowFits.fitsFor(view);
}

/** One formula being fitted. */
interface FittedFormula {
  readonly span: HTMLElement;
  /** KaTeX's display block inside the span, whose font size the natural width is a ratio of. */
  readonly display: Element | null;
  /** The span's content width as its last report gave it: the column its sheet fits to. */
  columnWidthPx: number;
  readonly bases: readonly Element[];
  readonly tags: readonly Element[];
  /** Whether `--math-natural-width` was written, so each later report only checks the fit. */
  hasNaturalWidth: boolean;
  /** The next frame's watch again, after a write stopped it. */
  rewatch: ScheduledHandle | undefined;
}

/** A natural width a report decided to write on one formula's span. */
interface NaturalWidthWrite {
  readonly formula: FittedFormula;
  readonly naturalWidth: number;
}

/** A formula's span, then its pieces and equation numbers: what its fit watches. */
function elementsOf(formula: FittedFormula): Element[] {
  return [formula.span, ...formula.bases, ...formula.tags];
}

/** One fit per window, held weakly so a closed window's fit goes with it. */
class WindowFits {
  readonly #fitsByWindow = new WeakMap<Window, DisplayFormulaFits>();

  public fitsFor(view: Window & typeof globalThis): DisplayFormulaFits {
    let fits = this.#fitsByWindow.get(view);
    if (fits === undefined) {
      fits = new DisplayFormulaFits(view);
      this.#fitsByWindow.set(view, fits);
    }
    return fits;
  }
}

const windowFits = new WindowFits();
