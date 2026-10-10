// What folds in the mounted feed and where a fold leaves the reader: nothing folds itself, a folded
// call stays folded while it is scrolled away, and the palette's two rows fold and open every
// group around the row nearest the middle of the view. Where a press on one header leaves that
// header needs real layout, so it is proven in the browser tier.

import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishCommandWindow } from "#renderer/registries/commands/command-window.js";
import { ViewportController } from "../../viewport/controller.js";
import { withLaidOutViewport } from "../../viewport/controller.test-support.js";
import {
  LIVE_RUN_ID,
  SESSION_ID,
  openSessionStoreWithGeneralLog,
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../../logs.test-support.js";
import {
  RUNS_AMONG_MESSAGES,
  openSessionStoreWithRunsAmongMessages,
  openSessionStoreWithSystemMessage,
} from "../../runs/groups.logs.test-support.js";
import {
  CallFoldingRowBody,
  RowIdBody,
  boundController,
  contributeTranscriptCommands,
  dispatchCommand,
  readerScrollsTo,
  renderFeed,
  scrollContainerOf,
  withdrawTranscriptCommands,
} from "./TranscriptFeed.test-support.js";

beforeEach(() => {
  // A command acts in the window used last; the test's document stands in for it.
  publishCommandWindow(() => document);
  contributeTranscriptCommands();
});

afterEach(() => {
  withdrawTranscriptCommands();
  vi.restoreAllMocks();
});

const RUN_GROUP_HEADER_BUTTON = ".meridian-run-group-header__disclosure";

/** A log of messages long enough that its newest rows leave the drawn range at its top. */
const MESSAGE_LOG_EVENT_COUNT = 40;

/** Whether the window mounted the row for the event at one log position. */
function isMounted(feed: HTMLElement, index: number): boolean {
  return feed.querySelector(`[data-row-id="${transcriptFixtureEventId(index)}"]`) !== null;
}

/** Every run group header button the feed drew. */
function headerButtons(feed: HTMLElement): HTMLButtonElement[] {
  return [...feed.querySelectorAll<HTMLButtonElement>(RUN_GROUP_HEADER_BUTTON)];
}

/** The header button of the run whose newest state is `runState`, refusing rather than null. */
function headerButtonOf(feed: HTMLElement, runState: string): HTMLButtonElement {
  const header = headerButtons(feed).find((button) =>
    (button.textContent ?? "").includes(runState),
  );
  if (header === undefined) {
    throw new Error(`the feed drew no run group header reading ${runState}`);
  }
  return header;
}

/** How far below the top of the box one row of the list starts. */
function offsetOnScreenPx(
  controller: ViewportController,
  scrollContainer: HTMLElement,
  rowKey: string,
): number {
  const startPx = controller.rowStartPx(rowKey);
  if (startPx === undefined) {
    throw new Error(`the list holds no row keyed ${rowKey}`);
  }
  return startPx - scrollContainer.scrollTop;
}

/** The ids of a run's member rows, from one log position through another. */
function eventIdsFrom(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_unused, offset) =>
    transcriptFixtureEventId(first + offset),
  );
}

/** Two runs among messages, mounted in a box that opens at its tail as the app's does. */
function openRunsAmongMessages(): {
  readonly feed: HTMLElement;
  readonly controller: ViewportController;
  readonly scrollContainer: HTMLElement;
} {
  withLaidOutViewport({ content: "laid-out" });
  const bindings = vi.spyOn(ViewportController.prototype, "bindVirtualizer");
  const feed = renderFeed(openSessionStoreWithRunsAmongMessages(), undefined, RowIdBody);
  return { feed, controller: boundController(bindings), scrollContainer: scrollContainerOf(feed) };
}

describe("the transcript feed — nothing folds itself", () => {
  it("keeps a run open when it ends", () => {
    withLaidOutViewport();
    const sessionStore = openSessionStoreWithSystemMessage();
    const feed = renderFeed(sessionStore, undefined, RowIdBody);
    expect(headerButtonOf(feed, "run.running").getAttribute("aria-expanded")).toBe("true");
    expect(isMounted(feed, 2)).toBe(true);

    act(() => {
      sessionStore.applyBatch([
        {
          id: transcriptFixtureEventId(3),
          sessionId: SESSION_ID,
          sequence: 3,
          cursor: transcriptFixtureStreamCursor(3),
          kind: "run.completed",
          occurredAt: transcriptFixtureStampAt(3),
          payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID, newState: "completed" },
          runStamp: { position: 3, epoch: 0 },
        },
      ]);
    });

    expect(headerButtonOf(feed, "run.completed").getAttribute("aria-expanded")).toBe("true");
    expect(isMounted(feed, 2)).toBe(true);
  });
});

