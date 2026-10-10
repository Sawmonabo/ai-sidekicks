// The rows the feed draws anything for. After the run group fold, a row the registered renderer has
// no body for, and that is no system message, leaves the viewport's list, so it takes no slot and
// no estimated height; a run group header always stays. Unlike the fold it reports nothing it took:
// no count or walk names a row the feed never draws. It runs on every admitted event, so it walks
// the fold's lists beside the ones it last walked and asks the renderer only about a row object it
// has not decided before.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type TranscriptRowRenderer } from "../rows/renderer.js";
import { type SystemMessageReading } from "../system-messages/classifier.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { holdsSameObjects } from "../window/row-positions.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/**
 * Takes the rows the feed draws nothing for out of the folded window, holding the last pass's
 * decisions. The window it publishes keeps the fold's `rowsByKey` and `systemMessageByRowId`, which
 * still join the rows it took: both are read by a key the list or a link hands over, and narrowing
 * them would cost a whole-log map on every streamed update.
 */
export class DrawnRowFilter {
  #drawsBody: TranscriptRowRenderer["drawsBody"] | undefined;
  #input: TranscriptWindowModel | undefined;
  #output: TranscriptWindowModel | undefined;

  /** One pass over the fold's window, handing on the current row objects. */
  public filter(
    model: TranscriptWindowModel,
    drawsBody: TranscriptRowRenderer["drawsBody"],
  ): TranscriptWindowModel {
    if (this.#output !== undefined && model === this.#input && drawsBody === this.#drawsBody) {
      return this.#output;
    }
    // A decision is a fact about one row object under one renderer, so a new renderer decides
    // every row again.
    const previous =
      drawsBody === this.#drawsBody && this.#input !== undefined && this.#output !== undefined
        ? { input: this.#input.rows, output: this.#output }
        : undefined;
    const decisions = new HeldDecisions(previous?.input ?? [], previous?.output.rows ?? []);
    const viewportRows: ViewportRow[] = [];
    const rows: TranscriptEventRow[] = [];
    let isAnyRowLeftOut = false;
    let rowPosition = 0;
    // The fold lists each row's identity in the rows' own order, a header standing before a run
    // group's first row; a header names no row, so it always stays.
    for (const identity of model.viewportRows) {
      const row = model.rows[rowPosition];
      if (row === undefined || row.id !== identity.key) {
        viewportRows.push(identity);
        continue;
      }
      rowPosition += 1;
      const isDrawn = decisions.decisionFor(row, () =>
        isDrawnRow(row, model.systemMessageByRowId, drawsBody),
      );
      if (isDrawn) {
        viewportRows.push(identity);
        rows.push(row);
      } else {
        isAnyRowLeftOut = true;
      }
    }
    const output = isAnyRowLeftOut
      ? {
          ...model,
          viewportRows:
            previous !== undefined && holdsSameObjects(viewportRows, previous.output.viewportRows)
              ? previous.output.viewportRows
              : viewportRows,
          rows,
        }
      : model;
    this.#drawsBody = drawsBody;
    this.#input = model;
    this.#output = output;
    return output;
  }
}

/**
 * Whether the feed draws a row: a system message always, being the feed's own line, and any other
 * row only when the registered renderer has a body for it.
 */
export function isDrawnRow(
  row: TranscriptEventRow,
  systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
  drawsBody: TranscriptRowRenderer["drawsBody"],
): boolean {
  return systemMessageByRowId.has(row.id) || drawsBody(row);
}

/**
 * The last pass's decisions, read in step with the rows asked about now. Rows reach this in log
 * order and the last pass's kept rows are an ordered subset of its input, so one walk of both
 * answers each row seen before by identity; a row that is new, or new as an object, is decided.
 */
class HeldDecisions {
  readonly #previousRows: readonly TranscriptEventRow[];
  readonly #previousKeptRows: readonly TranscriptEventRow[];
  #previousPosition = 0;
  #keptPosition = 0;

  public constructor(
    previousRows: readonly TranscriptEventRow[],
    previousKeptRows: readonly TranscriptEventRow[],
  ) {
    this.#previousRows = previousRows;
    this.#previousKeptRows = previousKeptRows;
  }

  /** Whether `row` is drawn: as decided before when it is the same object, else by `decide`. */
  public decisionFor(row: TranscriptEventRow, decide: () => boolean): boolean {
    // A row gone since the last pass is passed over; a row inserted ahead of rows seen before
    // passes over all of them, and they are decided again, which costs time and never a stale row.
    while (this.#previousPosition < this.#previousRows.length) {
      const previousRow = this.#previousRows[this.#previousPosition] as TranscriptEventRow;
      this.#previousPosition += 1;
      const wasKept = this.#previousKeptRows[this.#keptPosition] === previousRow;
      if (wasKept) {
        this.#keptPosition += 1;
      }
      if (previousRow === row) {
        return wasKept;
      }
      if (previousRow.id === row.id) {
        break;
      }
    }
    return decide();
  }
}
