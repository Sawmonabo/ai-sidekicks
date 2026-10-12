// The members a long table's row window is built with, and the state behind them. The window lays
// the table's body rows out against the conversation scroller through `ScrollerWindowMembers`, from
// the top of the table's body in the scroller's content: its anchor's top, which the markdown body
// answers and announces whenever it may move, and the table body's place in its anchor, read when
// the table's width changes or the markdown body is laid out anew. Drawn rows sit in flow inside
// one table, at columns held at fixed widths; a spacer row holds the room of each run of undrawn
// rows and names the text those rows were parsed from. Each row's height is kept in the table's
// remembered geometry.

import type { Table } from "mdast";
import type { Range, VirtualItem, Virtualizer } from "@tanstack/virtual-core";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type HeldTableColumns } from "#renderer/components/Markdown/table-offer.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { isSameBodyType, type MarkdownBodyType } from "../body-type.js";
import { type DrawnBandScreenHeights } from "#renderer/features/transcript/viewport/drawn-band.js";
import { ReaderPlaceHold } from "../reader-place-hold.js";
import { ScrollerWindowMembers } from "../scroller-window.js";
import { type ListedBodies, type TableWindowBody } from "./context.js";
import {
  forgetTableGeometries,
  recallTableGeometry,
  rememberTableGeometry,
  settledTableKeyOf,
  type TableGeometry,
} from "./geometry-memory.js";
import { TableCellMeasure } from "./cell-measure.js";
import {
  estimatedRowHeightPx,
  TableMeasurement,
  type TableCellMeasurer,
  type TableMeasuringFrame,
} from "./measurement.js";
import { type WidestCells } from "./widest-cells.js";

/** The virtualizer a long table runs, over its body element and its row elements. */
export type TableRowVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/** One element of a windowed table's body, in document order. */
export type TableWindowRow =
  | { readonly kind: "row"; readonly index: number }
  | {
      /** The room of a run of undrawn body rows, and the first and last of them. */
      readonly kind: "spacer";
      readonly key: string;
      readonly heightPx: number;
      readonly firstIndex: number;
      readonly lastIndex: number;
    };

/**
 * One long table's row window: the stable option members its virtualizer reads, the rows' heights,
 * and the table's place in the scroller.
 */
