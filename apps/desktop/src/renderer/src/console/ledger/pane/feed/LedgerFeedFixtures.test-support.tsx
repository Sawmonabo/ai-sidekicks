// The shared scaffolding every ledger-feed case is driven through.
//
// The feed's cases split by SUBJECT across several files — the rows, the rail, the
// absences, the narrowing, the replay dock, and the two seats — and every one of
// them needs the same three things: a laid-out box, a mount under a bridge, and a
// way to press a contributed palette row. Written once here, on
// `ledger/structure/timeline-rows.test-support.ts`' terms: a module beside the code it serves,
// consumed by tests and by nothing else.
//
// THE LOGS ARE NOT HERE. A store builder needs no DOM and no React, and the pane's
// pure-model cases read them without ever mounting anything, so they live in
// `ledger-feed-logs.test-support.ts` and this file holds only what has to render.
//
// `happy-dom` answers zero for every geometry read, which is why anything that needs
// the virtualizer to have a range stubs the two reads the chokepoint makes —
// `LedgerViewport.test.tsx`' stub, for its reason.

import { act, fireEvent, render } from "@testing-library/react";
import { vi } from "vitest";

import { LEDGER_WINDOW_ROW_CAP } from "../../../core/index.js";
import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { useLedgerRowLease } from "../../frame/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../bridge/scenarios/ledger-quiet.js";
import { consoleCommandSurface, consoleCommands } from "../../../palette/index.js";
import {
  LEDGER_COMMAND_OWNER,
  registerLedgerCommands,
} from "../../structure/structure-commands.js";
import { type SessionStore } from "../../../store/index.js";
import { type TimelineRowSlotProps } from "../../../seats/index.js";
import { LedgerFeed } from "./LedgerFeed.js";

export const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;

/** The deck pane every fixture feed is the body of, so its seat is read under one key. */
export const LEDGER_FIXTURE_PANE_ID = "pane-ledger-fixture";
const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;
export const LONG_LOG_EVENT_COUNT = 300;
export const REPLAY_LOG_EVENT_COUNT = 10;
export const OVER_CAP_EVENT_COUNT: number = LEDGER_WINDOW_ROW_CAP + 50;

/** A laid-out rail box. Any non-zero extent will do; the painter needs one to size its store. */
export const LAID_OUT_RAIL_BOX = { width: 20, height: 800 };

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
        paneId={LEDGER_FIXTURE_PANE_ID}
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

/** The facet bar's chip selector — shared, so two files never name it twice. */
export const LEDGER_FACET_CHIP = ".meridian-ledger-filter__facet";

/** One facet chip, by the value it offers. Refuses rather than answering null. */
export function facetChip(feed: HTMLElement, value: string): HTMLElement {
  const chip = [...feed.querySelectorAll<HTMLElement>(LEDGER_FACET_CHIP)].find(
    (candidate) =>
      candidate.querySelector(".meridian-ledger-filter__facet-value")?.textContent === value,
  );
  if (chip === undefined) {
    throw new Error(`the bar offered no facet for ${value}`);
  }
  return chip;
}

/** Open the find field the way the palette does, and type into it. */
export function typeIntoFind(feed: HTMLElement, query: string): void {
  contributeLedgerCommands();
  dispatchConsoleCommand("ledger.find");
  const input = feed.querySelector<HTMLInputElement>(".meridian-find__input");
  if (input === null) {
    throw new Error("the find command opened no field");
  }
  fireEvent.change(input, { target: { value: query } });
}
