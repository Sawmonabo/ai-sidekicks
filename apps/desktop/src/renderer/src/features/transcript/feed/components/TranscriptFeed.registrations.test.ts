// The mounted-transcript holder this mount fills: a command contributed at composition time
// reaches a feed mounted later.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishCommandWindow } from "#renderer/registries/commands/command-window.js";
import {
  SHORT_LOG_EVENT_COUNT,
  contributeTranscriptCommands,
  dispatchCommand,
  renderFeed,
  withdrawTranscriptCommands,
} from "./TranscriptFeed.test-support.js";
import { withLaidOutViewport } from "../../viewport/controller.test-support.js";
import { openSessionStoreWithFeedLog } from "../../logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// A command acts in the window used last; the test's document stands in for it.
beforeEach(() => publishCommandWindow(() => document));

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