describe("the transcript feed — a folded call", () => {
  it("stays folded after it scrolls out of the drawn rows and back", () => {
    withLaidOutViewport({ content: "laid-out" });
    const newestIndex = MESSAGE_LOG_EVENT_COUNT - 1;
    const feed = renderFeed(
      openSessionStoreWithGeneralLog(MESSAGE_LOG_EVENT_COUNT),
      undefined,
      CallFoldingRowBody,
    );
    const scrollContainer = scrollContainerOf(feed);
    const newestRow = (): HTMLElement | null =>
      feed.querySelector<HTMLElement>(`[data-row-id="${transcriptFixtureEventId(newestIndex)}"]`);
    expect(newestRow()?.dataset["density"]).toBe("expanded");

    fireEvent.click(newestRow() as Element);
    expect(newestRow()?.dataset["density"]).toBe("collapsed");

    readerScrollsTo(scrollContainer, 0);
    expect(newestRow()).toBeNull();
    readerScrollsTo(scrollContainer, scrollContainer.scrollHeight - scrollContainer.clientHeight);

    expect(newestRow()?.dataset["density"]).toBe("collapsed");
  });
});

describe("the transcript feed — Fold every run and Unfold every run", () => {
  /**
   * The runs among messages, read with a message between the two runs at the middle of the box
   * and the ended run's rows at its top, so a hold on the top row would hold a row that folds
   * away.
   */
  function openAtMessageBetweenRuns(): {
    readonly feed: HTMLElement;
    readonly controller: ViewportController;
    readonly scrollContainer: HTMLElement;
    readonly middleRowKey: string;
  } {
    const opened = openRunsAmongMessages();
    const { controller, scrollContainer } = opened;
    const middleRowKey = transcriptFixtureEventId(RUNS_AMONG_MESSAGES.betweenRunsMiddle);
    const middleStartPx = controller.rowStartPx(middleRowKey) ?? Number.NaN;
    readerScrollsTo(scrollContainer, middleStartPx + 1 - scrollContainer.clientHeight / 2);
    const firstBetweenRuns = transcriptFixtureEventId(RUNS_AMONG_MESSAGES.betweenRunsFirst);
    expect(controller.rowStartPx(firstBetweenRuns)).toBeGreaterThan(scrollContainer.scrollTop);
    return { ...opened, middleRowKey };
  }

  it("folds every group and opens every one, as every header then says", () => {
    const { feed } = openAtMessageBetweenRuns();
    const memberIds = [
      ...eventIdsFrom(RUNS_AMONG_MESSAGES.endedRunFirst, RUNS_AMONG_MESSAGES.endedRunLast),
      ...eventIdsFrom(RUNS_AMONG_MESSAGES.liveRunFirst, RUNS_AMONG_MESSAGES.liveRunLast),
    ];

    dispatchCommand("transcript.foldEveryRun");

    const foldedHeaders = headerButtons(feed);
    expect(foldedHeaders).toHaveLength(2);
    expect(foldedHeaders.map((header) => header.getAttribute("aria-expanded"))).toStrictEqual([
      "false",
      "false",
    ]);
    expect(memberIds.filter((rowId) => feed.querySelector(`[data-row-id="${rowId}"]`))).toEqual([]);

    dispatchCommand("transcript.unfoldEveryRun");

    const openedHeaders = headerButtons(feed);
    expect(openedHeaders.length).toBeGreaterThan(0);
    expect(openedHeaders.every((header) => header.getAttribute("aria-expanded") === "true")).toBe(
      true,
    );
    expect(isMounted(feed, RUNS_AMONG_MESSAGES.liveRunFirst + 1)).toBe(true);
  });

  it("keeps the row nearest the middle of the box where it stands through either", () => {
    const { controller, scrollContainer, middleRowKey } = openAtMessageBetweenRuns();
    const offsetBeforePx = offsetOnScreenPx(controller, scrollContainer, middleRowKey);
    const startBeforePx = controller.rowStartPx(middleRowKey) ?? Number.NaN;

    dispatchCommand("transcript.foldEveryRun");

    // The ended run above it folded, so the row moved up the list and the box followed it.
    expect(controller.rowStartPx(middleRowKey)).toBeLessThan(startBeforePx);
    expect(offsetOnScreenPx(controller, scrollContainer, middleRowKey)).toBeCloseTo(
      offsetBeforePx,
      0,
    );

    dispatchCommand("transcript.unfoldEveryRun");

    expect(controller.rowStartPx(middleRowKey)).toBeCloseTo(startBeforePx, 0);
    expect(offsetOnScreenPx(controller, scrollContainer, middleRowKey)).toBeCloseTo(
      offsetBeforePx,
      0,
    );
  });
});
