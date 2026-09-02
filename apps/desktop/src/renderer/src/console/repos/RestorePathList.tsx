// One rollback enumeration's paths, drawn either in full or through a window.
//
// Split out of `FileRestoreDisclosure.tsx` because the two ways of drawing this
// list share exactly one thing — the row — and a second copy of the row is how a
// windowed list and a plain one come to render a path differently. Both modes live
// here so the row is written once and the threshold is read once.
//
// THE VIRTUALIZER IS THE ADOPTED LIBRARY, CALLED DIRECTLY. `@tanstack/react-virtual`
// is a dependency of this package and the family's diff pane already windows with
// it. There is nothing to reuse from that pane: its virtualization is a row index
// over a nested structure, a measurement effect scoped to the wrap toggle, and a
// two-box layout carrying a diff's own classes — all diff-specific. So the library
// IS the shared implementation, and a hand-written wrapper over it would be a
// second abstraction with two callers and no behaviour in common.
//
// THE HEIGHT COMES FROM TYPESCRIPT, NOT FROM THE SHEET — AND ONLY THE HEIGHT. A
// window needs a bounded scroll container, and the bound is
// `RESTORE_PATH_VISIBLE_ROW_CAP` rows of `RESTORE_PATH_ROW_HEIGHT_PX` — set inline,
// on the same precedent the diff pane sets its own height cap from: a length that the
// window arithmetic also reads has one home, and a copy of it in the stylesheet is a
// second owner that can move alone. That reason reaches the bound and the row offset
// and nothing else, so everything this list presents that is NOT computed — the
// scroll, the overscroll containment, and the two sheet rules the windowed mode drops
// — lives in `repos.css` beside the rules it belongs with.
//
// THE RESIDUAL. Rows are placed at the height they MEASURE, so a wrapped path is
// spaced correctly; what the windowed mode gives up is the sheet's inter-row gap,
// which would sit between rows the arithmetic does not know about. The windowed
// list therefore stacks its rows contiguously. Nothing else about a path row
// differs between the two modes.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";

import {
  RESTORE_PATH_ROW_HEIGHT_PX,
  RESTORE_PATH_VIRTUALIZATION_THRESHOLD,
  RESTORE_PATH_VISIBLE_ROW_CAP,
} from "../core/index.js";
import { WireFigure } from "../primitives/index.js";

/** The tallest a windowed enumeration's scroll container may grow, in CSS pixels. */
const RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX =
  RESTORE_PATH_VISIBLE_ROW_CAP * RESTORE_PATH_ROW_HEIGHT_PX;

export interface RestorePathListProps {
  /** What the enumeration is called, for the scroll region's own name. */
  readonly label: string;
  readonly paths: readonly string[];
  /** Open one path in the diff pane. Absent where no diff exists for it. */
  readonly onOpenPath: ((path: string) => void) | undefined;
}

/**
 * The paths, windowed past the threshold and drawn in full below it.
 *
 * The branch is on the path COUNT and on nothing else — no measurement, no
 * capability probe — so which mode a given enumeration draws in is decidable from
 * the reading alone.
 */
export function RestorePathList(props: RestorePathListProps): React.JSX.Element {
  if (props.paths.length >= RESTORE_PATH_VIRTUALIZATION_THRESHOLD) {
    return <WindowedRestorePathList {...props} />;
  }
  return (
    <ul className="meridian-restore-disclosure__paths">
      {props.paths.map((path) => (
        <li key={path}>
          <RestorePathCell path={path} onOpenPath={props.onOpenPath} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The same paths, with only the window's worth of rows in the document.
 *
 * The scroll container is keyboard-focusable because a region that scrolls and
 * cannot be reached from the keyboard is a region half the operators cannot read,
 * and it carries the enumeration's own name so the focus stop announces what it
 * holds rather than announcing a group.
 *
 * Overscan is the library's own default: this list has no expensive row and no
 * horizontal axis, so a band picked here would be a number with no reason behind
 * it.
 */
function WindowedRestorePathList(props: RestorePathListProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: props.paths.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => RESTORE_PATH_ROW_HEIGHT_PX,
    // A first paint happens before any layout callback runs, so the window has to
    // be computed against something; this says which something, and the observed
    // rect replaces it on the next tick.
    initialRect: { width: 0, height: RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX },
    // React 19 warns when a virtualizer flushes synchronously from a lifecycle
    // method, and no frame here needs a scroll tick to land in the commit that
    // caused it.
    useFlushSync: false,
  });

  const virtualRows = virtualizer.getVirtualItems();
  return (
    <div
      className="meridian-restore-disclosure__path-scroller"
      ref={scrollerRef}
      role="group"
      aria-label={props.label}
      tabIndex={0}
      // Only the bound is inline: it is the same constant the virtualizer measures
      // against, so the window and its arithmetic keep one home. The scroll and the
      // overscroll containment are the sheet's.
      style={{ maxBlockSize: RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX }}
    >
      {/* Two boxes rather than absolute positioning, so the rendered rows stay in
          the document's own flow: the content box holds the whole list's height so
          the scrollbar reports the whole enumeration, and the window is placed at
          the offset of its first row. */}
      <div style={{ blockSize: virtualizer.getTotalSize() }}>
        <ul
          // The modifier drops the gap and the leading padding — space the window
          // arithmetic does not account for — in the sheet, beside the rules it
          // overrides. Only the offset is inline, because only the offset is computed.
          className="meridian-restore-disclosure__paths meridian-restore-disclosure__paths--windowed"
          style={{ transform: `translateY(${String(virtualRows[0]?.start ?? 0)}px)` }}
        >
          {virtualRows.map((virtualRow) => {
            const path = props.paths[virtualRow.index];
            return path === undefined ? null : (
              <li
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                // The window holds a slice, so each row says where it sits in the
                // whole enumeration; without it a screen reader would be told the
                // list is as long as the window.
                aria-setsize={props.paths.length}
                aria-posinset={virtualRow.index + 1}
              >
                <RestorePathCell path={path} onOpenPath={props.onOpenPath} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * One path, as text or as the control that opens it.
 *
 * The link exists only where the mounting surface can honour it — a disclosure with
 * no diff behind it renders text rather than a dead control.
 */
function RestorePathCell(props: {
  readonly path: string;
  readonly onOpenPath: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const { onOpenPath, path } = props;
  if (onOpenPath === undefined) {
    return <WireFigure value={path} />;
  }
  return (
    <button
      type="button"
      className="meridian-restore-disclosure__path-link"
      onClick={() => {
        onOpenPath(path);
      }}
    >
      <WireFigure value={path} />
    </button>
  );
}
