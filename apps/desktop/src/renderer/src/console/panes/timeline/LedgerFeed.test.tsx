// The feed's four seams, asserted where a screenshot cannot reach them.
//
// WHAT THIS FILE IS FOR. `LedgerFeed.tsx` adds arrangement and the callbacks that
// let one piece act on another, and every one of those is a claim that fails
// silently: a rail thumb sized off a virtualizer with no element under it looks
// exactly like a correct one, a replay that moves a timestamp without moving the
// rows looks exactly like a replay, and a control offering an act nobody can
// perform looks exactly like a control. So the cases below drive the composed feed
// with a REAL store, a real projection, a real viewport binding, and the real
// structure models, and assert the seams rather than the pieces.
//
// `happy-dom` answers zero for every geometry read, which is why every case that
// needs the virtualizer to have a range stubs the two reads the chokepoint makes —
// `LedgerViewport.test.tsx`' stub, for its reason.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import {
  consoleCommandSurface,
  consoleCommands,
  publishConsoleActRefusalSink,
} from "../../frame/command-surface.js";
import { projectFixtureShellRows } from "../../ledger/cards/index.js";
import { LEDGER_OVERSCAN_ROWS, LEDGER_WINDOW_ROW_CAP } from "../../ledger/frame/frame-bounds.js";
import {
  LEDGER_COMMAND_OWNER,
  ProvenanceRail,
  ProvenanceRailModel,
  registerLedgerCommands,
} from "../../ledger/structure/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { SessionStore } from "../../store/index.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import {
  actorFollowHandler,
  unregisterActorFollowHandler,
  type TimelineRowSlotProps,
} from "../../workspace/index.js";
import { LedgerFeed } from "./LedgerFeed.js";

const SESSION_ID = "session-ledger-feed";
const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;
const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;
const LONG_LOG_EVENT_COUNT = 300;

/**
 * Give the ledger a laid-out, scrollable box for the length of one case.
 *
 * Both reads are load-bearing and neither is the module under test: the
 * virtualizer treats a zero outer size as "no range at all", and the scroll
 * chokepoint clamps every write to `scrollHeight - clientHeight`.
 */
function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    LAID_OUT_CONTENT_HEIGHT_PX,
  );
}

/** A real store holding a log of `count` run events, oldest first. */
function openSessionStoreWithLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      sessionId: SESSION_ID,
      sequence: index,
      kind: "run.running",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString(),
      payload: { sessionId: SESSION_ID, runId: "019b793b-7b60-740e-8110-d1a4c1150111" },
    })),
  );
  return sessionStore;
}

/**
 * Mount the feed under a bridge, because the ledger reads the console clock.
 *
 * `onRowMounted` is how a case reads the three decisions the list makes for a row:
 * they reach the seat as arguments and never as markup, so a case that only read
 * the DOM could not see any of them.
 */
function renderFeed(
  sessionStore: SessionStore,
  onRowMounted?: (mount: TimelineRowSlotProps) => void,
): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
      <LedgerFeed
        sessionStore={sessionStore}
        renderTimelineRow={(mount) => {
          onRowMounted?.(mount);
          return <p>{mount.row.summary}</p>;
        }}
        feedLabel="Session timeline"
      />
    </SidekicksBridgeProvider>,
  );
  const feed = container.querySelector(".meridian-ledger");
  if (!(feed instanceof HTMLElement)) {
    throw new Error("LedgerFeed rendered no ledger element");
  }
  return feed;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger feed — one binding", () => {
  it("sizes the rail from the rows the box intersects, not the rows it mounts", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(LONG_LOG_EVENT_COUNT));
    const thumb = feed.querySelector<HTMLElement>(".meridian-rail__thumb");
    expect(thumb).not.toBeNull();
    // Both readings come off the DOM, so this discriminates rather than restating a
    // constant. At the head there is no leading overscan, so the mounted rows are
    // the intersected ones plus one trailing overscan band; `aria-setsize` carries
    // the window's whole length. "Under 50%" passed at BOTH readings.
    const mountedRows = [...feed.querySelectorAll(".meridian-ledger-viewport__row")];
    const windowRowCount = Number(mountedRows[0]?.getAttribute("aria-setsize"));
    const intersectedRowCount = mountedRows.length - LEDGER_OVERSCAN_ROWS;
    expect(intersectedRowCount).toBeGreaterThan(0);
    const thumbHeightPercent = Number.parseFloat(thumb?.style.height ?? "100");
    expect(thumbHeightPercent).toBeCloseTo((intersectedRowCount / windowRowCount) * 100, 4);
    // And the reading the mount range would have produced is a different number,
    // which is what makes the assertion above a claim about the overscan.
    expect(thumbHeightPercent).toBeLessThan((mountedRows.length / windowRowCount) * 100);
  });

  it("negative control: with no laid-out box there is no range, and the rail says so", () => {
    // Without this the case above would pass over any thumb style at all. An
    // unmeasured viewport genuinely has no rendered range, and the honest rail for
    // one is the full-height thumb — which is exactly what a rail reading an
    // unattached binding drew on a fully laid-out ledger.
    const feed = renderFeed(openSessionStoreWithLog(LONG_LOG_EVENT_COUNT));
    const thumb = feed.querySelector<HTMLElement>(".meridian-rail__thumb");
    expect(thumb?.style.height).toBe("100%");
  });
});

