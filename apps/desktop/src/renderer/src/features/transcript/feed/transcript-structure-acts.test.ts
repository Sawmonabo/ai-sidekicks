// The acts the feed publishes, driven with no render at all.
//
// Every case below invokes an act and watches what it reached. That is the whole
// property: the palette and the session header both resolve their target at press time,
// so the only thing that can be wrong is which of the feed's own callbacks an act
// runs — and none of them needs a DOM to check. No act refuses, so the refusal channel
// is watched too: a press that raised a banner over work it did would pass a trace alone.

import { afterEach, describe, expect, it } from "vitest";

import { type ConsoleRefusal } from "@renderer/lib/refusal.js";
import { publishCommandRefusalSink } from "@renderer/registries/commands/command-refusal.js";
import { emptyFindResult } from "../find/find-model.js";
import { type TranscriptFindState } from "../find/hooks/useTranscriptFind.js";
import {
  buildTranscriptStructureActs,
  type TranscriptStructureActInputs,
} from "./transcript-structure-acts.js";

/** What one case watched happen, in the order it happened. */
type ActTrace = string[];

/** The row a stubbed walk lands on, so a jump can be told from a walk that found nothing. */
const WALKED_ROW_ID = "row-the-walk-found";

/**
 * A find state whose members record rather than derive.
 *
 * `useTranscriptFind`'s real behaviour is `useTranscriptFind.test.ts`'; what matters
 * here is which member an act calls, which a recording stand-in answers and a real
 * hook would only obscure.
 */
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

/** One window's act inputs, with every seam recording into `trace`. */
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
    collapseAllTerminalChapters: () => {
      trace.push("collapseAllTerminalChapters");
    },
  };
}

/** Every refusal raised on the frame's channel for the length of one case. */
function collectRaisedRefusals(): {
  readonly raised: ConsoleRefusal[];
  readonly withdraw: () => void;
} {
  const raised: ConsoleRefusal[] = [];
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
    // Without this the case above would pass over an act that jumped on every
    // press — which, with no match to land on, is a scroll to a row id nobody
    // produced and a reader moved for no reason.
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace)).stepFindNext();
    expect(trace).toStrictEqual(["step:next"]);
  });

  it("scrolls to the tail through the transcript's own scroll writer", () => {
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace)).jumpToLatest();
    expect(trace).toStrictEqual(["jumpToTail"]);
  });

  it("folds every terminal chapter this feed has open", () => {
    const trace: ActTrace = [];
    buildTranscriptStructureActs(actInputs(trace)).foldEveryRun();
    expect(trace).toStrictEqual(["collapseAllTerminalChapters"]);
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

  it("folds the chapters rather than refusing over a control that now exists", () => {
    // The refusal this replaces said every finished chapter was already folded and
    // no control opened one. Both halves are false now that a chapter header is a
    // disclosure, so the press does the fold and raises nothing.
    const trace: ActTrace = [];
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    buildTranscriptStructureActs(actInputs(trace)).foldEveryRun();
    expect(trace).toStrictEqual(["collapseAllTerminalChapters"]);
    expect(raised).toStrictEqual([]);
  });

  it("negative control: the acts that CAN act raise nothing", () => {
    // Without this the case above would pass over a build that answered every
    // press with a banner, which would state a refusal over work that was done.
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
