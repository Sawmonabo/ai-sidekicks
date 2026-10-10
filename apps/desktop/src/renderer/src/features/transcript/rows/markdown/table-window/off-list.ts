// The long tables of rows not yet listed, measured off the list. `OffListTableFrames` draws each
// one's hidden frames inside a transcript row laid out at the width listed rows are, so its cells
// take a listed body's width and type; measured, a table's geometry is filed under its fingerprint
// and that body type, where the table window takes it as the row mounts and draws its window from
// the first frame.

import { getWindow } from "@floating-ui/utils/dom";
import type { Table } from "mdast";

import { readMarkdownBodyType, type MarkdownBodyType } from "../body-type.js";
import { recallTableGeometry, rememberTableGeometry } from "./geometry-memory.js";
import { TableMeasurement, type TableMeasuringFrame } from "./measurement.js";
import { TableFingerprints } from "./table-text.js";

/** One table waiting to be measured off the list, as its frames draw it. */
export interface OffListTable {
  /** What its frame is keyed by, unique among the tables waiting. */
  readonly key: number;
  readonly table: Table;
  /** The footnote identifiers the table's body declares, which its cells' markers draw by. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
  /**
   * The width, in CSS pixels, the table's hidden row is laid out at: the listed rows' width, or
   * `undefined` while it is not known and the table is not drawn.
   */
  readonly rowWidthPx: number | undefined;
  /** What to draw hidden for the table now, or `undefined` while it is worked in slices. */
  readonly frame: TableMeasuringFrame | undefined;
  /**
   * Reads `frame` from `table`, its hidden drawing, in the resize observation after the browser
   * laid it out; `body` is the markdown body it was drawn in, whose type the geometry is filed at.
   */
  readonly readFrame: (
    frame: TableMeasuringFrame,
    table: HTMLTableElement,
    body: HTMLElement,
  ) => void;
}

/**
 * The tables waiting to be measured off the list in one window. It holds only the tables of rows
 * being prepared: each is dropped when it is filed, fails or is withdrawn, as its row's
 * preparation is released.
 */
export class OffListTables {
  /** The window's tables' fingerprints, which its listed tables read too. */
  public readonly tableFingerprints: TableFingerprints = new TableFingerprints();
  readonly #ownerDocument: Document;
  readonly #view: Window;
  readonly #readRowWidthPx: () => number | undefined;
  readonly #listeners = new Set<() => void>();
  #tables: readonly OffListTable[] = [];
  #nextKey = 0;
  #isTelling = false;
  /** What each table measured before the rows' width was known does once it is read. */
  readonly #widthWaits = new Map<number, (rowWidthPx: number) => void>();
  /** The body type a frame was last read at, and the row width it was laid out at then. */
  #lastBody: { readonly rowWidthPx: number; readonly bodyType: MarkdownBodyType } | undefined;

  /** Hears each change to the tables waiting or the frames they need; returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The tables waiting, the same list until one changes. */
  public readonly read = (): readonly OffListTable[] => this.#tables;

  /**
   * The body type a listed reply's body takes at the rows' width now, as a frame here last read
   * it; `undefined` before one is read at that width.
   */
  public readonly listedBodyType = (): MarkdownBodyType | undefined => {
    const lastBody = this.#lastBody;
    return lastBody !== undefined && lastBody.rowWidthPx === this.#readRowWidthPx()
      ? lastBody.bodyType
      : undefined;
  };

  /**
   * `ownerDocument` is the window's own, whose fonts the tables are set in; `readRowWidthPx`
   * answers the width the window's rows are laid out at, or `undefined` before it is known.
   * Throws for a document with no window.
   */
  public constructor(ownerDocument: Document, readRowWidthPx: () => number | undefined) {
    const view = ownerDocument.defaultView;
    if (view === null) {
      throw new Error("The off-list tables were given a document with no window.");
    }
    this.#ownerDocument = ownerDocument;
    this.#view = view;
    this.#readRowWidthPx = readRowWidthPx;
  }

  /** The document the tables are drawn in. */
  public get ownerDocument(): Document {
    return this.#ownerDocument;
  }

