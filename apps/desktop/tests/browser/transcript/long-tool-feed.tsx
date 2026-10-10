// The real feed over a log many times longer than the window keeps, for the suites that scroll it
// far in the engine that lays the rows out: each row a tool call named for its place, the
// clipboard's writes recorded, and the page's text drawn above and below the transcript. One log
// is held whole in the store; the other is opened as the app opens a session, its runs' calls
// served as history. The same mount draws any store, with its history behind a page read.

import { act, getConfig } from "@testing-library/react";
import { expect, vi } from "vitest";

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";
import type { TranscriptReadRequest } from "@ai-sidekicks/contracts/transcript/operations";

import type { TextClipboardContent } from "#shared/preload-api.js";
import { letFramesPassUntilStill } from "../../helpers/animation-frame.js";
import { bridgeWrapper } from "../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../helpers/app/harness.js";
import { settleFrames } from "./windowed/reply.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { TranscriptFeed } from "#renderer/features/transcript/feed/components/TranscriptFeed.js";
import { transcriptOpeningPageLimit } from "#renderer/features/transcript/history/page-limit.js";
import {
  openPagedSessionStore,
  openSessionStoreWithToolRows,
  PAGED_SESSION_ID,
  readRowOf,
  scriptedTranscriptLog,
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "#renderer/features/transcript/logs.test-support.js";
import { projectTranscriptRows } from "#renderer/features/transcript/projection/rows.js";
import {
  TranscriptRow,
  drawsTranscriptRowBody,
} from "#renderer/features/transcript/rows/TranscriptRow.js";
import { type Clock } from "#renderer/lib/clock.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";

/** A log many times longer than the window keeps around the reader. */
export const TOOL_ROW_COUNT = 900;
/** The feed's box: a screen height of the window is this tall. */
export const FEED_HEIGHT_PX = 600;
/** A drawn row of the list. */
export const ROW_SELECTOR = ".meridian-transcript-viewport__row";
/** The text drawn above the transcript, where a session header sits, and below it. */
export const SESSION_HEADER_TEXT = "Session header above the transcript";
export const COMPOSER_TEXT = "Composer below the transcript";
/** The tool calls each run of the history log makes, few enough that no run's window clips. */
const CALLS_PER_RUN = 10;
/** A run's events: it starts running, makes its calls, and completes. */
const EVENTS_PER_RUN = CALLS_PER_RUN + 2;
/** The length a tool call's unread body is counted at. */
const TOOL_BODY_LENGTH = 64;
/** Longer than the pause that ends one scroll gesture, so each wheel step admits on its own. */
const GESTURE_PAUSE_MS = 200;
/** The frames the list holds still for once a gesture's scroll has been heard and drawn. */
const GESTURE_STILL_FRAME_COUNT = 3;

/** The log position a drawn tool row names, read from its tool name. */
export function positionOfRow(row: Element): number | undefined {
  const name = row.querySelector(".meridian-tool-card__name")?.textContent;
  const match = name === undefined ? null : /^tool_(\d+)$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Waits out one gesture: until the list holds still, so whatever the scroll set off has landed,
 * then the pause that ends a gesture, so the next scroll is a gesture of its own, and until it
 * holds still again. React renders as it does in the app rather than held until the wait ends.
 */
export async function endGesture(scroller: HTMLElement): Promise<void> {
  await letFramesPassUntilStill(scroller, GESTURE_STILL_FRAME_COUNT);
  await getConfig().asyncWrapper(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, GESTURE_PAUSE_MS);
    });
  });
  await letFramesPassUntilStill(scroller, GESTURE_STILL_FRAME_COUNT);
}

/** The mounted feed and what the case reads back: the clipboard writes and the drawn rows. */
export interface MountedFeed {
  readonly scroller: HTMLElement;
  readonly copied: readonly TextClipboardContent[];
}

/**
 * The long tool log, its store keeping every row, and the case's view of it, on `clock` (the wall
 * clock, when `undefined`).
 */
export async function mountLongToolFeed(
  clock?: Clock,
): Promise<MountedFeed & { readonly sessionId: string }> {
  const sessionStore = openSessionStoreWithToolRows(TOOL_ROW_COUNT);
  const mounted = await mountTranscriptFeed(sessionStore, undefined, clock);
  return { ...mounted, sessionId: sessionStore.sessionId };
}

/**
 * The long tool log as the app opens a session: its runs' calls, each named for its place among
 * the calls, served by `transcript.read` as run rows, the store holding the last page and the
 * rest read back as the reader scrolls.
 */
export async function mountLongToolHistory(): Promise<MountedHistory> {
  const eventCount = (TOOL_ROW_COUNT / CALLS_PER_RUN) * EVENTS_PER_RUN;
  return mountPagedHistory(Array.from({ length: eventCount }, (_, index) => toolRunEventAt(index)));
}

/** The mounted feed over a paged log, and the history reads it asked. */
export interface MountedHistory extends MountedFeed {
  readonly historyReads: readonly TranscriptReadRequest[];
}

