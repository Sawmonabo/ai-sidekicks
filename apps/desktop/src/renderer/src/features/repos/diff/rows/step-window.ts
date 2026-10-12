// A diff block's window over its steps of rows, for a block opened whole inside a transcript
// viewport: the width and type its estimates read and the place of its rows in their row, around
// the measured window every nested window of blocks in flow shares. Drawn steps sit in flow, so
// each long line wraps and stands as the whole block draws it; a spacer holds the room of each run
// of undrawn steps, a row's height a row until each step is measured, drawn or off screen in a
// slice of its own.

import type { Unsubscribe } from "#shared/preload-api.js";
import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
import { MeasuredItemWindow } from "#renderer/components/TranscriptBodyViewport/measured-item-window.js";
import { offsetInRowPx } from "#renderer/components/TranscriptBodyViewport/scroller-window.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { inheritedTextStyleOf } from "#renderer/lib/off-screen-measurement.js";
import { DIFF_FLOW_STEP_ROWS } from "../measures.js";
import { DIFF_FLOW_STEP_ATTRIBUTE, type DiffFlowRows } from "./flow.js";

/** One block's step window layout: its measured window, and the type its rows are read at. */
export class DiffStepWindowLayout {
  #flowRows: DiffFlowRows;
  #rowsElement: HTMLElement | undefined;
  #stopObservingRows: Unsubscribe | undefined;
  /** The rows' width, row height and type, read from their resize observations. */
  #type: DiffRowsType | undefined;
  /** How far the rows' top sits below their conversation row's, read each time they resize. */
  #offsetInRowPx = 0;

  /** The window over the block's steps, laid out against the conversation scroller. */
  public readonly window: MeasuredItemWindow<DiffFlowRows>;

  /** The rows' element: what the window observes its steps from. Never scrolled. */
  public readonly getScrollElement = (): HTMLElement | null => this.#rowsElement ?? null;

  /** A step's estimated room: a row's height for each of its rows, as a row that does not wrap. */
  public readonly estimateSize = (index: number): number => {
    const type = this.#type;
    if (type === undefined) {
      throw new Error("A diff's step was estimated before its rows were laid out.");
    }
    const firstRow = index * DIFF_FLOW_STEP_ROWS;
    return Math.min(DIFF_FLOW_STEP_ROWS, this.#flowRows.rows.length - firstRow) * type.rowHeightPx;
  };

  /**
   * Reads the rows' type as the window first draws them, with the other layout reads of the
   * commit, so the window draws its steps before the first frame paints; answers whether it read
   * one.
   */
  public readonly readTypeOnMount = (): boolean => {
    const element = this.#rowsElement;
    if (element === undefined || this.#type !== undefined) {
      return false;
    }
    this.#type = readRowsType(element, element.getBoundingClientRect().width);
    this.#offsetInRowPx = offsetInRowPx(element);
    return true;
  };

  /** `viewport` and `rowKey` are held for the layout's life. */
  public constructor(viewport: TranscriptBodyViewport, rowKey: string, flowRows: DiffFlowRows) {
    this.#flowRows = flowRows;
    this.window = new MeasuredItemWindow(
      viewport,
      rowKey,
      {
        itemCount: () => this.stepCount,
        // Every step stands as it was measured while the block's rows do.
        itemAt: () => this.#flowRows,
        estimateSize: this.estimateSize,
        readBox: () => {
          const element = this.#rowsElement;
          const type = this.#type;
          return element === undefined || type === undefined
            ? undefined
            : {
                ownerDocument: element.ownerDocument,
                widthPx: type.widthPx,
                textStyle: type.textStyle,
              };
        },
        offsetInRowPx: () => this.#offsetInRowPx,
      },
      DIFF_FLOW_STEP_ATTRIBUTE,
    );
  }

  /** Whether the rows' type is read, which every estimate needs: the window lays out from then. */
  public get isLaidOut(): boolean {
    return this.#type !== undefined;
  }

  /** How many steps the block's rows make. */
  public get stepCount(): number {
    return Math.ceil(this.#flowRows.rows.length / DIFF_FLOW_STEP_ROWS);
  }

  /** Takes the block's rows for this frame. */
  public setFlowRows(flowRows: DiffFlowRows): void {
    this.#flowRows = flowRows;
  }

  /** The rows' element, and its size observation: its width, type and place in its row. */
  public attachRows(element: HTMLElement | null): void {
    this.#stopObservingRows?.();
    this.#stopObservingRows = undefined;
    this.#rowsElement = element ?? undefined;
    if (element !== null) {
      this.#stopObservingRows = observeElementResize(element, (entries) => {
        this.#readRows(element, entries.at(-1));
      });
    }
  }

  /**
   * Reads the rows each time they resize, the first observation included: their place in their
   * row, and their type, which a new width or text size changes, the drawn steps' heights then
   * taken again and the rest measured anew.
   */
  #readRows(element: HTMLElement, entry: ResizeObserverEntry | undefined): void {
    const offsetInRow = offsetInRowPx(element);
    const type = readRowsType(element, entry?.contentBoxSize[0]?.inlineSize ?? 0);
    const previousType = this.#type;
    const isNewType = !isSameRowsType(type, previousType);
    if (isNewType) {
      this.#type = type;
      this.window.retype(previousType !== undefined);
    }
    if (offsetInRow !== this.#offsetInRowPx || isNewType) {
      this.#offsetInRowPx = offsetInRow;
      this.window.resendOffset();
    }
  }
}

/** How a block's rows are set: their width, one row's height, and the type they inherit. */
interface DiffRowsType {
  readonly widthPx: number;
  readonly rowHeightPx: number;
  /** The type the rows inherit in their conversation row, which the measuring frame is set in. */
  readonly textStyle: string;
}

/** The rows' type at `widthPx`, read from their computed style. */
function readRowsType(element: HTMLElement, widthPx: number): DiffRowsType {
  const style = getComputedStyle(element);
  return {
    widthPx,
    rowHeightPx: parseFloat(style.lineHeight),
    textStyle: inheritedTextStyleOf(style),
  };
}

function isSameRowsType(type: DiffRowsType, held: DiffRowsType | undefined): boolean {
  return (
    held !== undefined &&
    held.widthPx === type.widthPx &&
    held.rowHeightPx === type.rowHeightPx &&
    held.textStyle === type.textStyle
  );
}
