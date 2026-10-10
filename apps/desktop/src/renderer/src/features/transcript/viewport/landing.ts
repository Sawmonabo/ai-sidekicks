// A landing on one row: a link to a message, a find step or Home names the row, the window centers
// on it, and the committed render that holds it scrolls there. Until it lands, no scroll sample
// moves the reading state, so the landing wins over a return to the tail.
//
// A landing first waits for the screen it will show: the row and the rows around it, as far as
// the drawn band reaches, each drawn whole (its formulas and pictures ready), and no row the feed
// still holds out of the list among them, the landing's own row included, since a held row joins
// the list where it sits. Nothing moves while it waits, and a newer landing replaces a waiting
// one. The tail's jump waits the same way.

import type { Unsubscribe } from "#shared/preload-api.js";
import { type ScrollCaller } from "#renderer/lib/scroll/callers.js";
import { TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS } from "./caps.js";
import { type ReadingAnchor } from "./reading-anchor.js";
import { type ViewportRow } from "./snapshot.js";
import { type TranscriptRowVirtualizer, type VirtualizerOptions } from "./virtualizer-options.js";

/** Dependencies of a `ViewportLanding`. */
export interface ViewportLandingOptions {
  readonly anchor: ReadingAnchor;
  readonly virtualizerOptions: VirtualizerOptions;
  /** The virtualizer that lays the rows out, once it is bound. */
  readonly virtualizer: () => TranscriptRowVirtualizer | undefined;
  /** A published key's index, or `undefined` when the window does not hold it. */
  readonly indexOfRowKey: (rowKey: string) => number | undefined;
  /**
   * Runs one pass of the window over the last conditions, answering whether the rows the
   * viewport holds changed; `undefined` before any conditions were handed over.
   */
  readonly runOwnPass: () => boolean | undefined;
  /** Puts keyboard focus on the log, where a link's landing hands it. */
  readonly focusLog: () => void;
  /** The log the viewport was last handed, oldest first. */
  readonly logRows: () => readonly ViewportRow[];
  /** A row's position in that log, or `undefined` for a key it lacks. */
  readonly logPositionOf: (rowKey: string) => number | undefined;
  /** The height a row is laid out at, in pixels: measured, remembered or estimated. */
  readonly rowHeightPx: (rowKey: string) => number;
  /** The box's height in pixels, `0` before the first sample. */
  readonly viewportHeightPx: () => number;
  /** Whether a row draws whole if mounted now; see `TranscriptRowPreparation.isReady`. */
  readonly isRowPrepared: (rowKey: string) => boolean;
  /** Whether the feed holds a row out of the list until it draws whole. */
  readonly isRowHeldOut: (rowKey: string) => boolean;
  /**
   * Whether the feed holds a row out right after the listed row `rowKey`, or before the first
   * listed row for `undefined`.
   */
  readonly holdsRowAfter: (rowKey: string | undefined) => boolean;
  /** Hear each time any row's work lands. Returns the unsubscribe. */
  readonly subscribeToRowWork: (listener: () => void) => Unsubscribe;
  /** A landing starts: the frame draws the rows it ends on first, the band beyond them after. */
  readonly onLanding: () => void;
}

/** Where a landing puts its row: at the top of the box, in its middle, or at its foot. */
export type LandingAlignment = "start" | "center" | "end";

/**
 * Who lands the reader on one row: a link to a message, a find step, Home, or a shift-arrow
 * moving a selection's end in a row the window let go. Only a link's landing takes focus; the
 * others keep it where the person pressed.
 */
export type RowLandingCaller = Extract<
  ScrollCaller,
  "message-anchor" | "find-match" | "jump-to-head" | "row-reveal"
>;

/** The row a landing asked for, from the ask until the render that holds it scrolls there. */
export class ViewportLanding {
  readonly #anchor: ReadingAnchor;
  readonly #virtualizerOptions: VirtualizerOptions;
  readonly #virtualizer: () => TranscriptRowVirtualizer | undefined;
  readonly #indexOfRowKey: (rowKey: string) => number | undefined;
  readonly #runOwnPass: () => boolean | undefined;
  readonly #focusLog: () => void;
  readonly #logRows: () => readonly ViewportRow[];
  readonly #logPositionOf: (rowKey: string) => number | undefined;
  readonly #rowHeightPx: (rowKey: string) => number;
  readonly #viewportHeightPx: () => number;
  readonly #isRowPrepared: (rowKey: string) => boolean;
  readonly #isRowHeldOut: (rowKey: string) => boolean;
  readonly #holdsRowAfter: (rowKey: string | undefined) => boolean;
  readonly #subscribeToRowWork: (listener: () => void) => Unsubscribe;
  readonly #onLanding: () => void;
  /** The landing waiting for its screen, and the row and alignment that screen is read around. */
  #waiting:
    | {
        readonly rowKey: string;
        readonly alignment: LandingAlignment;
        readonly land: () => void;
      }
    | undefined;
  #stopHearingRowWork: Unsubscribe | undefined;
  /**
   * The row a landing asked for and who asked, until the committed render that holds it scrolls
   * there; no scroll sample moves the reading state meanwhile.
   */
  #pendingLanding: { readonly rowKey: string; readonly caller: RowLandingCaller } | undefined;
  #disposed = false;

