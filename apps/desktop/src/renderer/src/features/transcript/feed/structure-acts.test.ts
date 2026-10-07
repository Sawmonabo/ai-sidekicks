// The acts the feed publishes, driven with no render.

import { describe, expect, it } from "vitest";

import { emptyFindResult } from "../find/matcher.js";
import { type TranscriptFindState } from "../find/hooks/useTranscriptFind.js";
import {
  buildTranscriptStructureActs,
  type TranscriptStructureActInputs,
} from "./structure-acts.js";

type ActTrace = string[];

/** The row a stubbed walk lands on, so a jump can be told from a walk that found nothing. */
const WALKED_ROW_ID = "row-the-walk-found";

// A find state whose members record rather than derive: what matters is which member an
// act calls.
function recordingFindState(trace: ActTrace, walkedRowId?: string): TranscriptFindState {
  return {
    isOpen: false,
    query: "",
    result: emptyFindResult(0),
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

function actInputs(
  trace: ActTrace,
  options: {
    readonly walkedRowId?: string;
  } = {},
): TranscriptStructureActInputs {
  return {
    find: recordingFindState(trace, options.walkedRowId),
    jumpToRow: (rowId) => {
      trace.push(`jumpToRow:${rowId}`);
    },
    jumpToTail: () => {
      trace.push("jumpToTail");
    },
    collapseAllTerminalRunGroups: () => {
      trace.push("collapseAllTerminalRunGroups");
    },
  };
}

describe("the transcript's acts — what each one reaches", () => {
  it("walks the matches and scrolls to each one it lands on", () => {
    const trace: ActTrace = [];
    const acts = buildTranscriptStructureActs(actInputs(trace, { walkedRowId: WALKED_ROW_ID }));
    acts.stepFindNext();
    acts.stepFindPrevious();
    expect(trace).toStrictEqual([
      "step:next",
      `jumpToRow:${WALKED_ROW_ID}`,
      "step:previous",
      `jumpToRow:${WALKED_ROW_ID}`,
    ]);
  });
});
