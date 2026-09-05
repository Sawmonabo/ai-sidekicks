// What a channel address narrows, and what it must not.
//
// THE ADDRESS IS THE PANE'S SCOPE AND NOT ITS DECORATION. A channel address used to
// reach the header's breadcrumb and stop there, while the body below it was handed the
// whole session store — so a pane headed by one channel rendered every channel's rows,
// its facet bar offered speakers who had never said anything in it, and the header was
// the only thing on screen saying otherwise. Every case here is one surface that has to
// agree with the header.
//
// The pane's CHROME and its row slot are `TimelinePane.test.tsx`': the two suites
// mount the same pane and ask different things of it, and the fixtures they share
// live in `TimelinePaneFixtures.test-support.tsx`.

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { registerTimelineRowRenderer } from "../../seats/index.js";
// Deeply: the teardown is reached by tests alone, so it is not a door line.
import { unregisterTimelineRowRenderer } from "../../seats/timeline-row-slot.js";
// The shared stub rather than a second one: `happy-dom` reports zero for both box
// readings, and a viewport with no box holds no rows — a case that stubbed only the
// height would be measuring its own setup.
import { LEDGER_FACET_CHIP, withLaidOutViewport } from "./LedgerFeedFixtures.test-support.js";
import { TimelinePane, type TimelinePaneContext } from "./TimelinePane.js";
import {
  TIMELINE_PANE_SESSION_ID,
  paneContext,
  renderPane,
} from "./TimelinePaneFixtures.test-support.js";

afterEach(() => {
  // The seat is module-scope, so a case that filled it would leak into the next.
  unregisterTimelineRowRenderer();
  vi.restoreAllMocks();
});

