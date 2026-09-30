// The rows the cap took from this window, said out loud.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OVER_CAP_EVENT_COUNT,
  renderFeed,
  withLaidOutViewport,
} from "./TranscriptFeed.test-support.js";
import { openSessionStoreWithGeneralLog } from "../../transcript-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the transcript feed — what it does not hold", () => {
  it("names the rows the cap took", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(OVER_CAP_EVENT_COUNT));
    // The cap is a fact about the window and the feed states it; fetching rows the daemon still
    // holds is the viewport's backward read.
    expect(feed.textContent).toContain("Older entries are no longer in this window.");
  });
});
