// The run group's older head, as a read-only body that scrolls inside itself: the rows the
// outer list's ceiling left out, one line each (time, the daemon's own word, summary). It opens
// no cards and offers no acts; the rows in the outer list keep those.

import "./RunGroupBody.css";

import { useMemo, useState } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useOverlayScrollbar } from "#renderer/hooks/useOverlayScrollbar.js";
import {
  listClippedHeadRowIds,
  resolveRunGroupBodyHeight,
  type CssDeclarationSupportProbe,
} from "../body.js";
import { type RunGroup } from "../groups.js";

/** The props of a run group body. */
export interface RunGroupBodyProps {
  readonly runGroup: RunGroup;
  /** Probe for whether the engine parses the body's height; overridable for tests only. */
  readonly supportsDeclaration?: CssDeclarationSupportProbe;
}

/**
 * One run group's body: its older head, bounded, with the clip said out loud.
 *
 * `null` where the run group clips nothing, so an ordinary run group mounts no scroller.
 */
export function RunGroupBody(props: RunGroupBodyProps): React.JSX.Element | null {
  const { runGroup } = props;
  const contents = useMemo(() => runGroupBodyContents(runGroup), [runGroup]);
  const maxBlockSize = useMemo(
    () => resolveRunGroupBodyHeight(props.supportsDeclaration),
    [props.supportsDeclaration],
  );
  // Held, not derived; written only when the offset crosses the top, not per wheel notch.
  const [isClippedAbove, setIsClippedAbove] = useState(false);
  const scrollerScrollbarRef = useOverlayScrollbar<HTMLDivElement>(undefined, {
    start: "on-first-interaction",
  });
  if (contents.rows.length === 0 && contents.unheldRowCount === 0) {
    return null;
  }
  return (
    <div className="meridian-run-group-body">
      {/* Never the scroll anchor: an anchored overlay would hold the fade still. */}
      {isClippedAbove ? <div className="meridian-run-group-body__fade" aria-hidden="true" /> : null}
      {/* The bar is drawn inside the scroller, so the scroller is not the list: a list holds
          only its items. */}
      <div
        ref={scrollerScrollbarRef}
        className="meridian-run-group-body__scroller"
        style={{ maxBlockSize }}
        onScroll={(event) => {
          const clippedAbove = event.currentTarget.scrollTop > 0;
          if (clippedAbove !== isClippedAbove) {
            setIsClippedAbove(clippedAbove);
          }
        }}
      >
        <ol className="meridian-run-group-body__rows" aria-label="Earlier entries in this run">
          {contents.rows.map((row) => (
            <li key={row.id} className="meridian-run-group-body__row">
              <span className="meridian-run-group-body__time">{row.timestamp}</span>
              <span className="meridian-run-group-body__type">{row.type}</span>
              {row.summary.length === 0 ? (
                <Nothing kind="empty" placement="inline" title="This entry carries no summary." />
              ) : (
                <span className="meridian-run-group-body__summary">{row.summary}</span>
              )}
            </li>
          ))}
        </ol>
      </div>
      {contents.unheldRowCount === 0 ? null : (
        <p className="meridian-run-group-body__unheld">
          {String(contents.unheldRowCount)}
          {contents.unheldRowCount === 1
            ? " earlier entry is outside this window."
            : " earlier entries are outside this window."}
        </p>
      )}
    </div>
  );
}

/** The head rows this body holds, and how many of the head it could not keep. */
interface RunGroupBodyContents {
  readonly rows: readonly TranscriptEventRow[];
  readonly unheldRowCount: number;
}

/**
 * What the body draws, derived from the run group it was handed.
 *
 * Ids come from the run group's own row ids and rows from the bounded head the fold sealed, so
 * a filtered run group does not ask for excluded rows, and a row older than the sealed head is
 * counted as unheld rather than omitted.
 */
function runGroupBodyContents(runGroup: RunGroup): RunGroupBodyContents {
  const headRowsById = new Map(runGroup.clippedHeadRows.map((row) => [row.id, row]));
  const headRowIds = listClippedHeadRowIds(runGroup.rowIds);
  const rows = headRowIds
    .map((rowId) => headRowsById.get(rowId))
    .filter((row): row is TranscriptEventRow => row !== undefined);
  return { rows, unheldRowCount: headRowIds.length - rows.length };
}
