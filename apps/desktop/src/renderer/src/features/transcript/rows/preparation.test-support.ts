// Rows' bodies prepared as the feed prepares them, for a test that draws rows outside a feed.

import { type PublishedText } from "#renderer/lib/text/published.js";
import { PreparedBodies } from "./prepared-bodies.js";
import { OffListTables } from "./markdown/table-window/off-list.js";
import { prepareTranscriptRow } from "./preparation.js";
import { type TranscriptRowSources } from "./renderer.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/** Rows' bodies as their preparations publish them, and a refresh that reads each row again. */
export interface PreparedRowBodiesForTest {
  /** What the bodies' context provides. */
  readonly bodies: PreparedBodies;
  /** Reads each row's text again, as a drained frame has the feed do. */
  refresh(): void;
}

/**
 * Prepares what `rows` draw, each in view, so its output is parsed whole at once. A row's lane
 * text is what `liveTexts` holds under its id when a read is made: the handle its body is handed.
 */
export function prepareRowBodiesForTest(
  rows: readonly ProjectedTranscriptRow[],
  liveTexts: ReadonlyMap<string, PublishedText> = new Map(),
): PreparedRowBodiesForTest {
  const bodies = new PreparedBodies();
  const sources: TranscriptRowSources = {
    publishedTextFor: (rowId) => liveTexts.get(rowId),
    ownerWindow: window,
    diagramPictures: undefined,
    offListTables: new OffListTables(document, () => undefined),
    preparedBodies: bodies,
    reachOf: () => "view",
    isCallFolded: () => false,
  };
  const preparations = rows.map((row) => prepareTranscriptRow(row, sources, () => undefined));
  return {
    bodies,
    refresh: () => {
      for (const preparation of preparations) {
        preparation?.refresh();
      }
    },
  };
}