/**
 * Two participants whose PREFERRED wheel step is the same, so which of them takes
 * it is decided by admission order and by nothing else.
 *
 * The collision is the instrument: with distinct preferred steps both orders agree
 * and the case below would pass over either allocator.
 */
const EARLY_JOINER = "participant-alba";
const LATE_JOINER = "participant-enzo";

/** A store whose join order and first-event order deliberately disagree. */
function openStoreWhereJoinOrderIsNotEventOrder(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({
    cursor: -1,
    entities: [],
    participantJoinLog: [EARLY_JOINER, LATE_JOINER],
  });
  sessionStore.applyBatch([
    {
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "user.message",
      occurredAt: "2026-01-01T11:00:00.000Z",
      actorParticipantId: LATE_JOINER,
      payload: {},
    },
    {
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "user.message",
      occurredAt: "2026-01-01T11:00:01.000Z",
      actorParticipantId: EARLY_JOINER,
      payload: {},
    },
  ]);
  return sessionStore;
}

describe("the ledger feed — one wheel", () => {
  it("hands each row the hue the session store allocated", () => {
    withLaidOutViewport();
    const sessionStore = openStoreWhereJoinOrderIsNotEventOrder();
    const stepByActor = new Map<string, number>();
    renderFeed(sessionStore, (mount) => {
      if (mount.row.actor !== undefined && mount.participantHue !== undefined) {
        stepByActor.set(mount.row.actor, mount.participantHue.step);
      }
    });
    expect(stepByActor.get(EARLY_JOINER)).toBe(
      sessionStore.hueAllocator.assignmentFor(EARLY_JOINER)?.step,
    );
    expect(stepByActor.get(LATE_JOINER)).toBe(
      sessionStore.hueAllocator.assignmentFor(LATE_JOINER)?.step,
    );
  });

  it("negative control: allocating over first-event order gives the other answer", () => {
    // Without this the case above would pass over a ledger that kept its own wheel,
    // because two allocators agree wherever the two orders do. These two ids prefer
    // the same step, so the order decides who gets it — and the orders disagree.
    const byFirstEvent = new ParticipantHueAllocator();
    byFirstEvent.admit(LATE_JOINER);
    byFirstEvent.admit(EARLY_JOINER);
    const sessionStore = openStoreWhereJoinOrderIsNotEventOrder();
    expect(byFirstEvent.assignmentFor(EARLY_JOINER)?.step).not.toBe(
      sessionStore.hueAllocator.assignmentFor(EARLY_JOINER)?.step,
    );
  });
});

const REPLAY_LOG_EVENT_COUNT = 10;
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

/** The rail wrapper, the control it reveals, and the two focusable ends of a tab. */
function replayDockHarness(feed: HTMLElement): {
  readonly dock: HTMLElement;
  readonly railSlider: HTMLElement;
  readonly dockButton: HTMLElement;
} {
  const dock = feed.querySelector<HTMLElement>(".meridian-replay");
  const railSlider = feed.querySelector<HTMLElement>('[role="slider"]');
  const dockButton = feed.querySelector<HTMLElement>(".meridian-replay__primary");
  if (dock === null || railSlider === null || dockButton === null) {
    throw new Error("the feed rendered no rail wrapper, slider, or replay dock");
  }
  return { dock, railSlider, dockButton };
}

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

const OVER_CAP_EVENT_COUNT = LEDGER_WINDOW_ROW_CAP + 50;

/** A log of general rows, so no chapter is open and the cap may actually apply. */
function openSessionStoreWithGeneralLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      sessionId: SESSION_ID,
      sequence: index,
      kind: "user.message",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString(),
      payload: {},
    })),
  );
  return sessionStore;
}

