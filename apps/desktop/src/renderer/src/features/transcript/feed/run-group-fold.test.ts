// The run group fold, driven with no store and no React: the headers it stands, the folds a
// person holds, and the window of a long run it lets through.

import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { RunGroupFold } from "./run-group-fold.js";
import { measuredRunWindowInputs, wholeRunWindowInputs } from "./run-group-fold.test-support.js";
import { runWindowEdgeKey, type RunWindowMeasure } from "../runs/call-window.js";
import { longRunCallIds, longRunEvents, onlyRunGroupOf } from "../runs/call-window.test-support.js";
import { useTranscriptFolds, type TranscriptFolds } from "./hooks/useTranscriptFolds.js";
import { transcriptFixtureStampAt, transcriptFixtureStreamCursor } from "../logs.test-support.js";
import {
  TranscriptWindowDerivation,
  deriveTranscriptWindow,
  type TranscriptWindowModel,
} from "../window/transcript-window.js";
import { runEntitiesOf } from "#test/helpers/transcript/run-facts.js";

const SESSION_ID = "session-run-group-cap";
const RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
const OTHER_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150222";
/** A run group's key, opaque to the folds a person holds. */
const RUN_GROUP_KEY = "run-group-folded-by-the-reader";

// One finished run of `memberCount` rows, alone, so every figure below is that run's.
function oneRunLog(memberCount: number): readonly ProjectedSessionEvent[] {
  return runLog(
    Array.from({ length: memberCount }, (_unused, index) =>
      index === memberCount - 1 ? "run.completed" : "assistant.message",
    ),
  );
}

/** One run's events of `kinds`, in order. */
function runLog(kinds: readonly string[]): readonly ProjectedSessionEvent[] {
  return eventsOf(
    kinds.map((kind, index) => ({ id: `event-${String(index)}`, kind, runId: RUN_ID })),
  );
}

/** The events of `rows`, in order, each of its own kind and run. */
function eventsOf(
  rows: readonly { readonly id: string; readonly kind: string; readonly runId: string }[],
): readonly ProjectedSessionEvent[] {
  return rows.map((row, index) => ({
    id: row.id,
    sessionId: SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind: row.kind,
    occurredAt: transcriptFixtureStampAt(index),
    payload: { sessionId: SESSION_ID, runId: row.runId },
    runStamp: { position: index, epoch: 0 },
  }));
}

/** The key of the one run group a window of one unbroken run holds. */
function onlyRunGroupKey(model: TranscriptWindowModel): string {
  const [runGroupKey, ...others] = model.runGroupByHeaderKey.keys();
  if (runGroupKey === undefined || others.length > 0) {
    throw new Error("the window does not hold exactly one run group");
  }
  return runGroupKey;
}

describe("a long run's window in the outer list", () => {
  /** Ten pixels a row on a hundred-pixel screen: five screens hold fifty calls. */
  const MEASURE: RunWindowMeasure = { screenHeightPx: () => 100, rowHeightPx: () => 10 };

  it("puts the window's rows in the outer list between its two edge lines", () => {
    const events = longRunEvents(120);
    const model = deriveTranscriptWindow(events, runEntitiesOf(events));
    const runGroup = onlyRunGroupOf(model);
    const inputs = measuredRunWindowInputs(MEASURE);
    const fold = new RunGroupFold();
    fold.fold(model, new Set(), inputs);
    inputs.windows.openStretch(runGroup, "earlier", MEASURE);

    const folded = fold.fold(model, new Set(), { ...inputs, moveCount: 1 });

    const callIds = longRunCallIds(events);
    const window = inputs.windows.resolvedWindowOf(runGroup.key);
    expect(window?.earlierCount).toBeGreaterThan(0);
    expect(window?.laterCount).toBeGreaterThan(0);
    const firstCallId = callIds[window?.earlierCount ?? 0] ?? "";
    const lastCallId = callIds[callIds.length - (window?.laterCount ?? 0) - 1] ?? "";
    const windowRowIds = runGroup.rowIds.slice(
      runGroup.rowIds.indexOf(firstCallId),
      runGroup.rowIds.indexOf(lastCallId) + 1,
    );
    expect(folded.window.viewportRows.map((row) => row.key)).toStrictEqual([
      runGroup.key,
      runWindowEdgeKey(runGroup.key, "earlier"),
      ...windowRowIds,
      runWindowEdgeKey(runGroup.key, "later"),
    ]);
    expect(folded.removedRows.map((row) => row.id)).toStrictEqual(
      runGroup.rowIds.filter((rowId) => !windowRowIds.includes(rowId)),
    );
  });

  it("folds a run's growth in place as it would fold the grown log whole", () => {
    // Past the let-go distance, so the growth lets the window's oldest calls go.
    const events = longRunEvents(160);
    const derivation = new TranscriptWindowDerivation();
    const inputs = measuredRunWindowInputs(MEASURE);
    const fold = new RunGroupFold();
    fold.fold(derivation.derive(events.slice(0, 120), runEntitiesOf(events)), new Set(), inputs);

    const grownModel = derivation.derive(events, runEntitiesOf(events));
    const grown = fold.fold(grownModel, new Set(), inputs);
    const whole = new RunGroupFold().fold(grownModel, new Set(), inputs);

    expect(grown.window.viewportRows.map((row) => row.key)).toStrictEqual(
      whole.window.viewportRows.map((row) => row.key),
    );
    expect(grown.removedRows.map((row) => row.id)).toStrictEqual(
      whole.removedRows.map((row) => row.id),
    );
    expect(grown.removedRows.length).toBeGreaterThan(0);
  });
});

