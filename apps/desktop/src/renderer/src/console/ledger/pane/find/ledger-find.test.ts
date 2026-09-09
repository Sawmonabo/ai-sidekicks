// The find field: the walk when the window moves under it, and its own open act.
//
// Both subjects are about state the field HOLDS rather than about matching, which
// `find-model.test.ts` owns: a walk held by ordinal survived into a shorter result
// and read "10 of 2", and an open folded into the query setter reset a walk
// somebody was in the middle of.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  UNFILTERED_LEDGER,
  ProvenanceRailModel,
  type LedgerFilter,
} from "../../structure/index.js";
import { useLedgerFind, type LedgerFindState } from "./ledger-find.js";
import { NO_ROWS_REMOVED, type LedgerWindowModel } from "../window/ledger-window.js";
import { useFilteredLedgerWindow } from "./ledger-narrowing.js";
import {
  useVisibleLedgerWindow,
  type VisibleLedgerWindow,
} from "../window/ledger-visible-window.js";
import { deriveLedgerWindow } from "../window/ledger-window.js";
import {
  EVERY_ROW_QUERY,
  LOG_EVENT_COUNT,
  syntheticEventLog,
} from "../window/ledger-visible-window.test-support.js";

describe("the walk when the result moves under it", () => {
  /** A visible window over exactly these rows, with nothing outside it. */
  function windowOver(rows: readonly TimelineRow[]): VisibleLedgerWindow {
    return {
      rows,
      prunedAwayRows: [],
      withheldByReplayRows: [],
      hasEarlierRows: false,
      // Nothing outside this window, so both stage memberships are the rows
      // themselves — the identity the partition would have produced.
      revealedRowKeys: new Set(rows.map((row) => row.id)),
      heldRowKeys: new Set(rows.map((row) => row.id)),
      railModel: new ProvenanceRailModel({ rows, hasEarlierRows: false }),
    };
  }

  /** The find state over a window a case can swap for a different one. */
  function findOver(
    rows: readonly TimelineRow[],
  ): RenderHookResult<LedgerFindState, { readonly rows: readonly TimelineRow[] }> {
    return renderHook(
      ({ rows: currentRows }) =>
        useLedgerFind({
          visible: windowOver(currentRows),
          // Nothing is narrowed and nothing is folded here, so both upstream stages
          // report the shared empty removal.
          filteredAwayRows: NO_ROWS_REMOVED,
          foldedAwayRows: NO_ROWS_REMOVED,
        }),
      { initialProps: { rows } },
    );
  }

  const wholeLog = deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false).rows;

  /**
   * The find state over three stages of one pipeline, each a prefix of the last.
   *
   * Each stage REPORTS what it removed, which is what the hook counts, so a prefix
   * models the pipeline exactly at this seam: the rows the narrowing took are the
   * unfurled log's tail past the narrowed one, and the fold's are the narrowed log's
   * tail past the folded one. Building a facet bar and a terminal run chapter would
   * produce the same two sets and nothing else.
   */
  function findOverPipeline(stages: {
    readonly unfurled: number;
    readonly narrowed: number;
    readonly folded: number;
  }): RenderHookResult<LedgerFindState, unknown> {
    const modelOf = (count: number): LedgerWindowModel =>
      deriveLedgerWindow(syntheticEventLog(count), false);
    const foldedWindow = modelOf(stages.folded);
    return renderHook(() =>
      useLedgerFind({
        visible: windowOver(foldedWindow.rows),
        filteredAwayRows: modelOf(stages.unfurled).rows.slice(stages.narrowed),
        foldedAwayRows: modelOf(stages.narrowed).rows.slice(stages.folded),
      }),
    );
  }

  it("reports no position once the selected row has left the result", () => {
    const { result, rerender } = findOver(wholeLog);
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    for (let step = 0; step < LOG_EVENT_COUNT; step += 1) {
      act(() => {
        result.current.step("next");
      });
    }
    expect(result.current.currentMatchIndex).toBe(LOG_EVENT_COUNT - 1);

    // The same query over a window the replay or the cap has cut down to two rows,
    // neither of which is the selected one. A held ordinal read "10 of 2" here.
    rerender({ rows: wholeLog.slice(0, 2) });
    expect(result.current.result.matches).toHaveLength(2);
    expect(result.current.currentMatchIndex).toBe(-1);

    // And the next step ENTERS the shorter list rather than resuming from an
    // ordinal the new result cannot hold.
    let walked: ReturnType<LedgerFindState["step"]>;
    act(() => {
      walked = result.current.step("next");
    });
    expect(walked?.index).toBe(0);
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it("keeps the selected row's position when the window only grew", () => {
    const SELECTED_MATCH_INDEX = 3;
    const { result, rerender } = findOver(wholeLog.slice(0, LOG_EVENT_COUNT - 2));
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    for (let step = 0; step <= SELECTED_MATCH_INDEX; step += 1) {
      act(() => {
        result.current.step("next");
      });
    }
    expect(result.current.currentMatchIndex).toBe(SELECTED_MATCH_INDEX);
    rerender({ rows: wholeLog });
    expect(result.current.result.matches).toHaveLength(LOG_EVENT_COUNT);
    expect(result.current.currentMatchIndex).toBe(SELECTED_MATCH_INDEX);
  });

  it("counts matches the filter took out of the walk", () => {
    // A term in a row the facet bar is hiding is a term in a LOADED row. The walk
    // could not step to it, and nothing said so either — the field simply reported
    // fewer matches than the session holds, or none at all.
    const { result } = findOverPipeline({ unfurled: 10, narrowed: 8, folded: 6 });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.totalMatchCount).toBe(6);
    expect(result.current.filteredAwayMatchCount).toBe(2);
  });

  it("counts matches a folded chapter is holding", () => {
    // Rule 7 folds every finished run by default, so on a completed session most of
    // the log is behind a chapter header and this is most of the matches.
    const { result } = findOverPipeline({ unfurled: 10, narrowed: 8, folded: 6 });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.foldedAwayMatchCount).toBe(2);
  });

  it("negative control: an unnarrowed, unfolded ledger counts neither", () => {
    // Without this the two cases above would pass over counts that reported the whole
    // log every time, which is the same lie in the other direction.
    const { result } = findOverPipeline({ unfurled: 10, narrowed: 10, folded: 10 });
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.result.totalMatchCount).toBe(10);
    expect(result.current.filteredAwayMatchCount).toBe(0);
    expect(result.current.foldedAwayMatchCount).toBe(0);
  });

  it("negative control: a new query still restarts the walk", () => {
    // Without this the retention above could have been written as "never reset",
    // which would resume a walk inside a match list built from a different question.
    const { result } = findOver(wholeLog);
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    act(() => {
      result.current.step("next");
    });
    expect(result.current.currentMatchIndex).toBe(0);
    act(() => {
      result.current.setQuery("user");
    });
    expect(result.current.currentMatchIndex).toBe(-1);
  });
});

