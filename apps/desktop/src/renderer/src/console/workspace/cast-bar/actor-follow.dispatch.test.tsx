// Which pane a chip press moves, when the deck is holding more than one log.
//
// `actor-follow.test.ts` beside this file drives the resolution — is there a row to
// follow at all — with no React and no seat. This drives the DISPATCH: the deck
// focuses a pane and the ledger in that pane scrolls, and the two have to be the same
// pane. A deck holding a session timeline beside a channel-scoped one is the ordinary
// arrangement the console is built for, and it is exactly the arrangement in which a
// press could focus one log and scroll another.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  actorFollowHandler,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
  type ActorFollowOutcome,
} from "../../seats/index.js";
import { type ConsoleSessionEvent, type SessionStore } from "../../store/index.js";
import { DECK_RESTORED_PANE_CAP } from "../workspace-bounds.js";
import { DeckLayout } from "../deck/deck-layout.js";
import { ACTOR_FOLLOW_ANNOUNCEMENTS, useActorFollow } from "./actor-follow.js";

const FOLLOWED_PARTICIPANT = "agent-scout";

/** One row, attributed, so the resolution has something to follow. */
const SESSION_LOG: readonly ConsoleSessionEvent[] = [
  {
    id: "event-3",
    sessionId: "session-1",
    sequence: 3,
    kind: "user.message",
    occurredAt: "2026-01-01T14:20:00.000Z",
    actorId: FOLLOWED_PARTICIPANT,
  },
];

/**
 * Enough of a session store for the dispatch to read a log off.
 *
 * The hook reads exactly one thing from the store, and a fixture bridge would bring
 * a scenario engine, a clock, and a frame store to a claim none of them bear on.
 */
function storeHoldingLog(timeline: readonly ConsoleSessionEvent[]): SessionStore {
  return { snapshot: () => ({ timeline }) } as unknown as SessionStore;
}

/** A deck with a session timeline and a channel-scoped one, in that order. */
function twoTimelineDeck(): DeckLayout {
  const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  const sessionPaneId = layout.open({ kind: "timeline", entity: undefined });
  const channelPaneId = layout.open({
    kind: "timeline",
    entity: { kind: "channel", id: "channel-review" },
  });
  return Object.assign(layout, { sessionPaneId, channelPaneId });
}

/** A handler that records that it was asked, and says the row was revealed. */
function recordingHandler(scrolled: string[], paneId: string): () => ActorFollowOutcome {
  return () => {
    scrolled.push(paneId);
    return "revealed";
  };
}

function pressChip(layout: DeckLayout, announced: string[]): void {
  const { result } = renderHook(() =>
    useActorFollow({
      layout,
      sessionStore: storeHoldingLog(SESSION_LOG),
      announce: (sentence) => announced.push(sentence),
    }),
  );
  act(() => {
    result.current(FOLLOWED_PARTICIPANT);
  });
}

const registeredPaneIds: string[] = [];

function fillSeat(paneId: string, scrolled: string[]): void {
  registerActorFollowHandler(paneId, recordingHandler(scrolled, paneId));
  registeredPaneIds.push(paneId);
}

afterEach(() => {
  for (const paneId of registeredPaneIds) {
    unregisterActorFollowHandler(paneId);
  }
  registeredPaneIds.length = 0;
});

describe("useActorFollow — a deck holding two logs", () => {
  it("scrolls the pane it focused, not whichever ledger mounted last", () => {
    // Both feeds are on screen and both are live. A press that focused the session
    // log and then asked the channel log to scroll would move a pane the person is
    // not looking at, and report that it revealed the row.
    const layout = twoTimelineDeck();
    const scrolled: string[] = [];
    const sessionPaneId = layout.snapshot().panes[0]?.paneId ?? "";
    const channelPaneId = layout.snapshot().panes[1]?.paneId ?? "";
    fillSeat(sessionPaneId, scrolled);
    fillSeat(channelPaneId, scrolled);
    layout.focus(sessionPaneId);

    pressChip(layout, []);

    expect(scrolled).toStrictEqual([sessionPaneId]);
    expect(layout.snapshot().focusedPaneId).toBe(sessionPaneId);
  });

  it("follows the focused log when the person is reading the channel one", () => {
    // The other half of the same rule, so neither pane is privileged by position.
    const layout = twoTimelineDeck();
    const scrolled: string[] = [];
    const sessionPaneId = layout.snapshot().panes[0]?.paneId ?? "";
    const channelPaneId = layout.snapshot().panes[1]?.paneId ?? "";
    fillSeat(sessionPaneId, scrolled);
    fillSeat(channelPaneId, scrolled);
    layout.focus(channelPaneId);

    pressChip(layout, []);

    expect(scrolled).toStrictEqual([channelPaneId]);
    expect(layout.snapshot().focusedPaneId).toBe(channelPaneId);
  });

  it("falls back to the first log when the focused pane is not one", () => {
    // Following an actor is an act on a log, so a press made while an approvals pane
    // has focus has to move focus to a log rather than refuse.
    const layout = twoTimelineDeck();
    const scrolled: string[] = [];
    const sessionPaneId = layout.snapshot().panes[0]?.paneId ?? "";
    fillSeat(sessionPaneId, scrolled);
    const approvalsPaneId = layout.open({ kind: "approvals", entity: undefined });
    layout.focus(approvalsPaneId);

    pressChip(layout, []);

    expect(scrolled).toStrictEqual([sessionPaneId]);
    expect(layout.snapshot().focusedPaneId).toBe(sessionPaneId);
  });

  it("says so when the focused log has no ledger mounted in it", () => {
    // The seat's absence is a real state: the pane is there and its feed is not.
    const layout = twoTimelineDeck();
    const announced: string[] = [];
    layout.focus(layout.snapshot().panes[1]?.paneId ?? "");

    pressChip(layout, announced);

    expect(announced).toStrictEqual([ACTOR_FOLLOW_ANNOUNCEMENTS["no-ledger"]]);
  });

  it("negative control: the seat really is keyed, so one pane's claim is not the other's", () => {
    // Without this every case above would pass over a registry that answered the same
    // handler for every key — which is the shape being replaced.
    const scrolled: string[] = [];
    fillSeat("pane-a", scrolled);
    fillSeat("pane-b", scrolled);

    expect(actorFollowHandler("pane-a")).not.toBe(actorFollowHandler("pane-b"));
    expect(actorFollowHandler("pane-c")).toBeUndefined();
  });
});