  public constructor(options: ViewportLandingOptions) {
    this.#anchor = options.anchor;
    this.#virtualizerOptions = options.virtualizerOptions;
    this.#virtualizer = options.virtualizer;
    this.#indexOfRowKey = options.indexOfRowKey;
    this.#runOwnPass = options.runOwnPass;
    this.#focusLog = options.focusLog;
    this.#logRows = options.logRows;
    this.#logPositionOf = options.logPositionOf;
    this.#rowHeightPx = options.rowHeightPx;
    this.#viewportHeightPx = options.viewportHeightPx;
    this.#isRowPrepared = options.isRowPrepared;
    this.#isRowHeldOut = options.isRowHeldOut;
    this.#holdsRowAfter = options.holdsRowAfter;
    this.#subscribeToRowWork = options.subscribeToRowWork;
    this.#onLanding = options.onLanding;
  }

  /** Whether a landing waits for the render that holds its row. */
  public get isPending(): boolean {
    return this.#pendingLanding !== undefined;
  }

  /**
   * The offset the pending landing scrolls to, over the rows as the library now lays them out:
   * its row at the top of the box, or in its middle for a find match, within the scroll range;
   * `undefined` with none pending or while the window does not hold its row.
   */
  public pendingTargetPx(): number | undefined {
    const landing = this.#pendingLanding;
    const virtualizer = this.#virtualizer();
    const index = landing === undefined ? undefined : this.#indexOfRowKey(landing.rowKey);
    if (landing === undefined || virtualizer === undefined || index === undefined) {
      return undefined;
    }
    // Rebuilds the library's layout memo when a row measured since, so the cache read is current.
    const totalSizePx = virtualizer.getTotalSize();
    const item = virtualizer.measurementsCache[index];
    if (item === undefined) {
      return undefined;
    }
    const viewportHeightPx = this.#viewportHeightPx();
    const startPx =
      alignmentOf(landing.caller) === "center"
        ? item.start + (item.size - viewportHeightPx) / 2
        : item.start;
    return Math.max(0, Math.min(startPx, totalSizePx - viewportHeightPx));
  }

  /**
   * Lands the reader on one row, as a link to a message, a find step or Home does, once the screen
   * it will show draws whole; see `#landOnRowNow`.
   */
  public landOnRow(rowKey: string, caller: RowLandingCaller): void {
    this.landOncePrepared(rowKey, alignmentOf(caller), (hasWaited) => {
      this.#landOnRowNow(rowKey, caller, hasWaited);
    });
  }

