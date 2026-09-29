// The seat this mount claims for a caller composed before it existed.
//
// The palette's chords resolve their target at press time and are reached through a
// seat rather than an import. The property here is that a command contributed at
// COMPOSITION time reaches a feed mounted later, and that an unmounted feed says so
// instead of doing nothing.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../../fixtures/scenarios/empty-session.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { publishCommandRefusalSink } from "@renderer/registries/commands/command-refusal.js";
import { TranscriptFeed } from "./TranscriptFeed.js";
import {
  TRANSCRIPT_FIXTURE_PANE_ID,
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

describe("the ledger feed — the palette acts on the mounted feed", () => {
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
    // The chord's whole point is that the next keystroke enters the query, and the
    // field is the only thing on this surface that can hold a caret without
    // scrolling the log. Before this focus stayed on the ledger or the palette.
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
    // Not `body`: the log is where the reader was, and it is focusable for exactly
    // this reason.
    expect(document.activeElement).toBe(
      feed.querySelector(".meridian-transcript-viewport__surface"),
    );
  });

  it("states the seat's refusal when the same row is run with no ledger up", () => {
    // Which is the other half of the seam: the command is contributed for the
    // window's whole life and the feed is not, so the press has to say so rather
    // than doing nothing.
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

  it("negative control: an unmounted feed releases the seat it held", () => {
    // Without this the case above would pass over a feed that never took the seat
    // at all, which is exactly the state this lane found the ledger in.
    withLaidOutViewport();
    contributeTranscriptCommands();
    const raisedWhileMounted: Refusal[] = [];
    const withdrawSink = publishCommandRefusalSink((refusal) => {
      raisedWhileMounted.push(refusal);
    });
    const mounted = render(
      <PlatformBridgeProvider bridge={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
        <TranscriptFeed
          sessionStore={openSessionStoreWithFeedLog(SHORT_LOG_EVENT_COUNT)}
          paneId={TRANSCRIPT_FIXTURE_PANE_ID}
          renderTimelineRow={(mount) => <p>{mount.row.summary}</p>}
          feedLabel="Session timeline"
        />
      </PlatformBridgeProvider>,
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
