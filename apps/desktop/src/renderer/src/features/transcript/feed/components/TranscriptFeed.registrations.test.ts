// The mounted-transcript holder this mount fills: a command contributed at composition time
// reaches a feed mounted later.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHORT_LOG_EVENT_COUNT,
  contributeTranscriptCommands,
  dispatchCommand,
  renderFeed,
  withdrawTranscriptCommands,
} from "./TranscriptFeed.test-support.js";
import { withLaidOutViewport } from "../../viewport/viewport-controller.test-support.js";
import { openSessionStoreWithFeedLog } from "../../transcript-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the transcript feed — the palette acts on the mounted feed", () => {
  afterEach(() => {
    withdrawTranscriptCommands();
  });

  it("opens this feed's find field when the palette's find row is run", () => {
    withLaidOutViewport();
    contributeTranscriptCommands();
    const feed = renderFeed(openSessionStoreWithFeedLog(SHORT_LOG_EVENT_COUNT));
    expect(feed.querySelector(".meridian-find")).toBeNull();
    dispatchCommand("transcript.find");
    expect(feed.querySelector(".meridian-find")).not.toBeNull();
  });
});