  /**
   * Measures `table` off the list and calls `onLanded` once its geometry is filed or its measuring
   * failed. Answers the withdrawal, which stops the measuring and drops the table; `undefined`
   * when a geometry is filed for the table already at the body type rows of this width give, as
   * its fingerprint read before answers. A table whose fingerprint is not read yet is measured
   * while it is read in slices, and lands as soon as it is found filed. A table measured before
   * the rows' width is known waits, undrawn, for `readRowWidth`.
   */
  public measure(
    table: Table,
    definedFootnoteIdentifiers: ReadonlySet<string>,
    onLanded: () => void,
  ): (() => void) | undefined {
    let rowWidthPx = this.#readRowWidthPx();
    if (rowWidthPx !== undefined && this.#isFiled(table, rowWidthPx)) {
      return undefined;
    }
    let hasEnded = false;
    const key = this.#nextKey;
    this.#nextKey += 1;
    let bodyType: MarkdownBodyType | undefined;
    const measurement: TableMeasurement = new TableMeasurement(
      table,
      this.#ownerDocument,
      this.tableFingerprints,
      () => {
        const geometry = measurement.geometry;
        if (geometry !== undefined && bodyType !== undefined) {
          rememberTableGeometry(
            { fingerprint: this.tableFingerprints.fingerprintOf(table), bodyType },
            geometry,
          );
        }
        if (geometry !== undefined || measurement.hasFailed) {
          hasEnded = true;
          this.#drop(key);
          onLanded();
          return;
        }
        // The frame to draw changed: the list is new, so the frames draw it anew.
        this.#tables = [...this.#tables];
        this.#tell();
      },
    );
    const withdraw = (): void => {
      hasEnded = true;
      measurement.stop();
      this.#drop(key);
    };
    let isReadingFingerprint = false;
    // With a body type read to check against, the fingerprint is read in slices beside the
    // measuring; filed already, the table lands then.
    const checkFiledInSlices = (): void => {
      if (isReadingFingerprint || this.#lastBody === undefined) {
        return;
      }
      isReadingFingerprint = true;
      void this.tableFingerprints
        .readInSlices(table, this.#view, () => hasEnded)
        .then(() => {
          if (!hasEnded && rowWidthPx !== undefined && this.#isFiled(table, rowWidthPx)) {
            withdraw();
            onLanded();
          }
        });
    };
    if (rowWidthPx === undefined) {
      this.#widthWaits.set(key, (readWidthPx) => {
        if (this.#isFiled(table, readWidthPx)) {
          withdraw();
          onLanded();
          return;
        }
        rowWidthPx = readWidthPx;
        checkFiledInSlices();
      });
    } else {
      checkFiledInSlices();
    }
    this.#tables = [
      ...this.#tables,
      {
        key,
        table,
        definedFootnoteIdentifiers,
        get rowWidthPx() {
          return rowWidthPx;
        },
        get frame() {
          return measurement.frame;
        },
        readFrame: (frame, drawnTable, body) => {
          if (rowWidthPx === undefined) {
            return;
          }
          bodyType = readMarkdownBodyType(body, contentInlineSizePxOf(body));
          this.#lastBody = { rowWidthPx, bodyType };
          measurement.readFrame(frame, drawnTable);
        },
      },
    ];
    this.#tell();
    return withdraw;
  }

  /**
   * Reads the rows' width for the tables measured before it was known, and draws their frames at
   * it: called once the window's rows are laid out, and again whenever the reader changes.
   */
  public readRowWidth(): void {
    // Called after every render: the width is read only for a table waiting on it, since reading
    // it may lay out the whole page.
    if (this.#widthWaits.size === 0) {
      return;
    }
    const rowWidthPx = this.#readRowWidthPx();
    if (rowWidthPx === undefined) {
      return;
    }
    const waits = [...this.#widthWaits.values()];
    this.#widthWaits.clear();
    for (const wait of waits) {
      wait(rowWidthPx);
    }
    this.#tables = [...this.#tables];
    this.#tell();
  }

  /**
   * Whether a geometry is filed for `table` at the body type rows `rowWidthPx` wide last gave, as
   * its fingerprint read so far answers: reading nothing, a table not read yet is not filed.
   */
  #isFiled(table: Table, rowWidthPx: number): boolean {
    const lastBody = this.#lastBody;
    const fingerprint = this.tableFingerprints.heldFingerprintOf(table);
    return (
      lastBody?.rowWidthPx === rowWidthPx &&
      fingerprint !== undefined &&
      recallTableGeometry({ fingerprint, bodyType: lastBody.bodyType }) !== undefined
    );
  }

  #drop(key: number): void {
    this.#widthWaits.delete(key);
    const tables = this.#tables.filter((entry) => entry.key !== key);
    if (tables.length !== this.#tables.length) {
      this.#tables = tables;
      this.#tell();
    }
  }

  /**
   * Tells the listeners once the task that changed the tables ends: a row is prepared while the
   * feed renders, where its frames may not be told to render.
   */
  #tell(): void {
    if (this.#isTelling) {
      return;
    }
    this.#isTelling = true;
    queueMicrotask(() => {
      this.#isTelling = false;
      for (const listener of this.#listeners) {
        listener();
      }
    });
  }
}

/**
 * An element's content-box inline size, as its resize observation reports it. Read inside a resize
 * observation, so the layout it reads is already done.
 */
function contentInlineSizePxOf(element: HTMLElement): number {
  const style = getWindow(element).getComputedStyle(element);
  const edgesPx = [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  ].reduce((sum, value) => sum + Number.parseFloat(value), 0);
  return element.getBoundingClientRect().width - edgesPx;
}
