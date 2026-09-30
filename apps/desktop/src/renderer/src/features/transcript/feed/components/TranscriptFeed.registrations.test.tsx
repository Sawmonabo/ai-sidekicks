// The mounted-transcript holder this mount fills: a command contributed at composition time
// reaches a feed mounted later, and an unmounted feed says so instead of doing nothing.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../../fixtures/scenarios/empty-session.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { publishCommandRefusalSink } from "@renderer/registries/commands/command-refusal.js";
import { TranscriptFeed } from "./TranscriptFeed.js";
import {
  SHORT_LOG_EVENT_COUNT,
  contributeTranscriptCommands,
  dispatchCommand,
  renderFeed,
  withdrawTranscriptCommands,
  withLaidOutViewport,
} from "./TranscriptFeed.test-support.js";
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

  it("puts the caret in the field the palette opened, and gives it back on Escape", () => {
    // The chord's point is that the next keystroke enters the query; the field is the only thing
    // in the feed that holds a caret without scrolling the log.
    withLaidOutViewport();
    contributeTranscriptCommands();
    const feed = renderFeed(openSessionStoreWithFeedLog(SHORT_LOG_EVENT_COUNT));
    dispatchCommand("transcript.find");
    const input = feed.querySelector<HTMLInputElement>(".meridian-find__input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    act(() => {
      fireEvent.keyDown(input as HTMLInputElement, { key: "Escape" });
    });
    expect(feed.querySelector(".meridian-find")).toBeNull();
    // Not `body`: the log is where the reader was, and it is focusable for this reason.
    expect(document.activeElement).toBe(
      feed.querySelector(".meridian-transcript-viewport__scroll-container"),
    );
  });

  it("states the holder's refusal when the same row is run with no transcript up", () => {
    // The other half of the seam: the command lives for the window and the feed does not, so the
    // press must say so.
    contributeTranscriptCommands();
    const raised: Refusal[] = [];
    const withdrawSink = publishCommandRefusalSink((refusal) => {
      raised.push(refusal);
    });
    dispatchCommand("transcript.find");
    expect(raised.map((refusal) => refusal.code)).toStrictEqual([
      "transcript.no_mounted_transcript",
    ]);
    withdrawSink();
  });

  it("negative control: an unmounted feed releases the holder it filled", () => {
    // Without this the case above would pass over a feed that never filled the holder.
    withLaidOutViewport();
    contributeTranscriptCommands();
    const raisedWhileMounted: Refusal[] = [];
    const withdrawSink = publishCommandRefusalSink((refusal) => {
      raisedWhileMounted.push(refusal);
    });
    const mounted = render(
      <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
        <TranscriptFeed
          sessionStore={openSessionStoreWithFeedLog(SHORT_LOG_EVENT_COUNT)}
          renderTranscriptRow={(mount) => <p>{mount.row.summary}</p>}
          feedLabel="Transcript"
        />
      </FixtureBridgeProvider>,
    );
    dispatchCommand("transcript.find");
    expect(raisedWhileMounted).toStrictEqual([]);
    mounted.unmount();
    dispatchCommand("transcript.find");
    expect(raisedWhileMounted.map((refusal) => refusal.code)).toStrictEqual([
      "transcript.no_mounted_transcript",
    ]);
    withdrawSink();
  });
});
