// The dispatch for a key the window no longer holds, driven directly rather than through a
// mounted feed, so the case does not depend on the viewport's cap and reconcile.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type RetainedRowState } from "../../viewport/retained-row-state-table.js";
import { type ViewportRow } from "../../viewport/snapshot.js";
import { foldRunGroupHeaders } from "../run-group-fold.js";
import {
  TranscriptRowDispatch,
  type TranscriptRowDispatchOptions,
} from "./TranscriptRowDispatch.js";
import { TERMINAL_RUN_ID } from "../../logs.test-support.js";
import { openSessionStoreWithTerminalRunGroup } from "../../runs/groups.logs.test-support.js";
import {
  deriveTranscriptWindow,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

/** A viewport row is a key and its place in the list; the dispatch reads the key. */
function viewportRowFor(transcriptWindow: TranscriptWindowModel, key: string): ViewportRow {
  const row = transcriptWindow.viewportRows.find((candidate) => candidate.key === key);
  if (row === undefined) {
    throw new Error(`the fixture window holds no viewport row keyed ${key}`);
  }
  return row;
}

/** The options every case starts from, over one folded window. */
function rendererOptions(
  transcriptWindow: TranscriptWindowModel,
  overrides: Partial<TranscriptRowDispatchOptions> = {},
): TranscriptRowDispatchOptions {
  return {
    transcriptWindow,
    openedTerminalRunIds: new Set<string>(),
    hueForAgent: () => undefined,
    toggleRunGroup: () => undefined,
    retainedRowState: (): RetainedRowState | undefined => undefined,
    renderTranscriptRow: () => <output data-rendered-row="yes" />,
    ...overrides,
  };
}

describe("the feed's row dispatch — a key the window no longer holds", () => {
  /** The run-grouped fixture, shut, which is what puts a header key in the list. */
  function foldedRunGroupWindow(): TranscriptWindowModel {
    const sessionStore = openSessionStoreWithTerminalRunGroup();
    return foldRunGroupHeaders(
      deriveTranscriptWindow(sessionStore.snapshot().transcript),
      new Set<string>(),
    ).window;
  }

  it("names a row the window no longer holds rather than drawing a blank band", () => {
    // The window moved under the viewport between its reconcile and this paint; a blank would
    // read as an empty row, and this is a fact about the cap.
    const transcriptWindow = foldedRunGroupWindow();
    const vanished = viewportRowFor(transcriptWindow, TERMINAL_RUN_ID);
    const rowRendererCalls = vi.fn(() => <output data-rendered-row="yes" />);
    const { container } = render(
      <TranscriptRowDispatch
        row={vanished}
        // A window with neither the header nor any projected row under that key.
        {...rendererOptions(deriveTranscriptWindow([]), { renderTranscriptRow: rowRendererCalls })}
      />,
      { wrapper: LiveAnnouncerProvider },
    );

    expect(container.textContent).toContain("This entry is no longer loaded.");
    expect(rowRendererCalls).not.toHaveBeenCalled();
  });
});
