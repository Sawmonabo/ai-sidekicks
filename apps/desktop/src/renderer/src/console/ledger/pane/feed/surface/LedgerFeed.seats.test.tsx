// The seat this mount claims for a caller composed before it existed.
//
// The palette's chords resolve their target at press time and are reached through a
// seat rather than an import. The property here is that a command contributed at
// COMPOSITION time reaches a feed mounted later, and that an unmounted feed says so
// instead of doing nothing.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../../bridge/scenario/ledger/ledger-quiet.js";
import { type ConsoleRefusal } from "../../../../core/index.js";
import { publishConsoleActRefusalSink } from "../../../../palette/index.js";
import { LedgerFeed } from "./LedgerFeed.js";
import {
  LEDGER_FIXTURE_PANE_ID,
  SHORT_LOG_EVENT_COUNT,
  contributeLedgerCommands,
  dispatchConsoleCommand,
  renderFeed,
  withdrawLedgerCommands,
  withLaidOutViewport,
} from "./LedgerFeedFixtures.test-support.js";
import { openSessionStoreWithFeedLog } from "../ledger-feed-logs.test-support.js";

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
    const feed = renderFeed(openSessionStoreWithFeedLog(SHORT_LOG_EVENT_COUNT));
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
    const feed = renderFeed(openSessionStoreWithFeedLog(SHORT_LOG_EVENT_COUNT));
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
          sessionStore={openSessionStoreWithFeedLog(SHORT_LOG_EVENT_COUNT)}
          paneId={LEDGER_FIXTURE_PANE_ID}
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
