// The pane mounts the transcript and draws one row per admitted event. Fixtures:
// `TranscriptPane.test-support.tsx`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerTranscriptRowRenderer,
  unregisterTranscriptRowRenderer,
} from "./transcript-row-renderer.js";
// The shared stub: `happy-dom` reports zero for both box readings, and a viewport with no
// box holds no rows.
import { withLaidOutViewport } from "./feed/components/TranscriptFeed.test-support.js";
import { type TranscriptPaneContext } from "./TranscriptPane.js";
import {
  openSessionStoreWithPaneLog,
  paneContext,
  renderTranscriptPane as renderPane,
} from "./TranscriptPane.test-support.js";

beforeEach(() => {
  // The lazily loaded body registers the renderer before the pane renders, so each case
  // starts with one registered.
  registerTranscriptRowRenderer("transcript-pane-test", () => null);
});

afterEach(() => {
  // The registry is module-scope, so a case's renderer would leak into the next.
  unregisterTranscriptRowRenderer();
  vi.restoreAllMocks();
});

describe("TranscriptPane — the body", () => {
  it("mounts the transcript and renders one row per admitted event", () => {
    // Positive control: every earlier case is an absence, so a pane that rendered nothing
    // would pass them all.
    withLaidOutViewport();
    registerTranscriptRowRenderer("transcript-pane-test", (rowProps) => (
      <article data-row-type={rowProps.row.type}>{rowProps.row.summary}</article>
    ));
    const sessionStore = openSessionStoreWithPaneLog();
    const pane = renderPane({
      context: paneContext({ sessionStore } as Partial<TranscriptPaneContext>),
    });
    const feed = pane.querySelector('[role="feed"]');
    expect(feed).not.toBeNull();
    const rowTypes = [...pane.querySelectorAll("[data-row-type]")].map((row) =>
      row.getAttribute("data-row-type"),
    );
    expect(rowTypes).toStrictEqual(["session.created", "run.running"]);
    expect(pane.textContent).not.toContain("Nothing has happened in this session yet.");
  });
});
