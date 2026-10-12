// A feed whose history is read back held until a case releases it, each row id on its row, for the
// cases that watch rows wait out of the list until they draw whole. A recorder checks every change
// to the named rows and every frame for a formula drawn as its source, a diagram drawn as its
// source while it waits, a long table drawn whole or measured on screen, and a picture not yet
// decoded; another records each painted frame where a listed row paints over the one below it.

import { vi } from "vitest";

import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";
import type { TranscriptReadRequest } from "@ai-sidekicks/contracts/transcript/operations";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  DiagramPictures,
  DiagramPicturesContext,
} from "#renderer/components/Markdown/diagram/pictures.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { TranscriptFeed } from "#renderer/features/transcript/feed/components/TranscriptFeed.js";
import {
  openPagedSessionStore,
  scriptedTranscriptLog,
  transcriptFixtureEventId,
  transcriptFixtureStreamCursor,
} from "#renderer/features/transcript/logs.test-support.js";
import { WHOLE_TABLE_MAX_BODY_ROWS } from "#renderer/features/transcript/rows/markdown/table-window/long-tables.js";
import { prepareTranscriptRow } from "#renderer/features/transcript/rows/preparation.js";
import { type TranscriptRowProps } from "#renderer/features/transcript/rows/renderer.js";
import {
  TranscriptRow,
  drawsTranscriptRowBody,
} from "#renderer/features/transcript/rows/TranscriptRow.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { ROW_SELECTOR } from "../long-tool-feed.js";
import { PaintedFrameReader } from "../painted-frames.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { renderSettled } from "#test/helpers/app/harness.js";
import { SAME_LENGTH_TOLERANCE_PX } from "../windowed/long-table.js";

/** The rows the store opens with, the log's last; every row before them is history. */
const FIRST_OPEN_INDEX = 36;
/** How many rows the log holds. */
export const LOG_ROW_COUNT = 40;
/** The feed's box. */
const FEED_HEIGHT_PX = 700;
/** A whole case's budget: two workers load merman and draw, under a loaded machine. */
export const CASE_TIMEOUT_MS = 30_000;
/** A share far larger than these cases draw. */
export const PICTURE_CACHE_BYTE_CAP: number = 64 * 1024 * 1024;
/** The hidden frame a long table's rows are sampled in, on screen or off the list. */
export const SAMPLE_FRAME_SELECTOR = ".meridian-table-sample-frame";

/** Three paragraphs after the fences, as a reply closes its steps. */
export const SETTLING_PARAGRAPHS: string = "First step.\n\nSecond step.\n\nThird step.\n\n";

/** A reply holding a finished formula and a diagram whose one node is `label`. */
export function formulaAndDiagramReply(label: string): string {
  return (
    "Here is the change.\n\n```math\nE = mc^2\n```\n\n" +
    `\`\`\`mermaid\nflowchart LR\n  write --> ${label}\n\`\`\`\n\n${SETTLING_PARAGRAPHS}`
  );
}

/**
 * Watches the named rows on every change to the feed and every frame, and records each moment one
 * is on screen half-made, and when each first appeared.
 */
export class WholeRowRecorder {
  readonly halfMade: string[] = [];
  readonly firstSeenAtMs: Map<string, number> = new Map<string, number>();
  readonly #container: HTMLElement;
  readonly #rowIds: readonly string[];
  readonly #observer: MutationObserver;
  #isWatching = true;

  public constructor(container: HTMLElement, rowIds: readonly string[]) {
    this.#container = container;
    this.#rowIds = rowIds;
    this.#observer = new MutationObserver(() => {
      this.#check("change");
    });
    this.#observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const onFrame = (): void => {
      if (!this.#isWatching) {
        return;
      }
      this.#check("frame");
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  }

  public rowOf(rowId: string): HTMLElement | null {
    return this.#container.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
  }

  public stop(): void {
    this.#isWatching = false;
    this.#observer.disconnect();
  }

  #check(moment: "change" | "frame"): void {
    for (const rowId of this.#rowIds) {
      const row = this.rowOf(rowId);
      if (row === null) {
        continue;
      }
      if (!this.firstSeenAtMs.has(rowId)) {
        this.firstSeenAtMs.set(rowId, performance.now());
      }
      if (row.querySelector(".meridian-math--source") !== null) {
        this.halfMade.push(`${rowId} drew a formula as its source at a ${moment}`);
      }
      if (row.querySelector('.meridian-diagram[data-state="waiting"]') !== null) {
        this.halfMade.push(`${rowId} drew a diagram as its source at a ${moment}`);
      }
      if (row.querySelector(SAMPLE_FRAME_SELECTOR) !== null) {
        this.halfMade.push(`${rowId} measured a long table on screen at a ${moment}`);
      }
      for (const table of row.querySelectorAll("table")) {
        if (
          !table.hasAttribute("aria-rowcount") &&
          (table.tBodies[0]?.rows.length ?? 0) > WHOLE_TABLE_MAX_BODY_ROWS
        ) {
          this.halfMade.push(`${rowId} drew a long table whole at a ${moment}`);
        }
      }
      // A picture is decoded by the paint, so only a frame can tell whether it is blank.
      const picture = row.querySelector<HTMLImageElement>(".meridian-diagram__picture");
      if (moment === "frame" && picture !== null && !picture.complete) {
        this.halfMade.push(`${rowId} painted its picture before it decoded`);
      }
    }
  }
}