/**
 * `events` as the app opens a session: the store holding the opening page, the last events, and
 * the rest served by `transcript.read` as the reader scrolls back.
 */
export async function mountPagedHistory(
  events: readonly ProjectedSessionEvent[],
): Promise<MountedHistory> {
  const eventCount = events.length;
  const openingFirstIndex = eventCount - transcriptOpeningPageLimit(window);
  const sessionStore = openPagedSessionStore(
    openingFirstIndex,
    eventCount - 1,
    { cursor: transcriptFixtureStreamCursor(openingFirstIndex - 1), hasMore: true },
    (index) => events[index] ?? expect.fail(`the log holds event ${String(index)}`),
  );
  const rows = projectTranscriptRows(events).rows;
  const history = scriptedTranscriptLog(eventCount, (index) =>
    readRowOf(rows[index] ?? expect.fail(`the log holds row ${String(index)}`)),
  );
  return {
    ...(await mountTranscriptFeed(sessionStore, history.read)),
    historyReads: history.requests,
  };
}

/**
 * The real feed over `sessionStore` between the page's text above and below it, its history read
 * through `readTranscriptPage` (none, when `undefined`), on `clock` (the wall clock, when
 * `undefined`), a large body read in full through `readTranscriptBody` (none, when `undefined`).
 */
export async function mountTranscriptFeed(
  sessionStore: SessionStore,
  readTranscriptPage: TranscriptPageRead | undefined,
  clock?: Clock,
  readTranscriptBody?: TranscriptBodyRead,
): Promise<MountedFeed> {
  installMeridianTokens(document);
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const copied: TextClipboardContent[] = [];
  vi.spyOn(fixture.bridge.native, "copyToClipboard").mockImplementation(async (content) => {
    copied.push("text" in content ? content : expect.fail("the transcript copies text"));
  });
  // A formatted flavor added after its text is a write, while the clipboard still holds the text.
  vi.spyOn(fixture.bridge.native, "addClipboardFormatting").mockImplementation(async (content) => {
    if (copied.at(-1)?.text !== content.text) {
      return false;
    }
    copied.push(content);
    return true;
  });
  // The wall clock by default, not the scenario's frozen one: a scroll gesture is told by the time
  // between the reader's scroll samples.
  const Wrapper = bridgeWrapper(fixture.bridge, clock);
  const { container } = await renderSettled(
    <Wrapper>
      <LiveAnnouncerProvider>
        <p data-testid="session-header">{SESSION_HEADER_TEXT}</p>
        <div style={{ display: "grid", height: `${String(FEED_HEIGHT_PX)}px`, width: "800px" }}>
          <TranscriptFeed
            sessionStore={sessionStore}
            rowRenderer={{
              render: TranscriptRow,
              drawsBody: drawsTranscriptRowBody,
              prepareRow: () => undefined,
            }}
            feedLabel="Transcript"
            readTranscriptPage={readTranscriptPage}
            readTranscriptBody={readTranscriptBody}
          />
        </div>
        <p data-testid="composer">{COMPOSER_TEXT}</p>
      </LiveAnnouncerProvider>
    </Wrapper>,
  );
  // The rows are shown once the faces they draw in have landed, which can outlast the mount. Each
  // look waits on the faces inside its own act, so the render their landing asks for is drawn.
  const viewport =
    container.querySelector(".meridian-transcript-viewport") ??
    expect.fail("the feed draws its viewport");
  await expect
    .poll(async () => {
      await act(async () => {
        await document.fonts.ready;
      });
      return getComputedStyle(viewport).visibility;
    })
    .toBe("visible");
  await settleFrames();
  const scroller =
    viewport.querySelector<HTMLElement>(".meridian-transcript-viewport__scroll-container") ??
    expect.fail("the feed draws its scroller");
  return { scroller, copied };
}

/** The history log's event at `index`: a run's start, one of its tool calls, or its end. */
function toolRunEventAt(index: number): ProjectedSessionEvent {
  const runIndex = Math.floor(index / EVENTS_PER_RUN);
  const position = index % EVENTS_PER_RUN;
  const runId = `019b793b-7b60-740e-8110-${runIndex.toString(16).padStart(12, "0")}`;
  const callIndex = runIndex * CALLS_PER_RUN + position - 1;
  const common = {
    id: transcriptFixtureEventId(index),
    sessionId: PAGED_SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    occurredAt: transcriptFixtureStampAt(index),
    runStamp: { position, epoch: 0 },
  };
  if (position === 0 || position === EVENTS_PER_RUN - 1) {
    return {
      ...common,
      kind: position === 0 ? "run.running" : "run.completed",
      payload: { sessionId: PAGED_SESSION_ID, runId },
    };
  }
  return {
    ...common,
    kind: "tool.invoked",
    payload: {
      sessionId: PAGED_SESSION_ID,
      runId,
      toolName: `tool_${String(callIndex)}`,
      toolCallId: `call-${String(callIndex)}`,
      [CONTENT_LENGTH_PAYLOAD_KEY]: TOOL_BODY_LENGTH,
    },
  };
}
