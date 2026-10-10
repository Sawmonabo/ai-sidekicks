// The dispatch for a key the window no longer holds and for an edge of a long run's window, driven
// directly rather than through a mounted feed, so the cases do not depend on the viewport's cap
// and reconcile.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type ViewportRow } from "../../viewport/snapshot.js";
import { RunGroupFold } from "../run-group-fold.js";
import { measuredRunWindowInputs, wholeRunWindowInputs } from "../run-group-fold.test-support.js";
import { RunCallWindows, runWindowEdgeKey } from "../../runs/call-window.js";
import {
  longRunCallIds,
  longRunEvents,
  onlyRunGroupOf,
} from "../../runs/call-window.test-support.js";
import {
  TranscriptRowDispatch,
  type TranscriptRowDispatchOptions,
} from "./TranscriptRowDispatch.js";
import { TERMINAL_RUN_ID } from "../../logs.test-support.js";
import { openSessionStoreWithTerminalRunGroup } from "../../runs/groups.logs.test-support.js";
import { findRunGroup } from "../../runs/groups.test-support.js";
import {
  deriveTranscriptWindow,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { drawnText } from "#test/helpers/live-region.js";
import { runEntitiesOf } from "#test/helpers/transcript/run-facts.js";

/** A viewport row is a key and its place in the list; the dispatch reads the key. */
function viewportRowFor(transcriptWindow: TranscriptWindowModel, key: string): ViewportRow {
  const row = transcriptWindow.viewportRows.find((candidate) => candidate.key === key);
  if (row === undefined) {
    throw new Error(`the fixture window holds no viewport row keyed ${key}`);
  }
  return row;
}

/** The options every case starts from, over one window. */
function rendererOptions(
  transcriptWindow: TranscriptWindowModel,
  overrides: Partial<TranscriptRowDispatchOptions> = {},
): TranscriptRowDispatchOptions {
  return {
    transcriptWindow,
    foldedRunGroupKeys: new Set<string>(),
    foldedCallRowIds: new Set<string>(),
    openedOutputRowIds: new Set<string>(),
    hueForAgent: () => undefined,
    toggleRunGroup: () => undefined,
    runCallWindows: new RunCallWindows(),
    openRunStretch: () => undefined,
    renderTranscriptRow: () => <output data-rendered-row="yes" />,
    ...overrides,
  };
}

describe("the feed's row dispatch — a key the window no longer holds", () => {
  /** The run-grouped fixture, whose group puts a header key in the list. */
  function runGroupWindow(): TranscriptWindowModel {
    const sessionStore = openSessionStoreWithTerminalRunGroup();
    return new RunGroupFold().fold(
      deriveTranscriptWindow(
        sessionStore.snapshot().transcript,
        sessionStore.snapshot().partitions.run,
      ),
      new Set<string>(),
      wholeRunWindowInputs(),
    ).window;
  }

  it("names a row the window no longer holds rather than drawing a blank band", () => {
    // The window moved under the viewport between its reconcile and this paint; a blank would
    // read as an empty row, and this is a fact about the cap.
    const transcriptWindow = runGroupWindow();
    const vanished = viewportRowFor(
      transcriptWindow,
      findRunGroup([...transcriptWindow.runGroupByHeaderKey.values()], TERMINAL_RUN_ID).key,
    );
    const rowRendererCalls = vi.fn(() => <output data-rendered-row="yes" />);
    const { container } = render(
      <TranscriptRowDispatch
        row={vanished}
        // A window with neither the header nor any projected row under that key.
        {...rendererOptions(deriveTranscriptWindow([], {}), {
          renderTranscriptRow: rowRendererCalls,
        })}
      />,
      { wrapper: LiveAnnouncerProvider },
    );

    expect(drawnText(container)).toContain("This entry is no longer loaded.");
    expect(rowRendererCalls).not.toHaveBeenCalled();
  });
});

describe("the feed's row dispatch — the edges of a long run's window", () => {
  it("counts the run's calls beyond each edge, and not the rows that draw nothing", () => {
    const events = longRunEvents(120);
    const model = deriveTranscriptWindow(events, runEntitiesOf(events));
    const runGroup = onlyRunGroupOf(model);
    // Ten pixels a call on a hundred-pixel screen, so the window holds fifty calls.
    const measure = { screenHeightPx: () => 100, rowHeightPx: () => 10 };
    const inputs = measuredRunWindowInputs(measure);
    inputs.windows.windowOf(runGroup, measure);
    inputs.windows.openStretch(runGroup, "earlier", measure);
    const transcriptWindow = new RunGroupFold().fold(model, new Set(), inputs).window;
    const admittedIds = new Set(transcriptWindow.rows.map((row) => row.id));
    const callIds = longRunCallIds(events);
    const firstAdmitted = callIds.findIndex((callId) => admittedIds.has(callId));
    const lastAdmitted = callIds.findLastIndex((callId) => admittedIds.has(callId));

    const edgeText = (edge: "earlier" | "later"): string => {
      const { container } = render(
        <TranscriptRowDispatch
          row={viewportRowFor(transcriptWindow, runWindowEdgeKey(runGroup.key, edge))}
          {...rendererOptions(transcriptWindow, { runCallWindows: inputs.windows })}
        />,
      );
      return drawnText(container);
    };

    expect(firstAdmitted).toBeGreaterThan(0);
    expect(lastAdmitted).toBeLessThan(callIds.length - 1);
    expect(edgeText("earlier")).toBe(`· · · ${String(firstAdmitted)} earlier`);
    expect(edgeText("later")).toBe(`· · · ${String(callIds.length - 1 - lastAdmitted)} later`);
  });
});
