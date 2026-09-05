// The two seats this mount claims for callers composed before it existed.
//
// The palette's chords and the workspace's follow seat both resolve their target at
// press time, and both are reached through a seat rather than an import. The
// property here is that a command contributed at COMPOSITION time reaches a feed
// mounted later, and that an unmounted feed says so instead of doing nothing.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../bridge/scenarios/ledger-quiet.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import { publishConsoleActRefusalSink } from "../../../frame/command-surface.js";
import { actorFollowHandler, unregisterActorFollowHandler } from "../../../seats/index.js";
import { LedgerFeed } from "./LedgerFeed.js";
import {
  REPLAY_LOG_EVENT_COUNT,
  contributeLedgerCommands,
  dispatchConsoleCommand,
  renderFeed,
  replayDockHarness,
  withdrawLedgerCommands,
  withLaidOutViewport,
} from "./LedgerFeedFixtures.test-support.js";
import { openSessionStoreWithLog } from "./ledger-feed-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger feed — the palette acts on the mounted feed", () => {
  afterEach(() => {
    withdrawLedgerCommands();
  });

  it("opens this feed's find field when the palette's find row is run", () => {
    withLaidOutViewport();
    contributeLedgerCommands();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    expect(feed.querySelector(".meridian-find")).toBeNull();
    dispatchConsoleCommand("ledger.find");
    expect(feed.querySelector(".meridian-find")).not.toBeNull();
  });

  it("puts the caret in the field the palette opened, and gives it back on Escape", () => {
    // The chord's whole point is that the next keystroke enters the query, and the
    // field is the only thing on this surface that can hold a caret without
    // scrolling the log. Before this focus stayed on the ledger or the palette.
    withLaidOutViewport();
    contributeLedgerCommands();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    dispatchConsoleCommand("ledger.find");
    const input = feed.querySelector<HTMLInputElement>(".meridian-find__input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    act(() => {
      fireEvent.keyDown(input as HTMLInputElement, { key: "Escape" });
    });
    expect(feed.querySelector(".meridian-find")).toBeNull();
    // Not `body`: the log is where the reader was, and it is focusable for exactly
    // this reason.
    expect(document.activeElement).toBe(feed.querySelector(".meridian-ledger-viewport__surface"));
  });

  it("reveals the replay dock when the palette starts playback", () => {
    // Playing from idle parks the position at zero, so the ledger collapses to the
    // rows sharing the window's first instant. Behind a hidden dock there is no
    // visible control to undo that.
    withLaidOutViewport();
    contributeLedgerCommands();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    expect(replayDockHarness(feed).dock.hidden).toBe(true);
    dispatchConsoleCommand("ledger.toggleReplay");
    expect(replayDockHarness(feed).dock.hidden).toBe(false);
  });

  it("reveals the replay dock when the palette jumps to the next seam", () => {
    // The seam jump scrubs, and a scrub promotes idle to paused — engaged, so rows
    // are withheld exactly as a play withholds them.
    withLaidOutViewport();
    contributeLedgerCommands();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    expect(replayDockHarness(feed).dock.hidden).toBe(true);
    dispatchConsoleCommand("ledger.jumpToNextSeam");
    expect(replayDockHarness(feed).dock.hidden).toBe(false);
  });

  it("states the seat's refusal when the same row is run with no ledger up", () => {
    // Which is the other half of the seam: the command is contributed for the
    // window's whole life and the feed is not, so the press has to say so rather
    // than doing nothing.
    contributeLedgerCommands();
    const raised: ConsoleRefusal[] = [];
    const withdrawSink = publishConsoleActRefusalSink((refusal) => {
      raised.push(refusal);
    });
    dispatchConsoleCommand("ledger.find");
    expect(raised.map((refusal) => refusal.code)).toStrictEqual(["ledger.no_mounted_ledger"]);
    withdrawSink();
  });

  it("negative control: an unmounted feed releases the seat it held", () => {
    // Without this the case above would pass over a feed that never took the seat
    // at all, which is exactly the state this lane found the ledger in.
    withLaidOutViewport();
    contributeLedgerCommands();
    const raisedWhileMounted: ConsoleRefusal[] = [];
    const withdrawSink = publishConsoleActRefusalSink((refusal) => {
      raisedWhileMounted.push(refusal);
    });
    const mounted = render(
      <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
        <LedgerFeed
          sessionStore={openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT)}
          renderTimelineRow={(mount) => <p>{mount.row.summary}</p>}
          feedLabel="Session timeline"
        />
      </SidekicksBridgeProvider>,
    );
    dispatchConsoleCommand("ledger.find");
    expect(raisedWhileMounted).toStrictEqual([]);
    mounted.unmount();
    dispatchConsoleCommand("ledger.find");
    expect(raisedWhileMounted.map((refusal) => refusal.code)).toStrictEqual([
      "ledger.no_mounted_ledger",
    ]);
    withdrawSink();
  });
});

describe("the ledger feed — the cast bar's follow seat", () => {
  afterEach(() => {
    unregisterActorFollowHandler();
  });

  it("reveals the row a chip's sequence names while the feed is mounted", () => {
    withLaidOutViewport();
    renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const follow = actorFollowHandler();
    expect(follow).toBeDefined();
    expect(
      follow?.({ participantId: "participant-alba", newestSequence: REPLAY_LOG_EVENT_COUNT - 1 }),
    ).toBe("revealed");
  });

  it("answers row-not-in-view for a sequence this window does not hold", () => {
    withLaidOutViewport();
    renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    expect(
      actorFollowHandler()?.({
        participantId: "participant-alba",
        newestSequence: REPLAY_LOG_EVENT_COUNT + 100,
      }),
    ).toBe("row-not-in-view");
  });

  it("negative control: the seat is empty until a ledger fills it", () => {
    // Which is the state the workspace announces "the session log is not open in
    // this window" from — and the state the ledger was permanently in before.
    expect(actorFollowHandler()).toBeUndefined();
  });
});
