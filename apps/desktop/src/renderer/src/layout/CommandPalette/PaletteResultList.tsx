// The palette's rows: every ranked result, grouped by category, in one windowed list that draws
// only the rows in view. It renders the `Combobox.List` itself because the list reads its items
// from the enclosing `Combobox.Root`, which is told `virtualized` so it relies on each item's
// `index` rather than the DOM.

import { Combobox } from "@base-ui/react/combobox";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useId, useRef, type ReactNode } from "react";
import { ChordHint } from "#renderer/components/ChordHint/ChordHint.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useRowWindow, type RowWindow } from "#renderer/hooks/useRowWindow.js";
import { type ChordPlatform } from "#renderer/lib/chord-format.js";
import { rootFontSizePx } from "#renderer/lib/root-font-size.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import {
  ENUMERATION_ROW_HEIGHT_REM,
  SPACE_SCALE_REM,
  scaleStep,
} from "#renderer/styles/palette.js";
import { BODY_LINE_HEIGHT, TYPE_SCALE_REM } from "#renderer/styles/typography.js";
import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import type { CommandSearchResult } from "#renderer/registries/commands/ranking.js";
import type { KeybindingTable } from "#renderer/registries/keybindings/table.js";
import type { PaletteRowPressOutcome } from "./latch.js";
import type { PaletteListRow } from "./group-results.js";
import type { WhenClauseContext } from "#renderer/registries/commands/when-clause/semantics.js";

/** What the palette's listbox renders its rows against. */
export interface PaletteResultListProps {
  /** Every category heading and every match, in display order. */
  readonly rows: readonly PaletteListRow[];
  /** Receives the list's window, so a highlighted row off screen can be scrolled into view. */
  readonly rowWindowRef: React.Ref<RowWindow | null>;
  /** The live context keys. Decides which chord is printed beside a row. */
  readonly context: WhenClauseContext;
  /** Which chord convention to print. Passed in so a fixture can pin it. */
  readonly platform: ChordPlatform;
  /**
   * Supplies each row's chord; rows print none when absent. Required-but-`undefined` because
   * `exactOptionalPropertyTypes` makes it a different type from optional, and the overlay
   * forwards a value that may be undefined.
   */
  readonly bindings: KeybindingTable | undefined;
  /**
   * Runs the row's command and says whether it ran. A row that did not run must never be
   * selected, because selecting closes the combobox and a refusal must leave the palette as it
   * was.
   */
  readonly onRunResult: (result: CommandSearchResult) => PaletteRowPressOutcome;
}

/** The listbox: every match listed, only the rows in view drawn, each category a group. */
export function PaletteResultList(props: PaletteResultListProps): React.JSX.Element {
  const { rows, context, platform, bindings, onRunResult } = props;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollerScrollbarRef = useDrawOverlayScrollbar(scrollerRef);
  const scrollerId = useId();
  const clock = useBridgeClock();
  const ownerWindow = useOwnerWindow();
  // Rows are measured once drawn, so the estimate is only a first guess and the sheet stays the
  // one source of size. The guess is the sheet's own tokens at the window's text size.
  const { virtualizer } = useRowWindow({
    rowCount: rows.length,
    getScrollElement: () => scrollerRef.current,
    clock,
    estimateRowHeightPx: (rowIndex) =>
      (rows[rowIndex]?.kind === "group-label"
        ? GROUP_LABEL_HEIGHT_REM
        : ENUMERATION_ROW_HEIGHT_REM) * rootFontSizePx(ownerWindow.document),
    overscanRows: OVERSCAN_ROWS,
    rowWindowRef: props.rowWindowRef,
  });

  return (
    // A named tab stop, so the matches can be scrolled from the keyboard as well as walked from
    // the input. The bar is drawn inside the scroller, so the scroller is not the listbox, which
    // holds only its groups and options.
    <div
      ref={scrollerScrollbarRef}
      id={scrollerId}
      className="command-palette__list meridian-focus-inset"
      tabIndex={0}
      role="group"
      aria-label="Matching commands"
    >
      {/* Holds the whole height so the scrollbar spans every match; rows sit at their offsets.
          A listbox must carry a name, so it takes the scroller's rather than a second copy. */}
      <Combobox.List
        className="command-palette__rows"
        aria-labelledby={scrollerId}
        style={{ blockSize: virtualizer.getTotalSize() }}
      >
        {drawnCategoryRuns(virtualizer.getVirtualItems(), rows).map((run) => (
          // One group per category's drawn run. Named by `aria-label`, not its heading, because
          // the heading row may be scrolled out of the window while its commands are drawn.
          <Combobox.Group key={run.group} className="command-palette__group" aria-label={run.group}>
            {run.drawnRows.map(({ virtualRow, row }) => {
              const placement = {
                [WINDOWED_ROW_INDEX_ATTRIBUTE]: virtualRow.index,
                ref: virtualizer.measureElement,
                style: { transform: `translateY(${String(virtualRow.start)}px)` },
              };
              if (row.kind === "group-label") {
                // Hidden from assistive technology: the group's own name already says it.
                return (
                  <div
                    key={`label:${row.group}`}
                    className="command-palette__group-label"
                    aria-hidden="true"
                    {...placement}
                  >
                    {row.group}
                  </div>
                );
              }
              const { result } = row;
              const chord = bindings?.chordFor(result.command.id, context);
              return (
                <Combobox.Item
                  key={result.command.id}
                  // The flat index across categories, which a windowed list must pass: the
                  // combobox cannot count rows that are not in the DOM.
                  index={row.itemIndex}
                  value={result.command.id}
                  className="command-palette__item"
                  // Only a window is in the DOM, so each row says where it sits in its category.
                  aria-setsize={row.groupSize}
                  aria-posinset={row.positionInGroup + 1}
                  // `aria-disabled`, not `disabled`: the row stays listed and reachable by arrow
                  // key so its reason can be read; the press below still refuses it.
                  aria-disabled={result.command.unavailable !== undefined}
                  onClick={(event) => {
                    // A refused row is never selected: skipping Base UI's selection keeps the
                    // palette open, and it also covers Enter on the highlighted row.
                    if (onRunResult(result) === "refused") {
                      event.preventBaseUIHandler();
                    }
                  }}
                  {...placement}
                >
                  <span className="command-palette__item-title">
                    {renderTitle(result.command.title, result.titleMatch?.matchedIndices)}
                  </span>
                  {result.command.unavailable === undefined ? null : (
                    <span className="command-palette__item-unavailable">
                      {result.command.unavailable}
                    </span>
                  )}
                  {result.recentRank === undefined ? null : (
                    <span className="command-palette__recent-mark">Recent</span>
                  )}
                  {chord === undefined ? null : (
                    <span className="command-palette__chord">
                      <ChordHint chord={chord} platform={platform} />
                    </span>
                  )}
                </Combobox.Item>
              );
            })}
          </Combobox.Group>
        ))}
      </Combobox.List>
    </div>
  );
}

