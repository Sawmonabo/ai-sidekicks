// The dispatch for a key the window no longer holds, driven directly rather than through a
// mounted feed, so the case does not depend on the viewport's cap and reconcile.

import { render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type RetainedRowState } from "../../viewport/retained-row-state-table.js";
import { type ViewportRow } from "../../viewport/viewport-snapshot.js";
import { foldRunGroupHeaders } from "../run-group-fold.js";
import {
  useTranscriptRowRenderer,
  type TranscriptRowRendererOptions,
} from "../hooks/useTranscriptRowRenderer.js";
import { TERMINAL_RUN_ID } from "../../transcript-logs.test-support.js";
import { openSessionStoreWithTerminalRunGroup } from "../../run-group-logs.test-support.js";
import {
  deriveTranscriptWindow,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";

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
  overrides: Partial<TranscriptRowRendererOptions> = {},
): TranscriptRowRendererOptions {
  return {
    transcriptWindow,
    openedTerminalRunIds: new Set<string>(),
    hueForActor: () => undefined,
    toggleRunGroup: () => undefined,
    rowLease: (): RetainedRowState | undefined => undefined,
    renderTranscriptRow: () => <output data-rendered-row="yes" />,
    ...overrides,
  };
}

describe("the feed's row dispatch — which of the four a key is", () => {
  /** The run-grouped fixture, shut, which is what puts a header key in the list. */
  function foldedRunGroupWindow(): TranscriptWindowModel {
    const sessionStore = openSessionStoreWithTerminalRunGroup();
    return foldRunGroupHeaders(
      deriveTranscriptWindow(sessionStore.snapshot().timeline),
      new Set<string>(),
    ).window;
  }

  it("names a row the window no longer holds rather than drawing a blank band", () => {
    // The window moved under the viewport between its reconcile and this paint; a blank would
    // read as an empty row, and this is a fact about the cap.
    const transcriptWindow = foldedRunGroupWindow();
    const vanished = viewportRowFor(transcriptWindow, TERMINAL_RUN_ID);
    const rowRendererCalls = vi.fn(() => <output data-rendered-row="yes" />);
    const { result } = renderHook(() =>
      useTranscriptRowRenderer(
        rendererOptions(
          // A window with neither the header nor any projected row under that key.
          deriveTranscriptWindow([]),
          { renderTranscriptRow: rowRendererCalls },
        ),
      ),
    );
    const { container } = render(<>{result.current(vanished)}</>);

    expect(container.textContent).toContain("This entry is no longer loaded.");
    expect(rowRendererCalls).not.toHaveBeenCalled();
  });
});
