// A reply holding a finished formula and a diagram is drawn whole on the first frame it appears
// in, in the engine that lays the rows out and paints them. The feed reads a page of history whose
// replies already hold their text, and the diagram worker's answers are held back, so a reply is
// ready only once they land: until then it is not in the list, and the rows beside it are. A
// diagram that cannot be drawn lets its reply in as its failure. A recorder checks every change to
// the rows and every frame for a formula drawn as its source, a diagram drawn as its source while
// it waits, and a picture not yet decoded. Each reply's body arrives on its row in the page read,
// as the daemon serves history, and the reply is prepared from it before it is listed. The
// pictures' decodes are held too, so a reply whose picture is drawn but not decoded is seen still
// out of the list. A listed reply whose large body is opened keeps drawing as it stood until the
// body it read draws whole.

import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";
import type { TranscriptReadRequest } from "@ai-sidekicks/contracts/transcript/operations";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  DiagramPictures,
  DiagramPicturesContext,
} from "#renderer/components/Markdown/diagram/pictures.js";
import {
  startDiagramWorker,
  type DiagramWorkerPort,
} from "#renderer/components/Markdown/diagram/worker/connection.js";
import type {
  DiagramWorkerReply,
  DiagramWorkerRequest,
} from "#renderer/components/Markdown/diagram/worker/messages.js";
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
import { letFramesPass, nextFrame } from "../../helpers/animation-frame.js";
import { ROW_SELECTOR } from "./long-tool-feed.js";
import { PaintedFrameReader } from "./painted-frames.js";
import { readerScrollsTo } from "./reader-scroll.js";
import { bridgeWrapper } from "../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../helpers/app/harness.js";
import {
  SAME_LENGTH_TOLERANCE_PX,
  benchTable,
  headWidthsOf,
  replyWith,
} from "./windowed/long-table.js";

/** The rows the store opens with, the log's last; every row before them is history. */
const FIRST_OPEN_INDEX = 36;
const LOG_ROW_COUNT = 40;
/** A reply in the first page read back, holding a formula and a diagram. */
const FORMULA_AND_DIAGRAM_INDEX = 30;
/** A reply in the same page whose diagram merman refuses. */
const REFUSED_DIAGRAM_INDEX = 32;
/** How long the diagram worker's answers are held back, under its own deadline. */
const ANSWER_DELAY_MS = 400;
/** The feed's box. */
const FEED_HEIGHT_PX = 700;
/** A whole case's budget: two workers load merman and draw, under a loaded machine. */
const CASE_TIMEOUT_MS = 30_000;
/** A share far larger than these cases draw. */
const PICTURE_CACHE_BYTE_CAP = 64 * 1024 * 1024;

/** Three paragraphs after the fences, as a reply closes its steps. */
const SETTLING_PARAGRAPHS = "First step.\n\nSecond step.\n\nThird step.\n\n";

function formulaAndDiagramReply(label: string): string {
  return (
    "Here is the change.\n\n```math\nE = mc^2\n```\n\n" +
    `\`\`\`mermaid\nflowchart LR\n  write --> ${label}\n\`\`\`\n\n${SETTLING_PARAGRAPHS}`
  );
}

const REFUSED_DIAGRAM_REPLY = `\`\`\`mermaid\nflowchart TD\n  A --> B\n  B --> [Fix it\n\`\`\`\n\n${SETTLING_PARAGRAPHS}`;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The real diagram worker, its drawings' answers held back `delayMs`: the page and the worker
 * otherwise speak as they do in the app, labels measured and all.
 */
