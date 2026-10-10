// The members a long table's row window is built with, and the state behind them. The window lays
// the table's body rows out against the conversation scroller through `ScrollerWindowMembers`, from
// the top of the table's body in the scroller's content: its anchor's top, which the markdown body
// answers and announces whenever it may move, and the table body's place in its anchor, read when
// the table's width changes or the markdown body is laid out anew. Drawn rows sit in flow inside
// one table, at columns held at fixed widths; a spacer row holds the room of each run of undrawn
// rows and names the text those rows were parsed from. Each row's height is kept in the table's
// remembered geometry.

import type { Table } from "mdast";
import type { Range, VirtualItem, Virtualizer } from "@tanstack/react-virtual";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type HeldTableColumns } from "#renderer/components/Markdown/table-offer.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { isSameBodyType, type MarkdownBodyType } from "../body-type.js";
import { ScrollerWindowMembers } from "../scroller-window.js";
import { type ListedBodies, type TableWindowBody } from "./context.js";
import {
  forgetTableGeometries,
  recallTableGeometry,
  rememberTableGeometry,
  type TableGeometry,
} from "./geometry-memory.js";
import { TableCellMeasure } from "./cell-measure.js";
import {
  estimatedRowHeightPx,
  TableMeasurement,
  type TableCellMeasurer,
  type TableMeasuringFrame,
} from "./measurement.js";
import { tableFingerprintOf } from "./table-text.js";
import { type WidestCells } from "./widest-cells.js";

/** The virtualizer a long table runs, over its body element and its row elements. */
export type TableRowVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/** One element of a windowed table's body, in document order. */
export type TableWindowRow =
  | { readonly kind: "row"; readonly index: number }
  | {
      /** The room of a run of undrawn rows, and the text range they were parsed from. */
      readonly kind: "spacer";
      readonly key: string;
      readonly heightPx: number;
      readonly sourceStart: number;
      readonly sourceEnd: number;
    };

/**
 * One long table's row window: the stable option members its virtualizer reads, the rows' heights,
 * and the table's place in the scroller.
 */
export class TableWindowLayout {
  readonly #body: TableWindowBody;
  readonly #scroller: ScrollerWindowMembers;
  #table: Table;
  /** The fingerprint of the table it was read for, read only when the geometry is filed. */
  #fingerprint: { readonly table: Table; readonly value: string } | undefined;
  #blockIndex: number;
  #bodyElement: HTMLElement | undefined;
  #stopObservingBody: Unsubscribe | undefined;
  #stopFollowingPlacement: Unsubscribe | undefined;
  #virtualizer: TableRowVirtualizer | undefined;
  /** Keeps a row drawn wherever the window stands, given by the hook that draws the table. */
  #keepRowDrawn: ((index: number) => void) | undefined;
  /** How far the table's body sits below its anchor's top, read when either is laid out anew. */
  #bodyOffsetInAnchorPx = 0;
  #observedWidthPx: number | undefined;
  /** The table body's last known top, kept while a windowed body lets its block go. */
  #topPx = 0;
  /** The held columns, their rows' type and the rows' kept heights. */
  #geometry: TableGeometry | undefined;
  /** The body type the geometry is filed at; `undefined` while the body had none to file it at. */
  #filedBodyType: MarkdownBodyType | undefined;
  /** The table as it stood when its geometry was last filed. */
  #filedTable: Table | undefined;
  /** How many body rows the held columns were checked against: more arrive while it streams. */
  #checkedRowCount = 0;
  /** Whether the held geometry was measured in fonts that have since loaded anew. */
  #isMeasuredInOldFonts = false;
  /** The cells' text measured in their fonts, from the held geometry's cells' type. */
  #cellMeasurer: TableCellMeasurer | undefined;
  /** The body type the cells' type was read at: another text size sets the cells anew. */
  #cellMeasurerBodyType: MarkdownBodyType | undefined;
  /** The table's rows ranked by their widest cells, by the measurement that held the columns. */
  #widestCells: WidestCells | undefined;
  /** The measurement running, and the body type it measures at. */
  #measurement:
    | { readonly measurement: TableMeasurement; readonly bodyType: MarkdownBodyType }
    | undefined;
  /** Told each time the measurement's hidden frame changes or its geometry is ready. */
  readonly #onMeasured: () => void;
  readonly #listedBodies: ListedBodies | undefined;
  /** The rows the table last committed to the page. */
  #committedRows: readonly TableWindowRow[] = [];

