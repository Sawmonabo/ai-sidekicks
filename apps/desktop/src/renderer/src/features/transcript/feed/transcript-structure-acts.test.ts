// The acts the feed publishes, driven with no render. The refusal channel is watched too:
// a press that raised a banner over work it did would pass a trace alone.

import { afterEach, describe, expect, it } from "vitest";

import { type Refusal } from "@renderer/lib/refusal.js";
import { publishCommandRefusalSink } from "@renderer/registries/commands/command-refusal.js";
import { emptyFindResult } from "../find/find-model.js";
import { type TranscriptFindState } from "../find/hooks/useTranscriptFind.js";
import {
  buildTranscriptStructureActs,
  type TranscriptStructureActInputs,
} from "./transcript-structure-acts.js";

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
    beyondWindowMatchCount: 0,
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

function collectRaisedRefusals(): {
  readonly raised: Refusal[];
  readonly withdraw: () => void;
} {
  const raised: Refusal[] = [];
  const withdraw = publishCommandRefusalSink((refusal) => {
    raised.push(refusal);
  });
  return { raised, withdraw };
}

describe("the transcript's acts — what each one reaches", () => {
  it("opens the find field without touching its query", () => {
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace)).openFind();
    expect(trace).toStrictEqual(["open"]);
  });

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

  it("negative control: a walk that found nothing scrolls nowhere", () => {
    // Guards against an act that jumps on every press, with no match to land on.
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace)).stepFindNext();
    expect(trace).toStrictEqual(["step:next"]);
  });

  it("scrolls to the tail through the transcript's own scroll writer", () => {
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace)).jumpToLatest();
    expect(trace).toStrictEqual(["jumpToTail"]);
  });

  it("folds every terminal run group this feed has open", () => {
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace)).foldEveryRun();
    expect(trace).toStrictEqual(["collapseAllTerminalRunGroups"]);
  });

  it("fires nothing merely by being built", () => {
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace));
    expect(trace).toStrictEqual([]);
  });
});

describe("the transcript's acts — none of them refuses", () => {
  let withdrawSink: (() => void) | undefined;

  afterEach(() => {
    withdrawSink?.();
    withdrawSink = undefined;
  });

  it("folds the run groups rather than refusing over a control that now exists", () => {
    const trace: ActTrace = [];
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    buildTranscriptStructureActs(actInputs(trace)).foldEveryRun();
    expect(trace).toStrictEqual(["collapseAllTerminalRunGroups"]);
    expect(raised).toStrictEqual([]);
  });

  it("negative control: the acts that CAN act raise nothing", () => {
    // Guards against a build that answers every press with a banner.
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    const acts = buildTranscriptStructureActs(actInputs([], { walkedRowId: WALKED_ROW_ID }));
    acts.openFind();
    acts.stepFindNext();
    acts.jumpToLatest();
    acts.foldEveryRun();
    expect(raised).toStrictEqual([]);
  });
});