class DelayedDiagramWorker implements DiagramWorkerPort {
  public onmessage: ((event: MessageEvent<DiagramWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly #worker = startDiagramWorker();

  public constructor(delayMs: number) {
    this.#worker.onmessage = (event) => {
      const isDrawing = event.data.status === "settled" || event.data.status === "unmeasured";
      if (isDrawing) {
        setTimeout(() => this.onmessage?.(event), delayMs);
      } else {
        this.onmessage?.(event);
      }
    };
    this.#worker.onerror = (event) => this.onerror?.(event);
    this.#worker.onmessageerror = (event) => this.onmessageerror?.(event);
  }

  public postMessage(request: DiagramWorkerRequest): void {
    this.#worker.postMessage(request);
  }

  public terminate(): void {
    this.#worker.terminate();
  }
}

/**
 * Watches the named rows on every change to the feed and every frame, and records each moment one
 * is on screen half-made, and when each first appeared.
 */
class WholeRowRecorder {
  readonly halfMade: string[] = [];
  readonly firstSeenAtMs = new Map<string, number>();
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
 * decode does once released. The spy is restored after each case.
 */
function holdImageDecodes(): { readonly heldCount: () => number; readonly release: () => void } {
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
function heldHistoryRead(
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
 * The feed over the store's last rows, its history behind `read`, drawing diagrams in `pictures`,
 * a large body read in full through `readBody`.
 */
async function mountFeed(
  read: TranscriptPageRead,
  pictures: DiagramPictures,
  readBody?: TranscriptBodyRead,
): Promise<HTMLElement> {
  installMeridianTokens(document);
  const sessionStore = openPagedSessionStore(FIRST_OPEN_INDEX, LOG_ROW_COUNT - 1, {
    cursor: transcriptFixtureStreamCursor(FIRST_OPEN_INDEX - 1),
    hasMore: true,
  });
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

describe("a reply read back with a finished formula and diagram", () => {
  it(
    "joins the list only once drawn whole, its neighbors at once, a refused diagram as its failure",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const pictures = new DiagramPictures(
        PICTURE_CACHE_BYTE_CAP,
        () => new DelayedDiagramWorker(ANSWER_DELAY_MS),
        () => undefined,
      );
      const history = heldHistoryRead(
        new Map([
          [FORMULA_AND_DIAGRAM_INDEX, formulaAndDiagramReply("store")],
          [REFUSED_DIAGRAM_INDEX, REFUSED_DIAGRAM_REPLY],
        ]),
      );
      const decodes = holdImageDecodes();
      const container = await mountFeed(history.read, pictures);
      const replyId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX);
      const refusedId = transcriptFixtureEventId(REFUSED_DIAGRAM_INDEX);
      const neighborId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX + 1);
      await waitFor(() => {
        expect(history.requests.length).toBeGreaterThan(0);
      });

      const recorder = new WholeRowRecorder(container, [replyId, refusedId, neighborId]);
      const releasedAtMs = performance.now();
      await act(async () => {
        history.release();
        await nextFrame();
      });
      // The reply's picture is drawn and decoding: the refused diagram's reply is in, it is not.
      await waitFor(
        () => {
          expect(decodes.heldCount()).toBeGreaterThan(0);
          expect(recorder.rowOf(refusedId)?.textContent).toContain("Could not draw this diagram");
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      expect(recorder.rowOf(replyId)).toBe(null);
      decodes.release();
      await waitFor(
        () => {
          expect(recorder.rowOf(replyId)?.querySelector(".meridian-diagram__picture")).not.toBe(
            null,
          );
          expect(recorder.rowOf(refusedId)?.textContent).toContain("Could not draw this diagram");
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      recorder.stop();

      expect(recorder.halfMade).toEqual([]);
      expect(recorder.rowOf(replyId)?.querySelector(".meridian-math--display")).not.toBe(null);
      // The neighbor waited on nothing, so it was listed before the reply's answers landed.
      const neighborSeenAt = recorder.firstSeenAtMs.get(neighborId) ?? expect.fail("drawn");
      const replySeenAt = recorder.firstSeenAtMs.get(replyId) ?? expect.fail("drawn");
      expect(neighborSeenAt).toBeLessThan(replySeenAt);
      expect(replySeenAt - releasedAtMs).toBeGreaterThanOrEqual(ANSWER_DELAY_MS);
    },
  );
});

/** Where each row on screen stands below the top of the box, by row id. */
function rowsOnScreen(scrollContainer: HTMLElement): Map<string, number> {
  const box = scrollContainer.getBoundingClientRect();
  const tops = new Map<string, number>();
  for (const row of scrollContainer.querySelectorAll<HTMLElement>("[data-row-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > box.top && rect.top < box.bottom) {
      tops.set(row.dataset["rowId"] ?? "", rect.top - box.top);
    }
  }
  return tops;
}

describe("a held reply joining the list", () => {
  // The page read back holds rows 0 to 35; the reply at 30 waits on its picture, and the rows
  // above it wait with it, so the list starts at 31 until it joins at the head.
  for (const placement of ["at the top of the box", "above the box"] as const) {
    it(
      `moves no row on screen when the list's head is ${placement}`,
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const pictures = new DiagramPictures(
          PICTURE_CACHE_BYTE_CAP,
          startDiagramWorker,
          () => undefined,
        );
        const history = heldHistoryRead(
          new Map([[FORMULA_AND_DIAGRAM_INDEX, formulaAndDiagramReply("store")]]),
        );
        const decodes = holdImageDecodes();
        const container = await mountFeed(history.read, pictures);
        const replyId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX);
        const neighborId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX + 1);
        const scrollContainer =
          container.querySelector<HTMLElement>(".meridian-transcript-viewport__scroll-container") ??
          expect.fail("the feed drew no scroll container");
        await waitFor(() => {
          expect(history.requests.length).toBeGreaterThan(0);
        });
        await act(async () => {
          history.release();
          await nextFrame();
        });
        await waitFor(
          () => {
            expect(decodes.heldCount()).toBeGreaterThan(0);
          },
          { timeout: CASE_TIMEOUT_MS / 2 },
        );
        // The reader scrolls up: to the top of the list, or two box heights short of it.
        await readerScrollsTo(
          scrollContainer,
          placement === "at the top of the box" ? 0 : 2 * scrollContainer.clientHeight,
        );
        const listedRowIds = [
          ...scrollContainer.querySelectorAll<HTMLElement>("[data-row-id]"),
        ].map((row) => row.dataset["rowId"]);
        expect(listedRowIds).not.toContain(replyId);
        expect(listedRowIds).not.toContain(transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX - 1));
        const before = rowsOnScreen(scrollContainer);
        expect(before.has(neighborId)).toBe(placement === "at the top of the box");

        decodes.release();
        await waitFor(
          () => {
            expect(
              container.querySelector(`[data-row-id="${replyId}"] .meridian-diagram__picture`),
            ).not.toBe(null);
          },
          { timeout: CASE_TIMEOUT_MS / 2 },
        );
        await letFramesPass(2);

        // Within a device pixel: the hold restores the row's place to the scroll offset's grain.
        const after = rowsOnScreen(scrollContainer);
        for (const [rowId, topPx] of before) {
          expect({
            rowId,
            isInPlace: Math.abs((after.get(rowId) ?? Infinity) - topPx) < 1,
          }).toEqual({
            rowId,
            isInPlace: true,
          });
        }
      },
    );
  }
});

/** A reply in the first page read back holding a long table, prose after it settling its block. */
const LONG_TABLE_INDEX = 33;
/** A reply in the first page read back whose body is too large to travel with it. */
const LARGE_BODY_INDEX = 34;
const LONG_TABLE_ROW_COUNT = 300;
/** A cell only the table's last rows hold: drawn in a sample of its widest rows, never on screen. */
const SAMPLE_ONLY_TEXT = "読者位置表";
/** The hidden frame a long table's rows are sampled in, on screen or off the list. */
const SAMPLE_FRAME_SELECTOR = ".meridian-table-sample-frame";

/**
 * Selects the whole page at each change that leaves a sample frame holding `SAMPLE_ONLY_TEXT` in
 * it, and records each selection that took the sample's copy of it.
 */
class SampleSelectionRecorder {
  readonly leaks: string[] = [];
  sampledCount = 0;
  readonly #observer: MutationObserver;

