// The shared scaffolding every ledger-feed case is driven through.
//
// The feed's cases split by SUBJECT across four files — the rail, the absences, the
// replay dock, and the two seats — and every one of them needs the same four
// things: a laid-out box, a real store holding a real log, a mount under a bridge,
// and a way to press a contributed palette row. Written once here, on
// `ledger/structure/row-fixtures.ts`' terms: a module beside the code it serves,
// consumed by tests and by nothing else.
//
// `happy-dom` answers zero for every geometry read, which is why anything that needs
// the virtualizer to have a range stubs the two reads the chokepoint makes —
// `LedgerViewport.test.tsx`' stub, for its reason.

import { act, render } from "@testing-library/react";
import { vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { useLedgerRowLease } from "../../ledger/frame/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { consoleCommandSurface, consoleCommands } from "../../frame/command-surface.js";
import { LEDGER_WINDOW_ROW_CAP } from "../../ledger/frame/frame-bounds.js";
import { LEDGER_COMMAND_OWNER, registerLedgerCommands } from "../../ledger/structure/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { type TimelineRowSlotProps } from "../../seats/index.js";
import { LedgerFeed } from "./LedgerFeed.js";

export const SESSION_ID = "session-ledger-feed";

/**
 * The daemon's opaque row id for the event at one log position.
 *
 * Every `ConsoleSessionEvent` carries one — the hydrated-event read is keyed by it —
 * so a store seeded without one holds rows nothing could ever ask about. Positional
 * here because these logs are generated, and distinct from `SESSION_ID` because the
 * two identify different things.
 */
function fixtureEventId(sequence: number): string {
  return `019b793b-7b60-7ea1-8110-e5e0d115${String(sequence).padStart(4, "0")}`;
}
export const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;
const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;
export const LONG_LOG_EVENT_COUNT = 300;
export const REPLAY_LOG_EVENT_COUNT = 10;
export const OVER_CAP_EVENT_COUNT: number = LEDGER_WINDOW_ROW_CAP + 50;

/** A laid-out rail box. Any non-zero extent will do; the painter needs one to size its store. */
export const LAID_OUT_RAIL_BOX = { width: 20, height: 800 };

/**
 * Two participants whose PREFERRED wheel step is the same, so which of them takes
 * it is decided by admission order and by nothing else.
 *
 * The collision is the instrument: with distinct preferred steps both orders agree
 * and the cases that use it would pass over either allocator.
 */
export const EARLY_JOINER = "participant-alba";
export const LATE_JOINER = "participant-enzo";

/**
 * Give the ledger a laid-out, scrollable box for the length of one case.
 *
 * Both reads are load-bearing and neither is the module under test: the
 * virtualizer treats a zero outer size as "no range at all", and the scroll
 * chokepoint clamps every write to `scrollHeight - clientHeight`.
 */
export function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    LAID_OUT_CONTENT_HEIGHT_PX,
  );
}

