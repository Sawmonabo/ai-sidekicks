// The acts the feed publishes, driven with no render at all.
//
// Every case below invokes an act and watches what it reached. That is the whole
// property: the palette and the session header both resolve their target at press time,
// so the only thing that can be wrong is which of the feed's own callbacks an act
// runs — and none of them needs a DOM to check.
//
// THE REFUSING ARM is the reason this file exists in the shape it does. A no-op and
// a refusal are indistinguishable from a component test: nothing moves either way.
// Here the refusal is read off the frame's own act-refusal channel, so a press that
// quietly did nothing fails — and the act that CAN refuse is checked on both arms,
// because an act that refused unconditionally would pass a one-armed case.

import { afterEach, describe, expect, it } from "vitest";

import { type ConsoleRefusal } from "../../../../core/index.js";
import { publishConsoleActRefusalSink } from "../../../../palette/index.js";
import { UNFILTERED_LEDGER, emptyFindResult } from "../../../structure/index.js";
import {
  LEDGER_NOTHING_FILTERED_REFUSAL,
  buildLedgerStructureActs,
  type LedgerFeedActInputs,
} from "./ledger-feed-acts.js";
import { type LedgerFindState } from "../../find/ledger-find.js";
import { type LedgerFilterState } from "../../find/ledger-narrowing.js";

/** What one case watched happen, in the order it happened. */
type ActTrace = string[];

/** The row a stubbed walk lands on, so a jump can be told from a walk that found nothing. */
const WALKED_ROW_ID = "row-the-walk-found";

/**
 * A find state whose members record rather than derive.
 *
 * `useLedgerFind`'s real behaviour is `ledger-find.test.ts`'; what matters
 * here is which member an act calls, which a recording stand-in answers and a real
 * hook would only obscure.
 */
function recordingFindState(trace: ActTrace, walkedRowId?: string): LedgerFindState {
  return {
    isOpen: false,
    query: "",
    result: emptyFindResult(0),
    beyondWindowMatchCount: 0,
    filteredAwayMatchCount: 0,
    foldedAwayMatchCount: 0,
    currentMatchIndex: -1,
    setQuery: () => {
      trace.push("setQuery");
    },
    open: () => {
      trace.push("open");
    },
    openRequestCount: 0,
    close: () => {
      trace.push("close");
    },
    step: (direction) => {
      trace.push(`step:${direction}`);
      return walkedRowId === undefined
        ? undefined
        : { index: 0, match: { rowId: walkedRowId, sequence: 0, matchedIn: "summary" } };
    },
  };
}

/** One window's act inputs, with every seam recording into `trace`. */
function actInputs(
  trace: ActTrace,
  options: {
    readonly walkedRowId?: string;
    readonly isFiltered?: boolean;
  } = {},
): LedgerFeedActInputs {
  return {
    find: recordingFindState(trace, options.walkedRowId),
    jumpToRow: (rowId) => {
      trace.push(`jumpToRow:${rowId}`);
    },
    jumpToTail: () => {
      trace.push("jumpToTail");
    },
    collapseAllTerminalChapters: () => {
      trace.push("collapseAllTerminalChapters");
    },
    ledgerFilter: recordingFilterState(options.isFiltered ?? false, trace),
  };
}

/**
 * A narrowing whose members record.
 *
 * What it HOLDS is `ledger/structure/narrowing/filters.test.ts`'; what this file is
 * about is which of these members the feed's acts call.
 */
function recordingFilterState(isFiltered: boolean, trace: ActTrace): LedgerFilterState {
  return {
    filter: UNFILTERED_LEDGER,
    facets: { users: [], categories: [] },
    isFiltered,
    setFilter: () => {
      trace.push("setFilter");
    },
    clear: () => {
      trace.push("clearFilters");
    },
  };
}

/** Every refusal raised on the frame's channel for the length of one case. */
function collectRaisedRefusals(): {
  readonly raised: ConsoleRefusal[];
  readonly withdraw: () => void;
} {
  const raised: ConsoleRefusal[] = [];
  const withdraw = publishConsoleActRefusalSink((refusal) => {
    raised.push(refusal);
  });
  return { raised, withdraw };
}

describe("the ledger's acts — what each one reaches", () => {
  it("opens the find field without touching its query", () => {
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).openFind();
    expect(trace).toStrictEqual(["open"]);
  });

  it("walks the matches and scrolls to each one it lands on", () => {
    const trace: ActTrace = [];
    const acts = buildLedgerStructureActs(actInputs(trace, { walkedRowId: WALKED_ROW_ID }));
    acts.stepFindNext();
    acts.stepFindPrevious();
    expect(trace).toStrictEqual([
      "step:next",
      `jumpToRow:${WALKED_ROW_ID}`,
      "step:previous",
      `jumpToRow:${WALKED_ROW_ID}`,
    ]);
  });

  it("negative control: a walk that found nothing scrolls nowhere", () => {
    // Without this the case above would pass over an act that jumped on every
    // press — which, with no match to land on, is a scroll to a row id nobody
    // produced and a reader moved for no reason.
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).stepFindNext();
    expect(trace).toStrictEqual(["step:next"]);
  });

  it("scrolls to the tail through the ledger's own scroll writer", () => {
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).scrollToTail();
    expect(trace).toStrictEqual(["jumpToTail"]);
  });

  it("folds every terminal chapter this feed has open", () => {
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).collapseAllTerminalChapters();
    expect(trace).toStrictEqual(["collapseAllTerminalChapters"]);
  });

  it("fires nothing merely by being built", () => {
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace));
    expect(trace).toStrictEqual([]);
  });
});

describe("the ledger's acts — the one that refuses", () => {
  let withdrawSink: (() => void) | undefined;

  afterEach(() => {
    withdrawSink?.();
    withdrawSink = undefined;
  });

  it("says why there is nothing to widen when nothing is narrowed", () => {
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    buildLedgerStructureActs(actInputs([])).clearFilters();
    expect(raised).toStrictEqual([LEDGER_NOTHING_FILTERED_REFUSAL]);
    expect(raised[0]?.code).toBe("ledger.nothing_filtered");
    expect(raised[0]?.origin).toBe("ledger");
  });

  it("clears a narrowed ledger rather than refusing over a surface that now exists", () => {
    // The refusal this replaces said the ledger offered no narrowing at all, which
    // was true only while `filters.ts` had no caller. The facet bar reaches it now,
    // so a narrowed ledger widens and raises nothing.
    const trace: ActTrace = [];
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    buildLedgerStructureActs(actInputs(trace, { isFiltered: true })).clearFilters();
    expect(trace).toStrictEqual(["clearFilters"]);
    expect(raised).toStrictEqual([]);
  });

  it("folds the chapters rather than refusing over a control that now exists", () => {
    // The refusal this replaces said every finished chapter was already folded and
    // no control opened one. Both halves are false now that a chapter header is a
    // disclosure, so the press does the fold and raises nothing.
    const trace: ActTrace = [];
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    buildLedgerStructureActs(actInputs(trace)).collapseAllTerminalChapters();
    expect(trace).toStrictEqual(["collapseAllTerminalChapters"]);
    expect(raised).toStrictEqual([]);
  });

  it("negative control: the acts that CAN act raise nothing", () => {
    // Without this the case above would pass over a build that answered every
    // press with a banner, which would state a refusal over work that was done.
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    const acts = buildLedgerStructureActs(actInputs([], { walkedRowId: WALKED_ROW_ID }));
    acts.openFind();
    acts.stepFindNext();
    acts.scrollToTail();
    acts.collapseAllTerminalChapters();
    expect(raised).toStrictEqual([]);
  });
});
