// The rows the feed draws anything for. After the run group fold, a row the registered renderer has
// no body for, and that is no system message, leaves the viewport's list, so it takes no slot and
// no estimated height; a run group header always stays. Unlike the fold it reports nothing it took:
// no count or walk names a row the feed never draws. It runs on every admitted event, so a pass
// over the same row objects in the same order as the last one applies that pass's decision again
// instead of asking every row.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type TranscriptRowRenderer } from "../rows/renderer.js";
import { type SystemMessageReading } from "../system-messages/classifier.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { findPositions, holdsSameObjects, itemsOutsidePositions } from "../window/row-positions.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/**
 * Takes the rows the feed draws nothing for out of the folded window, holding the last pass's
 * decision. The window it publishes keeps the fold's `rowsByKey` and `systemMessageByRowId`, which
 * still join the rows it took: both are read by a key the list or a link hands over, and rebuilding
 * them would cost a whole-log map on every streamed update.
 */
export class DrawnRowFilter {
  #drawsBody: TranscriptRowRenderer["drawsBody"] | undefined;
  /** The identity list the positions below were decided over. */
  #decidedViewportRows: readonly ViewportRow[] = [];
  #removedViewportPositions: readonly number[] = [];
  #removedRowPositions: readonly number[] = [];

  /** One pass over the fold's window, handing on the current row objects. */
  public filter(
    model: TranscriptWindowModel,
    drawsBody: TranscriptRowRenderer["drawsBody"],
  ): TranscriptWindowModel {
    if (
      drawsBody !== this.#drawsBody ||
      !holdsSameObjects(model.viewportRows, this.#decidedViewportRows)
    ) {
      this.#decide(model, drawsBody);
    }
    if (this.#removedRowPositions.length === 0 && this.#removedViewportPositions.length === 0) {
      return model;
    }
    return {
      ...model,
      viewportRows: itemsOutsidePositions(model.viewportRows, this.#removedViewportPositions),
      rows: itemsOutsidePositions(model.rows, this.#removedRowPositions),
    };
  }

  #decide(model: TranscriptWindowModel, drawsBody: TranscriptRowRenderer["drawsBody"]): void {
    const isLeftOut = (row: TranscriptEventRow): boolean =>
      !isDrawnRow(row, model.systemMessageByRowId, drawsBody);
    this.#drawsBody = drawsBody;
    this.#decidedViewportRows = model.viewportRows;
    this.#removedRowPositions = findPositions(model.rows, isLeftOut);
    // A run group header is keyed by its run, which names no row, so it always stays.
    this.#removedViewportPositions = findPositions(model.viewportRows, (identity) => {
      const row = model.rowsByKey.get(identity.key);
      return row !== undefined && isLeftOut(row);
    });
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
