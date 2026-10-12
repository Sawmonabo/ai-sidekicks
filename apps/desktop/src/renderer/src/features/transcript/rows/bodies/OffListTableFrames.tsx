// The hidden frames of the long tables measured before their rows are listed. Each table is drawn
// in a transcript row of its own, laid out at the listed rows' width, around a reply's body, so its
// cells wrap at a listed body's width in its type, inside the window's measuring frames.

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";
import { type MarkdownTableOffer } from "#renderer/components/Markdown/table-offer.js";
import { useCodeSpanReader } from "#renderer/services/highlight/hooks/useCodeSpanReader.js";
import { TranscriptRowLayout } from "../../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { type TableMeasuringFrame } from "../markdown/table-window/measurement.js";
import { type OffListTable, type OffListTables } from "../markdown/table-window/off-list.js";
import { MeasuringFrames } from "./MeasuringFrames.js";
import { TableSampleFrame } from "./TableSampleFrame.js";

/** What the off-list frames are drawn from. */
export interface OffListTableFramesProps {
  /** The window's tables waiting to be measured. */
  readonly offList: OffListTables;
}

/** The hidden frames of every table waiting in `offList`, drawn in its document's body. */
export function OffListTableFrames(props: OffListTableFramesProps): React.JSX.Element {
  const { offList } = props;
  const tables = useSyncExternalStore(offList.subscribe, offList.read);
  return (
    <MeasuringFrames ownerDocument={offList.ownerDocument}>
      {tables.map((entry) =>
        entry.frame === undefined || entry.rowWidthPx === undefined ? null : (
          <OffListTableFrame
            key={entry.key}
            entry={entry}
            frame={entry.frame}
            rowWidthPx={entry.rowWidthPx}
          />
        ),
      )}
    </MeasuringFrames>
  );
}

/** One table's frame, in a reply's body inside a row at the listed rows' width. */
function OffListTableFrame(props: {
  readonly entry: OffListTable;
  readonly frame: TableMeasuringFrame;
  readonly rowWidthPx: number;
}): React.JSX.Element {
  const { entry, frame, rowWidthPx } = props;
  const codeSpanReader = useCodeSpanReader();
  const bodyRef = useRef<HTMLDivElement>(null);
  const readFrame = useCallback(
    (drawnFrame: TableMeasuringFrame, table: HTMLTableElement) => {
      const body = bodyRef.current;
      if (body === null) {
        throw new Error("A long table's hidden frame was read with no body around it.");
      }
      entry.readFrame(drawnFrame, table, body);
    },
    [entry],
  );
  const context = useMemo<MarkdownRenderContext>(
    () => ({
      isSettled: true,
      definedFootnoteIdentifiers: entry.definedFootnoteIdentifiers,
      codeSpanReader,
      renderCopy: undefined,
      renderTable: (offer: MarkdownTableOffer) => (
        <TableSampleFrame offer={offer} frame={frame} readFrame={readFrame} />
      ),
    }),
    [entry, codeSpanReader, frame, readFrame],
  );
  return (
    <div style={{ width: `${String(rowWidthPx)}px` }}>
      <TranscriptRowLayout agentHueStep={0} occurredAtIso={UNDRAWN_TIME} timePlacement="none">
        <div className="meridian-message-card meridian-message-card--agent-message">
          <div className="meridian-message-card__body">
            <div className="meridian-machine-body">
              <div className="meridian-markdown" ref={bodyRef}>
                <MarkdownNodes nodes={[entry.table]} context={context} />
              </div>
            </div>
          </div>
        </div>
      </TranscriptRowLayout>
    </div>
  );
}

/** The time a hidden row carries, which it never draws. */
const UNDRAWN_TIME = "1970-01-01T00:00:00.000Z";