  public constructor() {
    this.#observer = new MutationObserver(() => {
      const frames = document.querySelectorAll(SAMPLE_FRAME_SELECTOR);
      if (![...frames].some((frame) => frame.textContent.includes(SAMPLE_ONLY_TEXT))) {
        return;
      }
      this.sampledCount += 1;
      const selection = document.getSelection() ?? expect.fail("a selection");
      selection.selectAllChildren(document.body);
      const selectedCount = selection.toString().split(SAMPLE_ONLY_TEXT).length - 1;
      selection.removeAllRanges();
      // A row the reader's selection reaches is drawn for real, and is the only copy it may take.
      const drawnCount = [...document.querySelectorAll("td")].filter(
        (cell) =>
          cell.closest(SAMPLE_FRAME_SELECTOR) === null &&
          cell.textContent.includes(SAMPLE_ONLY_TEXT),
      ).length;
      if (selectedCount > drawnCount) {
        const where = [...frames]
          .map((frame) =>
            frame.closest(".meridian-off-list-table-frames") === null
              ? "on screen"
              : "off the list",
          )
          .join(", ");
        this.leaks.push(`a selection of the page took a sample row drawn ${where}`);
      }
    });
    this.#observer.observe(document.body, { subtree: true, childList: true });
  }

  public stop(): void {
    this.#observer.disconnect();
  }
}