describe("TimelinePane — a channel address is the pane's scope", () => {
  const CHANNEL_ONE = "019b793b-7b60-7c11-8110-c4a11e10001a";
  const CHANNEL_TWO = "019b793b-7b60-7c11-8120-c4a11e10002b";
  const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
  const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";
  const SEAT_ROW = ".meridian-ledger-viewport__row";

  const CHANNEL_ONE_SPEAKER = "agent-alba";
  const CHANNEL_TWO_SPEAKER = "agent-enzo";
  /** A channel the log names nowhere, so its pane is a log of nothing. */
  const SILENT_CHANNEL = "019b793b-7b60-7c11-8130-c4a11e10003c";

  /**
   * Two runs talking in two channels, and one session row belonging to neither.
   *
   * Each channel has a speaker of its own, which is what makes the facet bar a
   * question about the scope rather than about the log: a bar derived from the
   * whole session offers both speakers under a header naming one channel.
   */
  function openSessionStoreWithTwoChannels(
    extraEvents: readonly ConsoleSessionEvent[] = [],
  ): SessionStore {
    const sessionStore = new SessionStore({ sessionId: TIMELINE_PANE_SESSION_ID });
    sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
    const said = (
      sequence: number,
      runId: string,
      channelId: string,
      actorId: string,
    ): ConsoleSessionEvent => ({
      id: `event-${String(sequence)}`,
      sessionId: TIMELINE_PANE_SESSION_ID,
      sequence,
      kind: "assistant.message",
      occurredAt: `2026-01-01T11:05:0${String(sequence)}.000Z`,
      actorId,
      payload: { sessionId: TIMELINE_PANE_SESSION_ID, runId, channelId },
    });
    sessionStore.applyBatch([
      {
        id: "event-0",
        sessionId: TIMELINE_PANE_SESSION_ID,
        sequence: 0,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        payload: { sessionId: TIMELINE_PANE_SESSION_ID },
      },
      said(1, RUN_ONE, CHANNEL_ONE, CHANNEL_ONE_SPEAKER),
      said(2, RUN_ONE, CHANNEL_ONE, CHANNEL_ONE_SPEAKER),
      said(3, RUN_TWO, CHANNEL_TWO, CHANNEL_TWO_SPEAKER),
      ...extraEvents,
    ]);
    return sessionStore;
  }

  /** A pane addressed to one channel, with a real row renderer behind the seat. */
  function renderChannelPane(
    channelId: string | undefined,
    extraEvents: readonly ConsoleSessionEvent[] = [],
  ): HTMLElement {
    withLaidOutViewport();
    registerTimelineRowRenderer("timeline-pane-channel-scope", () => null);
    return renderPane(
      <TimelinePane
        context={paneContext({
          sessionStore: openSessionStoreWithTwoChannels(extraEvents),
          ...(channelId === undefined ? {} : { entity: { kind: "channel", id: channelId } }),
        } as Partial<TimelinePaneContext>)}
      />,
    );
  }

  /** Every value the facet bar offers to narrow on, in the order it draws them. */
  function facetValues(pane: HTMLElement): readonly string[] {
    return [...pane.querySelectorAll<HTMLElement>(LEDGER_FACET_CHIP)].map(
      (chip) => chip.querySelector(".meridian-ledger-filter__facet-value")?.textContent ?? "",
    );
  }

  it("shows only the addressed channel's rows", () => {
    // The defect: a channel address reached the header's breadcrumb and stopped
    // there, while the body was handed the whole session store — so a pane headed
    // by one channel rendered every channel's rows.
    expect(renderChannelPane(CHANNEL_ONE).querySelectorAll(SEAT_ROW)).toHaveLength(2);
    expect(renderChannelPane(CHANNEL_TWO).querySelectorAll(SEAT_ROW)).toHaveLength(1);
  });

  it("names itself for what it is a log of", () => {
    // The label is what a screen reader announces on entering the box, and
    // "Session timeline" over a channel window says the log is the session's.
    const feed = renderChannelPane(CHANNEL_ONE).querySelector(".meridian-ledger-viewport__surface");
    expect(feed?.getAttribute("aria-label")).toBe("Channel timeline");
  });

  it("offers only this channel's own participants and families to narrow on", () => {
    // The seat-row counts above would pass over a filter applied at the VIEWPORT:
    // the facet bar is derived from the unfurled projection, so a scope that
    // reached only as far as the rows would leave the other channel's speaker and
    // the session's own families on offer under a header naming this channel.
    const offered = facetValues(renderChannelPane(CHANNEL_ONE));

    expect(offered).toContain(CHANNEL_ONE_SPEAKER);
    expect(offered).not.toContain(CHANNEL_TWO_SPEAKER);
    expect(offered).not.toContain("session_lifecycle");
    // And the session pane is the control: both speakers, both families.
    const wholeSession = facetValues(renderChannelPane(undefined));
    expect(wholeSession).toContain(CHANNEL_TWO_SPEAKER);
    expect(wholeSession).toContain("session_lifecycle");
  });

  it("says an empty channel is empty, not that the session is", () => {
    // "Nothing has happened in this session yet" over a channel pane is false about
    // the session — and it fired for every channel pane in the shipped fixtures,
    // because no scenario event carries a channel at all.
    const pane = renderChannelPane(SILENT_CHANNEL);

    expect(pane.textContent).toContain("Nothing has happened in this channel yet.");
    expect(pane.textContent).not.toContain("Nothing has happened in this session yet.");
  });

  it("names the session when it reports an entry it could not place", () => {
    // The count comes off the whole-log projection, before the scope can apply, and
    // an event this build cannot place carries no channel it could be counted
    // under — so a channel pane says whose fact it is rather than implying its own.
    const unplaceable: ConsoleSessionEvent = {
      id: "event-9",
      sessionId: TIMELINE_PANE_SESSION_ID,
      sequence: 9,
      kind: "nothing.this.build.registers",
      occurredAt: "2026-01-01T11:05:09.000Z",
      payload: { sessionId: TIMELINE_PANE_SESSION_ID },
    };

    expect(renderChannelPane(CHANNEL_ONE, [unplaceable]).textContent).toContain(
      "Some of the session's entries could not be placed.",
    );
    // The negative control: the session pane keeps the plain sentence, so the
    // scoped wording is a scope decision rather than a rewrite of both.
    expect(renderChannelPane(undefined, [unplaceable]).textContent).toContain(
      "Some entries could not be placed.",
    );
  });

  it("leaves a bare address a log of the whole session", () => {
    // The negative control, and the compatibility claim in one: a timeline address
    // with no entity is session-scoped, and every row — both channels' and the
    // session's own — is on it.
    const pane = renderChannelPane(undefined);

    expect(pane.querySelectorAll(SEAT_ROW)).toHaveLength(4);
    expect(
      pane.querySelector(".meridian-ledger-viewport__surface")?.getAttribute("aria-label"),
    ).toBe("Session timeline");
  });
});