describe("the ledger feed — what it does not hold", () => {
  it("offers no load-earlier control, and names the rows the cap took", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(OVER_CAP_EVENT_COUNT));
    // No read this console can perform returns rows before the window's head, so
    // the affordance is absent rather than drawn over an act nobody can complete.
    expect(feed.querySelector(".meridian-rail__load-earlier")).toBeNull();
    expect(feed.querySelector(".meridian-find__load-earlier")).toBeNull();
    expect(feed.textContent).toContain("Older entries are no longer in this window.");
  });

  it("names entries the stream numbered and never delivered", () => {
    withLaidOutViewport();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
    sessionStore.applyBatch([
      {
        sessionId: SESSION_ID,
        sequence: 0,
        kind: "user.message",
        occurredAt: "2026-01-01T11:00:00.000Z",
        payload: {},
      },
      {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "user.message",
        occurredAt: "2026-01-01T11:00:04.000Z",
        payload: {},
      },
    ]);
    const feed = renderFeed(sessionStore);
    expect(feed.textContent).toContain("Some entries never arrived.");
    expect(feed.querySelector(".meridian-rail__load-earlier")).toBeNull();
  });

  it("negative control: a whole log under the cap claims nothing is missing", () => {
    // Without this the two cases above would pass over a feed that always said
    // something was missing, which is its own kind of lie about a complete session.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(5));
    expect(feed.textContent).not.toContain("Older entries are no longer in this window.");
    expect(feed.textContent).not.toContain("Some entries never arrived.");
  });
});

/**
 * Contribute the ledger's palette rows into this window's real command surface.
 *
 * The real one rather than a private registry, because the seam under test is
 * exactly that a command contributed at COMPOSITION time reaches a feed mounted
 * later. A test-owned surface would prove the acts fire and nothing about that.
 */
function contributeLedgerCommands(): void {
  registerLedgerCommands(consoleCommandSurface);
}

/** Leave the window with none of this family's rows, so cases do not leak into each other. */
function withdrawLedgerCommands(): void {
  consoleCommandSurface.contribute({
    owner: LEDGER_COMMAND_OWNER,
    commands: [],
    keyBindings: [],
  });
}

/** Run one contributed command by id, the way the palette does. */
function dispatchConsoleCommand(commandId: string): void {
  const command = consoleCommands
    .commandsFor({ sessionActive: true })
    .find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    throw new Error(`no command named ${commandId} is contributed to this window`);
  }
  act(() => {
    void command.run();
  });
}

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

/** A laid-out rail box. Any non-zero extent will do; the painter needs one to size its store. */
const LAID_OUT_RAIL_BOX = { width: 20, height: 800 };

/**
 * Record the ink every rail mark is painted with, for the length of one case.
 *
 * `happy-dom` answers `null` from `getContext` and zeroes from every rect, and the
 * painter treats both as "this host cannot paint" — correctly, which is why a case
 * about WHICH colour a mark takes has to supply both.
 */
function recordRailInk(): string[] {
  const inkPerMark: string[] = [];
  const recordingContext = {
    fillStyle: "",
    clearRect: () => undefined,
    fillRect: () => {
      inkPerMark.push(String(recordingContext.fillStyle));
    },
    setTransform: () => undefined,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    recordingContext as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(
    LAID_OUT_RAIL_BOX as DOMRect,
  );
  return inkPerMark;
}

describe("the ledger feed — the rail wears the session's own hues", () => {
  it("paints each actor's marks in that actor's allocated hue", () => {
    withLaidOutViewport();
    const inkPerMark = recordRailInk();
    renderFeed(openStoreWhereJoinOrderIsNotEventOrder());
    // Two speakers, two hues. While the rail was handed no lookup at all, both
    // marks took the one neutral tone and the map said nothing about who acted.
    expect(new Set(inkPerMark).size).toBe(2);
  });

  it("negative control: a rail handed no allocation paints one neutral tone", () => {
    // The rail as this feed mounted it before this change, over the same two rows:
    // the marks are still drawn, and they are all the same colour.
    const inkPerMark = recordRailInk();
    const sessionStore = openStoreWhereJoinOrderIsNotEventOrder();
    const { rows } = projectFixtureShellRows(sessionStore.snapshot().timeline);
    render(
      <ProvenanceRail
        model={new ProvenanceRailModel({ rows, hasEarlierRows: false })}
        viewportPosition={0}
        viewportExtent={1}
        isFollowing={false}
        onJumpToRow={() => undefined}
      />,
    );
    expect(inkPerMark.length).toBeGreaterThan(1);
    expect(new Set(inkPerMark).size).toBe(1);
  });
});

describe("the ledger feed — the clip it draws is the clip that is true", () => {
  it("draws the unloaded segment once the cap has taken rows", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(OVER_CAP_EVENT_COUNT));
    expect(feed.querySelector(".meridian-rail__unloaded")).not.toBeNull();
    expect(feed.textContent).toContain("Older entries are no longer in this window.");
    // And still no control, because no registered read returns rows before the head.
    expect(feed.querySelector(".meridian-rail__load-earlier")).toBeNull();
    expect(feed.querySelector(".meridian-find__load-earlier")).toBeNull();
  });

  it("negative control: a whole log under the cap draws no segment", () => {
    // Without this the case above would pass over a clip hard-coded true, which
    // would mark every complete session as truncated.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(5));
    expect(feed.querySelector(".meridian-rail__unloaded")).toBeNull();
    expect(feed.textContent).not.toContain("Older entries are no longer in this window.");
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