describe("a person's fold stays with its stretch as the window around it moves", () => {
  const STRETCH_ROW_COUNT = 10;
  const ROWS_OUTSIDE_THE_WINDOW = 4;

  /** Whether the fold under `foldedRunGroupKeys` shows the stretch as its header alone. */
  function isFoldedAway(
    model: TranscriptWindowModel,
    foldedRunGroupKeys: ReadonlySet<string>,
  ): boolean {
    const folded = new RunGroupFold().fold(
      model,
      foldedRunGroupKeys,
      wholeRunWindowInputs(),
    ).window;
    return folded.rows.length === 0 && folded.viewportRows.length === 1;
  }

  it("stays folded when a page of the stretch's older rows lands before it", () => {
    const log = oneRunLog(STRETCH_ROW_COUNT);
    const derivation = new TranscriptWindowDerivation();
    const folded = new Set([
      onlyRunGroupKey(derivation.derive(log.slice(ROWS_OUTSIDE_THE_WINDOW), runEntitiesOf(log))),
    ]);

    expect(isFoldedAway(derivation.derive(log, runEntitiesOf(log)), folded)).toBe(true);
  });

  it("stays folded when the stretch's first rows are let go", () => {
    const log = oneRunLog(STRETCH_ROW_COUNT);
    const derivation = new TranscriptWindowDerivation();
    const folded = new Set([onlyRunGroupKey(derivation.derive(log, runEntitiesOf(log)))]);

    expect(
      isFoldedAway(
        derivation.derive(log.slice(ROWS_OUTSIDE_THE_WINDOW), runEntitiesOf(log)),
        folded,
      ),
    ).toBe(true);
  });

  // The run's reply, its running row that draws nothing, another agent's reply, then two more of
  // the run's replies: two stretches of the run, which the running row may sit in either of.
  const twoStretchLog = eventsOf([
    { id: "reply-1", kind: "assistant.message", runId: RUN_ID },
    { id: "running", kind: "run.running", runId: RUN_ID },
    { id: "other-reply", kind: "assistant.message", runId: OTHER_RUN_ID },
    { id: "reply-2", kind: "assistant.message", runId: RUN_ID },
    { id: "reply-3", kind: "assistant.message", runId: RUN_ID },
  ]);

  /** The key of the stretch `rowId` sits in, or throws where it sits in none. */
  function stretchKeyOf(model: TranscriptWindowModel, rowId: string): string {
    const runGroupKey = model.runGroupKeyByRowId.get(rowId);
    if (runGroupKey === undefined) {
      throw new Error(`${rowId} sits in no run group`);
    }
    return runGroupKey;
  }

  /** The rows the fold under `foldedRunGroupKeys` hides, by id. */
  function foldedAwayRowIds(
    model: TranscriptWindowModel,
    foldedRunGroupKeys: ReadonlySet<string>,
  ): readonly string[] {
    return new RunGroupFold()
      .fold(model, foldedRunGroupKeys, wholeRunWindowInputs())
      .removedRows.map((row) => row.id);
  }

  it("keeps two stretches apart when pages land through a row that draws nothing", () => {
    const log = eventsOf([
      { id: "reply-1", kind: "assistant.message", runId: RUN_ID },
      { id: "other-reply", kind: "assistant.message", runId: OTHER_RUN_ID },
      { id: "running", kind: "run.running", runId: RUN_ID },
      { id: "reply-2", kind: "assistant.message", runId: RUN_ID },
    ]);
    const derivation = new TranscriptWindowDerivation();
    const folded = new Set([
      stretchKeyOf(derivation.derive(log.slice(3), runEntitiesOf(log)), "reply-2"),
    ]);
    derivation.derive(log.slice(2), runEntitiesOf(log));
    const model = derivation.derive(log, runEntitiesOf(log));

    // Both of the run's stretches and the other agent's reply each stand under a header.
    expect(model.runGroupByHeaderKey.size).toBe(3);
    expect(foldedAwayRowIds(model, folded)).toStrictEqual(["reply-2"]);
  });

  it("keeps a fold on its stretch when an earlier stretch of the run is let go", () => {
    const derivation = new TranscriptWindowDerivation();
    const whole = derivation.derive(twoStretchLog, runEntitiesOf(twoStretchLog));
    const foldedEarlier = new Set([stretchKeyOf(whole, "reply-1")]);
    const foldedLater = new Set([stretchKeyOf(whole, "reply-2")]);
    const released = derivation.derive(twoStretchLog.slice(1), runEntitiesOf(twoStretchLog));

    expect(foldedAwayRowIds(released, foldedLater)).toStrictEqual([
      "running",
      "reply-2",
      "reply-3",
    ]);
    expect(foldedAwayRowIds(released, foldedEarlier)).toStrictEqual([]);
  });

  it("keeps a fold on its stretch when an earlier stretch of the run lands before it", () => {
    const derivation = new TranscriptWindowDerivation();
    const folded = new Set([
      stretchKeyOf(
        derivation.derive(twoStretchLog.slice(1), runEntitiesOf(twoStretchLog)),
        "reply-2",
      ),
    ]);

    expect(
      foldedAwayRowIds(derivation.derive(twoStretchLog, runEntitiesOf(twoStretchLog)), folded),
    ).toStrictEqual(["reply-2", "reply-3"]);
  });
});