/** One category's rows that the window draws, consecutive in display order. */
interface DrawnCategoryRun {
  readonly group: string;
  readonly drawnRows: { readonly virtualRow: VirtualItem; readonly row: PaletteListRow }[];
}

/** Splits the drawn rows into one run per category, so each run renders inside its group. */
function drawnCategoryRuns(
  virtualRows: readonly VirtualItem[],
  rows: readonly PaletteListRow[],
): readonly DrawnCategoryRun[] {
  const runs: DrawnCategoryRun[] = [];
  for (const virtualRow of virtualRows) {
    const row = rows[virtualRow.index];
    if (row === undefined) {
      continue;
    }
    const lastRun = runs.at(-1);
    if (lastRun?.group === row.group) {
      lastRun.drawnRows.push({ virtualRow, row });
    } else {
      runs.push({ group: row.group, drawnRows: [{ virtualRow, row }] });
    }
  }
  return runs;
}

/** Splits a title into matched and unmatched runs; emphasis is weight and luminance, not hue. */
function renderTitle(title: string, matchedIndices: readonly number[] | undefined): ReactNode {
  if (matchedIndices === undefined || matchedIndices.length === 0) {
    return title;
  }
  const matched = new Set(matchedIndices);
  const segments: ReactNode[] = [];
  let runStart = 0;
  let runIsMatch = matched.has(0);
  for (let characterIndex = 1; characterIndex <= title.length; characterIndex += 1) {
    const isMatch = matched.has(characterIndex);
    if (characterIndex === title.length || isMatch !== runIsMatch) {
      const text = title.slice(runStart, characterIndex);
      segments.push(
        runIsMatch ? (
          <span className="command-palette__match" key={`${String(runStart)}-match`}>
            {text}
          </span>
        ) : (
          <span key={`${String(runStart)}-plain`}>{text}</span>
        ),
      );
      runStart = characterIndex;
      runIsMatch = isMatch;
    }
  }
  return segments;
}

/**
 * A category heading's height, in rem: one `text-xs` line box at the body line height under a
 * `space-2` and over a `space-1`, as the sheet pads it. A command row is an enumeration row.
 */
const GROUP_LABEL_HEIGHT_REM =
  scaleStep(TYPE_SCALE_REM, "text-xs") * BODY_LINE_HEIGHT +
  scaleStep(SPACE_SCALE_REM, "space-2") +
  scaleStep(SPACE_SCALE_REM, "space-1");

/** Rows drawn past each edge, so a quick flick or arrow press does not meet an undrawn band. */
const OVERSCAN_ROWS = 8;
