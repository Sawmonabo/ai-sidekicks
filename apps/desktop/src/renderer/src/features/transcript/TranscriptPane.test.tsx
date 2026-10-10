// The pane mounts the transcript and draws one row per admitted event. Fixtures:
// `TranscriptPane.test-support.tsx`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerTranscriptRowRenderer } from "./rows/renderer.js";
// The shared stub: `happy-dom` reports zero for both box readings, and a viewport with no
// box holds no rows.
import { withLaidOutViewport } from "./viewport/controller.test-support.js";
import {
  openSessionStoreWithPaneLog,
  renderTranscriptPane as renderPane,
  transcriptPaneContext,
} from "./TranscriptPane.test-support.js";

beforeEach(() => {
  // The lazily loaded body registers the renderer before the pane renders, so each case
  // starts with one registered.
  registerTranscriptRowRenderer("transcript-pane-test", {
    render: () => null,
    drawsBody: () => true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TranscriptPane — the body", () => {
  it("mounts the transcript and renders one row per admitted event", () => {
    withLaidOutViewport();
    registerTranscriptRowRenderer("transcript-pane-test", {
      render: (rowProps) => (
        <article data-row-type={rowProps.row.type}>{rowProps.row.summary}</article>
      ),
      drawsBody: () => true,
    });
    const sessionStore = openSessionStoreWithPaneLog();
    const pane = renderPane({
      context: transcriptPaneContext(sessionStore),
    });
    const feed = pane.querySelector('[role="feed"]');
    expect(feed).not.toBeNull();
    const rowTypes = [...pane.querySelectorAll("[data-row-type]")].map((row) =>
      row.getAttribute("data-row-type"),
    );
    expect(rowTypes).toStrictEqual(["session.created", "run.running"]);
    expect(pane.textContent).not.toContain("No messages yet. Say what you are after.");
  });
});