  /** The table's body element: what the window observes its rows from. Never scrolled. */
  public readonly getScrollElement = (): HTMLElement | null => this.#bodyElement ?? null;

  /** The window's offset, viewport and refused writes, against the conversation scroller. */
  public readonly scrollToFn: ScrollerWindowMembers["scrollToFn"];
  public readonly observeElementOffset: ScrollerWindowMembers["observeElementOffset"];
  public readonly observeElementRect: ScrollerWindowMembers["observeElementRect"];
  public readonly initialOffset: ScrollerWindowMembers["initialOffset"];

  /**
   * One row's room in the window: what it last measured at this width, or its estimate at the held
   * columns, its cells' text wrapped in the cells' fonts, kept beside the measured heights.
   */
  public readonly estimateSize = (index: number): number => {
    const geometry = this.#geometry;
    const held = geometry?.rowHeightsPx[index] ?? 0;
    if (held > 0) {
      return held;
    }
    const row = this.#table.children[index + 1];
    const cellMeasurer = this.#cellMeasurer;
    if (geometry === undefined || row === undefined || cellMeasurer === undefined) {
      return 0;
    }
    const estimatePx = estimatedRowHeightPx(row, geometry.columns, cellMeasurer);
    if (index < geometry.rowHeightsPx.length) {
      geometry.rowHeightsPx[index] = estimatePx;
    }
    return estimatePx;
  };

