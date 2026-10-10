// A transcript feed with history before its head, for the tiers that lay it out in a browser: the
// row-hold case measures its history line and the accessibility tier audits it. The box is narrow
// enough that the failed read's words wrap onto a second line, and every read waits until the case
// lets it land, so the line can be caught while it reads.

import { changeLayout, letObserversAnswer } from "../animation-frame.js";
import { spiedAnnouncer } from "../spied-announcer.js";
import { FixtureBridgeProvider } from "../app/frame-fixtures.js";
import { renderSettled } from "../app/harness.js";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { TranscriptFeed } from "#renderer/features/transcript/feed/components/TranscriptFeed.js";
import {
  openPagedSessionStore,
  scriptedTranscriptLog,
  transcriptFixtureStreamCursor,
  type ScriptedTranscriptLog,
} from "#renderer/features/transcript/logs.test-support.js";
import { type TranscriptRowProps } from "#renderer/features/transcript/rows/renderer.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript-page.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { type SessionStore } from "#renderer/store/session/store.js";

/** The feed's box: narrow, so the failed read's words wrap, and shorter than its rows. */
const BOX_WIDTH_PX = 200;
/** The box's height, in pixels. */
export const EARLIER_HISTORY_BOX_HEIGHT_PX = 480;
/** Every row's height, in pixels. */
export const EARLIER_HISTORY_ROW_HEIGHT_PX = 60;
/** The rows before the store's head, which one stretch reads whole. */
const ROWS_BEFORE_HEAD = 10;
/** The rows the store holds when the feed opens. */
const WINDOW_ROWS = 30;

/**
 * The mounted feed, its store and log, what its announcer said, and the one act that lands the
 * oldest waiting read.
 */
export interface EarlierHistoryFeed {
  readonly container: HTMLElement;
  readonly scrollContainer: HTMLElement;
  readonly sessionStore: SessionStore;
  readonly log: ScriptedTranscriptLog;
  /** Every sentence the window's announcer was asked to say, in order. */
  readonly spoken: () => readonly string[];
  /** Answers the oldest read still waiting, and lets the layout settle. */
  readonly landRead: () => Promise<void>;
}

/** Mounts the feed over a store whose head has rows before it, its observers answered. */
export async function mountEarlierHistoryFeed(): Promise<EarlierHistoryFeed> {
  const log = scriptedTranscriptLog(ROWS_BEFORE_HEAD + WINDOW_ROWS);
  const waitingReads: (() => void)[] = [];
  const read: TranscriptPageRead = (request) =>
    new Promise((resolve) => {
      waitingReads.push(() => {
        resolve(log.read(request));
      });
    });
  const sessionStore = openPagedSessionStore(ROWS_BEFORE_HEAD, ROWS_BEFORE_HEAD + WINDOW_ROWS - 1, {
    cursor: transcriptFixtureStreamCursor(ROWS_BEFORE_HEAD - 1),
    hasMore: true,
  });
  const announcer = spiedAnnouncer();
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      <LiveAnnouncerProvider announcer={announcer.announcer}>
        <div
          style={{
            display: "grid",
            width: `${String(BOX_WIDTH_PX)}px`,
            height: `${String(EARLIER_HISTORY_BOX_HEIGHT_PX)}px`,
          }}
        >
          <TranscriptFeed
            sessionStore={sessionStore}
            rowRenderer={{
              render: FixedHeightRow,
              drawsBody: () => true,
              prepareRow: () => undefined,
            }}
            feedLabel="Transcript"
            readTranscriptPage={read}
          />
        </div>
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  await letObserversAnswer();
  const scrollContainer = container.querySelector<HTMLElement>(
    ".meridian-transcript-viewport__scroll-container",
  );
  if (scrollContainer === null) {
    throw new Error("the feed rendered no scroll container");
  }
  return {
    container,
    scrollContainer,
    sessionStore,
    log,
    spoken: announcer.spoken,
    landRead: async () => {
      await changeLayout(() => {
        waitingReads.shift()?.();
      });
      await letObserversAnswer();
    },
  };
}

/** A row body of a fixed height, naming its row by id. */
function FixedHeightRow(props: TranscriptRowProps): React.JSX.Element {
  return (
    <p
      data-row-id={props.row.id}
      style={{ margin: 0, height: `${String(EARLIER_HISTORY_ROW_HEIGHT_PX)}px` }}
    />
  );
}