/** A real store holding a log of `count` run events, oldest first. */
export function openSessionStoreWithLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: fixtureEventId(index),
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
export function renderFeed(
  sessionStore: SessionStore,
  onRowMounted?: (mount: TimelineRowSlotProps) => void,
  renderRowBody?: (mount: TimelineRowSlotProps) => React.JSX.Element,
): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
      <LedgerFeed
        sessionStore={sessionStore}
        renderTimelineRow={(mount) => {
          onRowMounted?.(mount);
          return renderRowBody === undefined ? <p>{mount.row.summary}</p> : renderRowBody(mount);
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

/**
 * Two participants whose PREFERRED wheel step is the same, so which of them takes
 * it is decided by admission order and by nothing else.
 *
 * The collision is the instrument: with distinct preferred steps both orders agree
 * and the case below would pass over either allocator.
 */

/** A store whose join order and first-event order deliberately disagree. */
export function openStoreWhereJoinOrderIsNotEventOrder(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({
    cursor: -1,
    entities: [],
    participantJoinLog: [EARLY_JOINER, LATE_JOINER],
  });
  sessionStore.applyBatch([
    {
      id: fixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "user.message",
      occurredAt: "2026-01-01T11:00:00.000Z",
      actorId: LATE_JOINER,
      payload: {},
    },
    {
      id: fixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "user.message",
      occurredAt: "2026-01-01T11:00:01.000Z",
      actorId: EARLY_JOINER,
      payload: {},
    },
  ]);
  return sessionStore;
}

/**
 * A row body that presses its own disclosure through the list's lease.
 *
 * The composed feed hands each row to whichever renderer fills the seat, and the
 * shell that ships one is `FixtureShellRows.tsx` — whose own suite proves it writes
 * the press to the lease. What a FEED case needs is the other half: that a write
 * reaches the window and comes back as the density the seat is handed. This row is
 * the smallest thing that can perform the write from inside the tree.
 */
export function LeasingRowBody(props: TimelineRowSlotProps): React.JSX.Element {
  const rowLease = useLedgerRowLease();
  return (
    <button
      type="button"
      className="leasing-row"
      data-density={props.density}
      onClick={() => {
        rowLease.setLease(props.row.id, {
          density: props.density === "expanded" ? "collapsed" : "expanded",
          innerScrollTopPx: 0,
        });
      }}
    >
      {props.row.summary}
    </button>
  );
}

/** One run's id, so a case can name the chapter it expects a header for. */
export const TERMINAL_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
export const LIVE_RUN_ID = "019b793b-7b60-740e-8120-d1a4c1150112";

/**
 * A store holding one run that ENDED and one that is still going.
 *
 * Two lanes rather than one because the fold's rule is a difference between them:
 * the terminal chapter draws a header and folds to it and its receipt, the live one
 * draws none and keeps every row on screen. A single-lane log would pass over a fold
 * that folded everything.
 */
export function openSessionStoreWithTerminalChapter(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  const at = (index: number): string => new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
  sessionStore.applyBatch([
    {
      id: fixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: at(0),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: fixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "assistant.message",
      occurredAt: at(1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: fixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "run.paused",
      occurredAt: at(2),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: fixtureEventId(3),
      sessionId: SESSION_ID,
      sequence: 3,
      kind: "run.completed",
      occurredAt: at(3),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: fixtureEventId(4),
      sessionId: SESSION_ID,
      sequence: 4,
      kind: "run.running",
      occurredAt: at(4),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: fixtureEventId(5),
      sessionId: SESSION_ID,
      sequence: 5,
      kind: "assistant.message",
      occurredAt: at(5),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}

/** Message rows the finished run in `foldedMessageChapterLog` holds, all folded away. */
export const FOLDED_CHAPTER_MESSAGE_ROW_COUNT = 3;

/**
 * A finished run full of message rows, beside a live run holding a tool call.
 *
 * Shaped for the narrowing's ordering and for nothing else. The finished run's
 * members are `assistant_output` and the live run's is `tool_activity`, so the two
 * families name the two chapters: narrowing to the first can only be satisfied from
 * inside a chapter that is folded shut by default, and narrowing to the second
 * empties that chapter entirely. A single-family log would pass over a narrowing
 * that never looked inside a fold at all.
 */
export function foldedMessageChapterLog(): readonly ConsoleSessionEvent[] {
  const at = (index: number): string => new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
  const messageRows = Array.from(
    { length: FOLDED_CHAPTER_MESSAGE_ROW_COUNT },
    (_unused, index) => ({
      id: fixtureEventId(index + 1),
      sessionId: SESSION_ID,
      sequence: index + 1,
      kind: "assistant.message",
      occurredAt: at(index + 1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    }),
  );
  const afterMessages = FOLDED_CHAPTER_MESSAGE_ROW_COUNT + 1;
  return [
    {
      id: fixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: at(0),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    ...messageRows,
    {
      id: fixtureEventId(afterMessages),
      sessionId: SESSION_ID,
      sequence: afterMessages,
      kind: "run.completed",
      occurredAt: at(afterMessages),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: fixtureEventId(afterMessages + 1),
      sessionId: SESSION_ID,
      sequence: afterMessages + 1,
      kind: "tool.invoked",
      occurredAt: at(afterMessages + 1),
      payload: {
        sessionId: SESSION_ID,
        runId: LIVE_RUN_ID,
        toolName: "read_file",
        toolCallId: "call-live-0",
      },
    },
  ];
}

/** That log, in a real store. */
export function openSessionStoreWithFoldedMessageChapter(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch([...foldedMessageChapterLog()]);
  return sessionStore;
}

/**
 * A store whose one run is still live and carries a compaction seam.
 *
 * Live on purpose: the seam row and the chapter fold are two different dispatches in
 * the same renderer, and a seam inside a folded chapter would be hidden by the fold
 * rather than drawn — which would make a case about the seam pass or fail for the
 * fold's reasons.
 */
export function openSessionStoreWithSeam(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  const at = (index: number): string => new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
  sessionStore.applyBatch([
    {
      id: fixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: at(0),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: fixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "usage.context_compacted",
      occurredAt: at(1),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: fixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "assistant.message",
      occurredAt: at(2),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}

/**
 * A log with two participants, two event families, and a rollback boundary.
 *
 * Built for the narrowing cases, and shaped so the load-bearing rule can fail: the
 * boundary carries a DIFFERENT actor from the run it belongs to, so admitting the
 * agent's rows admits the boundary only if the filter's second pass does its job.
 * With one actor throughout, a filter that had dropped the boundary rule entirely
 * would still have passed.
 */
/**
 * A session id the CONTRACT accepts, which the boundary arm's payload needs.
 *
 * The shared `SESSION_ID` above is a readable string, which every other fixture can
 * afford because their payloads are open records. A rollback boundary's is parsed
 * against the wire schema and dropped when it does not satisfy it, so this one
 * fixture pays for a real identifier rather than shipping a log whose boundary is
 * silently counted as unprojectable.
 */
export const FILTERABLE_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/** The row id the projection mints for one sequence of that log. */
export function filterableRowId(sequence: number): string {
  return `${FILTERABLE_SESSION_ID}:${String(sequence)}`;
}

export function openSessionStoreWithFilterableLog(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: FILTERABLE_SESSION_ID });
  sessionStore.initialise({
    cursor: -1,
    entities: [],
    participantJoinLog: [EARLY_JOINER, LATE_JOINER],
  });
  const at = (index: number): string => new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
  sessionStore.applyBatch([
    {
      id: fixtureEventId(0),
      sessionId: FILTERABLE_SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: at(0),
      actorId: EARLY_JOINER,
      payload: { sessionId: FILTERABLE_SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: fixtureEventId(1),
      sessionId: FILTERABLE_SESSION_ID,
      sequence: 1,
      kind: "run.rolled_back",
      occurredAt: at(1),
      actorId: LATE_JOINER,
      payload: {
        sessionId: FILTERABLE_SESSION_ID,
        runId: LIVE_RUN_ID,
        runVersion: 1,
        targetPosition: 0,
      },
    },
    {
      id: fixtureEventId(2),
      sessionId: FILTERABLE_SESSION_ID,
      sequence: 2,
      kind: "user.message",
      occurredAt: at(2),
      actorId: LATE_JOINER,
      payload: {},
    },
  ]);
  return sessionStore;
}

/**
 * A live run whose rows are tool rows, which are the ones that carry a disclosure.
 *
 * The only card in the shell that offers one, so it is the only row through which a
 * reader's expansion can be pressed at all — and therefore the only one that can show
 * the lease making the round trip out of the row and back.
 */
export function openSessionStoreWithToolRows(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: fixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      kind: "tool.invoked",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString(),
      payload: {
        sessionId: SESSION_ID,
        runId: LIVE_RUN_ID,
        toolName: `tool_${String(index)}`,
        toolCallId: `call-${String(index)}`,
      },
    })),
  );
  return sessionStore;
}

/** A log of general rows, so no chapter is open and the cap may actually apply. */
export function openSessionStoreWithGeneralLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: fixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      kind: "user.message",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString(),
      payload: {},
    })),
  );
  return sessionStore;
}

/**
 * Contribute the ledger's palette rows into this window's real command surface.
 *
 * The real one rather than a private registry, because the seam under test is
 * exactly that a command contributed at COMPOSITION time reaches a feed mounted
 * later. A test-owned surface would prove the acts fire and nothing about that.
 */
export function contributeLedgerCommands(): void {
  registerLedgerCommands(consoleCommandSurface);
}

/** Leave the window with none of this family's rows, so cases do not leak into each other. */
export function withdrawLedgerCommands(): void {
  consoleCommandSurface.contribute({
    owner: LEDGER_COMMAND_OWNER,
    commands: [],
    keyBindings: [],
  });
}

/** Run one contributed command by id, the way the palette does. */
export function dispatchConsoleCommand(commandId: string): void {
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

/** The rail wrapper, the control it reveals, and the two focusable ends of a tab. */
export function replayDockHarness(feed: HTMLElement): {
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

/** A laid-out rail box. Any non-zero extent will do; the painter needs one to size its store. */

/**
 * Record the ink every rail mark is painted with, for the length of one case.
 *
 * `happy-dom` answers `null` from `getContext` and zeroes from every rect, and the
 * painter treats both as "this host cannot paint" — correctly, which is why a case
 * about WHICH colour a mark takes has to supply both.
 */
export function recordRailInk(): string[] {
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
