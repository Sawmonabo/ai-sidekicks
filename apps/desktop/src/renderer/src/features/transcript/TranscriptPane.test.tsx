// What this pane hands its chrome: its own kind, the session its route names, the rows the
// registered renderer draws, and the two different absences (no open session, empty session).
// The frame itself is asserted beside `PaneFrame`; fixtures: `TranscriptPane.test-support.tsx`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "@renderer/store/session/session-store.js";
import {
  registerTranscriptRowRenderer,
  unregisterTranscriptRowRenderer,
} from "./transcript-row-renderer.js";
// The shared stub: `happy-dom` reports zero for both box readings, and a viewport with no
// box holds no rows.
import { withLaidOutViewport } from "./feed/components/TranscriptFeed.test-support.js";
import { type TranscriptPaneContext } from "./TranscriptPane.js";
import {
  TRANSCRIPT_PANE_SESSION_ID,
  openSessionStoreWithPaneLog,
  paneContext,
  renderTranscriptPane as renderPane,
} from "./TranscriptPane.test-support.js";

/** Every crumb the address contributed, without the pane's own name at the end. */
function addressCrumbs(pane: HTMLElement): readonly (string | null)[] {
  return [...pane.querySelectorAll(".meridian-pane__crumb:not(.meridian-pane__heading)")].map(
    (crumb) => crumb.textContent,
  );
}

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

describe("TranscriptPane — what it hands the chrome", () => {
  it("mounts at its own kind, so the head wears the transcript glyph and name", () => {
    const pane = renderPane({ context: paneContext() });
    // The chrome derives the glyph and name from the kind, so the kind is what this asserts.
    expect(pane.classList.contains("meridian-pane--transcript")).toBe(true);
    expect(pane.querySelector(".meridian-pane__heading")?.textContent).toBe("Transcript");
    expect(pane.querySelector(".meridian-pane__kind svg")).not.toBeNull();
  });

  it("hands over the session the route names", () => {
    const pane = renderPane({ context: paneContext() });
    expect(addressCrumbs(pane)).toStrictEqual([TRANSCRIPT_PANE_SESSION_ID]);
  });

  it("hands over no session at all rather than one the route does not name", () => {
    // The pane owes an honest absence here, not a placeholder it invented.
    const pane = renderPane({ context: paneContext({}, null) });
    expect(addressCrumbs(pane)).toStrictEqual([]);
  });
});

describe("TranscriptPane — the body", () => {
  it("says no session is open when the pane has no store", () => {
    const pane = renderPane({ context: paneContext() });
    const body = pane.querySelector(".meridian-pane__body");
    expect(body?.textContent).toContain("No session is open in this pane.");
    expect(pane.querySelector('[role="feed"]')).toBeNull();
  });

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

  it("negative control: the same store with no events shows the empty session", () => {
    registerTranscriptRowRenderer("transcript-pane-test", () => null);
    const sessionStore = new SessionStore({ sessionId: TRANSCRIPT_PANE_SESSION_ID });
    sessionStore.initialize({ cursor: -1, entities: [] });
    const pane = renderPane({
      context: paneContext({ sessionStore } as Partial<TranscriptPaneContext>),
    });
    expect(pane.textContent).toContain("Nothing has happened in this session yet.");
    expect(pane.querySelectorAll("[data-row-type]")).toHaveLength(0);
  });
});