  /**
   * A row's height when it resizes, from the observer's border box, kept in the table's geometry.
   * With no observation, as a row mounts, it answers what it last held and reads nothing.
   */
  public readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: TableRowVirtualizer,
  ): number => {
    const index = instance.indexFromElement(element);
    const borderBox = entry?.borderBoxSize[0];
    if (borderBox === undefined) {
      return instance.itemSizeCache.get(index) ?? this.estimateSize(index);
    }
    const geometry = this.#geometry;
    if (geometry !== undefined && index < geometry.rowHeightsPx.length) {
      geometry.rowHeightsPx[index] = borderBox.blockSize;
    }
    return borderBox.blockSize;
  };

  /** The table's body element, and its width observation, which reads its place in its block. */
  public readonly attachBody = (element: HTMLElement | null): void => {
    this.#stopObservingBody?.();
    this.#stopObservingBody = undefined;
    this.#bodyElement = element ?? undefined;
    if (element !== null) {
      this.#stopObservingBody = observeElementResize(element, (entries) => {
        this.#readBody(element, entries.at(-1));
      });
    }
  };

  /**
   * Reads the hidden frame drawn for `frame` from `table`, once the browser has laid it out: the
   * running measurement takes it.
   */
  public readonly readMeasuringFrame = (
    frame: TableMeasuringFrame,
    table: HTMLTableElement,
  ): void => {
    this.#measurement?.measurement.readFrame(frame, table);
  };

  /**
   * `onMeasured` is told each time the hidden frame to draw changes or a geometry is ready; the
   * table lays out at `listedBodies`' type until its own body is laid out.
   */
  public constructor(
    body: TableWindowBody,
    table: Table,
    blockIndex: number,
    onMeasured: () => void,
    listedBodies: ListedBodies | undefined,
  ) {
    this.#body = body;
    this.#listedBodies = listedBodies;
    this.#table = table;
    this.#blockIndex = blockIndex;
    this.#onMeasured = onMeasured;
    const scroller = new ScrollerWindowMembers(body.viewport.scrollController, () =>
      this.#readTopPx(),
    );
    this.#scroller = scroller;
    this.scrollToFn = scroller.scrollToFn;
    this.observeElementOffset = scroller.observeElementOffset;
    this.observeElementRect = scroller.observeElementRect;
    this.initialOffset = scroller.initialOffset;
  }

  /** How many body rows the window lays out. */
  public get rowCount(): number {
    return Math.max(0, this.#table.children.length - 1);
  }

  /** The columns the table is held at, or `undefined` until they are measured. */
  public get heldColumns(): HeldTableColumns | undefined {
    return this.#geometry?.columns;
  }

  /**
   * The type the table lays out at: its body's, or until the body is laid out, a listed body's;
   * `undefined` while neither is known, and the table draws nothing.
   */
  public get bodyType(): MarkdownBodyType | undefined {
    return this.#body.placement.bodyType ?? this.#listedBodies?.listedBodyType();
  }

  /** What the running measurement needs drawn hidden in the body, or `undefined`. */
  public get measuringFrame(): TableMeasuringFrame | undefined {
    return this.#measurement?.measurement.frame;
  }

  /** Takes the table and the block it is drawn in for this frame, growing its kept heights. */
  public setTable(table: Table, blockIndex: number): void {
    this.#table = table;
    this.#blockIndex = blockIndex;
    const geometry = this.#geometry;
    if (geometry !== undefined && geometry.rowHeightsPx.length < this.rowCount) {
      // A streaming table outgrew its kept heights: twice the rows, so growth copies rarely.
      const rowHeightsPx = new Float32Array(
        Math.max(this.rowCount, 2 * geometry.rowHeightsPx.length),
      );
      rowHeightsPx.set(geometry.rowHeightsPx);
      this.#geometry = { ...geometry, rowHeightsPx };
      if (this.#filedBodyType !== undefined) {
        this.#file(this.#filedBodyType, this.#geometry);
      }
    }
  }

  /**
   * Brings the held geometry up to the table and the body as they stand, reading nothing from the
   * page: a measurement that finished is held; columns remembered at the body's width are taken;
   * and a measurement starts where none holds, for a body of another width, for rows that
   * arrived holding a column's widest cells, or after a font loaded. What is held stays drawn
   * until a measurement replaces it.
   */
  public update(): void {
    const bodyType = this.bodyType;
    if (this.#measurement?.measurement.geometry !== undefined) {
      this.#holdMeasured(this.#measurement.measurement, this.#measurement.bodyType);
    }
    if (bodyType === undefined) {
      return;
    }
    const geometry = this.#geometry;
    if (
      geometry !== undefined &&
      !this.#isMeasuredInOldFonts &&
      (this.#filedBodyType === undefined || isSameBodyType(this.#filedBodyType, bodyType))
    ) {
      if (this.#filedBodyType === undefined) {
        this.#file(bodyType, geometry);
      }
      this.#checkNewRows(geometry, bodyType);
      return;
    }
    if (isSameBodyType(this.#measurement?.bodyType, bodyType)) {
      return;
    }
    const remembered = this.#isMeasuredInOldFonts
      ? undefined
      : recallTableGeometry({ fingerprint: this.#currentFingerprint(), bodyType });
    if (remembered === undefined) {
      this.#measure(bodyType, this.#isMeasuredInOldFonts ? undefined : this.#known(bodyType));
      return;
    }
    this.#measurement?.measurement.stop();
    this.#measurement = undefined;
    this.#holdGeometry(remembered, this.rowCount);
    if (!isSameTextSize(this.#cellMeasurerBodyType, bodyType)) {
      this.#cellMeasurer = {
        type: remembered.cellType,
        measure: new TableCellMeasure(remembered.cellType, this.#ownerDocument()),
      };
      this.#cellMeasurerBodyType = bodyType;
    }
    this.#filedBodyType = bodyType;
    this.#filedTable = this.#table;
    this.setTable(this.#table, this.#blockIndex);
  }

  /**
   * Forgets every remembered table's geometry after a font finished loading, and measures this
   * table anew in the fonts it now draws, drawing the held geometry until that is done.
   */
  public forgetMeasurements(): void {
    forgetTableGeometries();
    this.#isMeasuredInOldFonts = true;
    this.#filedBodyType = undefined;
    this.#measurement?.measurement.stop();
    this.#measurement = undefined;
  }

  /**
   * Files the held geometry again under the table as it now stands, for the mount that draws it
   * next: a streaming table's block settling into place draws its last rows.
   */
  public release(): void {
    this.#measurement?.measurement.stop();
    this.#measurement = undefined;
    const geometry = this.#geometry;
    if (
      geometry !== undefined &&
      this.#filedBodyType !== undefined &&
      this.#filedTable !== this.#table
    ) {
      this.#file(this.#filedBodyType, geometry);
    }
  }

  /** The body rows drawn for the library's `range`: those on screen and the drawn band past them. */
  public drawnIndexesOf(range: Range): number[] {
    return this.#scroller.drawnIndexesOf(
      range,
      (index) => this.#virtualizer?.measurementsCache[index]?.size ?? this.estimateSize(index),
    );
  }

  /** Takes the virtualizer this layout's members were given to, and how to keep a row drawn. */
  public bindWindow(virtualizer: TableRowVirtualizer, keepRowDrawn: (index: number) => void): void {
    this.#virtualizer = virtualizer;
    this.#keepRowDrawn = keepRowDrawn;
  }

  /**
   * Draws body row `index` and scrolls the conversation the least distance that brings it into
   * view, however far from the window it lies.
   */
  public revealRow(index: number): void {
    this.#keepRowDrawn?.(index);
    this.#body.viewport.scrollController.requestGlide("row-reveal", (geometry) =>
      this.#revealOffsetOf(index, geometry.scrollTop, geometry.viewportHeight),
    );
  }

  /** The viewport the window opens against before its first geometry sample. */
  public initialRect(): ReturnType<ScrollerWindowMembers["initialRect"]> {
    return this.#scroller.initialRect();
  }

  /**
   * Calls `listener` each time fonts finish loading in the body's document, which set every cell
   * at another width, as they do the whole table's. Throws before the body mounts.
   */
  public followFontLoads(listener: () => void): Unsubscribe {
    const fonts = this.#ownerDocument().fonts;
    fonts.addEventListener("loadingdone", listener);
    return () => {
      fonts.removeEventListener("loadingdone", listener);
    };
  }

  /**
   * Calls `listener` after each change the markdown body announces that may move the table or
   * change the body's width; the table's place is read again where the body was laid out anew,
   * and its offset sent again, first.
   */
  public followPlacement(listener: () => void): Unsubscribe {
    this.#stopFollowingPlacement?.();
    const stop = this.#body.placement.subscribeToPlacement((change) => {
      const bodyElement = this.#bodyElement;
      if (change === "laid-out" && bodyElement !== undefined) {
        this.#readOffsetInAnchor(bodyElement);
      }
      this.#scroller.resendOffset();
      listener();
    });
    this.#stopFollowingPlacement = stop;
    return () => {
      stop();
      this.#stopFollowingPlacement = undefined;
    };
  }

  /**
   * The table body's elements in document order: each drawn row, with a spacer for each run of
   * undrawn rows before, between and after them, as tall as their laid-out rows.
   */
  public windowRows(virtualItems: readonly VirtualItem[], totalSizePx: number): TableWindowRow[] {
    const rows: TableWindowRow[] = [];
    let previousEndPx = 0;
    let previousIndex = -1;
    for (const item of virtualItems) {
      if (item.index > previousIndex + 1) {
        this.#pushSpacer(rows, previousIndex + 1, item.index - 1, item.start - previousEndPx);
      }
      rows.push({ kind: "row", index: item.index });
      previousEndPx = item.end;
      previousIndex = item.index;
    }
    if (previousIndex < this.rowCount - 1) {
      this.#pushSpacer(rows, previousIndex + 1, this.rowCount - 1, totalSizePx - previousEndPx);
    }
    return rows;
  }

  /** Takes the rows the table has just drawn. */
  public commitRows(rows: readonly TableWindowRow[]): void {
    this.#committedRows = rows;
  }

  /**
   * Whether the rows for these items differ from the ones on the page: a row measured anew moves
   * the spacers around it without changing which rows are drawn.
   */
  public differsFromCommittedRows(
    virtualItems: readonly VirtualItem[],
    totalSizePx: number,
  ): boolean {
    const rows = this.windowRows(virtualItems, totalSizePx);
    const committed = this.#committedRows;
    return (
      rows.length !== committed.length ||
      rows.some((row, index) => !isSameRow(row, committed[index]))
    );
  }

  /**
   * The scroll offset that brings body row `index` into view by the least distance, or `undefined`
   * when it already is, or the window does not lay it out.
   */
  #revealOffsetOf(index: number, scrollTop: number, viewportHeight: number): number | undefined {
    const item = this.#virtualizer?.measurementsCache[index];
    if (item === undefined) {
      return undefined;
    }
    const rowTopPx = this.#readTopPx() + item.start;
    const rowBottomPx = rowTopPx + item.size;
    if (rowTopPx < scrollTop) {
      return rowTopPx;
    }
    return rowBottomPx > scrollTop + viewportHeight ? rowBottomPx - viewportHeight : undefined;
  }

  /** The table body's top in the scroller's content: its anchor's top and its place there. */
  /** The body's document, known once the body has mounted, or the listed bodies' before. */
  #ownerDocument(): Document {
    const ownerDocument = this.#body.placement.ownerDocument ?? this.#listedBodies?.ownerDocument;
    if (ownerDocument === undefined) {
      throw new Error("A long table measured its text before its body mounted.");
    }
    return ownerDocument;
  }

  #readTopPx(): number {
    const anchorTopPx = this.#body.placement.anchorTopPx(this.#blockIndex);
    if (anchorTopPx !== undefined) {
      this.#topPx = anchorTopPx + this.#bodyOffsetInAnchorPx;
    }
    return this.#topPx;
  }

  /** Reads the body's place in its anchor when the table's width changes, and the first time. */
  #readBody(element: HTMLElement, entry: ResizeObserverEntry | undefined): void {
    const widthPx = Math.round(entry?.contentBoxSize[0]?.inlineSize ?? 0);
    if (widthPx === this.#observedWidthPx) {
      return;
    }
    this.#observedWidthPx = widthPx;
    this.#readOffsetInAnchor(element);
    this.#scroller.resendOffset();
  }

  #readOffsetInAnchor(element: HTMLElement): void {
    const anchor = this.#body.placement.anchorOf(element);
    this.#bodyOffsetInAnchorPx =
      anchor === null
        ? 0
        : element.getBoundingClientRect().top - anchor.getBoundingClientRect().top;
  }

  /**
   * Checks the rows that arrived since the columns were checked: when they hold a column's widest
   * cells, the sample the columns were measured from no longer holds every one, and the columns
   * are measured again. Rows never ranked, as a remembered table's, are ranked in slices first.
   */
  #checkNewRows(geometry: TableGeometry, bodyType: MarkdownBodyType): void {
    if (this.rowCount === this.#checkedRowCount || this.#measurement !== undefined) {
      return;
    }
    const known = this.#known(bodyType);
    if (known === undefined || known.widestCells === undefined) {
      this.#measure(bodyType, known);
      return;
    }
    const sample = known.widestCells.sampleRowIndexes(this.#table);
    if (isSameSample(sample, geometry.sampleRowIndexes)) {
      this.#checkedRowCount = this.rowCount;
      return;
    }
    this.#measure(bodyType, known);
  }

  /** Starts measuring the table as it stands, at the body's `bodyType`, from what is `known`. */
  #measure(
    bodyType: MarkdownBodyType,
    known:
      | { readonly cellMeasurer: TableCellMeasurer; readonly widestCells?: WidestCells }
      | undefined,
  ): void {
    this.#measurement?.measurement.stop();
    this.#measurement = {
      measurement: new TableMeasurement(
        this.#table,
        this.#ownerDocument(),
        this.#onMeasured,
        known,
      ),
      bodyType,
    };
  }

  /**
   * The cells' type and the rows' ranking the held geometry was measured with, while they hold at
   * `bodyType`: at another text size the cells set their text anew.
   */
  #known(
    bodyType: MarkdownBodyType,
  ): { readonly cellMeasurer: TableCellMeasurer; readonly widestCells?: WidestCells } | undefined {
    const cellMeasurer = this.#cellMeasurer;
    if (cellMeasurer === undefined || !isSameTextSize(this.#cellMeasurerBodyType, bodyType)) {
      return undefined;
    }
    return this.#widestCells === undefined
      ? { cellMeasurer }
      : { cellMeasurer, widestCells: this.#widestCells };
  }

  /** Holds the geometry `measurement` ended with, filed at the body type it measured at. */
  #holdMeasured(measurement: TableMeasurement, bodyType: MarkdownBodyType): void {
    const geometry = measurement.geometry;
    const known = measurement.known;
    if (geometry === undefined || known === undefined) {
      return;
    }
    this.#measurement = undefined;
    this.#isMeasuredInOldFonts = false;
    this.#cellMeasurer = known.cellMeasurer;
    this.#cellMeasurerBodyType = bodyType;
    this.#widestCells = known.widestCells;
    this.#holdGeometry(geometry, Math.max(0, measurement.table.children.length - 1));
    this.#file(bodyType, geometry, measurement.table);
    this.setTable(this.#table, this.#blockIndex);
  }

  /** Holds `geometry`, checked against the table's first `checkedRowCount` body rows. */
  #holdGeometry(geometry: TableGeometry, checkedRowCount: number): void {
    this.#geometry = geometry;
    this.#checkedRowCount = checkedRowCount;
  }

  /** Files `geometry` under `table` at `bodyType`: the table as it stands, by default. */
  #file(bodyType: MarkdownBodyType, geometry: TableGeometry, table: Table = this.#table): void {
    rememberTableGeometry({ fingerprint: this.#fingerprintOf(table), bodyType }, geometry);
    this.#filedBodyType = bodyType;
    this.#filedTable = table;
  }

  #currentFingerprint(): string {
    return this.#fingerprintOf(this.#table);
  }

  #fingerprintOf(table: Table): string {
    const held = this.#fingerprint;
    if (held?.table === table) {
      return held.value;
    }
    const value = tableFingerprintOf(table);
    this.#fingerprint = { table, value };
    return value;
  }

  /**
   * A spacer for undrawn rows `firstIndex` to `lastIndex`, if it has any height, naming the body
   * text they were parsed from: their block's start, and their own offsets in its parse less the
   * definitions every offset counts.
   */
  #pushSpacer(
    rows: TableWindowRow[],
    firstIndex: number,
    lastIndex: number,
    heightPx: number,
  ): void {
    if (heightPx <= 0) {
      return;
    }
    const firstRow = this.#table.children[firstIndex + 1];
    const lastRow = this.#table.children[lastIndex + 1];
    const base =
      this.#body.placement.blockSourceStart(this.#blockIndex) -
      this.#body.placement.definitionPreambleLength;
    rows.push({
      kind: "spacer",
      key: firstIndex === 0 ? "before" : `after:${String(firstIndex - 1)}`,
      heightPx,
      sourceStart: base + (firstRow?.position?.start.offset ?? 0),
      sourceEnd: base + (lastRow?.position?.end.offset ?? 0),
    });
  }
}

function isSameRow(row: TableWindowRow, held: TableWindowRow | undefined): boolean {
  if (row.kind === "row") {
    return held?.kind === "row" && held.index === row.index;
  }
  return (
    held?.kind === "spacer" &&
    held.key === row.key &&
    held.heightPx === row.heightPx &&
    held.sourceStart === row.sourceStart &&
    held.sourceEnd === row.sourceEnd
  );
}

function isSameSample(sample: readonly number[], held: readonly number[]): boolean {
  return sample.length === held.length && sample.every((index, at) => index === held[at]);
}

/** Whether two readings set text at one size, whatever their widths. */
function isSameTextSize(first: MarkdownBodyType | undefined, second: MarkdownBodyType): boolean {
  return first?.fontSizePx === second.fontSizePx && first.lineHeightPx === second.lineHeightPx;
}
