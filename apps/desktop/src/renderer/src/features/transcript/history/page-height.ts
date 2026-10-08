// How tall a page of history will be on screen, before the feed has drawn it. The page's events are
// derived, folded and filtered as the feed's own list is, and each row it would draw is estimated
// by the viewport's measurement table, so a stretch is counted in the same heights the window is
// laid out in rather than in rows.

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { DrawnRowFilter } from "../feed/drawn-rows.js";
import { rowBodyLengthOf, rowHeightKindOf } from "../feed/row-height-inputs.js";
import { foldRunGroupHeaders } from "../feed/run-group-fold.js";
import { type TranscriptRowRenderer } from "../rows/renderer.js";
import { type TranscriptViewportBinding } from "../viewport/hooks/useTranscriptViewport.js";
import { deriveTranscriptWindow } from "../window/transcript-window.js";

/** What a page's rows are drawn and estimated by: the feed's own rules and the viewport's table. */
export interface PageHeightInputs {
  readonly estimatedRowHeightPx: TranscriptViewportBinding["estimatedRowHeightPx"];
  readonly drawsBody: TranscriptRowRenderer["drawsBody"];
  /** The finished run groups the reader opened; every other one draws folded. */
  readonly openedTerminalRunIds: ReadonlySet<string>;
}

/** The estimated height, in pixels, of the rows the feed would draw for one page of events. */
export function estimatePageHeightPx(
  events: readonly ProjectedSessionEvent[],
  inputs: PageHeightInputs,
): number {
  const folded = foldRunGroupHeaders(
    deriveTranscriptWindow(events),
    inputs.openedTerminalRunIds,
  ).window;
  const drawn = new DrawnRowFilter().filter(folded, inputs.drawsBody);
  let heightPx = 0;
  for (const row of drawn.viewportRows) {
    heightPx += inputs.estimatedRowHeightPx(
      row.key,
      rowHeightKindOf(drawn, row.key),
      // A page read from history is drawn whole: no row of it is still being revealed.
      rowBodyLengthOf(drawn, isNeverRevealing, row.key),
    );
  }
  return heightPx;
}

function isNeverRevealing(): boolean {
  return false;
}
