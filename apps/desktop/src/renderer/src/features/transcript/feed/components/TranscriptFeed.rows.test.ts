// What a row is in the mounted feed: a system message, the row renderer's, or nothing at all.
// Every case drives the composed feed, because each pinned model (drawn rows, system message
// classification) is derived on every pass and has to reach a component. How a run group and a
// call fold is `TranscriptFeed.fold.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderFeed } from "./TranscriptFeed.test-support.js";
import { withLaidOutViewport } from "../../viewport/controller.test-support.js";
import {
  openSessionStoreWithGeneralLog,
  transcriptFixtureEventId,
} from "../../logs.test-support.js";
import { openSessionStoreWithSystemMessage } from "../../runs/groups.logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const VIEWPORT_ROW = ".meridian-transcript-viewport__row";

describe("the transcript feed — a system message is the transcript's own row", () => {
  it("draws a compaction as a system message rather than delegating it to the row renderer", () => {
    withLaidOutViewport();
    const rendererRowTypes: string[] = [];
    const feed = renderFeed(openSessionStoreWithSystemMessage(), (mount) => {
      rendererRowTypes.push(mount.row.type);
    });
    const systemMessageLine = feed.querySelector(".meridian-system-message");
    expect(systemMessageLine).not.toBeNull();
    expect(systemMessageLine?.textContent).toContain("Context compacted");
    expect(rendererRowTypes).not.toContain("usage.context_compacted");
  });
});

describe("the transcript feed — a row the renderer draws nothing for", () => {
  it("takes no place in the list and is not counted as a row the cap took", () => {
    withLaidOutViewport();
    const undrawnRowId = transcriptFixtureEventId(2);
    const renderedRowIds: string[] = [];
    const feed = renderFeed(
      openSessionStoreWithGeneralLog(5),
      (mount) => {
        renderedRowIds.push(mount.row.id);
      },
      undefined,
      { drawsBody: (row) => row.id !== undrawnRowId },
    );
    const listedRows = feed.querySelectorAll(VIEWPORT_ROW);
    expect(listedRows).toHaveLength(4);
    // The list's own count, which a blank row would still have taken a place in.
    expect(listedRows[0]?.getAttribute("aria-setsize")).toBe("4");
    expect(renderedRowIds).not.toContain(undrawnRowId);
    expect(feed.textContent).not.toContain("Older entries are no longer in this window.");
  });
});