export class TableWindowLayout {
  readonly #body: TableWindowBody;
  readonly #scroller: ScrollerWindowMembers;
  readonly #placeHold: ReaderPlaceHold;
  #table: Table;
  #blockIndex: number;
  #bodyElement: HTMLElement | undefined;
  #stopObservingBody: Unsubscribe | undefined;
  #stopFollowingPlacement: Unsubscribe | undefined;
  /** The body's layout count when the table last read the body, for the layouts it missed since. */
  #seenLayoutCount = 0;
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
  /** The body width the held columns were measured at, in CSS pixels. */
  #heldAtWidthPx: number | undefined;
  /** Whether the body stood narrower than that at the last update. */
  #isShrunkToRoom = false;
  /** Whether every row is being laid out anew, whose change above the reader is held once. */
  #isRelayingOut = false;
  /** The body type the geometry is kept at; `undefined` while the body had none to keep it at. */
  #keptBodyType: MarkdownBodyType | undefined;
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
    this.#keepRowHeight(index, borderBox.blockSize);
    return borderBox.blockSize;
  };

  /**
   * The library's question whether to move the offset for a row that resized, always answered no:
   * its write would land on the table's body, which never scrolls. A row wholly above the
   * scroller's top, in a row the table holds the reader's place inside, moves the conversation by
   * its change instead, so the rows being read stay where they are.
   */
  public readonly holdPlaceThroughResizedRow = (
    item: VirtualItem,
    deltaPx: number,
    instance: TableRowVirtualizer,
  ): boolean => {
    if (
      !this.#isRelayingOut &&
      item.end <= (instance.scrollOffset ?? 0) &&
      this.#body.viewport.holdsPlaceInsideRow(this.#body.placement.rowKey)
    ) {
      this.#placeHold.add(deltaPx);
    }
    return false;
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
   * table lays out at `listedBodies`' type until its own body is laid out, and a streaming table
   * hands its geometry to its next mount through them.
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
    this.#placeHold = new ReaderPlaceHold(body.viewport.scrollController);
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
   * Whether the held columns give way to a body narrower than the one they were measured in, so
   * the table never runs past it before they are measured at its width; read at the last update.
   */
  public get isShrunkToRoom(): boolean {
    return this.#isShrunkToRoom;
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
      if (this.#keptBodyType !== undefined) {
        this.#keep(this.#keptBodyType, this.#geometry);
      }
    }
  }

  /**
   * Brings the held geometry up to the table and the body as they stand, reading nothing from the
   * page: a measurement that finished is held; columns remembered at the body's width are taken,
   * or a streaming table's handed from its last mount, drawn while it is measured anew; and a
   * measurement starts where none holds, for a body of another width, for rows that arrived
   * holding a column's widest cells, or after a font loaded. What is held stays drawn until a
   * measurement replaces it. A streaming table hands what it holds to its next mount each time.
   */
  public update(): void {
    this.#updateGeometry();
    const widthPx = this.bodyType?.widthPx;
    this.#isShrunkToRoom =
      widthPx !== undefined && this.#heldAtWidthPx !== undefined && widthPx < this.#heldAtWidthPx;
  }

  /**
   * Forgets every remembered table's geometry after a font finished loading, and measures this
   * table anew in the fonts it now draws, drawing the held geometry until that is done.
   */
  public forgetMeasurements(): void {
    forgetTableGeometries();
    this.#isMeasuredInOldFonts = true;
    this.#keptBodyType = undefined;
    this.#measurement?.measurement.stop();
    this.#measurement = undefined;
  }

  /**
   * Keeps the held geometry for the mount that draws the table next, as the table now stands: a
   * streaming table's block settling into place draws its last rows.
   */
  public release(): void {
    this.#measurement?.measurement.stop();
    this.#measurement = undefined;
    const geometry = this.#geometry;
    if (geometry !== undefined && this.#keptBodyType !== undefined) {
      this.#keep(this.#keptBodyType, geometry);
    }
  }

  /**
   * The body rows drawn for the library's `range`: those on screen and `bandScreenHeights` past
   * them.
   */
  public drawnIndexesOf(range: Range, bandScreenHeights: DrawnBandScreenHeights): number[] {
    return this.#scroller.drawnIndexesOf(
      range,
      bandScreenHeights,
      (index) => this.#virtualizer?.measurementsCache[index]?.size ?? this.estimateSize(index),
    );
  }

  /** Takes the virtualizer this layout's members were given to, and how to keep a row drawn. */
  public bindWindow(virtualizer: TableRowVirtualizer, keepRowDrawn: (index: number) => void): void {
    this.#virtualizer = virtualizer;
    this.#keepRowDrawn = keepRowDrawn;
  }

  /**
   * Lays every row out anew at columns held anew: each drawn row at its height on the page, the
   * rest at their estimates. The rows above the reader, in a row the table holds the reader's place
   * inside, move the conversation by their change, so the rows being read stay where they are.
   */
  public relayOutRows(virtualizer: TableRowVirtualizer): void {
    const readOffsetPx = virtualizer.scrollOffset ?? 0;
    const readPlace = placeAt(virtualizer, readOffsetPx);
    this.#isRelayingOut = true;
    try {
      virtualizer.measure();
      // Every row laid out at its estimate first, so no drawn row is placed by the old heights.
      virtualizer.getTotalSize();
      for (const element of virtualizer.elementsCache.values()) {
        if (element.isConnected) {
          const index = virtualizer.indexFromElement(element);
          const heightPx = element.getBoundingClientRect().height;
          this.#keepRowHeight(index, heightPx);
          virtualizer.resizeItem(index, heightPx);
        }
      }
    } finally {
      this.#isRelayingOut = false;
    }
    if (
      readPlace !== undefined &&
      this.#body.viewport.holdsPlaceInsideRow(this.#body.placement.rowKey)
    ) {
      this.#placeHold.add(startOfPlace(virtualizer, readPlace) - readPlace.startPx);
    }
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
   * change the body's width, a layout made since the table last read the body included; the
   * table's place is read again where the body was laid out anew, and its offset sent again, first.
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
    }, this.#seenLayoutCount);
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

  /** Brings the held geometry up to the table and the body as they stand, as `update` says. */
  #updateGeometry(): void {
    this.#seenLayoutCount = this.#body.placement.layoutCount;
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
      (this.#keptBodyType === undefined || isSameBodyType(this.#keptBodyType, bodyType))
    ) {
      if (this.#keptBodyType === undefined || this.#isStreaming()) {
        this.#keep(bodyType, geometry);
      }
      this.#checkNewRows(geometry, bodyType);
      return;
    }
    if (isSameBodyType(this.#measurement?.bodyType, bodyType)) {
      return;
    }
    const remembered = this.#isMeasuredInOldFonts ? undefined : this.#recall(bodyType);
    if (remembered === undefined) {
      this.#measure(bodyType, this.#isMeasuredInOldFonts ? undefined : this.#known(bodyType));
      return;
    }
    this.#measurement?.measurement.stop();
    this.#measurement = undefined;
    const { geometry: recalled, isHanded } = remembered;
    this.#holdGeometry(recalled, this.rowCount, bodyType);
    if (!isSameTextSize(this.#cellMeasurerBodyType, bodyType)) {
      this.#cellMeasurer = {
        type: recalled.cellType,
        measure: new TableCellMeasure(recalled.cellType, this.#ownerDocument()),
      };
      this.#cellMeasurerBodyType = bodyType;
    }
    this.#keptBodyType = bodyType;
    this.setTable(this.#table, this.#blockIndex);
    if (isHanded) {
      this.#measure(bodyType, undefined);
    }
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

  /** The body's document, known once the body has mounted, or the listed bodies' before. */
  #ownerDocument(): Document {
    const ownerDocument = this.#body.placement.ownerDocument ?? this.#listedBodies?.ownerDocument;
    if (ownerDocument === undefined) {
      throw new Error("A long table measured its text before its body mounted.");
    }
    return ownerDocument;
  }

  /** The table body's top in the scroller's content: its anchor's top and its place there. */
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

  /** Holds the geometry `measurement` ended with, kept at the body type it measured at. */
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
    this.#holdGeometry(geometry, Math.max(0, measurement.table.children.length - 1), bodyType);
    this.#keep(bodyType, geometry);
    this.setTable(this.#table, this.#blockIndex);
  }

  /**
   * Holds `geometry`, measured at `bodyType`, checked against the table's first `checkedRowCount`
   * body rows.
   */
  #holdGeometry(
    geometry: TableGeometry,
    checkedRowCount: number,
    bodyType: MarkdownBodyType,
  ): void {
    this.#geometry = geometry;
    this.#checkedRowCount = checkedRowCount;
    this.#heldAtWidthPx = bodyType.widthPx;
  }

  /** Keeps body row `index`'s height in the held geometry, while the geometry has room for it. */
  #keepRowHeight(index: number, heightPx: number): void {
    const geometry = this.#geometry;
    if (geometry !== undefined && index < geometry.rowHeightsPx.length) {
      geometry.rowHeightsPx[index] = heightPx;
    }
  }

  /**
   * Keeps `geometry`, measured at `bodyType`, for the table's next mount, reading none of its rows:
   * filed under a settled table's key, or handed through the window for a streaming table.
   */
  #keep(bodyType: MarkdownBodyType, geometry: TableGeometry): void {
    const placement = this.#body.placement;
    const blockFingerprint = placement.blockFingerprint(this.#blockIndex);
    if (blockFingerprint === undefined) {
      this.#listedBodies?.streamingTables.hand(placement.rowKey, this.#startInBody(), {
        geometry,
        bodyType,
      });
    } else {
      rememberTableGeometry(
        {
          tableKey: settledTableKeyOf(blockFingerprint, placement.definitionPreamble, this.#table),
          bodyType,
        },
        geometry,
      );
    }
    this.#keptBodyType = bodyType;
  }

  /**
   * The geometry kept for the table at `bodyType`, reading none of its rows: filed under a settled
   * table's key, or else handed by the last mount starting where the table does in the body's
   * text, which is taken either way.
   */
  #recall(
    bodyType: MarkdownBodyType,
  ): { readonly geometry: TableGeometry; readonly isHanded: boolean } | undefined {
    const placement = this.#body.placement;
    const handed = this.#listedBodies?.streamingTables.take(placement.rowKey, this.#startInBody());
    const blockFingerprint = placement.blockFingerprint(this.#blockIndex);
    const filed =
      blockFingerprint === undefined
        ? undefined
        : recallTableGeometry({
            tableKey: settledTableKeyOf(
              blockFingerprint,
              placement.definitionPreamble,
              this.#table,
            ),
            bodyType,
          });
    if (filed !== undefined) {
      return { geometry: filed, isHanded: false };
    }
    return handed !== undefined && isSameBodyType(handed.bodyType, bodyType)
      ? { geometry: handed.geometry, isHanded: true }
      : undefined;
  }

  /** Whether the table is in the streaming tail, which has no key to be filed under. */
  #isStreaming(): boolean {
    return this.#body.placement.blockFingerprint(this.#blockIndex) === undefined;
  }

  /**
   * Where the table starts in the body's text: a streaming table's block starts later each time a
   * block ahead of it settles, and its place in the block earlier by as much.
   */
  #startInBody(): number {
    return this.#bodyOffsetOf(this.#table.position?.start.offset ?? 0);
  }

  /** The body text offset of `parseOffset` in the block's parse, less the definitions it counts. */
  #bodyOffsetOf(parseOffset: number): number {
    const placement = this.#body.placement;
    return (
      placement.blockSourceStart(this.#blockIndex) -
      placement.definitionPreamble.length +
      parseOffset
    );
  }

  /** A spacer for undrawn rows `firstIndex` to `lastIndex`, if it has any height. */
  #pushSpacer(
    rows: TableWindowRow[],
    firstIndex: number,
    lastIndex: number,
    heightPx: number,
  ): void {
    if (heightPx > 0) {
      rows.push({
        kind: "spacer",
        key: firstIndex === 0 ? "before" : `after:${String(firstIndex - 1)}`,
        heightPx,
        firstIndex,
        lastIndex,
      });
    }
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
    held.firstIndex === row.firstIndex &&
    held.lastIndex === row.lastIndex
  );
}