  /**
   * Runs `land` once the rows the box would show with `rowKey` at `alignment` draw whole: at once
   * when they do, else when the last of their work lands or the last held row among them joins
   * the list (`retryWaiting`). `hasWaited` tells `land` it runs outside the caller's act. Replaces
   * any landing still waiting.
   */
  public landOncePrepared(
    rowKey: string,
    alignment: LandingAlignment,
    land: (hasWaited: boolean) => void,
  ): void {
    this.#stopWaiting();
    if (this.#isScreenPrepared(rowKey, alignment)) {
      land(false);
      return;
    }
    this.#waiting = {
      rowKey,
      alignment,
      land: () => {
        land(true);
      },
    };
    this.#stopHearingRowWork = this.#subscribeToRowWork(() => {
      this.retryWaiting();
    });
  }

  /**
   * Lands a waiting landing whose screen now draws whole: called when any row's work lands and
   * once the viewport is handed a new log, which a held row joining brings.
   */
  public retryWaiting(): void {
    const waiting = this.#waiting;
    if (waiting !== undefined && this.#isScreenPrepared(waiting.rowKey, waiting.alignment)) {
      this.#stopWaiting();
      waiting.land();
    }
  }

  /**
   * Scrolls to the row `landOnRow` named once the window holds it, through the library's own
   * index scroll, which re-aims as the estimated rows around it measure: a link's row and Home's
   * at the top of the viewport, a find match in its middle. Called from the same layout effect as
   * the position hold, when the virtualizer counts the rows the window holds. A link's landing
   * hands the log focus, so the keyboard reads on from the message.
   */
  public commitPendingLanding(): void {
    const landing = this.#pendingLanding;
    const virtualizer = this.#virtualizer();
    if (this.#disposed || landing === undefined || virtualizer === undefined) {
      return;
    }
    const index = this.#indexOfRowKey(landing.rowKey);
    if (index === undefined) {
      return;
    }
    this.#pendingLanding = undefined;
    this.#virtualizerOptions.scrollFor(landing.caller, () => {
      virtualizer.scrollToIndex(index, { align: alignmentOf(landing.caller) });
    });
    if (landing.caller === "message-anchor") {
      this.#focusLog();
    }
  }

  /** Terminal: no landing commits or waits after it. */
  public dispose(): void {
    this.#disposed = true;
    this.#stopWaiting();
  }

  /**
   * Lands the reader on one row: reading starts at it, the window centers on it however far from
   * the window it sits, and `commitPendingLanding` brings it into view. A link's row may not be in
   * the log yet; the pass that brings it centers the window then. Until it lands, the landing wins
   * over a return to the tail.
   */
  #landOnRowNow(rowKey: string, caller: RowLandingCaller, hasWaited: boolean): void {
    this.#anchor.readFrom(rowKey);
    this.#pendingLanding = { rowKey, caller };
    this.#onLanding();
    const hasRowSetChanged = this.#runOwnPass();
    if (hasRowSetChanged === undefined) {
      return;
    }
    // A row the window already held lands now: the virtualizer still counts the same rows. A row
    // the pass brought in lands once the render that holds it commits.
    // A link's landing asked from the binding's layout effect waits for the next one, which
    // commits it; a landing that waited was asked from no render, so none follows.
    if (!hasRowSetChanged && (caller !== "message-anchor" || hasWaited)) {
      this.commitPendingLanding();
    }
  }

  /**
   * Whether every row the box would show with `rowKey` at `alignment` draws whole, the band the
   * virtualizer draws beyond the box included, walked over the log at the heights the rows are
   * laid out at, with no held row beside any of them.
   */
  #isScreenPrepared(rowKey: string, alignment: LandingAlignment): boolean {
    if (this.#isRowHeldOut(rowKey) || !this.#isRowPrepared(rowKey)) {
      return false;
    }
    const position = this.#logPositionOf(rowKey);
    if (position === undefined) {
      return true;
    }
    const rows = this.#logRows();
    const viewportHeightPx = this.#viewportHeightPx();
    const bandPx = viewportHeightPx * TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS;
    const halfPx = viewportHeightPx / 2 + bandPx;
    const [abovePx, belowPx] =
      alignment === "start"
        ? [bandPx, viewportHeightPx + bandPx]
        : alignment === "center"
          ? [halfPx, halfPx]
          : [viewportHeightPx + bandPx, 0];
    // The row at the foot of the box fills it from below; any other row fills it from its top.
    // A held row joins right after the listed row it follows, so each walked row is asked
    // whether one follows it, and the row above the walk too.
    if (this.#holdsRowAfter(rowKey)) {
      return false;
    }
    let walkedPx = alignment === "end" ? this.#rowHeightPx(rowKey) : 0;
    let index = position - 1;
    for (; index >= 0 && walkedPx < abovePx; index -= 1) {
      const row = rows[index];
      if (row === undefined) {
        break;
      }
      if (!this.#isRowPrepared(row.key) || this.#holdsRowAfter(row.key)) {
        return false;
      }
      walkedPx += this.#rowHeightPx(row.key);
    }
    if (this.#holdsRowAfter(rows[index]?.key)) {
      return false;
    }
    walkedPx = this.#rowHeightPx(rowKey);
    for (index = position + 1; index < rows.length && walkedPx < belowPx; index += 1) {
      const row = rows[index];
      if (row === undefined) {
        break;
      }
      if (!this.#isRowPrepared(row.key) || this.#holdsRowAfter(row.key)) {
        return false;
      }
      walkedPx += this.#rowHeightPx(row.key);
    }
    return true;
  }

  #stopWaiting(): void {
    this.#waiting = undefined;
    this.#stopHearingRowWork?.();
    this.#stopHearingRowWork = undefined;
  }
}

/** Where a landing puts its row: a find match in the middle of the box, any other at its top. */
function alignmentOf(caller: RowLandingCaller): Exclude<LandingAlignment, "end"> {
  return caller === "find-match" ? "center" : "start";
}