describe("a run with nothing drawn has no header", () => {
  it("stands no header over a run until its first card, then one above that card", () => {
    const log = runLog(["run.queued", "run.running", "assistant.message", "run.completed"]);

    const started = deriveTranscriptWindow(log.slice(0, 2), runEntitiesOf(log));
    expect(started.runGroupByHeaderKey.size).toBe(0);
    expect(
      new RunGroupFold().fold(started, new Set(), wholeRunWindowInputs()).window.viewportRows,
    ).toStrictEqual(started.viewportRows);

    const replied = deriveTranscriptWindow(log, runEntitiesOf(log));
    const keys = new RunGroupFold()
      .fold(replied, new Set(), wholeRunWindowInputs())
      .window.viewportRows.map((row) => row.key);
    const runGroupKey = onlyRunGroupKey(replied);
    expect(keys).toStrictEqual(["event-0", "event-1", runGroupKey, "event-2", "event-3"]);
  });
});

describe("the run group folds follow the session the pane is a log of", () => {
  const OTHER_SESSION_ID = "session-the-reader-moved-to";

  // The pane is not remounted between sessions: open session stores stay alive, so
  // navigating re-renders this position.
  function mountFolds(): ReturnType<
    typeof renderHook<TranscriptFolds, { readonly sessionId: string }>
  > {
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    return renderHook(
      (props: { readonly sessionId: string }) => useTranscriptFolds(props.sessionId),
      {
        initialProps: { sessionId: SESSION_ID },
        wrapper: ({ children }: { readonly children?: React.ReactNode }) =>
          createElement(FixtureBridgeProvider, { fixture, children }),
      },
    );
  }

  it("opens the next session's run groups, whatever was folded in the last", () => {
    const folds = mountFolds();
    act(() => {
      folds.result.current.toggleRunGroup(RUN_GROUP_KEY);
    });
    expect([...folds.result.current.foldedRunGroupKeys]).toStrictEqual([RUN_GROUP_KEY]);

    act(() => {
      folds.rerender({ sessionId: OTHER_SESSION_ID });
    });

    // A run group belongs to the session whose log holds it; carrying the set over folds the wrong
    // group.
    expect([...folds.result.current.foldedRunGroupKeys]).toStrictEqual([]);
  });

  it("holds a session's own folds across a re-render at that same session", () => {
    // Guards against a fix that resets on every render, opening a group whenever a row arrives.
    const folds = mountFolds();
    act(() => {
      folds.result.current.toggleRunGroup(RUN_GROUP_KEY);
    });

    act(() => {
      folds.rerender({ sessionId: SESSION_ID });
    });

    expect([...folds.result.current.foldedRunGroupKeys]).toStrictEqual([RUN_GROUP_KEY]);
  });
});
