// The chapter's older head, as a body that scrolls inside itself.
//
// WHAT IT ANSWERS. A chapter reports how many of its rows the outer list's ceiling
// left out, and until this component that figure was the whole of what a person got:
// the rows themselves were dropped out of the feed, so a long run's opening was
// counted and gone. This is the bounded viewport those rows live in — the same
// ceiling, read as a window rather than as a deletion.
//
// IT IS A READING SURFACE AND NOT A SECOND FEED. Each row is one line — the time it
// carries, the daemon's own word for what it was, and its summary — and nothing here
// opens a card, streams, or offers an act. The rows in the outer list keep every
// affordance they have; these are the ones scrolled past, and a second full row
// treatment for them would be a second renderer for the same vocabulary.

import { useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { Nothing } from "../../../primitives/index.js";
import {
  chapterClippedHeadRowIds,
  resolveChapterBodyViewportHeight,
  type CssDeclarationSupportProbe,
} from "./chapter-body.js";
import { type LedgerChapter } from "./chapters.js";

export interface ChapterBodyViewportProps {
  readonly chapter: LedgerChapter;
  /**
   * How the engine is asked whether it parses the body's height. Defaulted, and
   * overridable only so a test can drive the arm this host's engine does not take.
   */
  readonly supportsDeclaration?: CssDeclarationSupportProbe;
}

/**
 * One chapter's body: its older head, bounded, with the clip said out loud.
 *
 * `null` where the chapter clips nothing, so an ordinary chapter mounts no scroller
 * and pays for none.
 */
export function ChapterBodyViewport(props: ChapterBodyViewportProps): React.JSX.Element | null {
  const { chapter } = props;
  const contents = useMemo(() => chapterBodyContents(chapter), [chapter]);
  const maxBlockSize = useMemo(
    () => resolveChapterBodyViewportHeight(props.supportsDeclaration),
    [props.supportsDeclaration],
  );
  // The fade is a fact about the scroll offset, so it is held rather than derived —
  // and written only when the offset CROSSES the top, which is at most one render per
  // crossing rather than one per wheel notch.
  const [isClippedAbove, setIsClippedAbove] = useState(false);
  if (contents.rows.length === 0 && contents.unheldRowCount === 0) {
    return null;
  }
  return (
    <div className="meridian-chapter-body">
      {/* Never the scroll anchor: an overlay the engine picked as its anchor would
          hold the fade still and move the rows behind it. */}
      {isClippedAbove ? <div className="meridian-chapter-body__fade" aria-hidden="true" /> : null}
      <ol
        className="meridian-chapter-body__scroller"
        style={{ maxBlockSize }}
        aria-label="Earlier entries in this run"
        onScroll={(event) => {
          const clippedAbove = event.currentTarget.scrollTop > 0;
          if (clippedAbove !== isClippedAbove) {
            setIsClippedAbove(clippedAbove);
          }
        }}
      >
        {contents.rows.map((row) => (
          <li key={row.id} className="meridian-chapter-body__row">
            <span className="meridian-chapter-body__time">{row.timestamp}</span>
            <span className="meridian-chapter-body__type">{row.type}</span>
            {row.summary.length === 0 ? (
              <Nothing kind="empty" placement="inline" title="This entry carries no summary." />
            ) : (
              <span className="meridian-chapter-body__summary">{row.summary}</span>
            )}
          </li>
        ))}
      </ol>
      {contents.unheldRowCount === 0 ? null : (
        <p className="meridian-chapter-body__unheld">
          <span className="meridian-chapter-body__figure">{String(contents.unheldRowCount)}</span>
          {contents.unheldRowCount === 1
            ? " earlier entry is outside this window."
            : " earlier entries are outside this window."}
        </p>
      )}
    </div>
  );
}

/** The head rows this body holds, and how many of the head it could not keep. */
interface ChapterBodyContents {
  readonly rows: readonly TimelineRow[];
  readonly unheldRowCount: number;
}

/**
 * What the body draws, derived from the chapter it was handed.
 *
 * The ids come from the chapter's OWN row ids and the rows from the bounded head the
 * fold sealed, which is what makes this right under a narrowing: a filtered chapter
 * carries the admitted ids, so a row the filter excluded is not asked for — and a row
 * older than the sealed head is asked for, not found, and counted as unheld rather
 * than silently omitted.
 */
function chapterBodyContents(chapter: LedgerChapter): ChapterBodyContents {
  const headRowsById = new Map(chapter.clippedHeadRows.map((row) => [row.id, row]));
  const headRowIds = chapterClippedHeadRowIds(chapter.rowIds);
  const rows = headRowIds
    .map((rowId) => headRowsById.get(rowId))
    .filter((row): row is TimelineRow => row !== undefined);
  return { rows, unheldRowCount: headRowIds.length - rows.length };
}
