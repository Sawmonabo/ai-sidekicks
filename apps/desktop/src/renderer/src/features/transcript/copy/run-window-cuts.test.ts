// A copy over a long run takes every call of it in reading order: each edge line of the run's
// window stands for the calls the window cut on its side, which the copy reads from the log
// unfolded, so Select All over a run that draws a stretch of its calls copies all of them.

import { describe, expect, it } from "vitest";

import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";
import { runEntitiesOf } from "#test/helpers/transcript/run-facts.js";
import { RunGroupFold } from "../feed/run-group-fold.js";
import { measuredRunWindowInputs } from "../feed/run-group-fold.test-support.js";
import { type RowRevealContextValue } from "../reveal/components/RowRevealProvider.js";
import { runWindowEdgeKey, type RunWindowMeasure } from "../runs/call-window.js";
import { longRunCallIds, longRunEvents, onlyRunGroupOf } from "../runs/call-window.test-support.js";
import { deriveTranscriptWindow } from "../window/transcript-window.js";
import { readRowText } from "./row-text.js";
import { rowKeysWithRunWindowCuts } from "./run-window-cuts.js";

/** Ten pixels a row on a hundred-pixel screen: the window draws a few dozen calls of the run. */
const MEASURE: RunWindowMeasure = { screenHeightPx: () => 100, rowHeightPx: () => 10 };

/** No live lane and nothing drawn kept: every row is read from the log. */
const REVEAL = {
  publishedTextFor: () => undefined,
  drawnReplyText: { drawnTextOf: () => undefined },
} as unknown as RowRevealContextValue;

describe("a copy over a long run's window", () => {
  it("copies every call the window cut, in reading order, in place of its edge lines", () => {
    const events = longRunEvents(445);
    const callIds = longRunCallIds(events);
    const unfurledWindow = deriveTranscriptWindow(events, runEntitiesOf(events));
    const runGroup = onlyRunGroupOf(unfurledWindow);
    const inputs = measuredRunWindowInputs(MEASURE);
    const fold = new RunGroupFold();
    fold.fold(unfurledWindow, new Set(), inputs);
    // A stretch opened from the newest calls, so the window cuts calls on both of its sides.
    inputs.windows.openStretch(runGroup, "earlier", MEASURE);
    const drawnWindow = fold.fold(unfurledWindow, new Set(), { ...inputs, moveCount: 1 }).window;
    const drawnKeys = drawnWindow.viewportRows.map((row) => row.key);
    expect(drawnKeys).toContain(runWindowEdgeKey(runGroup.key, "earlier"));
    expect(drawnKeys).toContain(runWindowEdgeKey(runGroup.key, "later"));
    expect(drawnKeys.filter((rowKey) => callIds.includes(rowKey)).length).toBeLessThan(
      callIds.length / 4,
    );

    // Select All runs across the header, both edge lines and the stretch between them.
    const copiedKeys = rowKeysWithRunWindowCuts(drawnKeys, drawnWindow);

    expect(copiedKeys.filter((rowKey) => callIds.includes(rowKey))).toStrictEqual(callIds);
    expect(copiedKeys.every((rowKey) => !rowKey.includes("#window-"))).toBe(true);
    // Each call, cut or drawn, reads its own tool's line from the log unfolded.
    for (const event of events.filter((logged) => callIds.includes(logged.id))) {
      const part = readRowText(event.id, {
        transcriptWindow: unfurledWindow,
        reveal: REVEAL,
        densityOf: () => "collapsed",
        fullBodyOf: () => undefined,
        clockLocale: "en-US",
        view: TASKS_AT_ONCE,
      });
      const text = part instanceof Promise ? expect.fail(`${event.id} reads at once`) : part?.text;
      expect(text, event.id).toMatch(new RegExp(`\\btool_${String(event.sequence)}\\b`));
    }
  });
});
