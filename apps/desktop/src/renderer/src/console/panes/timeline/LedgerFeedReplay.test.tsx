// The replay dock: the rows a position reveals, and when the dock is on screen.
//
// Two claims a screenshot cannot separate. A replay that moved a timestamp without
// moving the rows would look exactly like a replay, and a dock concealed by a focus
// move that never left the rail would look exactly like a dock nobody opened.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REPLAY_LOG_EVENT_COUNT,
  contributeLedgerCommands,
  dispatchConsoleCommand,
  openSessionStoreWithLog,
  renderFeed,
  replayDockHarness,
  withLaidOutViewport,
  withdrawLedgerCommands,
} from "./ledger-feed-fixtures.js";

afterEach(() => {
  withdrawLedgerCommands();
  vi.restoreAllMocks();
});

const SCRUB_TO_FIFTH_ROW_MS = 4000;

describe("the ledger feed — replay reveals", () => {
  it("shows the rows the position has reached and no more", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    expect(feed.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(
      REPLAY_LOG_EVENT_COUNT,
    );

    const scrub = feed.querySelector<HTMLInputElement>(".meridian-replay__scrub");
    expect(scrub).not.toBeNull();
    fireEvent.change(scrub as HTMLInputElement, {
      target: { value: String(SCRUB_TO_FIFTH_ROW_MS) },
    });

    // The log is one row per second, so four seconds in is five rows: the wire
    // ordered prefix the position has reached, and nothing behind it. The timestamp
    // and the slider used to be the only things that moved.
    const revealed = [...feed.querySelectorAll(".meridian-ledger-viewport__row")];
    expect(revealed).toHaveLength(5);
    expect(revealed.map((row) => row.getAttribute("data-index"))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("gives the window back when the scrub reaches the tail", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const scrub = feed.querySelector<HTMLInputElement>(".meridian-replay__scrub");
    fireEvent.change(scrub as HTMLInputElement, {
      target: { value: String(SCRUB_TO_FIFTH_ROW_MS) },
    });
    fireEvent.change(scrub as HTMLInputElement, {
      target: { value: String((REPLAY_LOG_EVENT_COUNT - 1) * 1000) },
    });
    expect(feed.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(
      REPLAY_LOG_EVENT_COUNT,
    );
  });

  it("negative control: an untouched dock withholds nothing", () => {
    // Without this the case above would pass over a feed that filtered by the idle
    // position too — which reveals only the rows sharing the window's first instant
    // and would hide almost every session behind a control nobody had touched.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    expect(feed.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(
      REPLAY_LOG_EVENT_COUNT,
    );
  });
});

describe("the ledger feed — the dock stays up while focus is still in the rail", () => {
  it("does not conceal when a tab moves focus from the slider into the dock", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const { dock, railSlider, dockButton } = replayDockHarness(feed);
    fireEvent.focusIn(railSlider);
    expect(dock.hidden).toBe(false);
    // `focusout` bubbles, so this reaches the wrapper even though focus never left
    // it. Concealing here made the dock's own controls vanish mid-tab.
    fireEvent.focusOut(railSlider, { relatedTarget: dockButton });
    expect(dock.hidden).toBe(false);
  });

  it("negative control: focus leaving the wrapper conceals", () => {
    // Without this the case above would pass over a wrapper that had stopped
    // concealing at all, which is a dock that never closes.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const { dock, railSlider } = replayDockHarness(feed);
    fireEvent.focusIn(railSlider);
    expect(dock.hidden).toBe(false);
    const elsewhere = feed.querySelector<HTMLElement>(".meridian-ledger-viewport__surface");
    expect(elsewhere).not.toBeNull();
    fireEvent.focusOut(railSlider, { relatedTarget: elsewhere });
    expect(dock.hidden).toBe(true);
  });

  it("negative control: focus leaving the document conceals too", () => {
    // A null related target is focus leaving the window, not an intra-wrapper move.
    // Exempting it would leave the dock open under a window nobody is in.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const { dock, railSlider } = replayDockHarness(feed);
    fireEvent.focusIn(railSlider);
    fireEvent.focusOut(railSlider, { relatedTarget: null });
    expect(dock.hidden).toBe(true);
  });
});

describe("the ledger feed — replay from the row in view", () => {
  /** The dock's own control for it. Refuses rather than answering null. */
  function replayFromHereControl(feed: HTMLElement): HTMLElement {
    const control = feed.querySelector<HTMLElement>(".meridian-replay__from-here");
    if (control === null) {
      throw new Error("the dock drew no replay-from-here control");
    }
    return control;
  }

  it("scrubs the replay to the anchored row and reveals the dock", () => {
    // `ReplayEngine.replayFrom` had no production caller anywhere: three hits
    // repo-wide, one declaration and two assertions in its own test. The viewport
    // is parked at the head, so the row in view is the window's first — and the
    // engine holding at its instant is what makes the rows behind it withheld.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const { dock } = replayDockHarness(feed);
    expect(dock.hasAttribute("hidden")).toBe(true);

    fireEvent.click(replayFromHereControl(feed));

    expect(feed.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(1);
    // Engaging replay behind a hidden dock leaves a reader holding a control they
    // cannot see to undo, which is why the act reveals before it scrubs.
    expect(dock.hasAttribute("hidden")).toBe(false);
  });

  it("does the same from the keyboard, through the palette's own row", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    contributeLedgerCommands();

    dispatchConsoleCommand("ledger.replayFromRowInView");

    expect(feed.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(1);
    expect(replayDockHarness(feed).dock.hasAttribute("hidden")).toBe(false);
  });

  it("negative control: the window is whole until the control is pressed", () => {
    // Without this the cases above would pass over a feed that withheld rows for
    // some other reason — a replay nobody started, say.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    expect(feed.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(
      REPLAY_LOG_EVENT_COUNT,
    );
  });
});