/** Records each painted frame where a row paints over the listed row below it. */
class PaintedOverlapRecorder {
  readonly overlaps: string[] = [];
  readonly #frames: PaintedFrameReader<string | undefined>;

  public constructor(rowOf: () => HTMLElement | null) {
    this.#frames = new PaintedFrameReader(
      ROW_SELECTOR,
      () => overlapBelow(rowOf()?.closest(ROW_SELECTOR) ?? null),
      (overlap) => {
        if (overlap !== undefined) {
          this.overlaps.push(overlap);
        }
      },
    );
  }

  public stop(): void {
    this.#frames.stop();
  }
}

/** How far `row` paints over the listed row below it, or `undefined` when it does not. */
function overlapBelow(row: Element | null): string | undefined {
  if (row === null) {
    return undefined;
  }
  const box = row.getBoundingClientRect();
  const below = [...document.querySelectorAll(ROW_SELECTOR)]
    .map((listed) => listed.getBoundingClientRect())
    .filter((listed) => listed.top > box.top)
    .sort((first, second) => first.top - second.top)[0];
  return below !== undefined && box.bottom - below.top > SAME_LENGTH_TOLERANCE_PX
    ? `painted over the row below by ${String(box.bottom - below.top)} px`
    : undefined;
}

describe("a reply read back holding a long table", () => {
  it(
    "joins the list drawing its window from the first frame, laid out as measured on screen",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const pictures = new DiagramPictures(
        PICTURE_CACHE_BYTE_CAP,
        startDiagramWorker,
        () => undefined,
      );
      const history = heldHistoryRead(
        new Map([
          [
            LONG_TABLE_INDEX,
            `${replyWith(benchTable(LONG_TABLE_ROW_COUNT))}\n\n${SETTLING_PARAGRAPHS}`,
          ],
        ]),
      );
      const container = await mountFeed(history.read, pictures);
      await document.fonts.ready;
      const replyId = transcriptFixtureEventId(LONG_TABLE_INDEX);
      await waitFor(() => {
        expect(history.requests.length).toBeGreaterThan(0);
      });

      const selections = new SampleSelectionRecorder();
      const recorder = new WholeRowRecorder(container, [replyId]);
      const overlaps = new PaintedOverlapRecorder(() => recorder.rowOf(replyId));
      await act(async () => {
        history.release();
        await nextFrame();
      });
      await waitFor(
        () => {
          expect(recorder.rowOf(replyId)?.querySelector("table[aria-rowcount]") ?? null).not.toBe(
            null,
          );
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      recorder.stop();
      overlaps.stop();
      expect(recorder.halfMade).toEqual([]);
      expect(overlaps.overlaps).toEqual([]);

      // Measured again on screen, as after a font loads, the table keeps the same columns.
      const row = recorder.rowOf(replyId) ?? expect.fail("the reply is listed");
      const table =
        row.querySelector<HTMLTableElement>("table[aria-rowcount]") ??
        expect.fail("the listed reply draws no windowed table");
      const preparedWidths = headWidthsOf(table);
      act(() => {
        document.fonts.dispatchEvent(new Event("loadingdone"));
      });
      await waitFor(() => {
        expect(row.querySelector(SAMPLE_FRAME_SELECTOR)).not.toBe(null);
      });
      await waitFor(
        () => {
          expect(row.querySelector(SAMPLE_FRAME_SELECTOR)).toBe(null);
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(1);
      selections.stop();
      const measuredWidths = headWidthsOf(table);
      expect(measuredWidths).toHaveLength(preparedWidths.length);
      for (const [column, widthPx] of measuredWidths.entries()) {
        expect(
          Math.abs(widthPx - (preparedWidths[column] ?? 0)),
          `column ${String(column)}: on screen ${String(widthPx)}, off the list ${String(preparedWidths[column])}`,
        ).toBeLessThanOrEqual(SAME_LENGTH_TOLERANCE_PX);
      }
      // Both the frame off the list and the one on screen were drawn, and neither was selected.
      expect(selections.sampledCount).toBeGreaterThan(1);
      expect(selections.leaks).toEqual([]);
    },
  );
});

describe("a listed reply whose large body is opened", () => {
  it(
    "draws as it stood, the read under way, until the body it read draws whole",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const pictures = new DiagramPictures(
        PICTURE_CACHE_BYTE_CAP,
        startDiagramWorker,
        () => undefined,
      );
      const largeBody =
        formulaAndDiagramReply("read") + replyWith(benchTable(LONG_TABLE_ROW_COUNT));
      const history = heldHistoryRead(new Map(), new Map([[LARGE_BODY_INDEX, largeBody]]));
      const replyId = transcriptFixtureEventId(LARGE_BODY_INDEX);
      const readBody: TranscriptBodyRead = async () => ({
        status: "served",
        value: { status: "available", body: largeBody },
      });
      const container = await mountFeed(history.read, pictures, readBody);
      await waitFor(() => {
        expect(history.requests.length).toBeGreaterThan(0);
      });
      await act(async () => {
        history.release();
        await nextFrame();
      });
      const control = await waitFor(
        () =>
          container.querySelector<HTMLButtonElement>(
            `[data-row-id="${replyId}"] .meridian-full-output`,
          ) ?? expect.fail("the reply offers its full output"),
        { timeout: CASE_TIMEOUT_MS / 2 },
      );

      const decodes = holdImageDecodes();
      const recorder = new WholeRowRecorder(container, [replyId]);
      await act(async () => {
        control.click();
        await nextFrame();
      });
      // The body is read and its picture drawn, but not decoded: the reply still stands as it was.
      await waitFor(
        () => {
          expect(decodes.heldCount()).toBeGreaterThan(0);
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      expect(recorder.rowOf(replyId)?.textContent).toContain("Loading the full output…");
      decodes.release();
      await waitFor(
        () => {
          expect(
            recorder.rowOf(replyId)?.querySelector(".meridian-diagram__picture") ?? null,
          ).not.toBe(null);
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      recorder.stop();

      expect(recorder.halfMade).toEqual([]);
      const row = recorder.rowOf(replyId) ?? expect.fail("the reply is listed");
      expect(row.querySelector(".meridian-math--display")).not.toBe(null);
      expect(row.querySelector("table[aria-rowcount]")).not.toBe(null);
      expect(row.querySelector(".meridian-full-output")).toBe(null);
    },
  );
});