/** A narrowing that admits a family {@link syntheticEventLog} has no row of. */
const ADMITS_NO_SYNTHETIC_ROW: LedgerFilter = {
  participantIds: [],
  categories: ["tool_activity"],
};

describe("what an appended row costs the counts beside the field", () => {
  /**
   * A window model that tallies every pass a caller makes over its rows.
   *
   * A getter rather than a spy, because the claim is about passes over the loaded
   * projection and `rows` is what a pass reads. The counts beside the find field used
   * to derive their own sets from a pair of these — a `Set` over one stage's rows and
   * a filter over the previous stage's — so every appended row cost four passes over
   * the whole log for as long as a query sat in the field, on a ledger that had
   * narrowed and folded nothing.
   */
  function tallyingWindow(model: LedgerWindowModel, tally: { passes: number }): LedgerWindowModel {
    return {
      ...model,
      get rows(): readonly TimelineRow[] {
        tally.passes += 1;
        return model.rows;
      },
    };
  }

  /** A visible window over no rows: these cases measure the counts, not the walk. */
  const NOTHING_ON_SCREEN: VisibleLedgerWindow = {
    rows: [],
    prunedAwayRows: [],
    withheldByReplayRows: [],
    hasEarlierRows: false,
    revealedRowKeys: new Set<string>(),
    heldRowKeys: new Set<string>(),
    railModel: new ProvenanceRailModel({ rows: [], hasEarlierRows: false }),
  };

  /** What one measured render reports back. */
  interface NarrowingReading {
    readonly removedRowCount: number;
    readonly matchCount: number;
    readonly setQuery: (query: string) => void;
  }

  /**
   * The narrowing stage over a log a case can grow, with its passes counted.
   *
   * The tallying model reaches the STAGE and nothing else: the visible window is a
   * constant, so every pass the tally records is one the stage or the counts made.
   */
  function narrowingOver(
    filter: LedgerFilter,
    tally: { passes: number },
  ): RenderHookResult<NarrowingReading, { readonly eventCount: number }> {
    return renderHook(
      ({ eventCount }) => {
        const projection = deriveLedgerWindow(syntheticEventLog(eventCount), false);
        const narrowing = useFilteredLedgerWindow(tallyingWindow(projection, tally), filter);
        const find = useLedgerFind({
          visible: NOTHING_ON_SCREEN,
          filteredAwayRows: narrowing.removedRows,
          foldedAwayRows: NO_ROWS_REMOVED,
        });
        return {
          removedRowCount: narrowing.removedRows.length,
          matchCount: find.filteredAwayMatchCount,
          setQuery: find.setQuery,
        };
      },
      { initialProps: { eventCount: LOG_EVENT_COUNT } },
    );
  }

  /** Passes over the loaded projection that one appended row costs, under a filter. */
  function passesPerAppend(filter: LedgerFilter): number {
    const tally = { passes: 0 };
    const { result, rerender } = narrowingOver(filter, tally);
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    const passesBeforeAppend = tally.passes;
    rerender({ eventCount: LOG_EVENT_COUNT + 1 });
    return tally.passes - passesBeforeAppend;
  }

  it("walks the projection no times per appended row while a query is live", () => {
    expect(passesPerAppend(UNFILTERED_LEDGER)).toBe(0);
  });

  it("negative control: a ledger that IS narrowed does walk it, once per stage pass", () => {
    // Without this the case above would pass over a hook that had simply stopped
    // counting. Stated as a floor rather than a figure because the figure is the
    // stage's ONE pass multiplied by however many times this environment renders a
    // component per update — which is exactly why the case above is the sharp one:
    // zero stays zero under any multiplier.
    expect(passesPerAppend(ADMITS_NO_SYNTHETIC_ROW)).toBeGreaterThan(0);
  });

  it("counts matches over what the stage reported rather than over the projection", () => {
    // The count beside the field is the matches among exactly the rows the stage
    // removed — which here is every row, because the filter admits a family this log
    // has none of.
    const tally = { passes: 0 };
    const { result } = narrowingOver(ADMITS_NO_SYNTHETIC_ROW, tally);
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });

    expect(result.current.matchCount).toBe(LOG_EVENT_COUNT);
  });
});

