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
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { consoleCommandSurface, consoleCommands } from "../../frame/command-surface.js";
import { LEDGER_WINDOW_ROW_CAP } from "../../ledger/frame/frame-bounds.js";
import { LEDGER_COMMAND_OWNER, registerLedgerCommands } from "../../ledger/structure/index.js";
import { SessionStore } from "../../store/index.js";
import { type TimelineRowSlotProps } from "../../workspace/index.js";
import { LedgerFeed } from "./LedgerFeed.js";

export const SESSION_ID = "session-ledger-feed";
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

/** A log of general rows, so no chapter is open and the cap may actually apply. */
export function openSessionStoreWithGeneralLog(count: number): SessionStore {
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