/**
 * Where the reader stands in a table laid out at `offsetPx` from its body's top: the row the offset
 * falls in and its top, or past the last row and the rows' end; `undefined` above the table.
 */
function placeAt(
  virtualizer: TableRowVirtualizer,
  offsetPx: number,
): { readonly index: number | undefined; readonly startPx: number } | undefined {
  const endPx = virtualizer.getTotalSize();
  if (offsetPx <= 0 || endPx === 0) {
    return undefined;
  }
  if (offsetPx >= endPx) {
    return { index: undefined, startPx: endPx };
  }
  const item = virtualizer.getVirtualItemForOffset(offsetPx);
  return item === undefined ? undefined : { index: item.index, startPx: item.start };
}

/** Where `place`'s row starts in the table as it is laid out now, or the rows' end past them. */
function startOfPlace(
  virtualizer: TableRowVirtualizer,
  place: { readonly index: number | undefined },
): number {
  const endPx = virtualizer.getTotalSize();
  return place.index === undefined
    ? endPx
    : (virtualizer.measurementsCache[place.index]?.start ?? endPx);
}

function isSameSample(sample: readonly number[], held: readonly number[]): boolean {
  return sample.length === held.length && sample.every((index, at) => index === held[at]);
}

/** Whether two readings set text at one size, whatever their widths. */
function isSameTextSize(first: MarkdownBodyType | undefined, second: MarkdownBodyType): boolean {
  return first?.fontSizePx === second.fontSizePx && first.lineHeightPx === second.lineHeightPx;
}