describe("the find field's own open act", () => {
  /** The find state over one whole window, with nothing pruned. */
  function findOverWholeLog(): RenderHookResult<LedgerFindState, void> {
    const ledgerWindow = deriveLedgerWindow(syntheticEventLog(LOG_EVENT_COUNT), false);
    return renderHook(() =>
      useLedgerFind({
        visible: useVisibleLedgerWindow(
          ledgerWindow,
          ledgerWindow.viewportRows,
          ledgerWindow.viewportRows,
        ),
        // Nothing is narrowed and nothing is folded here, so both upstream stages
        // report the shared empty removal and both of their counts stay zero.
        filteredAwayRows: NO_ROWS_REMOVED,
        foldedAwayRows: NO_ROWS_REMOVED,
      }),
    );
  }

  it("reveals the field", () => {
    const { result } = findOverWholeLog();
    expect(result.current.isOpen).toBe(false);
    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("leaves the query and the walk exactly where they were", () => {
    // Which is why it is not `setQuery("")`: the palette row opens a field somebody
    // is about to type into, and resetting a walk they were in the middle of is a
    // different act wearing the same name.
    const { result } = findOverWholeLog();
    act(() => {
      result.current.setQuery(EVERY_ROW_QUERY);
    });
    act(() => {
      result.current.step("next");
    });
    const walkedIndex = result.current.currentMatchIndex;
    act(() => {
      result.current.open();
    });
    expect(result.current.query).toBe(EVERY_ROW_QUERY);
    expect(result.current.currentMatchIndex).toBe(walkedIndex);
  });

  it("negative control: a field nobody opened stays closed", () => {
    // Without this the case above would pass over a hook that reported `isOpen`
    // true from its first render, which is a find field nobody asked for.
    const { result, rerender } = findOverWholeLog();
    rerender();
    expect(result.current.isOpen).toBe(false);
  });
});