/**
 * Holds every image decode the page starts until `release`, each settling as the engine's own
 * decode does once released. The case restores the spy.
 */
export function holdImageDecodes(): {
  readonly heldCount: () => number;
  readonly release: () => void;
} {
  const decode = HTMLImageElement.prototype.decode;
  const held: (() => void)[] = [];
  let isHeld = true;
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    const decoded = decode.call(this);
    return isHeld
      ? new Promise<void>((resolve, reject) => {
          held.push(() => {
            decoded.then(resolve, reject);
          });
        })
      : decoded;
  });
  return {
    heldCount: () => held.length,
    release: () => {
      isHeld = false;
      for (const settle of held) {
        settle();
      }
    },
  };
}

/** A transcript row with its id on it, so the recorder can find it. */
function TaggedTranscriptRow(props: TranscriptRowProps): React.JSX.Element {
  return (
    <div data-row-id={props.row.id}>
      <TranscriptRow {...props} />
    </div>
  );
}

/**
 * History read back as the daemon serves it, the rows at `bodies`' indexes as replies carrying
 * those bodies, the rows at `largeBodies`' as replies carrying those bodies' sizes alone, and
 * every read held until the case releases it.
 */
export function heldHistoryRead(
  bodies: ReadonlyMap<number, string>,
  largeBodies: ReadonlyMap<number, string> = new Map(),
): {
  readonly read: TranscriptPageRead;
  readonly requests: TranscriptReadRequest[];
  readonly release: () => void;
} {
  const log = scriptedTranscriptLog(LOG_ROW_COUNT);
  const contentById = new Map<string, TranscriptRowContent>([
    ...[...bodies].map(
      ([index, body]) => [transcriptFixtureEventId(index), { status: "available", body }] as const,
    ),
    ...[...largeBodies].map(
      ([index, body]) =>
        [
          transcriptFixtureEventId(index),
          { status: "large", contentLength: new TextEncoder().encode(body).byteLength },
        ] as const,
    ),
  ]);
  const requests: TranscriptReadRequest[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    requests,
    release: () => {
      release();
    },
    read: async (request) => {
      requests.push(request);
      await released;
      const answer = await log.read(request);
      return answer.status !== "served"
        ? answer
        : {
            ...answer,
            value: {
              ...answer.value,
              entries: answer.value.entries.map((row) => {
                const content = contentById.get(row.id);
                return content !== undefined && row.kind === "general"
                  ? { ...row, type: "assistant.message", content }
                  : row;
              }),
            },
          };
    },
  };
}

/**
 * The feed over `sessionStore`, the log's last rows unless given, its history behind `read`,
 * drawing diagrams in `pictures`, a large body read in full through `readBody`.
 */
export async function mountFeed(
  read: TranscriptPageRead | undefined,
  pictures: DiagramPictures,
  readBody?: TranscriptBodyRead,
  sessionStore: SessionStore = openPagedSessionStore(FIRST_OPEN_INDEX, LOG_ROW_COUNT - 1, {
    cursor: transcriptFixtureStreamCursor(FIRST_OPEN_INDEX - 1),
    hasMore: true,
  }),
): Promise<HTMLElement> {
  installMeridianTokens(document);
  // The wall clock, not the scenario's frozen one, so the feed runs on real frames.
  const Wrapper = bridgeWrapper(createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO }).bridge);
  const { container } = await renderSettled(
    <Wrapper>
      <LiveAnnouncerProvider>
        <DiagramPicturesContext.Provider value={pictures}>
          <div style={{ display: "grid", height: `${String(FEED_HEIGHT_PX)}px`, width: "800px" }}>
            <TranscriptFeed
              sessionStore={sessionStore}
              rowRenderer={{
                render: TaggedTranscriptRow,
                drawsBody: drawsTranscriptRowBody,
                prepareRow: prepareTranscriptRow,
              }}
              feedLabel="Transcript"
              readTranscriptPage={read}
              readTranscriptBody={readBody}
            />
          </div>
        </DiagramPicturesContext.Provider>
      </LiveAnnouncerProvider>
    </Wrapper>,
  );
  return container;
}

/** Records each painted frame where a listed row paints over the listed row below it. */
export class PaintedOverlapRecorder {
  readonly overlaps: string[] = [];
  readonly #frames: PaintedFrameReader<string | undefined>;

  public constructor() {
    this.#frames = new PaintedFrameReader(ROW_SELECTOR, listedRowOverlap, (overlap) => {
      if (overlap !== undefined) {
        this.overlaps.push(overlap);
      }
    });
  }

  public stop(): void {
    this.#frames.stop();
  }
}

/** The first listed row that paints over the listed row below it, or `undefined` when none does. */
function listedRowOverlap(): string | undefined {
  const rows = [...document.querySelectorAll(ROW_SELECTOR)]
    .map((row) => ({
      rowId: row.querySelector<HTMLElement>("[data-row-id]")?.dataset["rowId"],
      box: row.getBoundingClientRect(),
    }))
    .sort((first, second) => first.box.top - second.box.top);
  for (const [index, upper] of rows.entries()) {
    const lower = rows[index + 1];
    if (lower !== undefined && upper.box.bottom - lower.box.top > SAME_LENGTH_TOLERANCE_PX) {
      return `${String(upper.rowId)} painted over ${String(lower.rowId)} by ${String(upper.box.bottom - lower.box.top)} px`;
    }
  }
  return undefined;
}
